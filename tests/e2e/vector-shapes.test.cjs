// Roadmap 64 D1 — vector shapes: drag out a rectangle / ellipse / star / polygon with real mouse
// drags, draw a pen path (corners, a smooth click-drag point, click the first point to close),
// edit its points, change the live corner radius — and a peer sees every step with ONE undo
// entry each (the shape is an ordinary mesh stamped {gtype: 'Vector'}, so it rides the object /
// geometry messages). A late joiner gets the record and can edit it.
const h = require('./helpers.cjs');

/** every vector shape on a page: uuid, kind, record, world centre */
const shapes = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const out = [];
					g?.traverse((o) => {
						const gp = o.userData?.geometryParams;
						if (gp?.gtype !== 'Vector') return;
						try {
						o.updateMatrixWorld(true);
						o.geometry.computeBoundingBox();
						const c = o.geometry.boundingBox.getCenter(o.position.clone()).applyMatrix4(o.matrixWorld);
						out.push({
							uuid: o.uuid,
							name: o.name,
							kind: gp.params.kind,
							params: gp.params,
							centre: c.toArray(),
							verts: o.geometry.attributes.position?.count ?? 0,
							colours: !!o.geometry.attributes.color,
							vertexColors: !!o.material?.vertexColors
						});
						} catch (error) {
							// a shape this helper cannot read is a finding, not a missing object
							out.push({ uuid: o.uuid, name: o.name, kind: gp.params?.kind, params: gp.params, error: String(error), type: o.type, hasGeometry: !!o.geometry });
						}
					});
					resolve(out);
				})();
			})
	);
