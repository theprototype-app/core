// 103-keys row 5: Move / Rotate / Resize now inside Edit Mesh, on the picked faces / edges (the
// session's own gizmo proxy, so the commit is the kernel session's, exactly as a gizmo drag).
//   1  default keys: G still arms Move (no gesture starts)
//   2  Blender preset, faces: G Y 0.5 Enter lifts the top face 0.5; one undo step puts it back
//   3  Esc cancels: the geometry is unchanged, NO undo entry, and the session stays open
//   4  edges: G Y 0.25 Enter lifts the picked edge
//   5  S 2 Enter on a face doubles it about its centre
//   6  vertices: G X 0.5 Enter moves one picked vertex 0.5 along X; Esc on a second gesture records nothing
const h = require('./helpers.cjs');

/** the box's local vertex extent */
const extent = (page) =>
	page.evaluate(() => {
		const pos = window.__box.geometry.attributes.position;
		let maxX = -Infinity, maxY = -Infinity, minX = Infinity;
		let topMinX = Infinity, topMaxX = -Infinity;
		for (let i = 0; i < pos.count; i++) {
			maxX = Math.max(maxX, pos.getX(i));
			minX = Math.min(minX, pos.getX(i));
			maxY = Math.max(maxY, pos.getY(i));
		}
		for (let i = 0; i < pos.count; i++)
			if (Math.abs(pos.getY(i) - maxY) < 1e-4) {
				topMinX = Math.min(topMinX, pos.getX(i));
				topMaxX = Math.max(topMaxX, pos.getX(i));
			}
		return { maxX, minX, maxY, topW: topMaxX - topMinX };
	});
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((v) => r(v.length))()));
const state = (page) => page.evaluate(() => window.__tp.test.v1.modalTransform.modalTransformState());
const seated = (page) =>
	page.evaluate(() => {
		let c;
		window.__tp.test.v1.TControls.subscribe((x) => (c = x))();
		return c?.object?.userData?.isFaceProxy ? 'face' : c?.object?.userData?.isVertexProxy ? 'vertex' : c?.object ? 'object' : null;
	});
const sessionOpen = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.faceEdit.faceEditObject.subscribe((o) => r(!!o))()));
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

