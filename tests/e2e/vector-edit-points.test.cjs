// Roadmap 64 D5 (lane 64-vector-edit) rows 1 + 2 — EDIT AFTER DRAWING and SNAP, with real mouse input:
//  1 draw a 4-point pen path, open Edit points, Shift-click THREE anchors, drag them: all three move by
//    the same amount, the pressed one lands ON THE GRID (scene grid snap, 0.25 m), ONE undo entry, B sees it
//  2 arrow keys nudge the picked set by the grid step (one undo each)
//  3 smart guides: with the grid off, an anchor dragged next to another shape's corner takes its x exactly
//    and the guide line shows while dragging
//  4 C closes the path, K splits it at a picked point (opens the loop there), Delete removes a picked
//    pair — each one undo entry, each seen by B; undo brings the previous outline back on B
//  5 the 64-2d toolbar's plane lock: armVectorTool(kind, {planeZ}) draws on the XY plane at that z
const h = require('./helpers.cjs');

const rec = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? JSON.parse(JSON.stringify(o.userData.geometryParams.params)) : null);
				})()
			),
		uuid
	);
/** a shape's local plane point -> world */
const toWorld = (page, uuid, xy) =>
	page.evaluate(
		([uuid, xy]) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g.getObjectByProperty('uuid', uuid);
					o.updateMatrixWorld(true);
					r(o.localToWorld(o.position.clone().set(xy[0], xy[1], 0)).toArray());
				})()
			),
		[uuid, xy]
	);
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const dbg = (page) => page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
const onGrid = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-4;
const vectorUuids = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const out = [];
					g.traverse((o) => o.userData?.geometryParams?.gtype === 'Vector' && out.push(o.uuid));
					r(out);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- a reference rectangle and a 4-point open pen path on the floor ---------------------
	// lying on the floor, 4 mm up — the plane a pen click on the ground draws in
	const rect = await A.page.evaluate(
		() =>
			window.__stores.vectorActions.addVectorShape(window.__stores.vectorRecord.vectorDefaults('rect'), {
				position: [1.6, 0.004, 0.4],
				quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
				select: false
			})?.uuid
	);
	await h.eventually(() => rec(B.page, rect), (p) => !!p, 'B has the reference rectangle');
	await A.page.evaluate(() => window.__stores.vectorTool.armVectorTool('pen'));
	h.check(await A.page.locator('#vector-toolbar').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false), 'the pen is armed');
	const before = await vectorUuids(A.page);
	for (const w of [[-1.4, 0, 0.9], [-0.7, 0, -0.3], [0.1, 0, 0.8], [0.8, 0, -0.2]]) {
		const s = await h.projectPoint(A.page, w);
		await A.page.mouse.click(s.x, s.y);
		await A.page.waitForTimeout(150);
	}
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	const path = (await vectorUuids(A.page)).find((u) => !before.includes(u));
	h.check(!!path, 'four clicks + Enter draw an open path');
	await A.page.evaluate(() => window.__stores.vectorTool.disarmVectorTool());
	await h.eventually(() => rec(B.page, path), (p) => p?.paths?.[0]?.nodes?.length === 4, 'B sees the 4-point path');

	// ---- 1 pick three anchors with Shift, drag them with the grid on -----------------------
	await A.page.evaluate(() => {
		window.__stores.snapping.snapSettings.update((s) => ({ ...s, translate: 0.25 }));
		window.__stores.snapping.snapEnabled.set(true);
	});
	await A.page.evaluate((u) => window.__stores.vectorEdit.enterVectorEdit(u), path);
	h.check(await A.page.locator('#vector-edit-toolbar').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false), 'the Edit points strip appears');
	let d = await dbg(A.page);
	await A.page.mouse.click(d.screen[0][1][0], d.screen[0][1][1]);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(d.screen[0][2][0], d.screen[0][2][1]);
	await A.page.mouse.click(d.screen[0][3][0], d.screen[0][3][1]);
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(200);
	d = await dbg(A.page);
	h.check(d.picks.length === 3 && d.picks.every((p) => p.index >= 1), `Shift-click picks three anchors (${JSON.stringify(d.picks)})`);
	h.check((await A.page.locator('#vector-edit-count').textContent())?.trim() === '3 picked', 'the strip says 3 picked');
	const base = d.paths[0].nodes.map((n) => [n.x, n.y]);
	let depth = await undoDepth(A.page);
	const grab = d.screen[0][2];
	await A.page.mouse.move(grab[0], grab[1]);
	await A.page.mouse.down();
	await A.page.mouse.move(grab[0] + 37, grab[1] - 23, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	d = await dbg(A.page);
	const moved = d.paths[0].nodes.map((n, i) => [n.x - base[i][0], n.y - base[i][1]]);
	h.check(Math.hypot(...moved[0]) < 1e-9, 'the unpicked anchor stays');
	h.check(Math.hypot(...moved[2]) > 0.05 && [1, 3].every((i) => Math.hypot(moved[i][0] - moved[2][0], moved[i][1] - moved[2][1]) < 1e-6), 'the three picked anchors move together, by the same amount');
	const lead = await toWorld(A.page, path, [d.paths[0].nodes[2].x, d.paths[0].nodes[2].y]);
	h.check(onGrid(lead[0], 0.25) && onGrid(lead[2], 0.25), `the pressed anchor lands on the 0.25 m grid (world ${lead.map((v) => v.toFixed(3))})`);
	h.check((await undoDepth(A.page)) === depth + 1, 'the three-point drag is ONE undo entry');
	await h.eventually(
		() => rec(B.page, path),
		(p) => [1, 2, 3].every((i) => Math.abs(p.paths[0].nodes[i].x - d.paths[0].nodes[i].x) < 1e-6 && Math.abs(p.paths[0].nodes[i].y - d.paths[0].nodes[i].y) < 1e-6),
		'B sees all three anchors where A left them'
	);

	// ---- 2 arrow nudge = the grid step -------------------------------------------------------
	depth = await undoDepth(A.page);
	const n0 = (await dbg(A.page)).paths[0].nodes[3];
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(250);
	const n1 = (await dbg(A.page)).paths[0].nodes[3];
	h.check(Math.abs(n1.x - n0.x - 0.25) < 1e-6 && Math.abs(n1.y - n0.y) < 1e-9, `ArrowRight nudges the set one grid step (${(n1.x - n0.x).toFixed(3)} m)`);
	h.check((await undoDepth(A.page)) === depth + 1, 'the nudge is one undo entry');

	// ---- 3 smart guides: grid off, line an anchor up with the rectangle's corner -------------
	await A.page.evaluate(() => window.__stores.snapping.snapEnabled.set(false));
	d = await dbg(A.page);
	await A.page.mouse.click(d.screen[0][0][0], d.screen[0][0][1]); // pick only anchor 0
	await A.page.waitForTimeout(150);
	d = await dbg(A.page);
	h.check(d.picks.length === 1 && d.picks[0].index === 0, 'a plain click picks one anchor');
	// the rectangle's corner in the PATH's plane coordinates, and a target 3 px off its x
	const corner = await A.page.evaluate(
		([path, rect]) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const p = g.getObjectByProperty('uuid', path);
					const q = g.getObjectByProperty('uuid', rect);
					p.updateMatrixWorld(true);
					q.updateMatrixWorld(true);
					const w = q.localToWorld(q.position.clone().set(-0.5, 0.5, 0));
					const l = p.worldToLocal(w.clone());
					r([l.x, l.y]);
				})()
			),
		[path, rect]
	);
	await A.page.waitForTimeout(450); // past the 350 ms double-click window (a second press would convert)
	const node0 = d.paths[0].nodes[0];
	const targetLocal = [corner[0], node0.y + 0.35];
	const targetWorld = await toWorld(A.page, path, targetLocal);
	const t = await h.projectPoint(A.page, targetWorld);
	await A.page.mouse.move(d.screen[0][0][0], d.screen[0][0][1]);
	await A.page.mouse.down();
	await A.page.mouse.move(t.x + 3, t.y, { steps: 10 });
	await A.page.waitForTimeout(150);
	const mid = await A.page.evaluate(() => window.__stores.vectorSnap.snapGuidesDebug());
	h.check(mid.shown && mid.segments >= 1, 'a smart guide shows while the anchor lines up with the corner');
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	d = await dbg(A.page);
	h.check(Math.abs(d.paths[0].nodes[0].x - corner[0]) < 1e-6, `the anchor takes the corner's x exactly (${d.paths[0].nodes[0].x.toFixed(4)} vs ${corner[0].toFixed(4)})`);
	if (Math.abs(d.paths[0].nodes[0].x - corner[0]) >= 1e-6)
		console.log('  guide diag: ' + JSON.stringify({ node0, targetLocal, targetWorld, screen: t, pressed: d.screen[0][0], lastSnap: d.lastSnap }));
	h.check(!(await A.page.evaluate(() => window.__stores.vectorSnap.snapGuidesDebug())).shown, 'the guide goes on release');

	// ---- 4 close, split, delete a pair ---------------------------------------------------------
	depth = await undoDepth(A.page);
	await A.page.keyboard.press('c');
	await A.page.waitForTimeout(250);
	h.check((await dbg(A.page)).paths[0].closed === true, 'C closes the open path');
	await h.eventually(() => rec(B.page, path), (p) => p.paths[0].closed === true, 'B sees it closed');
	d = await dbg(A.page);
	await A.page.mouse.click(d.screen[0][2][0], d.screen[0][2][1]);
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('k');
	await A.page.waitForTimeout(250);
	d = await dbg(A.page);
	h.check(d.paths[0].closed === false && d.paths[0].nodes.length === 5, `K opens the loop at the picked point (5 points, open: ${d.paths[0].nodes.length})`);
	const first = d.paths[0].nodes[0];
	const last = d.paths[0].nodes[4];
	h.check(Math.hypot(first.x - last.x, first.y - last.y) < 1e-9, 'the split point is both ends');
	await A.page.mouse.click(d.screen[0][1][0], d.screen[0][1][1]);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(d.screen[0][3][0], d.screen[0][3][1]);
	await A.page.keyboard.up('Shift');
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(250);
	h.check((await dbg(A.page)).paths[0].nodes.length === 3, 'Delete removes both picked points');
	h.check((await undoDepth(A.page)) === depth + 3, 'close, split and delete: one undo entry each');
	await h.eventually(() => rec(B.page, path), (p) => p.paths[0].nodes.length === 3 && !p.paths[0].closed, 'B sees the 3-point open path');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => rec(B.page, path), (p) => p.paths[0].nodes.length === 5, 'one undo brings the two points back on B');

	// ---- the strip's buttons say what is possible -------------------------------------------
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(!(await A.page.locator('#vector-edit-toolbar').isVisible()), 'Esc ends the session');

	// ---- 5 the 2D toolbar's plane lock (src/lib/vector/tools2d.js -> armVectorTool(kind, {planeZ})) ------------
	// 64-2d's flat view looks down -Z at the XY plane: a drag on empty space draws THERE, never on the floor behind
	const before5 = await vectorUuids(A.page);
	await A.page.evaluate(() => window.__stores.vectorTool.armVectorTool('rect', { planeZ: 0.5 }));
	const q0 = await h.projectPoint(A.page, [-0.4, 0.9, 0.5]);
	const q1 = await h.projectPoint(A.page, [0.3, 1.5, 0.5]);
	await A.page.mouse.move(q0.x, q0.y);
	await A.page.mouse.down();
	await A.page.mouse.move(q1.x, q1.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.vectorTool.disarmVectorTool());
	const locked = (await vectorUuids(A.page)).find((u) => !before5.includes(u));
	const pose = locked
		? await A.page.evaluate(
				(u) =>
					new Promise((r) =>
						window.__stores.objectsGroup.subscribe((g) => {
							const o = g.getObjectByProperty('uuid', u);
							o.updateMatrixWorld(true);
							const e = o.matrixWorld.elements;
							const l = Math.hypot(e[8], e[9], e[10]);
							r({ normal: [e[8] / l, e[9] / l, e[10] / l], z: e[14] });
						})()
				),
				locked
			)
		: null;
	h.check(!!pose && pose.normal[2] > 0.999 && Math.abs(pose.z - 0.5) < 0.01, `5. with planeZ the drag draws on the XY plane at z 0.5, facing +Z (${pose && pose.z.toFixed(3)})`);

	await h.finish(browser);
});
