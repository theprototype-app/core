// 48 F1 — THE BUDGET CHIP IS A CLUSTER. The user (roadmap 48): the budget chip "should be also possible to adjust using
// Edit Positions, also fix bug when I click its chevron it hides until context menu closed", "also allow to hide/unhide
// for this pill"; "keep pill as it is for today" (no compact-when-green, no hide toast; default ON).
//
// What is asserted, with a REAL mouse on desktop 1440×900:
//  1. the chevron menu no longer hides the chip: open, it stays drawn through two of the 1 s re-checks
//  2. Customize toolbar… lists "Budget chip" (checked); unticking hides it, ticking shows it — the record says so
//  3. Edit positions: an outline over the chip with a red "−", a grip, and the chip's own cluster menu (no Rotate,
//     no Pin); "−" leaves it faint with a "+", "+" brings it back
//  4. dragging it in Edit positions + ✓ PLACES it: drawn where it was put outside Edit positions, stored as fractions
//     in the record's clusters (so layouts carry it); placed, its chevron menu still leaves it drawn
//  5. Reset position puts it back beside the toolbar (today's measured spot)
//  6. "−" + ✓ hides it outside Edit positions; the Customize switch is the way back
//
// Counterfactual (base v1.38.0): section 1 is red (the chip is bc-hidden while its menu is open), and 2-6 are red
// (no Customize row, no grip / outline, nothing in the record).
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE || null;
const shot = async (page, name) => {
	if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` }).catch(() => {});
};
const chip = (page) =>
	page.evaluate(() => {
		const w = document.getElementById('budget-chip-wrap');
		if (!w) return null;
		const r = w.getBoundingClientRect();
		const p = document.getElementById('controls-pill')?.getBoundingClientRect();
		const cs = getComputedStyle(w);
		const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
		return { visible, opacity: Number(cs.opacity), room: w.dataset.room, rect: { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }, pill: p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null };
	});
const record = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('controlsLayout') ?? 'null'));
const rows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => ({ label: el.textContent.trim(), checked: el.className.includes('ctx-checked'), disabled: el.getAttribute('aria-disabled') === 'true' || el.className.includes('disabled') }))
			.filter((r) => r.label)
	);
const menuOpen = (page) => page.evaluate(() => !!document.querySelector('[role="menu"]'));
async function closeMenus(page) {
	for (let i = 0; i < 3 && (await menuOpen(page)); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(250);
	}
}
async function customize(page) {
	await page.locator('#controls-pill [title="Explorer"]').first().click({ button: 'right' });
	await page.waitForTimeout(350);
	await page.getByRole('menuitem', { name: 'Customize toolbar…', exact: true }).click();
	await page.waitForTimeout(400);
}
async function enterEdit(page) {
	await page.locator('#controls-pill [title="Explorer"]').first().click({ button: 'right' });
	await page.waitForTimeout(350);
	await page.getByRole('menuitem', { name: 'Edit positions', exact: true }).click();
	await page.waitForTimeout(900);
}
async function apply(page) {
	await page.locator('#toolbar-edit-apply').click();
	await page.waitForTimeout(800);
}
/** beside the bar, centred on it: today's measured spot */
const besideBar = (c) => !!c?.pill && Math.abs(c.rect.cy - (c.pill.y + c.pill.h / 2)) < 3 && c.rect.x >= c.pill.x + c.pill.w && c.rect.x - (c.pill.x + c.pill.w) < 16;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toastsInDrawerOnly: 'true', toursSeen: '{"editor":true,"editor-touch":true}' } });
	const P = A.page;
	await P.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
	await h.eventually(() => chip(P), (c) => !!c && c.visible && c.room !== 'measuring', 'premise: the budget chip is drawn beside the toolbar');
	const home = await chip(P);
	h.check(besideBar(home), `premise: unplaced, it sits at today's measured spot beside the bar (${home.room})`);

	// ---------- 1. the chevron menu no longer hides the chip ----------
	await P.locator('#budget-chip-target').click();
	await P.waitForTimeout(300);
	h.check(await menuOpen(P), 'premise: the chevron opened the chip menu');
	const during = [];
	for (let i = 0; i < 5; i++) {
		during.push(await chip(P));
		await P.waitForTimeout(500);
	}
	h.check(during.every((c) => c.visible), `F1: the chip stays drawn while its chevron menu is open, through two 1 s re-checks (${during.map((c) => (c.visible ? 'shown' : 'HIDDEN')).join(',')})`);
	h.check(during.every((c) => Math.abs(c.rect.x - home.rect.x) < 1 && Math.abs(c.rect.y - home.rect.y) < 1), 'F1: …and does not move');
	await shot(P, '01-chevron-menu-open');
	await closeMenus(P);
	await P.waitForTimeout(1300);
	h.check((await chip(P)).visible, 'F1: menu closed, the chip is still there');

	// ---------- 2. Customize toolbar…: the Budget chip switch ----------
	await customize(P);
	let r = await rows(P);
	const row = r.find((x) => x.label === 'Budget chip');
	h.check(!!row && row.checked, `F1: Customize toolbar… lists "Budget chip", checked by default (${r.map((x) => x.label).join(' | ')})`);
	await P.getByRole('menuitem', { name: 'Budget chip', exact: true }).click();
	await P.waitForTimeout(500);
	h.check(!(await chip(P)).visible, 'F1: unticked, the chip is hidden');
	h.check((await record(P))?.clusters?.budget?.hidden === true, 'F1: …and the toolbar record says so (persisted with the other placed items)');
	r = await rows(P);
	h.check(r.find((x) => x.label === 'Budget chip')?.checked === false, 'F1: the row reads unchecked (the menu stays open)');
	await P.getByRole('menuitem', { name: 'Budget chip', exact: true }).click();
	await P.waitForTimeout(600);
	await closeMenus(P);
	await h.eventually(() => chip(P), (c) => c?.visible && besideBar(c), 'F1: ticked again, it is back at its spot beside the bar');
	h.check(!(await record(P))?.clusters?.budget, 'F1: …and the record holds nothing for it (absent = at home, shown)');

	// ---------- 3. Edit positions: outline, "−" / "+", grip, its own menu ----------
	await enterEdit(P);
	h.check((await P.locator('#budget-edit').count()) === 1, 'F1: Edit positions outlines the chip');
	h.check((await P.locator('#cluster-grip-budget').count()) === 1, 'F1: …and gives it a grip like every other cluster');
	const ol = await P.evaluate(() => {
		const o = document.getElementById('budget-edit').getBoundingClientRect();
		const c = document.getElementById('budget-chip-wrap').getBoundingClientRect();
		return Math.abs(o.x - c.x) + Math.abs(o.y - c.y) + Math.abs(o.width - c.width) + Math.abs(o.height - c.height);
	});
	h.check(ol < 2, `F1: the outline sits ON the chip (off by ${ol.toFixed(1)} px)`);
	await shot(P, '02-edit-positions');
	await P.locator('#cluster-grip-budget').click();
	await P.waitForTimeout(350);
	r = await rows(P);
	h.check(r.some((x) => x.label === 'Move') && !r.some((x) => x.label.startsWith('Rotate')) && !r.some((x) => /Pin to top|Float/.test(x.label)) && r.some((x) => x.label === 'Hide cluster'), `F1: its cluster menu — Move, Reset, Hide; no Rotate, no Pin (${r.map((x) => x.label).join(' | ')})`);
	h.check((await chip(P)).visible, 'F1: the chip stays drawn while its cluster menu is open');
	await closeMenus(P);
	await P.locator('#budget-edit-remove').click();
	await P.waitForTimeout(400);
	let c = await chip(P);
	h.check(c.visible && c.opacity < 0.5 && (await P.locator('#budget-edit-add').count()) === 1, `F1: "−" leaves it faint in Edit positions with a "+" (opacity ${c.opacity})`);
	await shot(P, '03-edit-hidden');
	await P.locator('#budget-edit-add').click();
	await P.waitForTimeout(400);
	c = await chip(P);
	h.check(c.visible && c.opacity > 0.9 && (await P.locator('#budget-edit-remove').count()) === 1, 'F1: "+" brings it back');

	// ---------- 4. drag it + ✓ = placed ----------
	const g = await P.locator('#cluster-grip-budget').boundingBox();
	const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
	await P.mouse.move(from.x, from.y);
	await P.mouse.down();
	await P.mouse.move(from.x - 150, from.y - 200, { steps: 6 });
	await P.mouse.move(from.x - 300, from.y - 400, { steps: 6 });
	await P.waitForTimeout(150);
	await P.mouse.up();
	await P.waitForTimeout(500);
	const dropped = await chip(P);
	h.check(Math.abs(dropped.rect.y - home.rect.y) > 300, `F1: dragging its grip carries the chip (y ${Math.round(home.rect.y)} → ${Math.round(dropped.rect.y)})`);
	await apply(P);
	const rec = await record(P);
	const b = rec?.clusters?.budget;
	h.check(typeof b?.x === 'number' && typeof b?.y === 'number' && typeof b?.a === 'string' && !b.hidden, `F1: ✓ stores its place as anchor + fractions in the record (${JSON.stringify(b)})`);
	await P.waitForTimeout(1300);
	const placed = await chip(P);
	h.check(placed.visible && placed.room === 'placed' && Math.abs(placed.rect.x - dropped.rect.x) < 3 && Math.abs(placed.rect.y - dropped.rect.y) < 3, `F1: outside Edit positions it is drawn where it was put (${Math.round(placed.rect.x)},${Math.round(placed.rect.y)}, room ${placed.room})`);
	await shot(P, '04-placed');
	await P.locator('#budget-chip-target').click();
	await P.waitForTimeout(1300);
	const pm = await chip(P);
	h.check(pm.visible && Math.abs(pm.rect.y - placed.rect.y) < 1, 'F1: placed, its chevron menu still leaves it drawn in place');
	await closeMenus(P);
	// a layout reload keeps it (the record is the source)
	await P.evaluate(() => window.__stores.uiLayoutsCore?.runLayoutReloaders());
	await P.waitForTimeout(800);
	const again = await chip(P);
	h.check(Math.abs(again.rect.x - placed.rect.x) < 3 && Math.abs(again.rect.y - placed.rect.y) < 3, 'F1: re-read from the stored record, it comes back to the same spot');

	// ---------- 5. Reset position = today's spot ----------
	await enterEdit(P);
	await P.locator('#cluster-grip-budget').click();
	await P.waitForTimeout(350);
	await P.getByRole('menuitem', { name: 'Reset position', exact: true }).click();
	await P.waitForTimeout(400);
	await apply(P);
	await h.eventually(() => chip(P), (x) => x?.visible && besideBar(x) && x.room !== 'placed', 'F1: Reset position puts it back beside the toolbar (unplaced = the measured spot)');

	// ---------- 6. "−" + ✓ hides it; Customize brings it back ----------
	await enterEdit(P);
	await P.locator('#budget-edit-remove').click();
	await P.waitForTimeout(300);
	await apply(P);
	h.check(!(await chip(P)).visible && (await record(P))?.clusters?.budget?.hidden === true, 'F1: "−" + ✓ hides it outside Edit positions');
	await customize(P);
	await P.getByRole('menuitem', { name: 'Budget chip', exact: true }).click();
	await P.waitForTimeout(500);
	await closeMenus(P);
	await h.eventually(() => chip(P), (x) => x?.visible && besideBar(x), 'F1: the Customize switch shows it again');

	await h.finish(browser);
});
