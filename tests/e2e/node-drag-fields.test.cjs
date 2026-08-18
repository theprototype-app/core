// #20 P2 — the loose <input type="number"> in flow and shader node cards became
// DragRow, THE numeric field: drag to scrub, type live, up/down one minor unit with
// Ctrl x10 / Shift x100, Esc reverts.
//
// The one thing that could go wrong is invisible to a store-level check: xyflow and
// the field both want the same pointer, so without the `nodrag` class a horizontal
// drag MOVES THE CARD instead of changing the value. Every drag here is a REAL mouse
// and asserts both halves — the value moved AND the node did not.
//
// TRAP THIS SUITE PAID FOR: a `boundingBox()` is not a hit test, and the pane viewport is
// not something a suite can assume. The first version placed its nodes at flow
// y=60/240 and both fields turned out to be COVERED — one by
// the 3D CANVAS (above the dock pane) and one by the palette tab button. The Vector 3
// drag still "passed", because pressing the palette toggle reflowed the pane and the
// later moves landed on the real field. Hence: the palette and props panes are closed,
// the dock is made tall, and every drag is preceded by an elementFromPoint premise
// check naming what is actually under the cursor.
const h = require('./helpers.cjs');

/** Read a node's data + its card position. */
const READ = (id) => {
	let nodes;
	window.__stores.flowNodes.subscribe((v) => (nodes = v))();
	const n = nodes.find((x) => x.id === id);
	return n ? { data: { ...n.data }, pos: { x: n.position.x, y: n.position.y } } : null;
};

