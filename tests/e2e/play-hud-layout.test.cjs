// 94 SP6 — THE PHONE PLAY HUD FITS. On N6 folded (390 px) Sky Run's stage title sat under the Menu pill
// and the Playing chip hid behind the timer (docs img/touch-controls/sky-run-phone.webp). The play
// chrome (exit ✕, Playing chip, Menu pill, embed chrome — every `[data-play-chrome]`) and the game's
// HUD boxes (`#hud-layer .hud-slot`) must never cover each other.
//
// For Sky Run + Mini Golf + Marble Maze, on a touch phone FOLDED (390 x 844) and UNFOLDED (884 x 800),
// in the editor's Play AND in the play entry (`/play`, one HUD code path): enter play, read the boxes
// on the start menu, start the first round (the first HUD button), read them again in the running
// HUD. A box pair overlapping by more than 1 px is red, named with both ids.
//
// Counterfactual: on v1.56.0 Sky Run folded is red (the stage title / timer under the Menu pill and
// the Playing chip) — the base has no safe area (and no `data-play-chrome`, so the base run marks the
// same four elements by id: CHROME_IDS).
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene>, else the sibling scenes checkout's
// games/<slug>/scene.tpscene. Screenshots: EVIDENCE_DIR (default test-results/94-play/layout).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (/** @type {string} */ slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const GAMES = (process.env.ONLY || 'sky-run,mini-golf,marble-maze').split(',');
const SIZES = [
	{ name: 'folded', width: 390, height: 844 },
	{ name: 'unfolded', width: 884, height: 800 }
];
const PAGES = (process.env.PAGES || 'editor,play').split(',');
const EVIDENCE = process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../test-results/94-play/layout');
fs.mkdirSync(EVIDENCE, { recursive: true });
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** every chrome + HUD box on screen, and the overlapping pairs. Runs in the page. */
const boxes = () =>
	/** @type {any} */ (globalThis).document &&
	(() => {
		const CHROME_IDS = ['play-exit', 'play-banner', 'game-shell-menu-button', 'embed-chrome'];
		const vis = (el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 ? r : null;
		};
		const chromeEls = new Set([...document.querySelectorAll('[data-play-chrome]'), ...CHROME_IDS.map((id) => document.getElementById(id)).filter(Boolean)]);
		const chrome = [];
		for (const el of chromeEls) {
			// a container's own box can be empty space between its buttons: measure its children
			const parts = el.id === 'embed-chrome' ? [...el.children] : [el];
			for (const p of parts) {
				const r = vis(p);
				if (r) chrome.push({ id: '#' + (p.id || el.id + '>' + p.tagName.toLowerCase()), l: r.left, t: r.top, r: r.right, b: r.bottom });
			}
		}
		const hud = [];
		for (const slot of document.querySelectorAll('#hud-layer .hud-slot')) {
			// the element's own drawn box (the slot is its positioned wrapper)
			const inner = slot.firstElementChild ?? slot;
			const r = vis(inner) || vis(slot);
			if (r && r.width * r.height > 4) hud.push({ id: 'hud:' + slot.getAttribute('data-hud-id') + '(' + slot.getAttribute('data-hud-kind') + ')', l: r.left, t: r.top, r: r.right, b: r.bottom });
		}
		const hit = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
		const pairs = [];
		for (let i = 0; i < chrome.length; i++) {
			for (let j = i + 1; j < chrome.length; j++) if (hit(chrome[i], chrome[j])) pairs.push(chrome[i].id + ' × ' + chrome[j].id);
			for (const hb of hud) if (hit(chrome[i], hb)) pairs.push(chrome[i].id + ' × ' + hb.id);
		}
		const shift = document.querySelector('#hud-layer')?.getAttribute('data-top-shift') ?? null;
		return { chrome: chrome.length, hud: hud.length, pairs, shift };
	})();

