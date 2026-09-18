// 114 (v1.13): the node editor's MOUSE BINDINGS are adjustable. Classic (the default,
// and the counterfactual for everything below) keeps every shipped version's behaviour:
// a left drag on the pane PANS. Select-first: a left drag draws a selection rectangle,
// dragging the selection moves the whole set, Shift+click toggles membership, the
// middle/right button pans, and a right click that does not travel still opens the pane
// menu — which xyflow 1.6 swallows on its own once the right button pans, so
// Nodes.svelte re-emits it. Everything below is REAL mouse input.
//
// THREE GEOMETRY TRAPS THIS SUITE PAID FOR, all found by printing
// `document.elementFromPoint` rather than by reading handlers:
//  1. the "empty" bottom-right corner of the pane is the MINIMAP (pannable, at its own
//     scale) — a drag there panned 631px for a 80px gesture and a right click opened no
//     menu. Every empty point here is SCANNED for and verified to be the pane itself.
//  2. the editor is DOCKED by default and its pane is ~300px tall, so two cards 160
//     flow-units apart do not both fit; they sit side by side instead.
//  3. a rectangle selection renders xyflow's `.svelte-flow__selection-wrapper` OVER the
//     selected cards — that box is what a user then drags to move the set, and it is
//     also what silently eats a later click aimed at a card underneath it.
const h = require('./helpers.cjs');

const SEED = () => {
	const s = window.__stores;
	s.flowNodes.set([
		{ id: 'mb1', type: 'number', position: { x: 60, y: 20 }, data: { type: 'number', label: 'Number', value: 4, step: 1 }, class: 'w-[150px]' },
		{ id: 'mb2', type: 'number', position: { x: 260, y: 20 }, data: { type: 'number', label: 'Number', value: 7, step: 1 }, class: 'w-[150px]' }
	]);
	s.flowEdges.set([]);
};
const POSITIONS = () => {
	let nodes;
	window.__stores.flowNodes.subscribe((v) => (nodes = v))();
	const out = {};
	for (const n of nodes) out[n.id] = { x: n.position.x, y: n.position.y, selected: !!n.selected };
	return out;
};

/** open the editor with a PINNED viewport, and report the pane + both cards */
const openEditor = async (peer) => {
	await peer.page.evaluate(SEED);
	await peer.page.locator('p[title="Node editor (N)"]').click();
	await peer.page.waitForTimeout(1500);
	const hooked = await peer.page.evaluate(() => !!window.__flowViewport);
	h.check(hooked, 'the pane exposes its viewport (premise)');
	// xyflow's fitView runs at MOUNT against whatever nodes existed then, so screen
	// coordinates are a guess until the viewport is pinned (the node-drag-fields rule)
	await peer.page.evaluate(() => window.__flowViewport.setViewport({ x: 120, y: 30, zoom: 1 }));
	await peer.page.waitForTimeout(500);
	const pane = await peer.page.locator('.svelte-flow__pane').first().boundingBox();
	const n1 = await peer.page.locator('[data-id="mb1"]').boundingBox();
	const n2 = await peer.page.locator('[data-id="mb2"]').boundingBox();
	return { pane, n1, n2 };
};

/** a point that really IS the bare pane — never the minimap, the zoom controls or a card */
const emptySpot = async (peer, lay) => {
	const candidates = [
		[lay.pane.x + lay.pane.width * 0.75, lay.pane.y + lay.pane.height * 0.5],
		[lay.pane.x + lay.pane.width - 60, lay.pane.y + 40],
		[lay.pane.x + lay.pane.width * 0.6, lay.pane.y + lay.pane.height * 0.8],
		[lay.pane.x + lay.pane.width * 0.5, lay.pane.y + 30]
	];
	for (const [x, y] of candidates) {
		const isPane = await peer.page.evaluate(
			([x, y]) => !!document.elementFromPoint(x, y)?.classList?.contains('svelte-flow__pane'),
			[x, y]
		);
		if (isPane) return { x, y };
	}
	return null;
};

