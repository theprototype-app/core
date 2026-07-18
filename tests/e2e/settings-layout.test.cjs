// Phase 131: settings layout — wider modal + a borderless multi-column
// shortcuts grid (group headers span all columns).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(400);

	// expand the Shortcuts accordion
	await A.page.getByText('Shortcuts', { exact: true }).click();
	await A.page.waitForTimeout(300);

	const grid = await A.page.evaluate(() => {
		const el = document.querySelector('#shortcut-grid');
		if (!el) return { present: false };
		const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
		// a group header should span the whole row
		const header = el.querySelector('p');
		const span = header ? getComputedStyle(header).gridColumn : '';
		return { present: true, cols, spans: span.includes('1 / -1') || span.includes('span') };
	});
	h.check(grid.present, 'the shortcuts render in a grid container');
	h.check(grid.cols >= 2, `the grid has multiple columns at desktop width (${grid.cols})`);
	h.check(grid.spans, 'group headers span all columns');

	// the modal is wider than a default (sm) modal — check its max-width class /
	// rendered width is a large fraction of the viewport
	const wide = await A.page.evaluate(() => {
		const modal = document.querySelector('.modal-content')?.closest('[role="dialog"], .fixed');
		const box = document.querySelector('.modal-content')?.getBoundingClientRect();
		return box ? box.width : 0;
	});
	h.check(wide > 640, `the settings modal is wide (${Math.round(wide)}px)`);

	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await h.finish(browser);
});