/** the phone top bar's connection chip, measured. Runs in the page. */
const statusRow = () => {
	const btn = document.getElementById('ps-connect-chip');
	if (!btn) return null;
	const dot = btn.querySelector('.ps-dot');
	const chev = btn.querySelector('svg');
	const lbl = document.getElementById('ps-connect-label');
	const R = (el) => {
		const r = el.getBoundingClientRect();
		return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width };
	};
	const d = dot ? R(dot) : null;
	const c = chev ? R(chev) : null;
	// the chip's own content: every laid-out child (not the hidden measuring copy) + gaps + padding
	const cs = getComputedStyle(btn);
	const kids = [...btn.children].filter((k) => !k.classList.contains('ps-chip-measure') && getComputedStyle(k).position !== 'absolute');
	const gap = parseFloat(cs.columnGap) || 0;
	const content = kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
	return {
		text: lbl ? lbl.textContent.trim() : null,
		dotPos: dot ? getComputedStyle(dot).position : null,
		dotW: d ? Math.round(d.w) : null,
		dotOverChevron: !!(d && c && d.l < c.r - 0.5 && c.l < d.r - 0.5 && d.t < c.b - 0.5 && c.t < d.b - 0.5),
		dotBeforeChevron: !!(d && c && d.r <= c.l + 0.5),
		width: Math.round(btn.getBoundingClientRect().width),
		content: Math.round(content)
	};
};