/** press a start-at-once key and wait until its gesture runs (lazy chunk) */
async function startNow(page, key) {
	await page.keyboard.press(key);
	await page.waitForFunction(() => !!document.querySelector('#modal-transform-line'), null, { timeout: 8000 }).catch(() => {});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const uuid = await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__box = box;
		return box.uuid;
	});
	await page.waitForTimeout(800);
	await page.evaluate((u) => {
		const s = window.__tp?.test.v1;
		s.objectActions.selectObject(u);
		s.faceEdit.enterFaceEdit(u);
		s.faceEdit.setFaceSubmode('faces');
	}, uuid);
	await page.waitForTimeout(600);
	// a REAL click on the top face picks it and seats the face gizmo
	const top = await h.projectPoint(page, [0.3, 1, 0.3]);
	await page.mouse.click(Math.round(top.x), Math.round(top.y));
	await page.waitForTimeout(400);
	h.check((await seated(page)) === 'face', `0.1 premise: a click on the top face seats the face gizmo (${await seated(page)})`);
	const e0 = await extent(page);
	h.check(near(e0.maxY, 1), `0.2 premise: the top sits at y = 1 (${e0.maxY})`);

	// ---- 1. default keys ------------------------------------------------------------------------
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(500);
	h.check(!(await state(page)).active && near((await extent(page)).maxY, 1), `1.1 default: G arms Move and starts no gesture`);

	// ---- 2. Blender preset, faces: G Z 0.5 -----------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('blender'));
	const d0 = await undoDepth(page);
	await page.mouse.move(Math.round(top.x), Math.round(top.y));
	await startNow(page, 'KeyG');
	const st2 = await state(page);
	await page.keyboard.press('KeyY');
	await page.keyboard.type('0.5');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(600);
	const e2 = await extent(page);
	const d2 = await undoDepth(page);
	h.check(st2.active && st2.mesh, `2.1 G starts a mesh gesture at once (${JSON.stringify(st2)})`);
	h.check(near(e2.maxY, 1.5, 1e-3) && near(e2.maxX, 1) && (await sessionOpen(page)), `2.2 G Y 0.5 Enter lifts the top face 0.5 (max y ${e2.maxY.toFixed(4)}, max x ${e2.maxX.toFixed(4)}), the session stays open`);
	h.check(d2 === d0 + 1, `2.3 ONE undo entry (${d0} -> ${d2})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(600);
	h.check(near((await extent(page)).maxY, 1), `2.4 one undo puts it back (max y ${(await extent(page)).maxY.toFixed(4)})`);

	// ---- 3. Esc cancels -------------------------------------------------------------------------------
	if ((await seated(page)) !== 'face') {
		await page.mouse.click(Math.round(top.x), Math.round(top.y));
		await page.waitForTimeout(400);
	}
	const d3 = await undoDepth(page);
	await page.mouse.move(Math.round(top.x), Math.round(top.y));
	await startNow(page, 'KeyG');
	await page.mouse.move(Math.round(top.x) + 80, Math.round(top.y) - 60, { steps: 5 });
	await page.waitForTimeout(200);
	const moving = await extent(page);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(600);
	const e3 = await extent(page);
	h.check(Math.abs(moving.maxY - 1) > 1e-3 || Math.abs(moving.maxX - 1) > 1e-3, `3.1 the face follows the pointer live (max y ${moving.maxY.toFixed(3)}, max x ${moving.maxX.toFixed(3)})`);
	h.check(near(e3.maxY, 1) && near(e3.maxX, 1) && (await sessionOpen(page)) && (await undoDepth(page)) === d3, `3.2 Esc puts it back, records nothing and keeps the session (depth ${d3} -> ${await undoDepth(page)}, open ${await sessionOpen(page)})`);

	// ---- 5. S 2 on the face -----------------------------------------------------------------------------
	await page.mouse.move(Math.round(top.x), Math.round(top.y));
	await startNow(page, 'KeyS');
	await page.keyboard.type('2');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(600);
	const e5 = await extent(page);
	h.check(near(e5.topW, 4, 1e-3) && near(e5.maxY, 1, 1e-3), `5.1 S 2 Enter doubles the top face about its centre (top width ${e5.topW.toFixed(4)}, y ${e5.maxY.toFixed(4)})`);
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	await page.waitForTimeout(600);

	// ---- 4. edges ---------------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.faceEdit.setFaceSubmode('edges'));
	await page.waitForTimeout(400);
	const edge = await h.projectPoint(page, [0, 0.94 * 1, 1]);
	const edgePx = await h.projectPoint(page, [0, 1, 0.94]);
	await page.mouse.click(Math.round(edgePx.x), Math.round(edgePx.y));
	await page.waitForTimeout(400);
	const picked = await page.evaluate(() => window.__tp.test.v1.faceEdit.edgeSelectionSize());
	h.check(picked === 1 && (await seated(page)) === 'face', `4.0 premise: one edge picked, the gizmo seated (${picked})`);
	const e4a = await extent(page);
	await page.mouse.move(Math.round(edge.x), Math.round(edge.y));
	await startNow(page, 'KeyG');
	await page.keyboard.press('KeyY');
	await page.keyboard.type('0.25');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(600);
	const e4 = await extent(page);
	h.check(near(e4.maxY, e4a.maxY + 0.25, 1e-3), `4.1 edges: G Y 0.25 Enter lifts the picked edge (max y ${e4a.maxY.toFixed(3)} -> ${e4.maxY.toFixed(3)})`);

	// ---- 6. vertices ------------------------------------------------------------------------------------
	const v0 = await page.evaluate((u) => {
		const s = window.__tp?.test.v1;
		s.faceEdit.exitFaceEdit();
		s.meshEdit.enterEditMode(u);
		s.meshEdit.selectHandle(0);
		const pos = window.__box.geometry.attributes.position;
		return { x: pos.getX(0), y: pos.getY(0), z: pos.getZ(0) };
	}, uuid);
	await page.waitForTimeout(500);
	h.check((await seated(page)) === 'vertex', `6.0 premise: a picked vertex seats the vertex gizmo (${await seated(page)})`);
	const vAt = (page) => page.evaluate(() => { const p = window.__box.geometry.attributes.position; return { x: p.getX(0), y: p.getY(0), z: p.getZ(0) }; });
	const d6 = await undoDepth(page);
	await page.mouse.move(Math.round(top.x), Math.round(top.y));
	await startNow(page, 'KeyG');
	await page.keyboard.press('KeyX');
	await page.keyboard.type('0.5');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(600);
	const v1 = await vAt(page);
	h.check(near(v1.x, v0.x + 0.5) && near(v1.y, v0.y) && near(v1.z, v0.z) && (await undoDepth(page)) === d6 + 1, `6.1 vertices: G X 0.5 Enter moves the vertex 0.5 along X as one undo step (${v0.x.toFixed(3)} -> ${v1.x.toFixed(3)}, depth ${d6} -> ${await undoDepth(page)})`);
	const d6b = await undoDepth(page);
	await startNow(page, 'KeyG');
	await page.mouse.move(Math.round(top.x) + 70, Math.round(top.y) + 40, { steps: 5 });
	await page.waitForTimeout(200);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	const v2 = await vAt(page);
	h.check(near(v2.x, v1.x) && near(v2.y, v1.y) && near(v2.z, v1.z) && (await undoDepth(page)) === d6b, `6.2 Esc puts the vertex back and records nothing (depth ${d6b} -> ${await undoDepth(page)})`);

	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('theprototype'));
	await h.finish(browser);
});
