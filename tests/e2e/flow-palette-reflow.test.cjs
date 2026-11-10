// Phase 179: the Flow settings toggle is a gear (not an arrow) and auto-reflows
// to the side opposite the palette, so moving the palette can never hide it.
const h = require('./helpers.cjs');

const sep = (a, b) => a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the node editor
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(700);

	const box = (sel) => A.page.locator(sel).boundingBox();

	// default: palette left -> props toggle on the right, gear icon
	const pt = await box('#palette-toggle');
	const ft = await box('#flow-props-toggle');
	h.check(!!pt && !!ft, 'palette + props toggles render');
	h.check(ft.x > pt.x, 'by default the props toggle sits to the right of the palette toggle');
	h.check(sep(pt, ft), 'the toggles do not overlap (default layout)');
	// showhide-v8 + 78-int PL42: a PaneHandle — the chevron plus the panel's role icon (Lucide, never the emoji)
	const icons = await A.page.locator('#flow-props-toggle svg').count();
	const text = await A.page.locator('#flow-props-toggle').innerText();
	h.check(icons === 2 && !text.includes('⚙'), `the properties handle shows the chevron and its role icon (${icons} svg)`);

	// showhide-v8 (owner 2026-11-09, "Flow: remove the swap button"): the palette moves sides from its arrow
	// handle's menu ("Move the palette to the other side"), the dock-inset pattern
	const paletteSwap = async () => {
		await A.page.locator('#palette-toggle').click({ button: 'right' });
		await A.page.locator('[role=menu] [role=menuitem]', { hasText: 'Move the palette to the other side' }).first().click();
	};
	// move the palette to the right -> props toggle reflows to the LEFT
	await paletteSwap();
	await A.page.waitForTimeout(400);
	const pt2 = await box('#palette-toggle');
	const ft2 = await box('#flow-props-toggle');
	h.check(ft2.x < pt2.x, 'after moving the palette right, the props toggle reflows to the left');
	h.check(sep(pt2, ft2), 'the toggles still do not overlap after the reflow');

	// move back -> props toggle returns to the right
	await paletteSwap();
	await A.page.waitForTimeout(400);
	const ft3 = await box('#flow-props-toggle');
	const pt3 = await box('#palette-toggle');
	h.check(ft3.x > pt3.x, 'moving the palette back returns the props toggle to the right');

	await h.finish(browser);
});
