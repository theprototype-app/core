// Phase 149: custom theme export/import. Export captures the active theme's
// full token set; importing a .theme.json registers a selectable theme that
// applies (its tokens land on :root) and survives reload; junk files are
// rejected. The file download + Browse dialog are manual; the data path is here.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- export content: the active theme's token set (green has the full set) ---
	const exported = await A.page.evaluate(() => {
		const T = window.__stores.themes;
		T.theme.set('green');
		const tokens = T.activeThemeTokens();
		T.theme.set('dark');
		return tokens;
	});
	h.check(
		!!exported['--surface'] && !!exported['--scrollbar-thumb'] && !!exported['--dropdown-bg'],
		'export captures the semantic + scrollbar + dropdown tokens'
	);

	// --- import a fixture: registers, activates, tokens land on :root ---
	const imported = await A.page.evaluate(() => {
		const T = window.__stores.themes;
		const fixture = {
			name: 'Neon Test',
			tokens: {
				'--surface': 'rgb(1, 2, 3)',
				'--text': 'rgb(9, 8, 7)',
				'--scrollbar-thumb': 'rgb(4, 5, 6)',
				'--dropdown-bg': 'rgb(1, 2, 3)',
				'--bogus-ignored': 'rgb(0, 0, 0)'
			}
		};
		const id = T.registerCustomTheme(fixture);
		const cs = getComputedStyle(document.documentElement);
		let list;
		T.customThemes.subscribe((v) => (list = v))();
		let active;
		T.theme.subscribe((v) => (active = v))();
		return {
			id,
			active,
			selectable: list.some((t) => t.id === id && t.name === 'Neon Test'),
			surface: cs.getPropertyValue('--surface').trim(),
			thumb: cs.getPropertyValue('--scrollbar-thumb').trim()
		};
	});
	h.check(!!imported.id && imported.active === imported.id, 'importing registers + activates the theme');
	h.check(imported.selectable, 'the imported theme is a selectable entry');
	h.check(
		imported.surface === 'rgb(1, 2, 3)' && imported.thumb === 'rgb(4, 5, 6)',
		`its tokens land on :root (${imported.surface})`
	);

	// --- survives reload ---
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores && !!window.__stores.themes, { timeout: 30000 });
	await A.page.waitForTimeout(600);
	const afterReload = await A.page.evaluate(() => {
		let active;
		window.__stores.themes.theme.subscribe((v) => (active = v))();
		return { active, surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() };
	});
	h.check(
		afterReload.active === imported.id && afterReload.surface === 'rgb(1, 2, 3)',
		'the imported theme survives reload'
	);

	// --- junk files are rejected (drives the Settings toast) ---
	const rejected = await A.page.evaluate(async () => {
		const T = window.__stores.themes;
		const bad = await T.importThemeFile(new File(['not json {'], 'bad.theme.json', { type: 'application/json' }));
		const noTokens = T.registerCustomTheme({ name: 'x', tokens: { '--bogus': '#fff' } });
		const noName = T.registerCustomTheme({ tokens: { '--surface': '#fff' } });
		return { bad, noTokens, noName };
	});
	h.check(
		rejected.bad === null && rejected.noTokens === null && rejected.noName === null,
		'invalid / junk theme files are rejected (null -> toast)'
	);

	// --- remove: a removed custom theme falls back to Dark ---
	const removed = await A.page.evaluate(() => {
		const T = window.__stores.themes;
		let list;
		T.customThemes.subscribe((v) => (list = v))();
		list.forEach((t) => T.removeCustomTheme(t.id));
		let active;
		T.theme.subscribe((v) => (active = v))();
		let after;
		T.customThemes.subscribe((v) => (after = v))();
		return { active, count: after.length };
	});
	h.check(removed.active === 'dark' && removed.count === 0, 'removing the active custom theme falls back to Dark');

	await h.finish(browser);
});
