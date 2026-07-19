// Roadmap #9 fix: the node palette used HTML5 drag-and-drop, which touch devices
// don't synthesize — so nothing happened on a tap-drag. A tap/click now adds the
// node at the flow pane centre (a real drag fires no click, so desktop is unaffected).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.flowNodes.set([]));
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);
	// make sure the palette is open
	const hasItem = await A.page.evaluate(() => !!document.querySelector('aside [role="listitem"]'));
	if (!hasItem) {
		await A.page.evaluate(() => document.querySelector('#palette-toggle')?.click());
		await A.page.waitForTimeout(400);
	}

	const r = await A.page.evaluate(async () => {
		const s = window.__stores;
		let before;
		s.flowNodes.subscribe((x) => (before = x.length))();
		const item = document.querySelector('aside [role="listitem"]');
		item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		let after;
		s.flowNodes.subscribe((x) => (after = x))();
		return { before, count: after.length, hasPos: after.length ? !!after[after.length - 1].position : false };
	});
	h.check(r.count === r.before + 1, `tapping a palette node adds it to the flow (${r.before}->${r.count})`);
	h.check(r.hasPos, 'the added node has a position (placed at the pane centre)');

	// touch DRAG-to-place: a horizontal-dominant touch drag from a palette item onto
	// the pane drops the node at the finger position (vertical stays palette scroll).
	const drag = await A.page.evaluate(async () => {
		const s = window.__stores;
		let before;
		s.flowNodes.subscribe((x) => (before = x.length))();
		const item = document.querySelector('aside [role="listitem"]');
		const pane = document.querySelector('.svelte-flow');
		const ir = item.getBoundingClientRect();
		const pr = pane.getBoundingClientRect();
		const sx = ir.left + ir.width / 2;
		const sy = ir.top + ir.height / 2;
		const px = Math.round(pr.left + pr.width / 2);
		const py = Math.round(pr.top + pr.height / 2);
		const ev = (type, x, y) => item.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y }));
		ev('pointerdown', sx, sy);
		ev('pointermove', sx + 40, sy); // horizontal -> starts dragging
		await new Promise((r) => setTimeout(r, 60)); // let Svelte render the ghost
		const ghost = !!document.querySelector('.fixed.pointer-events-none');
		ev('pointermove', px, py); // onto the pane
		ev('pointerup', px, py);
		await new Promise((r) => setTimeout(r, 300));
		let after;
		s.flowNodes.subscribe((x) => (after = x))();
		return { before, count: after.length, ghost, last: after[after.length - 1]?.position };
	});
	h.check(drag.ghost, 'a drag ghost appears once the horizontal touch drag starts');
	h.check(drag.count === drag.before + 1, `dragging a palette node onto the pane adds it (${drag.before}->${drag.count})`);
	h.check(!!drag.last && Number.isFinite(drag.last.x), 'the dropped node is placed at a flow position');

	await h.finish(browser);
});