const byUuid = async (page, uuid) => (await shapes(page)).find((s) => s.uuid === uuid) ?? null;
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** a real press-drag-release between two world points */
async function dragWorld(page, from, to, steps = 8) {
	const a = await h.projectPoint(page, from);
	const b = await h.projectPoint(page, to);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps });
	await page.mouse.up();
	await page.waitForTimeout(250);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- arm from the toolbar's entry point -------------------------------
	await A.page.evaluate(() => window.__stores.vectorTool.armVectorTool('rect'));
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#vector-toolbar').isVisible(), 'the vector toolbar appears when a tool is armed');
	const armed = await A.page.evaluate(() => window.__stores.vectorTool.vectorToolDebug());
	h.check(armed.tool === 'rect' && armed.armed, 'Rectangle is armed and the pointer seam is registered');

	// ---- each parametric kind from a real drag on the ground ---------------
	/** @type {Record<string, any>} */
	const made = {};
	// the draw frame's +X is the CAMERA's right laid on the plane, so a 1 x 1 box drag is built
	// from that axis and its in-plane perpendicular (a world-diagonal drag can run along one axis)
	const [rx, rz] = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) => {
					const e = c.matrixWorld.elements;
					const l = Math.hypot(e[0], e[2]) || 1;
					r([e[0] / l, e[2] / l]);
				})()
			)
	);
	const box = (cx, cz) => [
		[cx - (rx - rz) / 2, 0, cz - (rz + rx) / 2],
		[cx + (rx - rz) / 2, 0, cz + (rz + rx) / 2]
	];
	const drags = {
		rect: box(-1.9, 0.1),
		ellipse: box(-0.5, 0.1),
		star: [[1.0, 0, 0.1], [1.5, 0, 0.1]],
		polygon: [[2.4, 0, 0.1], [2.8, 0, 0.1]]
	};
	for (const [kind, [from, to]] of Object.entries(drags)) {
		// a button press on the ARMED tool disarms it (the toggle), so rect — armed above — is not pressed again
		if ((await A.page.evaluate(() => window.__stores.vectorTool.vectorToolDebug().tool)) !== kind) await A.page.locator(`#vector-tool-${kind}`).click();
		const before = (await shapes(A.page)).length;
		const depth = await undoDepth(A.page);
		await dragWorld(A.page, from, to);
		const list = await shapes(A.page);
		const shape = list.find((s) => s.kind === kind && !Object.values(made).some((m) => m.uuid === s.uuid));
		made[kind] = shape;
		h.check(list.length === before + 1 && !!shape, `a drag with ${kind} armed makes one ${kind} shape`);
		h.check((await undoDepth(A.page)) === depth + 1, `${kind}: exactly one undo entry`);
		if (!shape) continue;
		h.check(shape.verts > 0 && shape.colours && shape.vertexColors, `${kind}: a filled mesh with vertex colours`);
		if (kind === 'rect' || kind === 'ellipse') {
			const mid = from.map((v, i) => (v + to[i]) / 2);
			h.check(near(shape.centre, mid, 0.2), `${kind}: centred between the press and the release (${shape.centre.map((v) => v.toFixed(2))})`);
			h.check(Math.abs(shape.params.width - 1) < 0.1 && Math.abs(shape.params.height - 1) < 0.1, `${kind}: a 1 x 1 drag makes a 1 x 1 shape (${shape.params.width.toFixed(2)} x ${shape.params.height.toFixed(2)})`);
		} else {
			h.check(Math.abs(shape.params.radius - Math.hypot(to[0] - from[0], to[2] - from[2])) < 0.08, `${kind}: radius = the drag distance (${shape.params.radius.toFixed(2)})`);
			h.check(near(shape.centre, from, 0.25), `${kind}: centred on the press`);
		}
		await h.eventually(() => byUuid(B.page, shape.uuid), (s) => !!s && s.kind === kind && s.verts === shape.verts, `B sees the ${kind} (same uuid, same geometry)`);
	}

	// ---- a click without travel drops the default size -------------------
	await A.page.locator('#vector-tool-rect').click();
	const tapAt = await h.projectPoint(A.page, [0, 0, 2]);
	await A.page.mouse.click(tapAt.x, tapAt.y);
	await A.page.waitForTimeout(300);
	const tapped = (await shapes(A.page)).find((s) => !Object.values(made).some((m) => m.uuid === s.uuid));
	h.check(tapped?.params.width === 1 && tapped?.params.height === 1, 'a click with Rectangle armed drops a 1 x 1 rectangle');

	// ---- the pen: two corners, one smooth click-drag, click the first to close
	await A.page.locator('#vector-tool-pen').click();
	const penWorld = [[-1, 0, 2.6], [0, 0, 3.4], [1, 0, 2.6]];
	const p0 = await h.projectPoint(A.page, penWorld[0]);
	await A.page.mouse.click(p0.x, p0.y);
	await A.page.waitForTimeout(150);
	// the middle point is dragged out: a smooth node with mirrored handles
	await dragWorld(A.page, penWorld[1], [0.4, 0, 3.4], 6);
	const p2 = await h.projectPoint(A.page, penWorld[2]);
	await A.page.mouse.click(p2.x, p2.y);
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#vector-pen-count').textContent())?.trim() === '3 points', 'the pen placed three points');
	const draft = await A.page.evaluate(() => window.__stores.vectorTool.vectorToolDebug().pen);
	h.check(draft?.[1]?.smooth && Math.hypot(draft[1].ox, draft[1].oy) > 0.2 && Math.abs(draft[1].ox + draft[1].ix) < 1e-6, 'the click-dragged point is smooth with mirrored handles');
	const penDepth = await undoDepth(A.page);
	await A.page.mouse.click(p0.x, p0.y);
	await A.page.waitForTimeout(400);
	const path = (await shapes(A.page)).find((s) => s.kind === 'path');
	h.check(!!path && path.params.paths[0].closed && path.params.paths[0].nodes.length === 3, 'clicking the first point closes the path (3 nodes)');
	h.check(path?.params.fillType === 'solid', 'a closed pen path fills');
	h.check((await undoDepth(A.page)) === penDepth + 1, 'the finished path is one undo entry');
	await h.eventually(() => byUuid(B.page, path?.uuid), (s) => s?.kind === 'path' && s.params.paths[0].nodes.length === 3, 'B sees the pen path');
	if (!(await byUuid(B.page, path?.uuid)))
		console.log('  B has: ' + JSON.stringify((await shapes(B.page)).map((s) => [s.uuid.slice(0, 8), s.kind, s.error ?? 'ok'])) + ' A path ' + path?.uuid.slice(0, 8) + ' json ' + (await A.page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(JSON.stringify(g.getObjectByProperty('uuid', u)?.toJSON() ?? null).length))()), path?.uuid)) + ' bytes');

	// an open path: Enter finishes it
	const q0 = await h.projectPoint(A.page, [2, 0, 2.4]);
	const q1 = await h.projectPoint(A.page, [3, 0, 3.2]);
	await A.page.mouse.click(q0.x, q0.y);
	await A.page.waitForTimeout(400);
	await A.page.mouse.click(q1.x, q1.y);
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	const open = (await shapes(A.page)).find((s) => s.kind === 'path' && !s.params.paths[0].closed);
	h.check(!!open && open.params.fillType === 'none' && open.params.strokeWidth > 0, 'Enter finishes an OPEN path (stroked, not filled)');

	// Esc twice disarms
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(!(await A.page.locator('#vector-toolbar').isVisible()), 'Esc disarms the tool');

	// ---- the live corner radius (Inspector row = applyGeometry) ------------
	const rect = made.rect;
	const cornerDepth = await undoDepth(A.page);
	await A.page.evaluate((uuid) => window.__stores.vectorActions.setVectorParams(uuid, { corner: 0.2 }), rect.uuid);
	await h.eventually(() => byUuid(B.page, rect.uuid), (s) => s?.params.corner === 0.2 && s.verts !== rect.verts, 'B sees the corner radius change');
	h.check((await undoDepth(A.page)) === cornerDepth + 1, 'the corner radius edit is one undo entry');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => byUuid(B.page, rect.uuid), (s) => s?.params.corner === 0, 'undo puts the square corners back on B');

	// the Inspector shows the shape's rows and colours
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), made.star.uuid);
	// the Inspector opens on a timer that takes 0.5-1.5 s under e2e load: poll, never sleep
	const readInspector = () =>
		A.page.evaluate(() => ({
			section: !!document.querySelector('#vector-section'),
			fill: !!document.querySelector('#vector-colour-fill'),
			rows: document.querySelector('#inspector-geometry')?.textContent ?? ''
		}));
	await h.eventually(readInspector, (i) => i.section && /Points/.test(i.rows), 'the Inspector opens on the star');
	const inspector = await readInspector();
	h.check(inspector.section && inspector.fill, 'the Inspector shows the Shape section with a fill colour');
	h.check(/Points/.test(inspector.rows) && /Corner radius/.test(inspector.rows) && !/Width/.test(inspector.rows), 'the Geometry rows are the star\'s own (Points, Corner radius — no Width)');
	await A.page.evaluate((uuid) => window.__stores.vectorActions.setVectorParams(uuid, { fill: '#ff0000' }), made.star.uuid);
	await h.eventually(() => byUuid(B.page, made.star.uuid), (s) => s?.params.fill === '#ff0000', 'a fill colour change reaches B');

	// ---- edit points: a real drag on an anchor ------------------------------
	await A.page.evaluate((uuid) => window.__stores.vectorEdit.enterVectorEdit(uuid), path.uuid);
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#vector-edit-toolbar').isVisible(), 'the edit-points strip appears');
	const dbg = await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
	const anchor = dbg.screen[0][0];
	const editDepth = await undoDepth(A.page);
	await A.page.mouse.move(anchor[0], anchor[1]);
	await A.page.mouse.down();
	await A.page.mouse.move(anchor[0] - 40, anchor[1] + 30, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	const after = await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
	h.check(after.pick?.index === 0 && Math.hypot(after.paths[0].nodes[0].x - dbg.paths[0].nodes[0].x, after.paths[0].nodes[0].y - dbg.paths[0].nodes[0].y) > 0.05, 'dragging an anchor moves it');
	h.check((await undoDepth(A.page)) === editDepth + 1, 'the point drag is ONE undo entry');
	await h.eventually(
		() => byUuid(B.page, path.uuid),
		(s) => Math.abs(s?.params.paths[0].nodes[0].x - after.paths[0].nodes[0].x) < 1e-6,
		'B sees the moved point'
	);
	// insert on the outline (midpoint of segment 0 -> 1, on screen)
	const s0 = after.screen[0][0];
	const s1 = after.screen[0][1];
	const mid = await A.page.evaluate(() => {
		const d = window.__stores.vectorEdit.vectorEditDebug();
		const sub = d.paths[0];
		const { segmentControls, cubicAt } = window.__stores.vectorPath;
		return cubicAt(segmentControls(sub.nodes[0], sub.nodes[1]), 0.5);
	});
	h.check(!!s0 && !!s1 && !!mid, 'the outline midpoint is computable');
	await A.page.evaluate(() => window.__stores.vectorEdit.insertPoint(0, 0, 0.5));
	await A.page.waitForTimeout(300);
	h.check((await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug())).paths[0].nodes.length === 4, 'inserting on the outline adds a point');
	await A.page.keyboard.press('Delete');
	await A.page.waitForTimeout(300);
	const afterDel = await A.page.evaluate(() => window.__stores.vectorEdit.vectorEditDebug());
	h.check(afterDel.paths[0].nodes.length === 3, 'Delete removes the picked point (and not the shape)');
	h.check(!!(await byUuid(A.page, path.uuid)), 'the shape itself is still there');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(!(await A.page.locator('#vector-edit-toolbar').isVisible()), 'Esc ends the edit session');

	// ---- undo removes a created shape everywhere, redo brings it back -------
	const spawned = await A.page.evaluate(() => window.__stores.vectorActions.placeVectorShape('polygon', [0, 0, -2])?.uuid);
	await h.eventually(() => byUuid(B.page, spawned), (s) => !!s, 'Add ▸ Vector ▸ Polygon reaches B');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => byUuid(B.page, spawned), (s) => !s, 'one undo removes it from B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => byUuid(B.page, spawned), (s) => s?.kind === 'polygon', 'redo brings it back on B');

	// ---- a late joiner gets the records -------------------------------------
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await h.eventually(
		() => byUuid(C.page, made.star.uuid),
		(s) => s?.kind === 'star' && s.params.fill === '#ff0000',
		'a late joiner receives the star WITH its record',
		30000 // a third page on software GL is slow to boot and to drain the handshake (arch-primitives, script-nodes)
	);
	if (!(await byUuid(C.page, made.star.uuid)))
		console.log(
			'  C holds: ' +
				JSON.stringify(
					await C.page.evaluate(
						(u) =>
							new Promise((r) =>
								window.__stores.objectsGroup.subscribe((g) => {
									const o = g?.getObjectByProperty('uuid', u);
									r({ children: g?.children.length, star: o ? { type: o.type, keys: Object.keys(o.userData ?? {}), gp: o.userData?.geometryParams?.gtype } : null });
								})()
							),
						made.star.uuid
					)
				)
		);
	const lateEdit = await C.page.evaluate((uuid) => window.__stores.vectorActions.setVectorParams(uuid, { points: 7 }), made.star.uuid);
	h.check(lateEdit, 'the late joiner can edit the shape');
	await h.eventually(() => byUuid(A.page, made.star.uuid), (s) => s?.params.points === 7, 'A sees the late joiner\'s edit');

	await h.finish(browser);
});
