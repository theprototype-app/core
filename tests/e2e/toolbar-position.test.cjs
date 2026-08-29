// W8a: THE CONTROLS BAR MOVES. Its horizontal position is the user's call — drag it
// anywhere along the bottom edge, or arm "Move toolbar" from any of its right-click
// menus and place it with a click.
//
// Three things this suite is really about, because each is somewhere the design could
// be got wrong and still look right:
//
//   · THE DISCRIMINATION. One press does two jobs: a press that TRAVELS moves the bar,
//     a press that does not presses the button under it. It is movement-based and never
//     time-based, so a finger held still stays the browser's long press (which is what
//     raises the `contextmenu` every toolbar menu lives on). Both halves are asserted
//     on the SAME cell, in both orders.
//   · THE CLAMP IS MEASURED. The bar may not slide under the corner HUD clusters, whose
//     positions differ by breakpoint and three of which are conditional — so the rule is
//     read off the live DOM, not coded against a breakpoint. Proven by HIDING a
//     neighbour and watching the reachable extent move, and by the converse: switching
//     ON a neighbour that sits in a DIFFERENT ROW changes nothing, because only a
//     vertical-band overlap can clamp.
//   · THE POSITION IS A FRACTION, not a pixel offset, so it survives a reload and could
//     survive a narrower screen. Read back through a real reload.
//
// Everything is driven the way a user drives it: real mouse presses on real cells, real
// right-clicks, real `[role=menuitem]` rows (ContextMenu's rows are DIVs, so a `button`
// selector returns [] — the documented trap).
const h = require('./helpers.cjs');

const NEIGHBOURS = ['#ai-hud-button', '#mobile-add-button', '#chat-button', '#mic-button', '#sim-controls'];

/** the bar's own box plus every corner-HUD neighbour's, in one read */
const geom = (page) =>
	page.evaluate((sels) => {
		const nav = document.getElementById('controls-pill');
		const r = nav?.getBoundingClientRect();
		/** @type {any} */
		const nb = {};
		for (const sel of sels) {
			const el = document.querySelector(sel);
			if (!el) continue;
			const b = el.getBoundingClientRect();
			nb[sel] = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
		}
		return {
			left: r?.left ?? 0,
			right: r?.right ?? 0,
			top: r?.top ?? 0,
			bottom: r?.bottom ?? 0,
			width: r?.width ?? 0,
			centre: r ? r.left + r.width / 2 : 0,
			vw: window.innerWidth,
			nb
		};
	}, NEIGHBOURS);

/** which VISIBLE neighbours sharing the bar's row it currently overlaps — the list that
 *  must always be empty. A neighbour in another row is not an overlap: that is the whole
 *  point of the <=600px lift, which moves the chat/AI cluster off this row entirely. */
function overlapped(g) {
	const hits = [];
	for (const [sel, b] of Object.entries(g.nb)) {
		if (!b.w || !b.h) continue; // in the DOM but not rendered
		if (b.bottom <= g.top || b.top >= g.bottom) continue; // a different row
		if (b.right > g.left && b.left < g.right) hits.push(sel);
	}
	return hits;
}

const posX = (page) =>
	page.evaluate(() => {
		const raw = localStorage.getItem('controlsLayout');
		return raw ? (JSON.parse(raw).posX ?? null) : null;
	});

/** Press in the middle of a cell, travel to an ABSOLUTE client x, release.
 *
 *  Absolute rather than a delta, and every target kept INSIDE the viewport, because a
 *  pointermove dispatched past the window edge is never delivered to the page — so a
 *  "+4000, drag it hard right" gesture moves NOTHING and reads exactly like a working
 *  clamp. Measured: the same press aimed at `vw - 5` walks the bar to its real stop.
 *  `steps` matters too: the gesture only starts once a move has crossed the 6px slop. */
async function dragCellTo(page, title, toX) {
	const box = await page.locator(`#controls-pill p[title="${title}"]`).boundingBox();
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const vw = await page.evaluate(() => window.innerWidth);
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(Math.max(2, Math.min(toX, vw - 2)), y, { steps: 14 });
	await page.mouse.up();
	await page.waitForTimeout(250);
	return { x, y };
}

/** the same, expressed as the travel the caller wants */
async function dragCell(page, title, dx) {
	const box = await page.locator(`#controls-pill p[title="${title}"]`).boundingBox();
	return dragCellTo(page, title, box.x + box.width / 2 + dx);
}

