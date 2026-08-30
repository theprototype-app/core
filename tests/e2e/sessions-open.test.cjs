// R22 ROUND 13 — THE SESSIONS ROW: ICONS, OPEN, AND A .tp THAT LANDS IN SESSIONS.
//
// Four reports, one row:
//
//   "Change emojis ▶,⤵ to Lucid icons inside modal"
//   "Instead of 'Load' for items put 'Open'"
//   "When add .tp file using 'import session file' button from Sessions modal should just
//    add another item in Sessions 'projects', same as when importing .tpscene, fix it as
//    now it imports it as a folder inside projets Library"
//   "import session file, when chosen in '+ Mount project...' Explorer button, it should
//    automatically also mount this session file, not just import"
//
// The two-peer half of "Open" (a project open LEAVES the session first) is its own file,
// `sessions-open-peers` — signaling is slow and this suite has to stay inside the runner's
// 8-minute budget.
//
// Run: APP_URL='https://localhost:5206/' npm run e2e -- sessions-open
const h = require('./helpers.cjs');

/** the saved entries, as the manager's own store sees them */
const metas = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).map((m) => ({ id: m.id, name: m.name, lib: m.hasLibrary, files: m.libraryCount }));
	});

const openSessions = async (p) => {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(900);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.sessions && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
	});
	await page.waitForTimeout(500);

	// one scene worth saving, and one file so the project entry is a real project
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		s.objectActions.deselectObject();
		await s.explorer.addItemFromBytes(new TextEncoder().encode('notes').buffer, 'readme.txt', null);
	});
	await page.waitForTimeout(900);
	await page.evaluate(async () => {
		const s = window.__stores.sessions;
		s.saveSession('Wharf');
		await new Promise((r) => setTimeout(r, 400));
		await s.saveSessionWithLibrary('Depot');
	});
	await page.waitForTimeout(900);
	const saved = await metas(A);
	h.check(
		saved.length === 2 && saved.some((m) => m.name === 'Wharf' && !m.lib) && saved.some((m) => m.name === 'Depot' && m.lib),
		`premise: a SCENE entry and a PROJECT entry are saved (${JSON.stringify(saved.map((m) => [m.name, m.lib]))})`
	);

	// ---- 1. THE GLYPHS ARE GONE, in BOTH views ---------------------------------------
	// The view is a REMEMBERED pref and only LIST rows carry `.session-row`, so each half
	// is pinned rather than inherited from whatever the last suite left in localStorage.
	await openSessions(A);
	const readRow = (selector) =>
		page.evaluate((sel) => {
			const row = document.querySelector(sel);
			if (!row) return null;
			const btn = (cls) => row.querySelector(cls);
			const read = (cls) => {
				const el = btn(cls);
				if (!el) return null;
				const icon = el.querySelector('svg');
				return {
					text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
					svg: el.querySelectorAll('svg').length,
					// "inherits currentColor" is exactly this equality, and it is what a
					// hardcoded gray would break while still LOOKING like an icon
					stroke: icon ? getComputedStyle(icon).stroke : '',
					color: getComputedStyle(el).color
				};
			};
			return {
				glyphs: /[▶⤵⧉✕]/.test(row.textContent || ''),
				load: read('.session-load'),
				mount: read('.session-mount'),
				imports: read('.session-import'),
				del: read('button[aria-label="Delete"]')
			};
		}, selector);

	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	const listRow = await readRow('#session-list .session-row');
	h.check(!!listRow, 'premise: the LIST view draws rows');
	h.check(!listRow.glyphs, 'no ▶ ⤵ ⧉ ✕ is left anywhere in a list row');
	h.check(
		listRow.load?.svg === 1 && listRow.imports?.svg === 1 && listRow.del?.svg === 1,
		`every action button carries a real icon instead (${JSON.stringify([listRow.load?.svg, listRow.imports?.svg, listRow.del?.svg])})`
	);
	// icons inherit `currentColor` — the app's rule, and the one thing a hardcoded fill
	// would break silently (it would still LOOK like an icon in a screenshot)
	h.check(
		!!listRow.load?.stroke && listRow.load.stroke === listRow.load.color,
		`…drawn in the button's own colour, never a hardcoded one (${listRow.load?.stroke} vs ${listRow.load?.color})`
	);

	await page.locator('#session-view-grid').click();
	await page.waitForTimeout(500);
	const cardRow = await readRow('.session-card');
	h.check(!!cardRow, 'premise: the GRID view draws cards');
	h.check(!cardRow.glyphs, 'and no glyph is left in a grid card either');
	h.check(
		cardRow.load?.svg === 1 && cardRow.imports?.svg === 1 && cardRow.del?.svg === 1,
		`the same three buttons carry the same three icons there (${JSON.stringify([cardRow.load?.svg, cardRow.imports?.svg, cardRow.del?.svg])})`
	);

	// the WORDS are untouched by the icon change — this is what the round-11 checks read
	h.check(
		/Import (files|objects)/.test(cardRow.imports?.text ?? ''),
		`the import button still says what it does (${cardRow.imports?.text})`
	);

	// a PROJECT card is the only one offered a Mount, and it wears the mount icon
	const mount = await page.evaluate(() => {
		const card = [...document.querySelectorAll('.session-card')].find((c) => /Project/.test(c.textContent || ''));
		const other = [...document.querySelectorAll('.session-card')].find((c) => !/Project/.test(c.textContent || ''));
		const btn = card?.querySelector('.session-mount');
		return {
			project: btn ? { text: (btn.textContent || '').trim(), svg: btn.querySelectorAll('svg').length } : null,
			scene: other ? other.querySelectorAll('.session-mount').length : -1
		};
	});
	h.check(
		mount.project?.svg === 1 && /^Mount$/.test(mount.project?.text ?? ''),
		`Mount lost its ⧉ and kept its word (${JSON.stringify(mount.project)})`
	);
	h.check(mount.scene === 0, 'a SCENE entry is still offered no Mount at all');

	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(300);

	await h.finish(browser);
});
