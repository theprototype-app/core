// 42 I12 — "bug: the toast for quality select double sometimes, also how to change quality (configure
// scene settings does not have quality preset setting to edit at it likely should be top option)".
//   1. WHY IT DOUBLED: the governor steps every ~3 s and each automatic step that lowers a NEW
//      toggle announced itself as its OWN toast — shadows, then resolution three seconds later —
//      so two "Lowered … to keep it smooth · Keep full quality" cards stacked (a phone's lighter
//      start followed by a water drop did the same). The notice is ONE card by id now: a later
//      drop rewords it in place. Counterfactual (feat/41-int): two cards.
//   2. Configure Scene ▸ Quality is the TOP section: Preset (Auto / High / Medium / Low, the ladder
//      a game's Quality setting uses), the auto switch and shadow quality; LOCAL (saved on this
//      device, survives a reload, never sent); a game's own preset outranks it while played; the
//      same row in Settings ▸ Scene ▸ Performance, found by searching "quality".
// Frames are SYNTHETIC on a clock 1e9 ms ahead (the auto-quality-notice recipe), so the page's own
// frames cannot step or recover the level mid-test. OUT=<dir> writes the screenshots.
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';

/** the synthetic driver (auto-quality-notice's) @param {any} page */
async function freeze(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__q = { t: 1e9 };
		w.__stores.qualityGovernor.governorForTest.setLevel(0, w.__q.t);
		w.__q.t += 1000;
		/** @param {number} dur @param {number} slow @param {boolean} [once] stop at the first step */
		w.__qdrive = (dur, slow, once = false) => {
			const Q = w.__stores.qualityGovernor;
			const g = Q.governorForTest;
			/** @type {number[]} */ const moves = [];
			const end = w.__q.t + dur;
			let next = w.__q.t + 250;
			while (w.__q.t < end) {
				w.__q.t += slow;
				g.frame(slow, w.__q.t);
				if (w.__q.t >= next) {
					next = w.__q.t + 250;
					const d = Q.decideNow(w.__q.t);
					if (d.moved) moves.push(d.level);
					if (once && moves.length) break;
				}
			}
			return { moves, level: g.level() };
		};
	});
}

/** the "Lowered …" cards on screen @param {any} page */
const cards = (page) =>
	page.evaluate(() => [...document.querySelectorAll('.toasts-regular .tp-toast .tp-toast-text')].map((e) => e.textContent?.trim() ?? '').filter((t) => /^Lowered /.test(t)));
/** @param {any} page */
const q = (page) =>
	page.evaluate(() => {
		let s;
		window.__stores.qualityGovernor.qualityState.subscribe((/** @type {any} */ v) => (s = v))();
		return /** @type {any} */ (s);
	});

