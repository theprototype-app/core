// 61 G3 — TEST WITH PLAYERS on every surface it ships to. test-players.test.cjs proves the run itself
// (2 bots, roles, the win, a clean Stop) on the desktop; this suite proves the ENTRY, the CAP, the COST and
// a clean Stop on the devices:
//   n6-folded   (390x896, the phone shell): long-press Play on the bar gives "Test with players…"; the
//               sheet offers 1 (2 and 3 are disabled); one Player bot joins and plays; measured cost; Stop clean
//   n6-unfolded (770x850, light theme): the same from the Play FAB
//   desktop     (1280x800, light theme): the cap is 3; two bots for the light shots of the sheet and strip
//   quest       (IWER Quest 3, a Quest Browser UA): the cap is 1; a running test SURVIVES entering and
//               leaving VR (the bot's link stays open both ways, its view stays on the strip), Stop clean
// Every surface: axe (serious/critical gate) on the sheet and on the strip; shots with E2E_SHOTS=<dir>.
// TP-DEVICE-COST lines: the host tab's JS heap (the bot frames share it: same origin, same process) and
// the host's frame interval, before and with the bot(s). Headless numbers, not a phone's — the cap is the
// guard, these say what one bot costs.
//
//   APP_URL=https://theprototype.app:5941/ node tests/e2e/test-players-devices.test.cjs
//   E2E_DEVICES=n6-folded,quest  runs a subset
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.2.0.0 SamsungBrowser/4.0 Chrome/130.0.0.0 VR Safari/537.36';
// NOT aiAssistantDocked: boot migrates it away (uiLayouts migrateChatKeys), and the harness's seed is an init script that
// runs again in every bot frame — it would write the key back into the real storage and read as a bot's write
const STORAGE = { explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false' };

const DEVICES = [
	{ id: 'n6-folded', theme: 'dark', cap: 1, entry: '#ps-play', ctx: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, userAgent: h.N6_UA } },
	{ id: 'n6-unfolded', theme: 'light', cap: 1, entry: '#play-button', ctx: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, userAgent: h.N6_UA } },
	{ id: 'desktop', theme: 'light', cap: 3, entry: '#play-button', roles: ['player', 'viewer'], ctx: { viewport: { width: 1280, height: 800 } } },
	{ id: 'quest', theme: 'dark', cap: 1, entry: '#play-button', vr: true, ctx: { viewport: { width: 1280, height: 800 }, userAgent: QUEST_UA } }
];

const spy = require('./test-players-spy.cjs');
const WRITE_SPY = spy.writeSpy([...Object.keys(STORAGE), 'theme']);

/** @param {any} page */
const facts = (page) =>
	page.evaluate(() => {
		const s = window.__tp.test.v1;
		const dbg = s.testPlayers.testPlayersDebug();
		let users = [];
		s.userdata.subscribe((v) => (users = v))();
		let pc = null;
		s.peers.subscribe((v) => (pc = v))();
		const ids = dbg ? dbg.bots.map((b) => b.id).filter(Boolean) : [];
		const ls = [];
		for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i));
		return {
			dbg,
			me: pc.peer.id,
			roster: users.map((u) => u[0]),
			opened: [...pc.openedPeers],
			links: Object.keys(pc.connections),
			playModes: ids.map((id) => s.gamePresence.playModeOf(id)),
			frames: document.querySelectorAll('#test-players-strip iframe').length,
			ls: ls.sort(),
			botWrites: (window.__tpBotRealWrites ?? []).slice()
		};
	});

/** the host's frame interval over `ms` @param {any} page */
const frameCost = (page, ms = 3000) =>
	page.evaluate(
		(ms) =>
			new Promise((resolve) => {
				const d = [];
				let last = performance.now();
				const end = last + ms;
				const tick = (t) => {
					d.push(t - last);
					last = t;
					if (t < end) requestAnimationFrame(tick);
					else {
						d.sort((a, b) => a - b);
						resolve({ n: d.length, mean: d.reduce((a, b) => a + b, 0) / d.length, p95: d[Math.floor(d.length * 0.95)] });
					}
				};
				requestAnimationFrame(tick);
			}),
		ms
	);

/** the JS heap of the host's renderer isolate (bots included), MB @param {any} cdp */
async function heapMB(cdp) {
	await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
	const { metrics } = await cdp.send('Performance.getMetrics');
	return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
}