/** The field's centre, plus what the browser says is actually there. */
const PROBE = ({ id, index }) => {
	const el = document.querySelectorAll(`[data-id="${id}"] .dn-input`)[index ?? 0];
	if (!el) return { ok: false, why: 'no field' };
	const r = el.getBoundingClientRect();
	const cx = r.x + r.width / 2;
	const cy = r.y + r.height / 2;
	const at = document.elementFromPoint(cx, cy);
	return {
		ok: at === el,
		cx,
		cy,
		at: at ? at.tagName + (at.className ? '.' + String(at.className).split(' ')[0] : '') : null
	};
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a wide, tall, chrome-free node pane so the cards are genuinely clickable
	await A.page.evaluate(() => {
		localStorage.setItem('flowPaletteOpen', 'false');
		localStorage.setItem('flowPropsOpen', 'false');
		localStorage.setItem('flowDockHeight', '520');
	});
	await h.freshReload(A);

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{
				id: 'num1',
				type: 'number',
				position: { x: 60, y: 40 },
				data: { type: 'number', label: 'Number', value: 4, step: 1 },
				class: 'w-[150px]'
			},
			{
				id: 'vec1',
				type: 'vector3',
				position: { x: 320, y: 40 },
				data: { type: 'vector3', label: 'Vector 3', x: 0, y: 0, z: 0 },
				class: 'w-[150px]'
			}
		]);
		s.flowEdges.set([]);
	});
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1500);

	// PIN the pane viewport. xyflow's `fitView` runs at MOUNT, against whatever nodes
	// existed then — measured, it left a card at screen x = -29.5 at zoom 0.5, and a real
	// pane drag panned 3775px for a 200px gesture. `__flowViewport` is the debugStores
	// hook added for exactly this (Outline/CameraPreview pattern).
	const hooked = await A.page.evaluate(() => !!window.__flowViewport);
	h.check(hooked, 'the pane exposes its viewport to the suite (premise)');
	await A.page.evaluate(() => window.__flowViewport.setViewport({ x: 120, y: 60, zoom: 1 }));
	await A.page.waitForTimeout(500);

	// ---- 1. premise: the fields are DragRows, not number inputs ----------------
	const shape = await A.page.evaluate(() => {
		const card = document.querySelector('[data-id="num1"]');
		return {
			dragRows: card ? card.querySelectorAll('.dn-wrap').length : -1,
			numberInputs: card ? card.querySelectorAll('input[type="number"]').length : -1,
			// the wrapper must carry the class xyflow's drag filter looks for
			nodrag: card ? card.querySelectorAll('.dn-wrap.nodrag').length : -1,
			textType: card ? card.querySelector('.dn-input')?.getAttribute('type') : null
		};
	});
	h.check(shape.dragRows === 1, `the Number card renders one DragRow (got ${shape.dragRows})`);
	h.check(shape.numberInputs === 0, `no bare number input is left in the card (got ${shape.numberInputs})`);
	h.check(shape.nodrag === 1, `the field carries nodrag so xyflow lets the scrub through (got ${shape.nodrag})`);
	h.check(shape.textType === 'text', `it is a text input on purpose, no native spinner (got ${shape.textType})`);

	const vecShape = await A.page.evaluate(() => {
		const card = document.querySelector('[data-id="vec1"]');
		return card ? card.querySelectorAll('.dn-wrap.nodrag').length : -1;
	});
	h.check(vecShape === 3, `the Vector 3 card renders three nodrag fields (got ${vecShape})`);

	// ---- 2. a real drag scrubs the value and does NOT move the card ------------
	const before = await A.page.evaluate(READ, 'num1');
	h.check(before?.data.value === 4, `the Number node starts at 4 (premise: ${before?.data.value})`);

	const spot = await A.page.evaluate(PROBE, { id: 'num1', index: 0 });
	h.check(spot.ok, `the Number field is the top element at its own centre (premise: ${spot.at})`);

	const DRAG_PX = 100;
	await A.page.mouse.move(spot.cx, spot.cy);
	await A.page.mouse.down();
	for (let x = 10; x <= DRAG_PX; x += 10)
		await A.page.mouse.move(spot.cx + x, spot.cy, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);

	const dragged = await A.page.evaluate(READ, 'num1');
	const delta = dragged.data.value - before.data.value;
	// the Number node feeds its own `step` in as the drag rate: step 1 -> 0.01 per px,
	// so 100px is +1.00. Asserting the MAGNITUDE (not just the direction) is what
	// would catch a wrong rate or a doubled gesture.
	const expected = DRAG_PX * 0.01;
	h.check(
		Math.abs(delta - expected) < 0.06,
		`a ${DRAG_PX}px drag scrubbed by ${expected} (4 -> ${dragged.data.value}, delta ${delta.toFixed(3)})`
	);
	h.check(
		dragged.pos.x === before.pos.x && dragged.pos.y === before.pos.y,
		`the node card did not move (${JSON.stringify(dragged.pos)} vs ${JSON.stringify(before.pos)})`
	);

	// ---- 3. the scrubbed value reaches the RUNTIME -----------------------------
	// A field that updates its own display and nothing else would pass section 2.
	const evaluated = await A.page.evaluate(() => {
		let nodes;
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		const node = nodes.find((n) => n.id === 'num1');
		return window.__stores.flowRuntime.evalNode(node, [], [], 0);
	});
	h.check(
		Math.abs(evaluated - dragged.data.value) < 1e-6,
		`the runtime reads the scrubbed value (${evaluated} vs ${dragged.data.value})`
	);

	// ---- 4. Ctrl and Shift change the arrow STEP ------------------------------
	// decimals=2 so one minor unit is 0.01; Ctrl x10 = 0.1, Shift x100 = 1.
	const steps = await A.page.evaluate(async () => {
		const input = document.querySelector('[data-id="num1"] .dn-input');
		const read = () => {
			let nodes;
			window.__stores.flowNodes.subscribe((v) => (nodes = v))();
			return nodes.find((n) => n.id === 'num1').data.value;
		};
		const press = async (key, mods) => {
			const start = read();
			input.focus();
			input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
			await new Promise((r) => setTimeout(r, 120));
			return Math.abs(read() - start);
		};
		return {
			plain: await press('ArrowUp', {}),
			ctrl: await press('ArrowUp', { ctrlKey: true }),
			shift: await press('ArrowUp', { shiftKey: true })
		};
	});
	h.check(Math.abs(steps.plain - 0.01) < 1e-6, `ArrowUp steps one minor unit (got ${steps.plain})`);
	h.check(Math.abs(steps.ctrl - 0.1) < 1e-6, `Ctrl+ArrowUp steps x10 (got ${steps.ctrl})`);
	h.check(Math.abs(steps.shift - 1) < 1e-6, `Shift+ArrowUp steps x100 (got ${steps.shift})`);

	// ---- 5. typing still applies LIVE, per keystroke --------------------------
	const typed = await A.page.evaluate(async () => {
		const input = document.querySelector('[data-id="num1"] .dn-input');
		input.focus();
		input.value = '7.25';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		let nodes;
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		return nodes.find((n) => n.id === 'num1').data.value;
	});
	h.check(Math.abs(typed - 7.25) < 1e-6, `typing applies without Enter (got ${typed})`);

	// ---- 6. a per-axis field writes only ITS axis ------------------------------
	const axes = await A.page.evaluate(READ, 'vec1');
	const ySpot = await A.page.evaluate(PROBE, { id: 'vec1', index: 1 });
	h.check(ySpot.ok, `the Vector 3 y field is the top element at its centre (premise: ${ySpot.at})`);
	await A.page.mouse.move(ySpot.cx, ySpot.cy);
	await A.page.mouse.down();
	for (let x = 10; x <= 100; x += 10) await A.page.mouse.move(ySpot.cx + x, ySpot.cy, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const axesAfter = await A.page.evaluate(READ, 'vec1');
	h.check(
		Math.abs(axesAfter.data.y - (axes.data.y + 1)) < 0.06,
		`scrubbing y by 100px moved it +1.00 (${axes.data.y} -> ${axesAfter.data.y})`
	);
	h.check(
		axesAfter.data.x === axes.data.x && axesAfter.data.z === axes.data.z,
		`x and z were untouched (x${axesAfter.data.x} z${axesAfter.data.z})`
	);
	h.check(
		axesAfter.pos.x === axes.pos.x && axesAfter.pos.y === axes.pos.y,
		'the Vector 3 card did not move either'
	);

	// ---- 7. a drag on an ALREADY-FOCUSED field ---------------------------------
	// This is the case `nodrag` actually earns its place in, and it took removing the
	// class to find out. DragRow's pointerdown calls preventDefault only `if (!focused)`
	// — enough to keep xyflow off a FIRST drag all by itself — so a suite that only
	// ever drags a cold field passes with the class gone. Click first (which focuses,
	// by design: focus is granted on release so click-to-type works), then drag.
	const focusSpot = await A.page.evaluate(PROBE, { id: 'num1', index: 0 });
	h.check(focusSpot.ok, `the field is still hittable before the focused drag (premise: ${focusSpot.at})`);
	await A.page.mouse.click(focusSpot.cx, focusSpot.cy);
	await A.page.waitForTimeout(200);
	const isFocused = await A.page.evaluate(
		() => document.activeElement === document.querySelector('[data-id="num1"] .dn-input')
	);
	h.check(isFocused, 'clicking the field focused it (premise)');

	const hotBefore = await A.page.evaluate(READ, 'num1');
	await A.page.mouse.move(focusSpot.cx, focusSpot.cy);
	await A.page.mouse.down();
	for (let x = 10; x <= 60; x += 10)
		await A.page.mouse.move(focusSpot.cx + x, focusSpot.cy, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const hotAfter = await A.page.evaluate(READ, 'num1');
	h.check(
		Math.abs(hotAfter.data.value - hotBefore.data.value - 0.6) < 0.06,
		`a focused field still scrubs (${hotBefore.data.value} -> ${hotAfter.data.value})`
	);
	h.check(
		hotAfter.pos.x === hotBefore.pos.x && hotAfter.pos.y === hotBefore.pos.y,
		`the card stayed put on a focused drag (${JSON.stringify(hotAfter.pos)} vs ${JSON.stringify(hotBefore.pos)})`
	);

	// ---- 8. nothing crashed while rendering ------------------------------------
	// A duplicate-key or a runes/legacy mix-up in a node card takes the whole editor
	// down, and every store read above would still have passed (the 17-E lesson).
	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors while driving the cards (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