h.run(async () => {
	const browser = await h.launch();
	// ── 1. two automatic steps in a row: ONE card ────────────────────────────────────────────────
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	let page = D.page;
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(800);
	await freeze(page);
	// a heavy scene for the desktop budget (the governor only acts on one)
	await page.evaluate(() => /** @type {any} */ (window).__stores.sceneBudget.qualityBaseline.set({ objects: 0, triangles: 0, calls: 5000 }));
	// ONE step at a time (on a loaded box a long drive can take two steps before the notice batches)
	const d1 = await page.evaluate(() => /** @type {any} */ (window).__qdrive(4000, 60, true));
	h.check(d1.moves.length === 1, `1.0 (premise) missed frames take one automatic step (${d1.moves.join(',')})`);
	await page.waitForTimeout(1200); // the notice batches a drop's writes for 400 ms
	const c1 = await cards(page);
	h.check(c1.length === 1 && /^Lowered .+ to keep it smooth$/.test(c1[0]), `1.1 the first drop is announced (${JSON.stringify(c1)})`);
	// 42-int: the ladder (qualityGovernorCore STEPS) lowers a NEW toggle only at levels 1 shadows, 2 resolution,
	// 4 AO, 6 the scene look — a loaded box can land the first drive on 2, and 2 -> 3 (resolution 85 -> 72 %)
	// rightly announces nothing new. Drive one step at a time until a step crosses a new toggle.
	const NEW_TOGGLE = [1, 2, 4, 6];
	const crossesNew = (/** @type {number} */ a, /** @type {number} */ b) => NEW_TOGGLE.some((l) => l > a && l <= b);
	let d2 = await page.evaluate(() => /** @type {any} */ (window).__qdrive(6000, 60, true));
	for (let i = 0; i < 2 && d2.moves.length === 1 && !crossesNew(d1.level, d2.level); i++) d2 = await page.evaluate(() => /** @type {any} */ (window).__qdrive(6000, 60, true));
	h.check(d2.moves.length === 1 && crossesNew(d1.level, d2.level), `1.2 (premise) seconds on, a later step lowers something new (${d1.level} -> ${d2.moves.join(',')})`);
	await page.waitForTimeout(1200);
	const c2 = await cards(page);
	console.log('cards after two drops', JSON.stringify(c1), '->', JSON.stringify(c2));
	h.check(c2.length === 1, `1.3 ONE quality card after two drops, not two stacked (${c2.length}: ${JSON.stringify(c2)})`);
	h.check(c2[0] !== c1[0] && /^Lowered .+ to keep it smooth$/.test(c2[0] ?? ''), `1.4 …reworded with the newest drop ("${c1[0]}" -> "${c2[0]}")`);
	const keep = await page.evaluate(() => [...document.querySelectorAll('.toasts-regular .tp-toast-action')].filter((b) => b.textContent?.trim() === 'Keep full quality').length);
	h.check(keep === 1, `1.5 one "Keep full quality" button (${keep})`);
	if (OUT) await page.screenshot({ path: path.join(OUT, 'i12-one-quality-card.png') });

	// ── 2. Configure Scene ▸ Quality, the top section ────────────────────────────────────────────
	// back to a light scene and full quality; the heavy premise above can also trip 26-G's freeze
	// pause on a loaded box (its overlay would take the clicks below) — stand it down
	await page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		w.sceneBudget.qualityBaseline.set(null);
		w.qualityGovernor.governorForTest.reset();
		w.overloadGuard?.resumeRendering?.();
	});
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.openSceneSection('Quality'));
	await page.waitForSelector('#scene-quality-preset', { state: 'visible', timeout: 10000 });
	await page.waitForTimeout(500);
	const order = await page.evaluate(() => {
		const ins = document.querySelector('#inspector') ?? document;
		const labels = [...ins.querySelectorAll('.sec-label, [data-section-label], .section-label, h3')].map((e) => e.textContent?.trim() ?? '').filter(Boolean);
		const first = ins.querySelector('#scene-quality-preset')?.getBoundingClientRect().top ?? 1e9;
		const env = ins.querySelector('#environment-presets')?.getBoundingClientRect().top ?? -1;
		return { labels: labels.slice(0, 4), qualityAboveEnvironment: first < env };
	});
	h.check(order.qualityAboveEnvironment, `2.1 the Quality preset sits above Environment, the top of Configure Scene (${JSON.stringify(order)})`);
	const opts = await page.evaluate(() => [...document.querySelectorAll('#scene-quality-preset [role="radio"]')].map((b) => b.textContent?.trim()));
	h.check(opts.join() === 'Auto,High,Medium,Low', `2.2 Auto / High / Medium / Low (${opts.join(',')})`);
	if (OUT) {
		for (const t of ['dark', 'light']) {
			await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
			await page.waitForTimeout(350);
			await page.screenshot({ path: path.join(OUT, `i12-configure-scene-quality-${t}.png`) });
		}
		await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	}
	await page.locator('#scene-quality-preset [role="radio"]', { hasText: 'Low' }).click();
	await page.waitForTimeout(400);
	let s = await q(page);
	h.check(s.level === 8 && /quality preset: low/.test(s.reason), `2.3 Low holds level 8 (${s.level}, "${s.reason}")`);
	const stored = await page.evaluate(() => localStorage.getItem('quality:preset'));
	h.check(stored === 'low', `2.4 saved on this device (${stored})`);
	const drift = await page.evaluate(() => /** @type {any} */ (window).__qdrive(20000, 8));
	h.check(drift.moves.length === 0 && drift.level === 8, `2.5 a pinned preset is never re-decided: twenty seconds of fast frames keep 8 (${drift.moves.join(',') || 'none'})`);
	// a game's own Quality setting outranks it while the game is played
	await page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(0, 'high'));
	s = await q(page);
	h.check(s.level === 0, `2.6 a game's High preset wins while played (${s.level})`);
	const note = await page.evaluate(() => document.querySelector('#scene-quality-game-note')?.textContent?.trim() ?? '');
	h.check(/holds its own Quality setting/.test(note), `2.7 …and the section says so ("${note}")`);
	await page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(null, 'auto'));
	s = await q(page);
	h.check(s.level === 8, `2.8 leaving the game hands back the device preset (${s.level})`);
	// survives a reload
	await h.freshReload(D);
	await page.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
	s = await q(page);
	h.check(s.level === 8 && /quality preset: low/.test(s.reason), `2.9 after a reload the preset holds again (${s.level}, "${s.reason}")`);
	await page.evaluate(() => window.__stores.openSceneSection('Quality'));
	await page.waitForSelector('#scene-quality-preset', { state: 'visible', timeout: 10000 });
	await page.locator('#scene-quality-preset [role="radio"]', { hasText: 'Auto' }).click();
	await page.waitForTimeout(400);
	s = await q(page);
	h.check(s.level === 0 && (await page.evaluate(() => localStorage.getItem('quality:preset'))) === 'auto', `2.10 Auto gives the level back to the governor (${s.level})`);
	// Settings ▸ Scene: the same row, found by searching
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForSelector('#settings-search', { timeout: 10000 });
	await page.fill('#settings-search', 'quality');
	await page.waitForTimeout(700);
	const found = await page.evaluate(() => {
		const r = document.querySelector('#row-quality-preset');
		return !!r && /** @type {HTMLElement} */ (r).offsetParent !== null;
	});
	h.check(found, '2.11 Settings search "quality" finds the Quality preset row');
	await page.locator('#quality-preset [role="radio"]', { hasText: 'Medium' }).click();
	await page.waitForTimeout(400);
	s = await q(page);
	h.check(s.level === 3, `2.12 Medium from Settings holds level 3, the same store (${s.level})`);
	await page.locator('#quality-preset [role="radio"]', { hasText: 'Auto' }).click();
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	h.check(h.pageErrors(D).length === 0, `no page errors (${JSON.stringify(h.pageErrors(D)).slice(0, 200)})`);
	await h.finish(browser);
});
