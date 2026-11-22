// 103 H7: the custom transform gizmo — four styles, the triple switch, the bar buttons' press-and-drag.
//   1  style A (the suites' default) is three's own gizmo and loads no face; Auto = B with a mouse
//   2  B all in one: every handle kind shows; arrow = one axis, plane square = two, ring = rotate,
//      cube = one-axis resize, centre knob = even resize / Shift = free move; one undo per drag;
//      the tool's mode is back after a drag in another mode; snapping steps hold
//   3  row 8: the triple switch on 1 / 2 / 3 (B: all -> hidden -> tool -> all; A: tool -> all -> hidden)
//      and the bar button's three states
//   4  C touch puck: disc slides on the ground, lift = up, ring = turn, knob = even resize, a tap on
//      the disc opens the per-axis handles; a finger's hit area is >= 44 px, a mouse's is not
//   5  D box: a face cone pushes one side (the other side stays), a corner resizes evenly about the
//      opposite corner, the size shows while dragging, the arc turns
//   6  press-and-drag from the bar's Move button moves the selection at once; one undo
//   7  a second peer sees the result of a B drag and a D push (the gizmo's own `move`)
//   8  Settings ▸ Scene ▸ Gizmo: style, size, show only
const h = require('./helpers.cjs');

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const fx = (a) => a.map((n) => n.toFixed(3)).join(',');

/** @param {any} page @param {string} uuid */
async function pose(page, uuid) {
	return page.evaluate((u) => {
		let group;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (group = x))();
		const o = group.getObjectByProperty('uuid', u);
		return o ? { pos: o.position.toArray(), rot: o.rotation.toArray().slice(0, 3), scale: o.scale.toArray() } : null;
	}, uuid);
}

/** the gizmo's state @param {any} page */
async function gizmo(page) {
	return page.evaluate(async () => {
		let tc;
		window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
		const faces = tc?._face ? await window.__tp.test.v1.gizmoFaces : null;
		const prefs = await window.__tp.test.v1.gizmoPrefs;
		let hs;
		prefs.handleSet.subscribe((v) => (hs = v))();
		const list = faces && tc._face ? faces.describeFace(tc._face.b && !tc._face.usesBox(tc.object) ? tc._face.b : tc._face) : [];
		const kinds = [...new Set(list.filter((x) => x.visible).map((x) => x.kind))].sort();
		return {
			object: tc?.object?.uuid ?? null,
			style: tc?.gizmoStyle,
			face: tc?._face?.style ?? null,
			faceActive: !!tc?.faceActive?.(),
			stockVisible: !!tc?._gizmo?.visible,
			handleSet: hs,
			mode: tc?.mode,
			kinds
		};
	});
}

/** a handle's screen point, waiting for the lazy face @param {any} page */
async function handleAt(page, kind, axis, along) {
	await page.waitForFunction(() => {
		let tc;
		window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
		return !!tc?._face;
	}, null, { timeout: 15000 });
	return page.evaluate(
		async ([k, a, al]) => {
			let tc;
			window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
			const faces = await window.__tp.test.v1.gizmoFaces;
			return faces.handlePoint(tc, k, a || undefined, al ?? 0.7);
		},
		[kind, axis ?? '', along ?? null]
	);
}

/** press on a point, travel, release (a mouse) @param {any} page */
async function drag(page, from, dx, dy, opts = {}) {
	await page.mouse.move(from.x, from.y);
	await page.waitForTimeout(60);
	if (opts.shift) await page.keyboard.down('Shift');
	await page.mouse.down();
	await page.mouse.move(from.x + dx * 0.3, from.y + dy * 0.3, { steps: 4 });
	await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
	await page.waitForTimeout(80);
	await page.mouse.up();
	if (opts.shift) await page.keyboard.up('Shift');
	await page.waitForTimeout(250);
}

const undo = (page) => page.evaluate(() => window.__tp.test.v1.history.undo()).then(() => page.waitForTimeout(250));
const setStyle = (page, s) =>
	page.evaluate(async (v) => {
		const p = await window.__tp.test.v1.gizmoPrefs;
		p.gizmoStyle.set(v);
	}, s).then(() => page.waitForTimeout(500));