/** axe on one region, serious/critical gated @param {any} page @param {string} sel @param {string} what */
async function axe(page, sel, what) {
	const res = await new AxeBuilder({ page }).include(sel).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	for (const v of res.violations) console.log(`  [axe ${what}] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(gated.length === 0, `${what}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

/** @param {any} page */
async function shot(page, name) {
	if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
}

/** @param {any} browser @param {typeof DEVICES[number]} dev */
async function onDevice(browser, dev) {
	console.log(`\n=== ${dev.id} (${dev.theme}) ===`);
	const P = await h.setupPage(browser, dev.id, { context: { ...dev.ctx, colorScheme: dev.theme }, storage: { ...STORAGE, theme: dev.theme }, init: { content: (dev.vr ? iwer.initScript().content + '\n' : '') + WRITE_SPY } });
	const page = P.page;
	await h.answerRestore(P).catch(() => {});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await page.waitForTimeout(3000);
	const before = await facts(page);
	const heap0 = await heapMB(cdp);
	const cost0 = await frameCost(page);

	// ---- the entry: a long press (a real touch contextmenu) / right-click on Play ----------------
	await page.waitForSelector(dev.entry, { timeout: 30000 });
	await page.locator(dev.entry).first().dispatchEvent('contextmenu', { button: 2, clientX: 40, clientY: 40 });
	await page.waitForTimeout(400);
	const rows = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(rows.some((r) => /^Test with players/.test(r)), `${dev.id}: holding Play offers "Test with players…" (${JSON.stringify(rows)})`);
	await page.getByRole('menuitem', { name: /Test with players/ }).click();
	await page.waitForSelector('#test-players-start', { timeout: 30000 });
	const counts = await page.evaluate(() => [1, 2, 3].map((n) => { const b = document.querySelector('#test-players-count-' + n); return b ? !(b.disabled || b.getAttribute('aria-disabled') === 'true') : null; }));
	h.check(counts.filter(Boolean).length === dev.cap && counts[0] === true, `${dev.id}: the sheet offers up to ${dev.cap} (${JSON.stringify(counts)})`);
	const roles = dev.roles ?? ['player'];
	if (dev.cap > 1) await page.click('#test-players-count-' + roles.length);
	for (const [i, r] of roles.entries()) await page.click(`#test-player-role-${i + 1}-${r}`);
	await shot(page, `${dev.id}-${dev.theme}-sheet`);
	await axe(page, '#test-players-sheet', `${dev.id} sheet`);
	const startBox = await page.locator('#test-players-start').boundingBox();
	const vp = dev.ctx.viewport;
	h.check(!!startBox && startBox.y + startBox.height <= vp.height && startBox.x >= 0 && startBox.x + startBox.width <= vp.width, `${dev.id}: Start test is on screen (${JSON.stringify(startBox)})`);
	await page.click('#test-players-start');
	const t0 = Date.now();

	// ---- the bot(s) join, the player plays -------------------------------------------------------
	let st = null;
	const until = Date.now() + 240000;
	while (Date.now() < until) {
		st = await facts(page);
		if (st.dbg && st.dbg.bots.length === roles.length && st.dbg.bots.every((b) => b.id && st.opened.includes(b.id)) && st.playModes[0] === 'playing') break;
		await page.waitForTimeout(1000);
	}
	const joinS = Math.round((Date.now() - t0) / 1000);
	if (!(st.dbg && st.dbg.bots.every((b) => b.id))) await spy.stuck(page, st.dbg);
	h.check(!!st.dbg && st.dbg.bots.length === roles.length && st.dbg.bots.every((b) => b.id && st.opened.includes(b.id)), `${dev.id}: ${roles.length} bot(s) joined in ${joinS} s (${JSON.stringify(st.dbg?.bots)})`);
	h.check(st.playModes[0] === 'playing', `${dev.id}: the player bot is in Play (${JSON.stringify(st.playModes)})`);
	h.check(st.frames === roles.length, `${dev.id}: the strip shows ${roles.length} view(s) (${st.frames})`);
	const stripBox = await page.locator('#test-players-strip').boundingBox();
	const stopBox = await page.locator('#test-players-stop').boundingBox();
	h.check(!!stripBox && stripBox.x >= 0 && stripBox.x + stripBox.width <= vp.width + 1 && !!stopBox && stopBox.y + stopBox.height <= vp.height && stopBox.x + stopBox.width <= vp.width, `${dev.id}: the strip and Stop test fit the screen (${JSON.stringify(stripBox)} ${JSON.stringify(stopBox)})`);
	await page.waitForTimeout(3000);
	const heap1 = await heapMB(cdp);
	const cost1 = await frameCost(page);
	console.log(`TP-DEVICE-COST ${dev.id} bots=${roles.length} join=${joinS}s heap ${heap0.toFixed(0)} -> ${heap1.toFixed(0)} MB (+${(heap1 - heap0).toFixed(0)}, ${((heap1 - heap0) / roles.length).toFixed(0)}/bot) · frame mean ${cost0.mean.toFixed(1)} -> ${cost1.mean.toFixed(1)} ms, p95 ${cost0.p95.toFixed(1)} -> ${cost1.p95.toFixed(1)} ms`);
	await shot(page, `${dev.id}-${dev.theme}-strip`);
	await axe(page, '#test-players-strip', `${dev.id} strip`);

	// ---- Quest: the run survives entering and leaving VR -----------------------------------------
	if (dev.vr) {
		h.check(await iwer.installed(page), 'quest: IWER is the headset');
		const botId = st.dbg.bots[0].id;
		const inVr = await iwer.enter(page).catch((e) => ({ error: String(e) }));
		h.check(!inVr.error && inVr.presenting, `quest: the host entered VR with a test running (${JSON.stringify(inVr.error ?? inVr.presenting)})`);
		await iwer.frames(page, 30);
		await page.waitForTimeout(2000);
		let vr = await facts(page);
		h.check(vr.opened.includes(botId) && vr.dbg?.bots[0]?.id === botId && vr.frames === 1, `quest: in VR the bot is still linked and on the strip (${JSON.stringify({ opened: vr.opened, frames: vr.frames })})`);
		await iwer.exit(page);
		await page.waitForTimeout(2500);
		vr = await facts(page);
		h.check(!(await iwer.state(page)).presenting, 'quest: left VR');
		h.check(vr.opened.includes(botId) && vr.dbg?.bots[0]?.id === botId && vr.frames === 1 && vr.roster.includes(botId), `quest: after VR the same bot is still joined (${JSON.stringify({ opened: vr.opened, roster: vr.roster })})`);
		const botFrame = page.frames().find((f) => /[?&]tpbot=/.test(f.url()));
		const botSees = botFrame ? await botFrame.evaluate(() => { let pc = null; window.__tp.test.v1.peers.subscribe((v) => (pc = v))(); return [...pc.openedPeers]; }) : [];
		h.check(botSees.includes(vr.me), `quest: and the bot still has the host (${JSON.stringify(botSees)})`);
	}

	// ---- the write spy can see a bot's write (positive control), then forgets it --------------------
	const seen = await spy.probe(page, page.frames().find((f) => /[?&]tpbot=/.test(f.url())));
	h.check(seen, `${dev.id}: the write spy sees a bot frame's real write (positive control)`);

	// ---- Stop test: clean ------------------------------------------------------------------------
	await page.click('#test-players-stop');
	await page.waitForFunction(() => !document.querySelector('#test-players-strip'), null, { timeout: 20000 }).catch(() => {});
	await page.waitForTimeout(1500);
	st = await facts(page);
	const newLs = st.ls.filter((k) => !before.ls.includes(k));
	h.check(st.dbg === null && st.frames === 0 && page.frames().every((f) => !/[?&]tpbot=/.test(f.url())), `${dev.id}: Stop ends the run, no frames left`);
	h.check(st.roster.filter((id) => id !== st.me).length === 0 && st.opened.length === 0 && st.links.length === 0, `${dev.id}: 0 bot roster rows, no links (${JSON.stringify(st.roster)} ${JSON.stringify(st.links)})`);
	h.check(st.botWrites.length === 0, `${dev.id}: the bots wrote nothing to this tab's real storage (${JSON.stringify(st.botWrites)})`);
	// the host's OWN new keys (a one-time hint the test made it show, say) are the host's, not a bot's: logged
	console.log(`${dev.id}: keys the host itself added during the test: ${JSON.stringify(newLs)}`);
	const heap2 = await heapMB(cdp);
	console.log(`TP-DEVICE-COST ${dev.id} after Stop: heap ${heap2.toFixed(0)} MB (was ${heap0.toFixed(0)} before the test)`);
	h.check(heap2 - heap0 < Math.max(40, (heap1 - heap0) * 0.5), `${dev.id}: Stop gives the bots' memory back (${heap0.toFixed(0)} -> ${heap1.toFixed(0)} -> ${heap2.toFixed(0)} MB)`);
	await P.page.context().close();
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const only = (process.env.E2E_DEVICES ?? '').split(',').filter(Boolean);
	for (const dev of DEVICES) if (!only.length || only.includes(dev.id)) await onDevice(browser, dev);
	await h.finish(browser);
});