const dragMouse = async (page, from, to, button = 'left') => {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down({ button });
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.mouse.up({ button });
	await page.waitForTimeout(350);
};

h.run(async () => {
	const browser = await h.launch();

	// ==== CLASSIC (the default, nothing seeded): a left drag pans, selects nothing ====
	const A = await h.setupPage(browser, 'A');
	const pref = await A.page.evaluate(() => localStorage.getItem('flow:mouseBindings'));
	h.check(pref === null || pref === 'classic', `the pref defaults to classic (${pref})`);
	const layA = await openEditor(A);
	h.check(!!layA.n1 && !!layA.n2, 'both cards are on screen (premise)');
	const spotA = await emptySpot(A, layA);
	h.check(!!spotA, `found a point on the bare pane, clear of the minimap (${JSON.stringify(spotA)})`);
	await dragMouse(A.page, spotA, { x: spotA.x - 80, y: spotA.y - 40 });
	const n1After = await A.page.locator('[data-id="mb1"]').boundingBox();
	const posA = await A.page.evaluate(POSITIONS);
	h.check(
		Math.abs(n1After.x - (layA.n1.x - 80)) < 3 && Math.abs(n1After.y - (layA.n1.y - 40)) < 3,
		`Classic: a left drag on the pane PANS (the card moved ${Math.round(n1After.x - layA.n1.x)}, ${Math.round(n1After.y - layA.n1.y)} on screen)`
	);
	h.check(posA.mb1.x === 60 && posA.mb2.x === 260, 'Classic: the nodes did not move in the graph');
	h.check(!posA.mb1.selected && !posA.mb2.selected, 'Classic: the drag selected nothing');
	await A.page.mouse.click(spotA.x, spotA.y, { button: 'right' });
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('[role="menu"]').count()) > 0, 'Classic: a right click opens the pane menu');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// ==== SELECT-FIRST (seeded, as a saved setting would be) =========================
	const B = await h.setupPage(browser, 'B', { storage: { 'flow:mouseBindings': 'select' } });
	const layB = await openEditor(B);
	const spotB = await emptySpot(B, layB);
	h.check(!!spotB, `found a bare-pane point for Select-first (${JSON.stringify(spotB)})`);

	// 1. a left drag across both cards SELECTS them, and pans nothing
	await dragMouse(
		B.page,
		{ x: layB.n1.x - 18, y: layB.n1.y - 18 },
		{ x: layB.n2.x + layB.n2.width + 18, y: layB.n2.y + layB.n2.height / 2 }
	);
	let pos = await B.page.evaluate(POSITIONS);
	const n1B = await B.page.locator('[data-id="mb1"]').boundingBox();
	h.check(pos.mb1.selected && pos.mb2.selected, `Select-first: a left drag rectangle selected both nodes (${JSON.stringify(pos)})`);
	h.check(
		Math.abs(n1B.x - layB.n1.x) < 2 && Math.abs(n1B.y - layB.n1.y) < 2,
		`Select-first: the left drag did not pan (card at ${Math.round(n1B.x)}, ${Math.round(n1B.y)} vs ${Math.round(layB.n1.x)}, ${Math.round(layB.n1.y)})`
	);

	// 2. dragging the selection moves the whole SET by one delta
	const wrap = await B.page.locator('.svelte-flow__selection-wrapper').boundingBox();
	h.check(!!wrap, 'the box selection leaves a draggable selection overlay (premise)');
	await dragMouse(
		B.page,
		{ x: wrap.x + wrap.width / 2, y: wrap.y + wrap.height / 2 },
		{ x: wrap.x + wrap.width / 2 + 90, y: wrap.y + wrap.height / 2 + 40 }
	);
	pos = await B.page.evaluate(POSITIONS);
	const d1 = { x: pos.mb1.x - 60, y: pos.mb1.y - 20 };
	const d2 = { x: pos.mb2.x - 260, y: pos.mb2.y - 20 };
	h.check(d1.x > 50 && d1.y > 20, `dragging the selection moved it (${d1.x}, ${d1.y})`);
	h.check(
		Math.abs(d1.x - d2.x) < 1 && Math.abs(d1.y - d2.y) < 1,
		`...and every selected node moved by the SAME delta (${d2.x}, ${d2.y})`
	);

	// 3. Shift+click toggles membership (the overlay covers the cards while a rectangle
	//    selection stands, so start from a cleared selection — what a user does too)
	await B.page.mouse.click(spotB.x, spotB.y);
	await B.page.waitForTimeout(300);
	const cleared = await B.page.evaluate(POSITIONS);
	h.check(!cleared.mb1.selected && !cleared.mb2.selected, 'a click on empty pane clears the selection (premise)');
	const c1 = await B.page.locator('[data-id="mb1"]').boundingBox();
	const c2 = await B.page.locator('[data-id="mb2"]').boundingBox();
	await B.page.mouse.click(c1.x + 12, c1.y + 8);
	await B.page.waitForTimeout(250);
	await B.page.keyboard.down('Shift');
	await B.page.mouse.click(c2.x + 12, c2.y + 8);
	await B.page.keyboard.up('Shift');
	await B.page.waitForTimeout(300);
	pos = await B.page.evaluate(POSITIONS);
	h.check(pos.mb1.selected && pos.mb2.selected, `Shift+click ADDS to the selection (${JSON.stringify([pos.mb1.selected, pos.mb2.selected])})`);
	await B.page.keyboard.down('Shift');
	await B.page.mouse.click(c2.x + 12, c2.y + 8);
	await B.page.keyboard.up('Shift');
	await B.page.waitForTimeout(300);
	pos = await B.page.evaluate(POSITIONS);
	h.check(pos.mb1.selected && !pos.mb2.selected, `...and Shift+click again REMOVES it (${JSON.stringify([pos.mb1.selected, pos.mb2.selected])})`);

	// 4. a right DRAG pans and opens no menu. This runs BEFORE the stationary
	//    right-click check on purpose: the menu opens AT the pointer, so it would then
	//    be sitting on the very spot this drag starts from — a click there lands on the
	//    menu itself (it is not a backdrop), and nothing would reach the pane at all.
	const before = await B.page.locator('[data-id="mb1"]').boundingBox();
	await dragMouse(B.page, spotB, { x: spotB.x - 80, y: spotB.y - 40 }, 'right');
	const after = await B.page.locator('[data-id="mb1"]').boundingBox();
	const menuAfterPan = await B.page.locator('[role="menu"]').count();
	h.check(
		Math.abs(after.x - (before.x - 80)) < 3 && Math.abs(after.y - (before.y - 40)) < 3,
		`Select-first: a right drag PANS (${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)})`
	);
	h.check(menuAfterPan === 0, '...and that right drag opened no menu');

	// 5. ...while a right click that does not travel still opens it
	await B.page.mouse.click(spotB.x, spotB.y, { button: 'right' });
	await B.page.waitForTimeout(400);
	h.check((await B.page.locator('[role="menu"]').count()) > 0, 'Select-first: a stationary right click opens the pane menu');

	// 6. the pref survives a reload, and Settings carries the row that writes it
	await h.freshReload(B);
	const kept = await B.page.evaluate(() => localStorage.getItem('flow:mouseBindings'));
	h.check(kept === 'select', `the binding persists across a reload (${kept})`);
	await B.page.evaluate(() => {
		window.__stores.settingsSection.set('input');
		window.__stores.settingsOpen.set(true);
	});
	await B.page.waitForTimeout(900);
	h.check((await B.page.locator('#flow-mouse-bindings').count()) > 0, 'Settings ▸ Input carries the Mouse bindings row');

	await h.finish(browser);
});
