// 38 R1 — THE SEARCH LOCK (SPEC §0: "Search in Settings and the Inspector filter keep
// finding the same rows"). Recorded, then verified as SETS (order and highlighting may change
// with the redesign; what a query finds may not):
//
//   · Settings › search: every inventory row's own name, plus the words people search with
//     that labels do not contain (the KEYWORDS of $lib/settingsSearch and common terms) ->
//     which rows and which sections show;
//   · the Inspector's "Filter properties…" on an object, a light and the scene: every
//     section's own label plus common terms -> which sections stay.
//
//   LOCK_RECORD=1 node tests/e2e/lock-search.test.cjs   records fixtures/lock/search.json
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');
const S = require('./lockSurfaces.cjs');

const WORDS = [
	'dark', 'light', 'colour', 'color', 'contrast', 'appearance', 'sfx', 'audio', 'volume', 'performance', 'frame rate',
	'beacon', 'telemetry', 'touchpad', 'trackpad', 'controller', 'xbox', 'joystick', 'drift', 'fps', 'lag', 'lod',
	'instancing', 'backup', 'recovery', 'crash', 'units', 'metres', 'inches', 'degrees', 'radians', 'rotate', 'comfort',
	'quest', 'locomotion', 'mixed reality', 'hz', 'peerjs', 'network', 'relay', 'nat', 'release', 'changelog', 'bug',
	'debug', 'llm', 'claude', 'api key', 'model', 'meshy', 'trash', 'disk', 'quota', 'toolbar', 'menu', 'mouse',
	'keyboard', 'gamepad', 'grid', 'snap', 'files', 'library', 'headset', 'xr', 'assistant', 'peer', 'server', 'invite',
	'room', 'session', 'keys', 'hotkey', 'binding', 'version', 'privacy', 'shadow', 'water', 'tour', 'welcome',
	'checkpoint', 'placeholder', 'wireframe', 'duplicate', 'material', 'share', 'delete', 'export', 'theme', 'pinch',
	'zoom', 'pan', 'wheel', 'hand', 'hud', 'vr', 'ai', 'zz-no-match'
];

h.run(async () => {
	const browser = await L.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	const inventory = require('./fixtures/lock/settings-inventory.json');

	// ---- Settings search -------------------------------------------------------------------
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-search').waitFor({ state: 'visible', timeout: 15000 });
	const queries = [...new Set([...Object.values(inventory).flat().map((r) => r.name), ...WORDS])];
	/** @type {Record<string, {rows: string[], sections: string[]}>} */
	const settings = {};
	let previous = '';
	for (const q of queries) {
		await page.fill('#settings-search', q);
		// settle: the filter re-applies after the sections expand — wait until two reads agree
		let last = '';
		for (let i = 0; i < 12; i++) {
			await page.waitForTimeout(150);
			const now = await page.evaluate(({ ROW_SEL, NAME_SEL }) => {
				const vis = (/** @type {Element} */ e) => /** @type {HTMLElement} */ (e).offsetParent !== null;
				return JSON.stringify({
					rows: [...document.querySelectorAll(ROW_SEL)].filter(vis).map((r) => (r.querySelector(NAME_SEL)?.textContent || '').trim()).sort(),
					sections: [...document.querySelectorAll('#settings-nav .sn-row')].filter((b) => !b.hasAttribute('hidden')).map((b) => b.getAttribute('data-section') || '')
				});
			}, { ROW_SEL: L.ROW_SEL, NAME_SEL: L.NAME_SEL });
			if (now === last && now !== previous) break;
			if (now === last && i > 3) break;
			last = now;
		}
		previous = last;
		settings[q] = JSON.parse(last);
	}
	h.check(Object.values(settings).some((r) => r.rows.length > 0), 'premise — the search finds rows');
	h.check(settings['zz-no-match'].rows.length === 0, 'a nonsense query finds nothing');
	await page.fill('#settings-search', '');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);

	// ---- Inspector filter ----------------------------------------------------------------------
	const ctx = await S.seedScene(page);
	/** @type {Record<string, Record<string, string[]>>} */
	const inspector = {};
	const targets = /** @type {[string, () => Promise<any>][]} */ ([
		['object', () => page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.box)],
		['light', () => page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.light)],
		['scene', () => page.evaluate(() => window.__stores.showSidebar('scene'))]
	]);
	const sectionsShown = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('#inspector .ui-section-label')]
				.filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null)
				.map((e) => (e.querySelector('span')?.textContent ?? e.textContent ?? '').trim())
				.filter(Boolean)
		);
	for (const [name, open] of targets) {
		await S.closeAll(page);
		await open();
		await page.locator('#inspector-search').waitFor({ state: 'visible', timeout: 10000 });
		await page.evaluate(() => window.__stores.inspectorFilter.set(''));
		await page.waitForTimeout(400);
		const all = await sectionsShown();
		const qs = [...new Set([...all.map((s) => s.toLowerCase()), 'position', 'rotation', 'scale', 'color', 'colour', 'shadow', 'physics', 'material', 'intensity', 'fog', 'grid', 'camera', 'water', 'lod', 'render', 'light', 'sky', 'environment', 'origin', 'snap', 'zz-no-match'])];
		/** @type {Record<string, string[]>} */
		const table = { '': all.slice().sort() };
		for (const q of qs) {
			await page.locator('#inspector-search').fill(q);
			await page.waitForTimeout(350);
			table[q] = (await sectionsShown()).sort();
		}
		await page.locator('#inspector-search').fill('');
		inspector[name] = table;
		h.check(all.length >= 3, `premise — the ${name} inspector has sections (${all.length})`);
	}
	h.check(inspector.object['zz-no-match'].length === 0, 'the Inspector filter hides every section for a nonsense query');

	// ---- record / verify ---------------------------------------------------------------------------
	if (L.RECORD) {
		L.writeFixture('search', { recordedAt: new Date().toISOString(), settings, inspector });
		return h.finish(browser);
	}
	const fixture = L.readFixture('search');
	h.check(!!fixture, 'the recorded search lock exists (tests/e2e/fixtures/lock/search.json)');
	if (fixture) {
		let bad = 0;
		for (const [q, want] of Object.entries(fixture.settings)) {
			const got = settings[q];
			const ok = !!got && JSON.stringify(got.rows) === JSON.stringify(want.rows) && JSON.stringify(got.sections) === JSON.stringify(want.sections);
			if (!ok) {
				bad++;
				h.check(false, `Settings search "${q}" finds the same rows\n      expected ${JSON.stringify(want)}\n      actual   ${JSON.stringify(got)}`);
			}
		}
		h.check(bad === 0, `Settings search: ${Object.keys(fixture.settings).length} queries find the same rows and sections`);
		for (const [target, table] of Object.entries(fixture.inspector)) {
			const diff = Object.entries(table).filter(([q, want]) => JSON.stringify(inspector[target]?.[q] ?? null) !== JSON.stringify(want));
			h.check(diff.length === 0, `Inspector filter (${target}): ${Object.keys(table).length} queries keep the same sections` + (diff.length ? '\n      ' + diff.map(([q, w]) => `"${q}": expected ${JSON.stringify(w)} got ${JSON.stringify(inspector[target]?.[q])}`).join('\n      ') : ''));
		}
	}
	await h.finish(browser);
});
