// 103-keys row 3: the UV editor's start-at-once keys, U / V locks, tool keys and Shift-drag box select.
//   1  default keys unchanged: G still ARMS Move (no grab starts), the tool keys are unbound
//   2  Shift-drag on empty space with the Select tool box-selects
//   3  Blender preset: G starts the grab at once, X locks U, a click keeps it (one undo entry)
//   4  G + a right click cancels: the UVs go back, no menu opens
//   5  S + Y resizes V alone; Enter keeps it
//   6  the tool keys W / B / C / P pick Select / Box / Lasso / Paint
const h = require('./helpers.cjs');

const texturedBox = (page) =>
	page.evaluate(async () => {
		const w = window.__tp?.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f00';
		ctx.fillRect(0, 0, 64, 64);
		box.material.map = new w.THREE.CanvasTexture(c);
		box.material.needsUpdate = true;
		w.objectActions.selectObject(box.uuid);
		return box.uuid;
	});

const dbg = (page) => page.evaluate(() => window.__uvDebug());
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((v) => r(v.length))()));
const uvs = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__tp?.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const uv = g.getObjectByProperty('uuid', uuid).geometry.attributes.uv;
		return window.__uvDebug().selectedIndices.map((i) => [uv.getX(i), uv.getY(i)]);
	}, uuid);
const span = (pts) => ({
	u: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
	v: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
	cu: pts.reduce((s, p) => s + p[0], 0) / pts.length,
	cv: pts.reduce((s, p) => s + p[1], 0) / pts.length
});
const canvasCentre = (page) =>
	page.evaluate(() => {
		const r = document.getElementById('uv-canvas').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, left: r.left, top: r.top };
	});