h.run(async () => {
	const browser = await h.launch();

	// ---- the phone STATUS ROW and the Connected panel on a fresh page (83-batch3 findings 1 + 2) ----
	if (PAGES.includes('editor') && !process.env.SKIP_STATUS) {
		const context = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
		const { page, ctx } = await h.setupPage(browser, 'status', { context });
		await page.evaluate(() => window.__stores.templatesModalOpen?.set(false));
		await page.waitForTimeout(800);
		const roomy = await page.evaluate(statusRow);
		console.log('status row:', JSON.stringify(roomy));
		check(!!roomy, 'status row premise: the phone connection chip is on screen');
		check(roomy?.text === 'Connect', `status row: a fresh phone chip says "Connect", the desktop word (${JSON.stringify(roomy?.text)})`);
		check(roomy?.dotPos === 'static' && roomy?.dotBeforeChevron && !roomy?.dotOverChevron, `status row: the connection dot sits in the row before the chevron (${JSON.stringify(roomy)})`);
		check(!!roomy && roomy.width <= roomy.content + 2, `status row: the chip is as wide as what it shows (${roomy?.width} px for ${roomy?.content} px of content)`);
		// crowded (the peers button / a call): the dot alone — still in the row, still not on the chevron
		await page.evaluate(() => document.documentElement.style.setProperty('--ps-right', '240px'));
		await page.waitForTimeout(500);
		const tight = await page.evaluate(statusRow);
		check(!!tight && tight.text === null && tight.dotPos === 'static' && !tight.dotOverChevron && tight.width <= tight.content + 2, `status row crowded: dot + chevron only, no stretch (${JSON.stringify(tight)})`);
		await page.screenshot({ path: path.join(EVIDENCE, 'status-row-390.png'), clip: { x: 0, y: 0, width: 390, height: 70 } });
		await page.evaluate(() => document.documentElement.style.removeProperty('--ps-right'));
		// the Connected panel on a fresh page: other public rooms under their own heading
		await page.evaluate(() =>
			window.__stores.cloudHooks.scenePresence.set({
				myRoomId: 'room-me',
				rooms: [{ id: 'room-2', name: 'Azure Atrium', scene: 'Atrium', hostPeerId: 'h2', members: [{ peerId: 'p1', name: 'Someone Else', mode: 'playing' }] }]
			})
		);
		await page.waitForTimeout(400);
		const trig = page.locator('#peers-trigger');
		if (await trig.count()) await trig.first().click().catch(() => {});
		await page.waitForTimeout(600);
		const panel = await page.evaluate(() => {
			const sec = document.getElementById('cross-scene-presence');
			const chip = sec?.querySelector('.mode-chip');
			const row = chip?.closest('.cross-scene-row, .peers-row');
			return sec
				? {
						heading: document.getElementById('cross-scene-heading')?.textContent?.trim() ?? null,
						chipW: chip ? Math.round(chip.getBoundingClientRect().width) : null,
						rowW: row ? Math.round(row.getBoundingClientRect().width) : null,
						rowH: row ? Math.round(row.getBoundingClientRect().height) : null
					}
				: null;
		});
		console.log('connected panel:', JSON.stringify(panel));
		check(panel?.heading === 'Public rooms', `Connected panel: other live rooms sit under "Public rooms" (${JSON.stringify(panel)})`);
		check(!!panel && panel.chipW != null && panel.chipW < 80 && panel.rowH < 48, `Connected panel: the mode chip keeps its own width in a 390 px row (${JSON.stringify(panel)})`);
		await page.screenshot({ path: path.join(EVIDENCE, 'connected-panel-390.png') });
		await ctx.close();
	}
	for (const slug of GAMES) {
		const file = sceneOf(slug);
		if (!file) {
			console.log(`SKIP ${slug}: no scene.tpscene`);
			continue;
		}
		for (const size of SIZES) {
			for (const kind of PAGES) {
				const tag = `${slug} ${size.name} ${kind}`;
				console.log(`\n=== ${tag} ===`);
				const context = { viewport: { width: size.width, height: size.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
				let page;
				let ctx;
				if (kind === 'editor') {
					({ page, ctx } = await h.setupPage(browser, slug.slice(0, 3) + size.name[0], { context }));
					const bytes = Array.from(fs.readFileSync(file));
					await page.evaluate(async (arr) => {
						const s = window.__stores;
						s.templatesModalOpen?.set(false);
						const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
						await s.sessions.applySession(payload, { backup: false });
					}, bytes);
				} else {
					ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...context });
					await ctx.addInitScript(() => {
						localStorage.setItem('debugStores', 'true');
						localStorage.setItem('hasSeenDisclaimer', 'true');
						localStorage.setItem('hasSeenWelcome', 'true');
					});
					await ctx.route('**/e2e-scenes/*.tpscene', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(file) }));
					page = await ctx.newPage();
					const res = await page.goto(`${h.URL}play?scene=${encodeURIComponent('/e2e-scenes/' + slug + '.tpscene')}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
					if (!res || res.status() !== 200) {
						check(false, `${tag}: /play answers 200 (${res?.status()})`);
						await ctx.close();
						continue;
					}
					await page.waitForFunction(() => window.tpPlay && window.__stores?.playMode, null, { timeout: 90000 });
					await page.evaluate(() => window.tpPlay.loaded);
				}
				await page.waitForTimeout(2500);
				await page.evaluate(() => window.__stores.playMode.requestPlay({ flat: true }));
				await h.eventually(() => page.evaluate((r) => eval(r)(window.__stores.isLocked), read), (v) => v === true, `${tag}: premise: in Play`, 15000);
				await page.waitForTimeout(1500);
				const menu = await page.evaluate(boxes);
				await page.screenshot({ path: path.join(EVIDENCE, `${slug}-${size.name}-${kind}-menu.png`) });
				console.log(`menu: chrome ${menu.chrome}, hud ${menu.hud}, shift ${menu.shift}`);
				check(menu.chrome > 0, `${tag} menu: the play chrome is on screen (${menu.chrome})`);
				check(menu.pairs.length === 0, `${tag} menu: no chrome box covers another or a HUD box (${menu.pairs.join('; ') || 'none'})`);
				// start the first round: the first button of the visible HUD (a stage / Play button)
				const pressed = await page.evaluate(() => {
					const b = [...document.querySelectorAll('#hud-layer button')].find((x) => x.getBoundingClientRect().width > 0);
					if (!b) return null;
					b.click();
					return b.textContent?.trim().slice(0, 40) ?? '';
				});
				await page.waitForTimeout(3500);
				const run = await page.evaluate(boxes);
				await page.screenshot({ path: path.join(EVIDENCE, `${slug}-${size.name}-${kind}-hud.png`) });
				console.log(`hud (pressed "${pressed}"): chrome ${run.chrome}, hud ${run.hud}, shift ${run.shift}`);
				check(run.hud > 0, `${tag} running: the game HUD is on screen (${run.hud})`);
				check(run.pairs.length === 0, `${tag} running: no chrome box covers another or a HUD box (${run.pairs.join('; ') || 'none'})`);
				await ctx.close();
			}
		}
	}
	await h.finish(browser);
});