const handleSetNow = (page) => page.evaluate(async () => {
	const p = await window.__tp.test.v1.gizmoPrefs;
	let v;
	p.handleSet.subscribe((x) => (v = x))();
	return v;
});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- 1. style A: three's gizmo, no face loaded ------------------------------------------------
	const faceAtBoot = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /gizmo\/faces/.test(e.name)));
	h.check(!faceAtBoot, `1.0 style A (the suites' seed) never fetches the gizmo faces`);
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);
	const c = await page.evaluate(() => {
		const r = document.querySelector('canvas').getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await page.mouse.click(c.x + 320, c.y + 260); // the viewport takes the keyboard (empty ground)
	await page.waitForTimeout(300);
	const boxId = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		const b = g.children.find((o) => o.name === 'Box') ?? g.children[0];
		window.__tp.test.v1.objectActions.selectObject(b.uuid);
		return b.uuid;
	});
	await page.waitForTimeout(500);
	const select = async (label) => {
		await page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), boxId);
		await page.waitForTimeout(300);
		const g = await gizmo(page);
		h.check(g.object === boxId, `${label} premise: the gizmo is on the box (${g.object === boxId})`);
	};
	let g = await gizmo(page);
	h.check(g.style === 'A' && !g.faceActive && g.stockVisible && g.object === boxId, `1.1 style A: three's own gizmo on the box (${JSON.stringify(g)})`);
	const start = await pose(page, boxId);

	// ---- 2. style B ----------------------------------------------------------------------------
	await setStyle(page, 'auto');
	g = await gizmo(page);
	await handleAt(page, 'arrows', 'X');
	g = await gizmo(page);
	h.check(g.style === 'B' && g.face === 'B' && g.faceActive && !g.stockVisible, `2.0 Auto with a mouse = B, three's gizmo stands down (${JSON.stringify(g)})`);
	h.check(g.handleSet === 'all' && ['arrows', 'cubes', 'knob', 'planes', 'rings'].every((k) => g.kinds.includes(k)), `2.1 B starts on all in one: every handle kind shows (${g.kinds})`);

	// 2.2 the X arrow moves along X only
	let p0 = await pose(page, boxId);
	let at = await handleAt(page, 'arrows', 'X');
	await drag(page, at, 120, 0);
	let p1 = await pose(page, boxId);
	h.check(Math.abs(p1.pos[0] - p0.pos[0]) > 0.1 && near(p1.pos[1], p0.pos[1]) && near(p1.pos[2], p0.pos[2]), `2.2 the X arrow moves along X only (${fx(p0.pos)} -> ${fx(p1.pos)})`);
	await undo(page);
	p1 = await pose(page, boxId);
	h.check(near(p1.pos[0], p0.pos[0]), `2.3 one undo puts it back (${fx(p1.pos)})`);

	// 2.4 the ground square moves on X and Z, never Y
	at = await handleAt(page, 'planes', 'XZ');
	await drag(page, at, 90, 50);
	p1 = await pose(page, boxId);
	h.check((Math.abs(p1.pos[0] - p0.pos[0]) > 0.05 || Math.abs(p1.pos[2] - p0.pos[2]) > 0.05) && near(p1.pos[1], p0.pos[1]), `2.4 the X-Z square moves on the ground (${fx(p1.pos)})`);
	await undo(page);

	// 2.5 a ring drag rotates while the tool stays Move
	at = await handleAt(page, 'rings', 'Y', 0.5);
	await drag(page, at, 100, 30);
	p1 = await pose(page, boxId);
	g = await gizmo(page);
	h.check(Math.abs(p1.rot[1] - p0.rot[1]) > 0.05 && near(p1.pos[0], p0.pos[0]) && g.mode === 'translate', `2.5 the Y ring turns the box; the tool is Move again after (${fx(p1.rot)}, mode ${g.mode})`);
	await undo(page);

	// 2.6 a cube resizes one axis
	at = await handleAt(page, 'cubes', 'X');
	await drag(page, at, 90, 0);
	p1 = await pose(page, boxId);
	h.check(Math.abs(p1.scale[0] - p0.scale[0]) > 0.05 && near(p1.scale[1], p0.scale[1]) && near(p1.scale[2], p0.scale[2]), `2.6 the X cube resizes X only (${fx(p1.scale)})`);
	await undo(page);

	// 2.7 the centre knob resizes evenly; with Shift it moves
	at = await handleAt(page, 'knob');
	await drag(page, { x: at.x, y: at.y }, 0, -80);
	p1 = await pose(page, boxId);
	h.check(Math.abs(p1.scale[0] - p0.scale[0]) > 0.02 && near(p1.scale[0], p1.scale[1], 1e-4) && near(p1.scale[1], p1.scale[2], 1e-4), `2.7 the centre knob resizes evenly (${fx(p1.scale)})`);
	await undo(page);
	at = await handleAt(page, 'knob');
	await drag(page, at, 70, -40, { shift: true });
	p1 = await pose(page, boxId);
	h.check(near(p1.scale[0], p0.scale[0]) && Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[1] - p0.pos[1], p1.pos[2] - p0.pos[2]) > 0.05, `2.8 Shift + the centre knob moves freely, no resize (${fx(p1.pos)} / ${fx(p1.scale)})`);
	await undo(page);

	// 2.9 snapping: the arrow lands on the 0.5 grid
	await page.evaluate(async () => {
		const s = window.__tp.test.v1.snapping;
		const m = s.then ? await s : s;
		m.snapSettings?.update?.((v) => ({ ...v, translate: 0.5 }));
		m.snapEnabled?.set?.(true);
	});
	await page.waitForTimeout(300);
	at = await handleAt(page, 'arrows', 'X');
	await drag(page, at, 140, 0);
	p1 = await pose(page, boxId);
	const snapped = await page.evaluate(() => {
		let tc;
		window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
		return tc.translationSnap;
	});
	h.check(snapped > 0 && near((p1.pos[0] - p0.pos[0]) / snapped, Math.round((p1.pos[0] - p0.pos[0]) / snapped), 1e-3) && Math.abs(p1.pos[0] - p0.pos[0]) > 0, `2.9 with snapping on the arrow moves in steps of ${snapped} (dx ${(p1.pos[0] - p0.pos[0]).toFixed(3)})`);
	await undo(page);
	await page.evaluate(async () => {
		const s = window.__tp.test.v1.snapping;
		const m = s.then ? await s : s;
		m.snapEnabled?.set?.(false);
	});

	// ---- 3. row 8, the triple switch ---------------------------------------------------------------
	await select('3.0');
	const cell = (t) => page.evaluate((title) => document.querySelector(`p[title="${title}"]`)?.getAttribute('data-handles') ?? null, t);
	const marked = () => page.evaluate(() => !!document.querySelector('p[title="Move (1)"] .gizmo-all-mark'));
	h.check((await handleSetNow(page)) === 'all' && (await cell('Move (1)')) === 'all' && (await marked()), `3.1 B: the Move button shows the all mark (${await cell('Move (1)')})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(400);
	g = await gizmo(page);
	h.check(!g.object || g.object !== boxId, `3.2 B: 1 on all in one = hidden (${g.object})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(600);
	g = await gizmo(page);
	h.check(g.object === boxId && g.handleSet === 'tool' && g.kinds.join() === 'arrows,planes' && (await cell('Move (1)')) === 'tool', `3.3 B: 1 again = Move's handles only (${g.kinds}, ${await cell('Move (1)')})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(400);
	g = await gizmo(page);
	h.check(g.handleSet === 'all' && g.kinds.includes('rings'), `3.4 B: 1 again = all in one (${g.kinds})`);
	await page.keyboard.press('Digit2');
	await page.waitForTimeout(400);
	g = await gizmo(page);
	h.check(g.handleSet === 'tool' && g.kinds.join() === 'rings' && (await cell('Rotate (2)')) === 'tool', `3.5 B: 2 = Rotate's handles (${g.kinds})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(300);
	// style A: tool -> all in one (B's) -> hidden -> tool
	await setStyle(page, 'A');
	await select('3.6');
	g = await gizmo(page);
	h.check(g.style === 'A' && !g.faceActive && g.handleSet === 'tool', `3.6 A: the tool's own gizmo (${JSON.stringify(g)})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(600);
	await handleAt(page, 'rings', 'Y');
	g = await gizmo(page);
	h.check(g.faceActive && g.face === 'B' && g.kinds.includes('rings') && g.kinds.includes('cubes') && (await marked()), `3.7 A: 1 again = B's all in one while it is on (${JSON.stringify(g)})`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(400);
	g = await gizmo(page);
	h.check(!g.object || g.object !== boxId, `3.8 A: 1 again = hidden`);
	await page.keyboard.press('Digit1');
	await page.waitForTimeout(600);
	g = await gizmo(page);
	h.check(g.object === boxId && !g.faceActive && g.stockVisible, `3.9 A: 1 again = Move's own gizmo (${JSON.stringify(g)})`);

	// ---- 4. style C, the puck --------------------------------------------------------------------
	await setStyle(page, 'C');
	await select('4.0');
	await handleAt(page, 'disc');
	g = await gizmo(page);
	h.check(g.face === 'C' && ['disc', 'knob', 'lift', 'ring'].every((k) => g.kinds.includes(k)) && !g.kinds.includes('arrows'), `4.1 C: disc, lift, ring, knob; no per-axis handles yet (${g.kinds})`);
	p0 = await pose(page, boxId);
	at = await handleAt(page, 'disc');
	await drag(page, at, 80, 40);
	p1 = await pose(page, boxId);
	h.check((Math.abs(p1.pos[0] - p0.pos[0]) > 0.05 || Math.abs(p1.pos[2] - p0.pos[2]) > 0.05) && near(p1.pos[1], p0.pos[1]), `4.2 the disc slides on the ground (${fx(p1.pos)})`);
	await undo(page);
	at = await handleAt(page, 'lift');
	await drag(page, at, 0, -70);
	p1 = await pose(page, boxId);
	h.check(p1.pos[1] - p0.pos[1] > 0.05 && near(p1.pos[0], p0.pos[0]) && near(p1.pos[2], p0.pos[2]), `4.3 the lift arrow raises it (${fx(p1.pos)})`);
	await undo(page);
	at = await handleAt(page, 'ring', 'Y', 0.1);
	await drag(page, at, 90, 20);
	p1 = await pose(page, boxId);
	h.check(Math.abs(p1.rot[1] - p0.rot[1]) > 0.05, `4.4 the turn ring turns it about up (${fx(p1.rot)})`);
	await undo(page);
	at = await handleAt(page, 'knob');
	await drag(page, at, 60, 60);
	p1 = await pose(page, boxId);
	h.check(Math.abs(p1.scale[0] - p0.scale[0]) > 0.02 && near(p1.scale[0], p1.scale[2], 1e-4), `4.5 the knob resizes evenly (${fx(p1.scale)})`);
	await undo(page);
	at = await handleAt(page, 'disc');
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	g = await gizmo(page);
	p1 = await pose(page, boxId);
	h.check(g.kinds.includes('arrows') && g.kinds.includes('cubes') && JSON.stringify(p1.pos) === JSON.stringify(p0.pos), `4.6 a tap on the disc opens the per-axis handles and moves nothing (${g.kinds})`);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(300);
	// hit areas: 20 px off the lift arrow's shaft
	const hitTest = await page.evaluate(async () => {
		let tc;
		window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
		const faces = await window.__tp.test.v1.gizmoFaces;
		const p = faces.handlePoint(tc, 'lift', undefined, 0.5);
		const r = tc.domElement.getBoundingClientRect();
		const ndc = (x, y) => ({ x: ((x - r.left) / r.width) * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1, button: 0 });
		const ask = (kind) => {
			tc.pointerKind = kind;
			tc.pointerHover(ndc(p.x + 20, p.y));
			const a = tc.axis;
			tc.pointerHover(ndc(p.x + 40, p.y));
			const b = tc.axis;
			return [a, b];
		};
		const out = { touch: ask('touch'), mouse: ask('mouse') };
		tc.pointerKind = 'mouse';
		tc.axis = null;
		return out;
	});
	h.check(hitTest.touch[0] === 'Y' && hitTest.touch[1] !== 'Y' && hitTest.mouse[0] !== 'Y', `4.7 a finger 20 px off the lift still takes it (44 px target), 40 px does not; a mouse needs to be on it (${JSON.stringify(hitTest)})`);

	// ---- 5. style D, box handles --------------------------------------------------------------------
	await setStyle(page, 'D');
	await select('5.0');
	await handleAt(page, 'faces', 'X');
	g = await gizmo(page);
	h.check(g.face === 'D' && ['arc', 'corners', 'faces', 'mover'].every((k) => g.kinds.includes(k)), `5.1 D: corners, face cones, the arc and the mover (${g.kinds})`);
	const world = () =>
		page.evaluate((u) => {
			let group;
			window.__tp.test.v1.objectsGroup.subscribe((x) => (group = x))();
			const o = group.getObjectByProperty('uuid', u);
			o.updateMatrixWorld(true);
			const THREE_Box = o.geometry.boundingBox ?? (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
			const b = THREE_Box.clone().applyMatrix4(o.matrixWorld);
			return { min: b.min.toArray(), max: b.max.toArray() };
		}, boxId);
	p0 = await pose(page, boxId);
	let w0 = await world();
	// which way +X goes on screen: from the -X face cone toward the +X one
	const xPlus = await handleAt(page, 'faces', 'X', 0.5);
	await page.mouse.move(xPlus.x, xPlus.y);
	await page.waitForTimeout(60);
	await page.mouse.down();
	// outward = from the box's centre through the cone, on screen
	const ctr = await handleAt(page, 'mover');
	const len = Math.hypot(xPlus.x - ctr.x, xPlus.y - ctr.y) || 1;
	const ux = (xPlus.x - ctr.x) / len, uy = (xPlus.y - ctr.y) / len;
	await page.mouse.move(xPlus.x + 30 * ux, xPlus.y + 30 * uy, { steps: 3 });
	await page.mouse.move(xPlus.x + 90 * ux, xPlus.y + 90 * uy, { steps: 6 });
	await page.waitForTimeout(100);
	const label = await page.evaluate(() => document.querySelector('.gizmo-size-label')?.textContent ?? null);
	await page.mouse.up();
	await page.waitForTimeout(300);
	let w1 = await world();
	p1 = await pose(page, boxId);
	const grewX = Math.abs(w1.max[0] - w1.min[0] - (w0.max[0] - w0.min[0])) > 0.05;
	const oneSide = near(w1.min[0], w0.min[0], 2e-3) || near(w1.max[0], w0.max[0], 2e-3);
	h.check(grewX && oneSide && near(p1.scale[1], p0.scale[1]) && near(p1.scale[2], p0.scale[2]), `5.2 a face cone pushes one side; the other side stays (x ${w0.min[0].toFixed(3)}..${w0.max[0].toFixed(3)} -> ${w1.min[0].toFixed(3)}..${w1.max[0].toFixed(3)})`);
	h.check(!!label && /×/.test(label) && /m$/.test(label), `5.3 the size shows while dragging (${label})`);
	h.check(!(await page.evaluate(() => !!document.querySelector('.gizmo-size-label'))), `5.4 the size goes when the drag ends`);
	await undo(page);
	w0 = await world();
	at = await handleAt(page, 'corners');
	await drag(page, at, 60, 60);
	w1 = await world();
	p1 = await pose(page, boxId);
	const fixedCorner = [0, 1, 2].every((i) => near(w1.min[i], w0.min[i], 3e-3) || near(w1.max[i], w0.max[i], 3e-3));
	h.check(Math.abs(p1.scale[0] - p0.scale[0]) > 0.02 && near(p1.scale[0], p1.scale[1], 1e-4) && fixedCorner, `5.5 a corner resizes evenly, the opposite corner stays (${fx(p1.scale)})`);
	await undo(page);
	at = await handleAt(page, 'arc', undefined, 0.5);
	await drag(page, at, 80, 10);
	p1 = await pose(page, boxId);
	h.check(Math.abs(p1.rot[1] - p0.rot[1]) > 0.03 || Math.abs(p1.rot[0] - p0.rot[0]) > 0.03, `5.6 the arc turns it (${fx(p1.rot)})`);
	await undo(page);

	// ---- 6. press-and-drag from the bar's Move button ------------------------------------------------
	await setStyle(page, 'B');
	await select('6.0');
	p0 = await pose(page, boxId);
	const btn = await page.evaluate(() => {
		const r = document.querySelector('p[title="Move (1)"]')?.getBoundingClientRect();
		return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
	});
	h.check(!!btn, `6.0 the Move button is on the bar`);
	if (btn) {
		const hsBefore = await handleSetNow(page);
		await page.mouse.move(btn.x, btn.y);
		await page.mouse.down();
		await page.mouse.move(btn.x + 10, btn.y - 20, { steps: 3 });
		await page.mouse.move(btn.x + 120, btn.y - 160, { steps: 10 });
		await page.waitForTimeout(150);
		await page.mouse.up();
		await page.waitForTimeout(400);
		p1 = await pose(page, boxId);
		const hsAfter = await handleSetNow(page);
		h.check(Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[1] - p0.pos[1], p1.pos[2] - p0.pos[2]) > 0.1 && hsAfter === hsBefore, `6.1 a press that travels from Move moves the box at once, and is not a click (${fx(p1.pos)}, ${hsBefore} -> ${hsAfter})`);
		await undo(page);
		p1 = await pose(page, boxId);
		h.check(near(p1.pos[0], p0.pos[0]) && near(p1.pos[1], p0.pos[1]), `6.2 one undo puts it back`);
	}

	// ---- 7. a second peer sees it ---------------------------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await B.page.waitForTimeout(2500);
	await select('7.0');
	p0 = await pose(page, boxId);
	at = await handleAt(page, 'arrows', 'X');
	await drag(page, at, 110, 0);
	p1 = await pose(page, boxId);
	await B.page.waitForTimeout(1500);
	const pb = await pose(B.page, boxId);
	h.check(!!pb && near(pb.pos[0], p1.pos[0], 1e-3) && Math.abs(p1.pos[0] - p0.pos[0]) > 0.1, `7.1 B: peer B sees the arrow drag (${pb && fx(pb.pos)} vs ${fx(p1.pos)})`);
	await setStyle(page, 'D');
	await select('7.2');
	at = await handleAt(page, 'faces', 'Y', 0.5);
	await drag(page, at, 0, -70);
	p1 = await pose(page, boxId);
	await B.page.waitForTimeout(1500);
	const pb2 = await pose(B.page, boxId);
	h.check(!!pb2 && near(pb2.scale[1], p1.scale[1], 1e-3) && near(pb2.pos[1], p1.pos[1], 1e-3) && Math.abs(p1.scale[1] - p0.scale[1]) > 0.02, `7.2 D: peer B sees the push (scale ${pb2 && fx(pb2.scale)} vs ${fx(p1.scale)}, y ${pb2?.pos[1].toFixed(3)} vs ${p1.pos[1].toFixed(3)})`);

	// ---- 8. Settings ---------------------------------------------------------------------------------
	await page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.settingsOpen.set(false);
		s.settingsSection.set('scene');
		s.settingsOpen.set(true);
	});
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(500);
	const rows = await page.evaluate(() => ({
		style: !!document.querySelector('#gizmo-style'),
		size: !!document.querySelector('#gizmo-size'),
		only: document.querySelectorAll('[data-gizmo-kind]').length
	}));
	h.check(rows.style && rows.size && rows.only > 0, `8.1 Settings ▸ Scene ▸ Gizmo: style, size, show only (${JSON.stringify(rows)})`);
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await setStyle(page, 'B');
	await page.evaluate(async () => {
		const p = await window.__tp.test.v1.gizmoHide;
		p.setKindShown('B', 'rings', false);
	});
	await select('8.2');
	await page.waitForTimeout(300);
	g = await gizmo(page);
	h.check(!g.kinds.includes('rings') && g.kinds.includes('arrows'), `8.2 show only: rings off hides the rings (${g.kinds})`);
	await page.evaluate(async () => {
		(await window.__tp.test.v1.gizmoHide).setKindShown('B', 'rings', true);
		const p = await window.__tp.test.v1.gizmoPrefs;
		p.gizmoSize.set('L');
	});
	await page.waitForTimeout(300);
	const size = await page.evaluate(() => {
		let tc;
		window.__tp.test.v1.TControls.subscribe((v) => (tc = v))();
		return tc.size;
	});
	h.check(near(size, 1.3), `8.3 size L = 1.3 x (${size})`);

	void start;
	await h.finish(browser);
});