const focusUv = (page) => page.evaluate(() => document.getElementById('uv-canvas-wrap').focus());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	const uuid = await texturedBox(page);
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.uvEditorClose.set(false);
		s.bottomDock.activateDock('uv');
	});
	await page.waitForTimeout(900);
	const c = await canvasCentre(page);
	await focusUv(page);
	await page.keyboard.press('Control+KeyA');
	await page.waitForTimeout(300);
	const all = (await dbg(page)).selected;
	h.check(all > 0, `0.1 premise: Ctrl+A selects the UVs (${all})`);

	// ---- 1. default keys -------------------------------------------------------------------------
	await page.mouse.move(c.x + 20, c.y + 10);
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(300);
	const d1 = await dbg(page);
	const unbound = await page.evaluate(() => ['uv.now-move', 'uv.tool-box', 'uv.lock-u'].map((id) => window.__tp.test.v1.shortcutsRegistry.bindingOf(id)));
	h.check(!d1.grabbing && d1.xform === 'move' && unbound.every((k) => k === ''), `1.1 default: G arms Move and starts no grab; the new rows are unbound (${JSON.stringify(unbound)}, grabbing ${d1.grabbing})`);

	// ---- 2. Shift-drag box select ----------------------------------------------------------------
	await page.keyboard.press('Escape'); // drop the selection
	await page.waitForTimeout(200);
	h.check((await dbg(page)).selected === 0 && (await dbg(page)).tool === 'select', `2.0 premise: nothing selected, the Select tool armed`);
	const from = await page.evaluate(() => {
		const el = document.getElementById('uv-canvas');
		const r = el.getBoundingClientRect();
		// an empty spot outside the 0..1 square that is the canvas itself
		for (const [u, v] of [[-0.2, 1.2], [-0.1, 1.1], [-0.05, 1.05]]) {
			const p = window.__uvDebug().project(u, v);
			const x = r.left + p.x;
			const y = r.top + p.y;
			if (document.elementFromPoint(x, y) === el) return { x, y };
		}
		return { x: r.left + 12, y: r.top + 12 };
	});
	const to = await page.evaluate(() => {
		const r = document.getElementById('uv-canvas').getBoundingClientRect();
		const p = window.__uvDebug().project(1.1, -0.1);
		return { x: Math.min(r.right - 4, r.left + p.x), y: Math.min(r.bottom - 4, r.top + p.y) };
	});
	await page.keyboard.down('Shift');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 4 });
	await page.mouse.up();
	await page.keyboard.up('Shift');
	await page.waitForTimeout(300);
	const d2 = await dbg(page);
	h.check(d2.selected > 0 && d2.tool === 'select', `2.1 Shift-drag on empty space box-selects with the Select tool (${d2.selected} selected)`);
	if (!d2.selected) {
		await focusUv(page);
		await page.keyboard.press('Control+KeyA');
	}

	// ---- 3. Blender preset: G X, click keeps -----------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('blender'));
	await focusUv(page);
	await page.mouse.move(c.x, c.y);
	const before = await uvs(page, uuid);
	const depth0 = await undoDepth(page);
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(200);
	const g1 = await dbg(page);
	await page.keyboard.press('KeyX');
	await page.mouse.move(c.x + 30, c.y + 20, { steps: 3 });
	await page.mouse.move(c.x + 60, c.y + 40, { steps: 3 });
	await page.waitForTimeout(150);
	const live = await uvs(page, uuid);
	await page.mouse.click(c.x + 60, c.y + 40);
	await page.waitForTimeout(400);
	const kept = await uvs(page, uuid);
	const sb = span(before);
	const sl = span(live);
	h.check(g1.grabbing, `3.1 G starts the grab at once (grabbing ${g1.grabbing})`);
	h.check(Math.abs(sl.cu - sb.cu) > 0.01 && Math.abs(sl.cv - sb.cv) < 1e-6, `3.2 X locks U: the points move along U only (du ${(sl.cu - sb.cu).toFixed(4)}, dv ${(sl.cv - sb.cv).toFixed(6)})`);
	h.check(Math.abs(span(kept).cu - sl.cu) < 0.01 && !(await dbg(page)).grabbing && (await undoDepth(page)) === depth0 + 1, `3.3 a click keeps it as ONE undo entry (depth ${depth0} -> ${await undoDepth(page)})`);

	// ---- 4. right click cancels ------------------------------------------------------------------
	const b4 = await uvs(page, uuid);
	await page.mouse.move(c.x, c.y);
	await page.keyboard.press('KeyG');
	await page.waitForTimeout(200);
	await page.mouse.move(c.x - 50, c.y + 30, { steps: 4 });
	await page.mouse.click(c.x - 50, c.y + 30, { button: 'right' });
	await page.waitForTimeout(400);
	const a4 = await uvs(page, uuid);
	const menuRows = await page.evaluate(() => document.querySelectorAll('.ctx-item, [role="menuitem"]').length);
	h.check(JSON.stringify(a4.map((p) => p.map((n) => n.toFixed(5)))) === JSON.stringify(b4.map((p) => p.map((n) => n.toFixed(5)))) && !(await dbg(page)).grabbing && menuRows === 0, `4.1 a right click cancels: the UVs go back and no menu opens (menu rows ${menuRows})`);

	// ---- 5. S + Y: V alone -----------------------------------------------------------------------
	const b5 = span(await uvs(page, uuid));
	await page.mouse.move(c.x + 20, c.y + 20);
	await page.keyboard.press('KeyS');
	await page.waitForTimeout(200);
	await page.keyboard.press('KeyY');
	await page.mouse.move(c.x + 60, c.y + 60, { steps: 5 });
	await page.waitForTimeout(150);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	const a5 = span(await uvs(page, uuid));
	h.check(Math.abs(a5.u - b5.u) < 1e-4 && Math.abs(a5.v - b5.v) > 0.01, `5.1 S Y resizes V alone (u span ${b5.u.toFixed(4)} -> ${a5.u.toFixed(4)}, v span ${b5.v.toFixed(4)} -> ${a5.v.toFixed(4)})`);

	// ---- 6. tool keys ----------------------------------------------------------------------------
	const tools = [];
	for (const key of ['KeyB', 'KeyC', 'KeyP', 'KeyW']) {
		await focusUv(page);
		await page.keyboard.press(key);
		await page.waitForTimeout(150);
		tools.push((await dbg(page)).tool);
	}
	h.check(JSON.stringify(tools) === JSON.stringify(['box', 'lasso', 'paint', 'select']), `6.1 B / C / P / W pick Box / Lasso / Paint / Select (${tools.join(', ')})`);
	await page.evaluate(() => window.__tp.test.v1.shortcutsRegistry.setKeymapPreset('theprototype'));

	await h.finish(browser);
});