/** what `document.elementFromPoint` says is under a point — the premise check that
 *  stops a synthesized press being asserted against the wrong element */
const atPoint = (page, x, y) =>
	page.evaluate(
		([px, py]) => {
			const el = document.elementFromPoint(px, py);
			return el ? (el.getAttribute('title') ?? el.id ?? el.tagName) : null;
		},
		[Math.round(x), Math.round(y)]
	);

/** is the object list closed? `classList.contains`, NEVER `className.includes`: the
 *  panel also carries `overflow-hidden`, so the substring test is ALWAYS true and every
 *  check built on it passes vacuously — which three of them did, until this was fixed. */
const listHidden = (page) =>
	page.evaluate(() => !!document.getElementById('object-list')?.classList.contains('hidden'));

async function cellMenu(page, title) {
	await page.locator(`#controls-pill p[title="${title}"]`).click({ button: 'right' });
	await page.waitForTimeout(350);
}

async function pick(page, name) {
	await page.getByRole('menuitem', { name, exact: true }).click();
	await page.waitForTimeout(350);
}

const rows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((el) => ({
			label: el.textContent.trim(),
			disabled: el.className.includes('cursor-default')
		}))
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- premise: centred, and nothing stored ------------------------------------
	let g = await geom(A.page);
	h.check(g.width > 0, `premise: the bar is measurable (${Math.round(g.width)}px wide)`);
	h.check(
		Math.abs(g.centre - g.vw / 2) <= 2,
		`premise: an untouched bar is centred (${Math.round(g.centre)} vs ${g.vw / 2})`
	);
	h.check((await posX(A.page)) === null, 'premise: and stores no position');
	h.check(
		overlapped(g).length === 0,
		`premise: centred, it overlaps no corner button (${JSON.stringify(g.nb['#chat-button'] ? 'chat measured' : 'no chat')})`
	);
	// the two neighbours that DO share the bar's row at this width — named here so the
	// clamp checks below are asserting against something that exists
	const sharesRow = Object.entries(g.nb).filter(([, b]) => b.w && b.h && b.bottom > g.top && b.top < g.bottom);
	h.check(
		sharesRow.length >= 2,
		`premise: ${sharesRow.length} corner buttons share the bar's row (${sharesRow.map(([s]) => s).join(', ')})`
	);

	// ---- the discrimination, part 1: a TRAVELLING press moves the bar -------------
	const beforeList = await listHidden(A.page);
	h.check(beforeList === true, 'premise: the object list starts closed');
	const grab = await dragCell(A.page, 'Object list (O)', 180);
	h.check(
		(await atPoint(A.page, grab.x, grab.y)) !== null,
		'premise: the grab point resolved to a real element'
	);
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - (g.vw / 2 + 180)) <= 6,
		`a drag from a button moves the bar by the travel (${Math.round(g.centre - g.vw / 2)}px of 180)`
	);
	h.check(
		(await listHidden(A.page)) === true,
		'...and does NOT press the button it started on (the object list stayed closed)'
	);
	h.check((await posX(A.page)) !== null, 'the move is persisted as a fraction');
	const movedFrac = await posX(A.page);
	h.check(movedFrac > 0.5 && movedFrac <= 1, `...and that fraction is right of centre (${movedFrac.toFixed(3)})`);

	// ---- the discrimination, part 2: a STILL press is still a click ---------------
	await A.page.locator('#controls-pill p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	h.check((await listHidden(A.page)) === false, 'a plain click on that same button still opens its panel');
	await A.page.locator('#controls-pill p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	h.check((await listHidden(A.page)) === true, '...and closes it again');
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - (g.vw / 2 + 180)) <= 6,
		'...while leaving the bar exactly where the drag put it'
	);

	// ---- the clamp: hard against each edge ---------------------------------------
	await dragCellTo(A.page, 'Object list (O)', g.vw);
	g = await geom(A.page);
	const hardRight = g.right;
	h.check(
		overlapped(g).length === 0,
		`dragged hard right, the bar overlaps no corner button (right edge ${Math.round(g.right)})`
	);
	h.check(g.right <= g.vw - 8 + 1, `...and stays inside the viewport (${Math.round(g.vw - g.right)}px clear)`);
	h.check(
		g.nb['#chat-button'] && g.right <= g.nb['#chat-button'].left,
		`...stopping short of the chat button (${Math.round(g.right)} <= ${Math.round(g.nb['#chat-button'].left)})`
	);

	await dragCellTo(A.page, 'Object list (O)', 0);
	g = await geom(A.page);
	h.check(overlapped(g).length === 0, `dragged hard left, the bar overlaps no corner button (left edge ${Math.round(g.left)})`);
	h.check(g.left >= 8 - 1, `...and stays inside the viewport (${Math.round(g.left)}px clear)`);
	h.check(
		g.nb['#ai-hud-button'] && g.left >= g.nb['#ai-hud-button'].right,
		`...stopping short of the AI button (${Math.round(g.left)} >= ${Math.round(g.nb['#ai-hud-button'].right)})`
	);

	// ---- the clamp is MEASURED, not coded ----------------------------------------
	// (a) a neighbour that shares the bar's row and DISAPPEARS gives the bar more room,
	// and the bar takes it IMMEDIATELY — the stored fraction re-maps onto the wider
	// track with no gesture at all, which is the strongest form this can be asserted
	// in. `display: none` is exactly how an absent neighbour reads to
	// `getBoundingClientRect` (a zero box), and the ResizeObserver over the found set
	// is what notices.
	await dragCellTo(A.page, 'Object list (O)', g.vw);
	let g2 = await geom(A.page);
	h.check(Math.abs(g2.right - hardRight) <= 2, `premise: parked hard right again (${Math.round(g2.right)})`);
	await A.page.evaluate(() => {
		const el = document.getElementById('chat-button');
		if (el) el.style.display = 'none';
	});
	await A.page.waitForTimeout(400);
	g2 = await geom(A.page);
	h.check(
		g2.right > hardRight + 20,
		`hiding the chat button widens the track on the spot (${Math.round(g2.right)} > ${Math.round(hardRight)})`
	);
	h.check(
		g2.right <= g2.vw - 8 + 1,
		`...as far as the viewport margin and no further (${Math.round(g2.vw - g2.right)}px clear)`
	);
	await dragCellTo(A.page, 'Object list (O)', g2.vw);
	g2 = await geom(A.page);
	h.check(
		g2.right > hardRight + 20 && overlapped(g2).length === 0,
		`...and a drag can reach that new extent (${Math.round(g2.right)})`
	);
	await A.page.evaluate(() => {
		const el = document.getElementById('chat-button');
		if (el) el.style.display = '';
	});
	await A.page.waitForTimeout(400);
	g2 = await geom(A.page);
	h.check(
		Math.abs(g2.right - hardRight) <= 2,
		`bringing it back pushes the bar off it again (${Math.round(g2.right)} vs ${Math.round(hardRight)})`
	);
	h.check(overlapped(g2).length === 0, '...so a returning neighbour can never end up underneath the bar');

	// (b) THE CONVERSE, which is what makes it a rule rather than a list: switching on
	// a neighbour that sits in a DIFFERENT ROW must change nothing. `#sim-controls` is
	// at bottom:112px — well above this bar — so it can never be in its way, and a
	// clamp that simply collected every corner button would wrongly shrink the track.
	await A.page.evaluate(() => window.__stores.showSimControls.set(true));
	await A.page.waitForTimeout(500);
	const simGeom = await geom(A.page);
	h.check(
		!!simGeom.nb['#sim-controls'] && simGeom.nb['#sim-controls'].h > 0,
		'premise: the sim transport is on screen now'
	);
	h.check(
		simGeom.nb['#sim-controls'].bottom <= simGeom.top,
		`premise: and it sits in a row ABOVE the bar (${Math.round(simGeom.nb['#sim-controls'].bottom)} <= ${Math.round(simGeom.top)})`
	);
	await dragCellTo(A.page, 'Object list (O)', simGeom.vw);
	g2 = await geom(A.page);
	h.check(
		Math.abs(g2.right - hardRight) <= 2,
		`a neighbour in another row does NOT clamp the bar (${Math.round(g2.right)} vs ${Math.round(hardRight)})`
	);
	await A.page.evaluate(() => window.__stores.showSimControls.set(false));
	await A.page.waitForTimeout(300);

	// ---- snap to the middle -------------------------------------------------------
	// park it right, then drag back to within the magnet's reach but NOT onto the centre
	await dragCellTo(A.page, 'Object list (O)', (await geom(A.page)).vw);
	g = await geom(A.page);
	{
		const box = await A.page.locator('#controls-pill p[title="Object list (O)"]').boundingBox();
		const grabX = box.x + box.width / 2;
		await dragCellTo(A.page, 'Object list (O)', grabX + (g.vw / 2 + 12 - g.centre));
	}
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - g.vw / 2) <= 1,
		`released 12px off the middle, the bar snaps to it (${Math.round(g.centre)} vs ${g.vw / 2})`
	);
	h.check(
		(await posX(A.page)) === null,
		'...and stores the DEFAULT rather than a fraction that happens to land there'
	);

	// ---- persistence across a real reload -----------------------------------------
	await dragCell(A.page, 'Object list (O)', 150);
	const before = (await geom(A.page)).centre;
	h.check(
		Math.abs(before - ((await geom(A.page)).vw / 2 + 150)) <= 6,
		`premise: moved 150px right of centre (${Math.round(before)})`
	);
	await h.freshReload(A);
	await A.page.waitForSelector('#controls-pill', { timeout: 15000 });
	await A.page.waitForTimeout(600);
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - before) <= 3,
		`the position survives a reload (${Math.round(g.centre)} vs ${Math.round(before)})`
	);
	h.check(overlapped(g).length === 0, '...and is still clear of every corner button');

	// ---- the play FAB never starts a move ----------------------------------------
	// a 50px circle is the way into play mode and what a thumb aims at, so it is the one
	// cell excluded from the gesture: a drag from it must leave the bar exactly put
	const fabBefore = (await geom(A.page)).centre;
	const fab = await A.page.locator('#play-button').boundingBox();
	h.check(
		fab && fab.width > 40 && fab.width < 60,
		`premise: the play FAB is a ${Math.round(fab?.width ?? 0)}px circle riding in the moved bar`
	);
	await A.page.mouse.move(fab.x + fab.width / 2, fab.y + fab.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(fab.x + fab.width / 2 + 120, fab.y + fab.height / 2, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	h.check(
		Math.abs((await geom(A.page)).centre - fabBefore) <= 1,
		'a drag from the play FAB does not move the bar'
	);
	// and the FAB's round hit area still answers for itself after the move (its
	// clip-path is a circle on a 50px box that rides inside the bar)
	// `closest`, not `el.id`: the glyph inside the FAB is an <svg>/<path> of its own, so
	// elementFromPoint legitimately answers with a child — the question is which control
	// OWNS the pixel, and the circle's clip-path is what decides it
	const fabHit = await A.page.evaluate(() => {
		const r = document.getElementById('play-button')?.getBoundingClientRect();
		if (!r) return null;
		const owner = (x, y) => {
			const el = document.elementFromPoint(Math.round(x), Math.round(y));
			return el?.closest('#play-button') ? 'fab' : (el?.closest('#controls-pill') ? 'bar' : 'other');
		};
		return {
			mid: owner(r.left + r.width / 2, r.top + r.height / 2),
			corner: owner(r.left + 2, r.bottom - 2)
		};
	});
	h.check(fabHit?.mid === 'fab', `the moved FAB still owns its own centre (${fabHit?.mid})`);
	h.check(
		fabHit?.corner !== 'fab',
		`...and its square corner still belongs to the bar, not the circle (${fabHit?.corner}) — the clip-path travels with it`
	);

	// ---- "Reset toolbar position" -------------------------------------------------
	await cellMenu(A.page, 'Explorer');
	let menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Move toolbar'),
		'every toolbar menu offers Move toolbar'
	);
	h.check(
		menu.some((r) => r.label === 'Reset toolbar position' && !r.disabled),
		'...and Reset toolbar position, enabled while the bar has been moved'
	);
	await pick(A.page, 'Reset toolbar position');
	g = await geom(A.page);
	h.check(Math.abs(g.centre - g.vw / 2) <= 2, `Reset toolbar position re-centres the bar (${Math.round(g.centre)})`);
	h.check((await posX(A.page)) === null, '...and clears the stored position');
	await cellMenu(A.page, 'Explorer');
	menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Reset toolbar position' && r.disabled),
		'...so the row disables itself: there is nothing left to reset'
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// ---- the armed move: follows the pointer, Escape puts it back -----------------
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Move toolbar');
	const armedFrom = (await geom(A.page)).centre;
	// NO button held — this is the modal half of the gesture
	const menuAt = await A.page.locator('#controls-pill p[title="Explorer"]').boundingBox();
	await A.page.mouse.move(menuAt.x + 200, menuAt.y + menuAt.height / 2, { steps: 8 });
	await A.page.waitForTimeout(200);
	g = await geom(A.page);
	h.check(
		g.centre > armedFrom + 50,
		`armed, the bar follows the pointer with no button held (${Math.round(g.centre)} > ${Math.round(armedFrom)})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - armedFrom) <= 1,
		`Escape puts it back exactly (${Math.round(g.centre)} vs ${Math.round(armedFrom)})`
	);
	h.check((await posX(A.page)) === null, '...and a cancelled move writes nothing');

	// ---- the armed move: a click commits, and the arrows nudge -------------------
	// The commit lands ON A TOOLBAR CELL, which is not an edge case but the normal one:
	// the bar is under the pointer by design. Neither `preventDefault` nor
	// `stopPropagation` on the committing pointerdown stops the `click` that follows it,
	// so without a swallowed click this press ALSO toggled that cell's panel — and with
	// the Node editor cell under it, the opening dock lifted the bar and widened the
	// track, so the position committed 21px from where it was placed. That is what the
	// three checks below measure together.
	await cellMenu(A.page, 'Explorer');
	await pick(A.page, 'Move toolbar');
	await A.page.mouse.move(menuAt.x + 160, menuAt.y + menuAt.height / 2, { steps: 8 });
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('ArrowRight');
	await A.page.keyboard.press('ArrowRight');
	await A.page.keyboard.down('Shift');
	await A.page.keyboard.press('ArrowRight');
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(250);
	const nudged = (await geom(A.page)).centre;
	h.check(
		nudged > armedFrom + 100,
		`the arrows nudge the armed bar (+12px on top of the pointer's travel, at ${Math.round(nudged)})`
	);
	// what is actually under the commit point, so the check below names a real target
	const underCommit = await atPoint(A.page, menuAt.x + 160, menuAt.y + menuAt.height / 2);
	h.check(
		typeof underCommit === 'string',
		`premise: the commit press lands on the bar itself (${underCommit})`
	);
	const insetBefore = await A.page.evaluate(() =>
		parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
	);
	await A.page.mouse.down();
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	g = await geom(A.page);
	h.check(
		Math.abs(g.centre - nudged) <= 1,
		`a click commits the armed move exactly where the arrows left it (${Math.round(g.centre)} vs ${Math.round(nudged)})`
	);
	h.check((await posX(A.page)) !== null, '...and the committed position is stored');
	const insetAfter = await A.page.evaluate(() =>
		parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
	);
	h.check(
		insetAfter === insetBefore && (await listHidden(A.page)) === true,
		`...and the committing click presses NO button under it (dock inset ${insetBefore} -> ${insetAfter})`
	);

	// the computed track agrees with the rendered rects — the debug seam beside the
	// geometry, so a clamp that were secretly hardcoded could not agree with both
	const dbg = await A.page.evaluate(() => window.__toolbarTrack ?? null);
	g = await geom(A.page);
	h.check(
		dbg && Math.abs(dbg.centre - g.centre) <= 1,
		`the bar's computed centre matches its rendered one (${Math.round(dbg?.centre ?? -1)} vs ${Math.round(g.centre)})`
	);
	h.check(
		dbg && dbg.min >= 8 && dbg.max <= g.vw - 8 && dbg.max > dbg.min,
		`...and its track sits inside the viewport margins (${Math.round(dbg?.min ?? 0)}..${Math.round(dbg?.max ?? 0)})`
	);

	// ---- no room to move: the bar centres and the gesture stands down -------------
	// 280px is narrower than the bar plus its margins, so there is no position to
	// choose. The honest answer is a centred bar and a disabled row, not a drag that
	// cannot go anywhere.
	await A.page.setViewportSize({ width: 280, height: 700 });
	await A.page.waitForTimeout(600);
	g = await geom(A.page);
	h.check(
		g.width + 16 > g.vw,
		`premise: at 280px the bar (${Math.round(g.width)}px) no longer fits the track`
	);
	h.check(
		Math.abs(g.centre - g.vw / 2) <= 2,
		`...so it falls back to centred (${Math.round(g.centre)} vs ${g.vw / 2})`
	);
	await cellMenu(A.page, 'Explorer');
	menu = await rows(A.page);
	h.check(
		menu.some((r) => r.label === 'Move toolbar' && r.disabled),
		'...and Move toolbar is offered but disabled, with the reason in its tooltip'
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	const narrowCentre = (await geom(A.page)).centre;
	await dragCell(A.page, 'Explorer', 90);
	h.check(
		Math.abs((await geom(A.page)).centre - narrowCentre) <= 1,
		'...and a drag there moves nothing'
	);
	await A.page.setViewportSize({ width: 1280, height: 720 });
	await A.page.waitForTimeout(500);

	// ---- MINIMIZING THE DOCK CHANGES THE BAR'S ROW, so it must re-measure -----------
	// The bar's `bottom` is `calc(var(--bottom-inset) + 16px)` while it floats, so an
	// open dock lifts it into a band of its OWN — no corner button shares that row, and
	// the track is therefore the full width. Minimizing drops `--bottom-inset` to 0 and
	// the bar back onto the chat/AI row, whose neighbours DO clamp it. Nothing about the
	// bar itself changed, so neither the ResizeObserver nor the roster notices: without
	// the `bottomInset` dependency in the measuring effect the bar keeps the wide track's
	// position and sits ON the chat button until some unrelated change re-measures.
	// MEASURED with that dependency removed: right edge 1272 against a chat button at
	// 1220 — 52px of overlap.
	//
	// LAST in the file on purpose: it opens a dock and parks the bar at an extreme, so it
	// would move the ground under any section following it.
	await dragCellTo(A.page, 'Object list (O)', 640);
	// Toggled to the state we need rather than clicked once and assumed: the 280px
	// section above ends on a press that could not move the bar, which is BY DESIGN an
	// ordinary click on the Explorer cell — so the panel may already be open, and a
	// single click here would close it.
	const inset = () =>
		A.page.evaluate(() =>
			parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
		);
	for (let i = 0; i < 3 && (await inset()) < 100; i++) {
		await A.page.locator('#controls-pill p[title="Explorer"]').click();
		await A.page.waitForTimeout(800);
	}
	let gd = await geom(A.page);
	const dockInset = await inset();
	h.check(dockInset > 100, `premise: opening the Explorer dock reserves ${dockInset}px of --bottom-inset`);
	h.check(
		overlapped(gd).length === 0 && gd.nb['#chat-button'] && gd.bottom <= gd.nb['#chat-button'].top,
		`premise: the lifted bar sits ABOVE the corner row (bar bottom ${Math.round(gd.bottom)} <= chat top ${Math.round(gd.nb['#chat-button']?.top ?? 0)})`
	);
	await dragCellTo(A.page, 'Object list (O)', gd.vw);
	gd = await geom(A.page);
	const liftedRight = gd.right;
	h.check(
		liftedRight > (gd.nb['#chat-button']?.left ?? Infinity),
		`premise: with the dock open it reaches PAST where the chat button sits (${Math.round(liftedRight)} > ${Math.round(gd.nb['#chat-button']?.left ?? 0)}) — a position the corner row would not allow`
	);
	await A.page.click('#dock-minimize');
	await A.page.waitForTimeout(900);
	gd = await geom(A.page);
	h.check((await inset()) === 0, 'minimizing the dock drops --bottom-inset to 0');
	h.check(
		gd.nb['#chat-button'] && gd.bottom > gd.nb['#chat-button'].top,
		`...which puts the bar back on the corner row (bar ${Math.round(gd.top)}..${Math.round(gd.bottom)} vs chat ${Math.round(gd.nb['#chat-button']?.top ?? 0)}..${Math.round(gd.nb['#chat-button']?.bottom ?? 0)})`
	);
	h.check(
		overlapped(gd).length === 0,
		`...and it re-measures on the spot, so it overlaps no corner button (${Math.round(liftedRight)} -> ${Math.round(gd.right)}, chat at ${Math.round(gd.nb['#chat-button']?.left ?? 0)})`
	);
	h.check(
		gd.right <= (gd.nb['#chat-button']?.left ?? 0) && gd.right < liftedRight,
		`...having given back exactly the ${Math.round(liftedRight - gd.right)}px the narrower row costs`
	);
	// the stored fraction is untouched: `posX` is a fraction OF THE LIVE TRACK, so the
	// re-map is the whole re-clamp — nothing has to rewrite what was saved
	const dockFrac = await posX(A.page);
	const dockTrack = await A.page.evaluate(() => window.__toolbarTrack ?? null);
	h.check(
		dockFrac != null && dockFrac > 0.99,
		`the stored fraction is left alone (${dockFrac?.toFixed(3)}) — it is a fraction, legal on either track`
	);
	h.check(
		dockTrack && Math.abs(dockTrack.min + dockFrac * (dockTrack.max - dockTrack.min) - gd.centre) <= 1,
		`...and the bar is that fraction of the NARROWER track (${Math.round(dockTrack?.min ?? 0)}..${Math.round(dockTrack?.max ?? 0)} -> ${Math.round(gd.centre)})`
	);

	await h.finish(browser);
});
