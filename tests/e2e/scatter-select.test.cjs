// 51 E4 — the scatter SELECT tool, two peers (brushes: scatter-edit). A REAL click and a REAL box
// drag select instances, the gizmo moves / turns / scales the selection (one entry per drag), the
// toolbox Turn / Bigger / Re-roll (keeps every other instance) / Delete, Delete and Escape owned by
// the selection (never the terrain).
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS_DIR || '';

/** @param {any} page @param {string} uuid */
const scatterOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', u);
					resolve(o ? JSON.stringify(o.userData.terrainScatter ?? null) : 'missing');
				})();
			}),
		uuid
	);
/** The decoded lists, per set id. @param {any} page @param {string} uuid */
const listsOf = (page, uuid) =>
	page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const t = g.getObjectByProperty('uuid', u);
		const b = s.terrainSurface.terrainBounds(t);
		const block = s.terrainScatterCore.normalizeScatter(t.userData.terrainScatter, s.terrainPaintCore.base64ToBytes);
		const out = {};
		for (const set of block?.sets ?? []) out[set.id] = s.terrainScatterCore.decodeInstances(s.terrainPaintCore.base64ToBytes(set.data), b);
		return out;
	}, uuid);
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const state = (page) => page.evaluate(() => window.__stores.scatterEdit.scatterEditState());
/** @param {any} page */
const objectCount = (page) => page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()));

/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			orbit?.target?.set(t[0], t[1], t[2]);
			orbit?.update?.();
			cam.lookAt(t[0], t[1], t[2]);
		},
		[pos, target]
	);
}

/** One programmatic stroke of the armed tool at local (x, z). @param {any} page @param {string} uuid */
async function stroke(page, uuid, x, z, steps = 10, dt = 0.05) {
	await page.evaluate(
		async ([u, x, z, steps, dt]) => {
			const ts = window.__stores.terrainSculpt;
			ts.beginStroke(u);
			for (let i = 0; i < steps; i++) {
				ts.strokeMove(u, x, z, dt);
				await new Promise((r) => setTimeout(r, 10));
			}
			ts.endStroke();
		},
		[uuid, x, z, steps, dt]
	);
}

/** Screen point of an instance's base (and whether the canvas is what is there).
 * @param {any} page @param {string} uuid @param {{x: number, z: number}} inst */
async function screenOf(page, uuid, inst) {
	const world = await page.evaluate(
		([u, x, z]) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const t = g.getObjectByProperty('uuid', u);
			const grid = s.terrainScatterCore.buildHeightGrid(t.geometry.attributes.position.array);
			const y = s.terrainScatterCore.sampleHeight(grid, x, z).y;
			t.updateWorldMatrix(true, false);
			const e = t.matrixWorld.elements;
			// the cone's middle, so the ray from above lands on the model (y + 0.5 of a unit cone)
			const ly = y + 0.4;
			return [e[0] * x + e[4] * ly + e[8] * z + e[12], e[1] * x + e[5] * ly + e[9] * z + e[13], e[2] * x + e[6] * ly + e[10] * z + e[14]];
		},
		[uuid, inst.x, inst.z]
	);
	const p = await h.projectPoint(page, world);
	const canvas = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [p.x, p.y]);
	return { ...p, canvas };
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create Terrain 24 48');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return group.children[group.children.length - 1].uuid;
	});
	await h.eventually(() => scatterOf(B.page, uuid), (v) => v !== 'missing', 'B has the terrain', 20000);
	await look(A.page, [0.5, 22, 3], [0, 0, 0]);
	await look(B.page, [-6, 16, -8], [0, 0, 0]);

	// ---- paint two models ---------------------------------------------------------------------
	const entered = await A.page.evaluate((u) => {
		const s = window.__stores;
		const ok = s.terrainSculpt.enterSculpt(u);
		s.terrainSculpt.sculptOp.set('scatter');
		s.terrainSculpt.sculptRadius.set(3);
		s.terrainPaint.scatterDensity.set(1);
		s.terrainPaint.scatterSource.set({ kind: 'primitive', type: 'Cone' });
		s.scatterEdit.setScatterTool('paint');
		return ok;
	}, uuid);
	h.check(entered, 'A enters the sculpt session, Scatter brush, Paint tool');
	await stroke(A.page, uuid, 0, 0, 6);
	await stroke(A.page, uuid, -6, -6, 6);
	await A.page.evaluate(() => window.__stores.terrainPaint.scatterSource.set({ kind: 'primitive', type: 'Box' }));
	await stroke(A.page, uuid, 0, 0, 6); // boxes fill the gaps between the cones in the same circle
	let lists = await listsOf(A.page, uuid);
	h.check(lists['p:Cone']?.length > 20 && lists['p:Box']?.length > 0, `two models scattered (${lists['p:Cone']?.length} cones, ${lists['p:Box']?.length} boxes)`);
	await h.eventually(async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B holds the same scatter', 15000);

	let d0 = 0;
	// ---- E4 select: real click, real box, gizmo -------------------------------------------------
	await A.page.evaluate(() => {
		window.__stores.scatterEdit.scatterAffects.set('p:Cone');
		window.__stores.scatterEdit.setScatterTool('select');
	});
	if (SHOTS) await A.page.screenshot({ path: `${SHOTS}/01-select-tool.png` });
	lists = await listsOf(A.page, uuid);
	// an instance whose pixel is the canvas
	let pick = null;
	for (const [i, inst] of lists['p:Cone'].entries()) {
		if (Math.hypot(inst.x, inst.z) > 2.5) continue;
		const p = await screenOf(A.page, uuid, inst);
		if (p.canvas) {
			pick = { i, p };
			break;
		}
	}
	h.check(!!pick, 'a cone near the middle is on the canvas (premise)');
	if (pick) {
		await A.page.mouse.click(pick.p.x, pick.p.y);
		await A.page.waitForTimeout(200);
		let st = await state(A.page);
		h.check(st.count === 1 && st.gizmo, `a REAL click selects one instance and seats the gizmo (${st.count}, gizmo ${st.gizmo})`);
		// a real box over the middle (from an empty selection: the gizmo would own a press on it)
		await A.page.evaluate(() => window.__stores.scatterEdit.clearScatterSelection());
		const c = await h.projectPoint(A.page, [0, 0, 0]);
		await A.page.mouse.move(c.x - 70, c.y - 70);
		await A.page.mouse.down();
		await A.page.mouse.move(c.x, c.y, { steps: 4 });
		await A.page.mouse.move(c.x + 70, c.y + 70, { steps: 4 });
		await A.page.mouse.up();
		await A.page.waitForTimeout(200);
		st = await state(A.page);
		const expect = await A.page.evaluate(
			([u, r]) => {
				let cam;
				window.__stores.editorCam.subscribe((v) => (cam = v))();
				const m = window.__stores.scatterEdit.instancesInScreenRect(u, r, cam);
				let n = 0;
				for (const ids of m.values()) n += ids.size;
				return n;
			},
			[uuid, { x0: c.x - 70, y0: c.y - 70, x1: c.x + 70, y1: c.y + 70 }]
		);
		h.check(st.count > 3 && st.count === expect, `a REAL box drag selects the cones inside it (${st.count} of ${expect})`);
		h.check(Object.keys(st.selection).every((k) => k === 'p:Cone'), 'Affects holds the box to the cones');
		// the toolbox holds still while instances are picked (a selection must not reflow it every frame)
		const boxes = await A.page.evaluate(async () => {
			const out = [];
			for (let i = 0; i < 12; i++) {
				const r = document.getElementById('sculpt-toolbar')?.getBoundingClientRect();
				out.push(r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',') : 'none');
				await new Promise((res) => setTimeout(res, 50));
			}
			return out;
		});
		h.check(new Set(boxes).size === 1 && boxes[0] !== 'none', `the toolbox holds still with a selection (${[...new Set(boxes)].join(' | ')})`);
		if (SHOTS) {
			await A.page.screenshot({ path: `${SHOTS}/02-box-selected.png` });
			// the new toolbox UI in three themes (53: tokens only, every theme)
			for (const t of ['dark', 'light', 'contrast']) {
				await A.page.evaluate((id) => window.__stores.themes.theme.set(id), t);
				await A.page.waitForTimeout(250);
				const r = await A.page.evaluate(() => {
					const b = document.getElementById('sculpt-toolbar')?.getBoundingClientRect();
					return b && { x: b.x, y: b.y, width: b.width, height: b.height };
				});
				if (r) await A.page.screenshot({ path: `${SHOTS}/03-toolbox-select-${t}.png`, clip: r });
			}
			await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));
		}

		// gizmo: move, turn, scale — each drag ONE entry, absolute from the drag start
		const sel = st.selection['p:Cone'];
		const pre = (await listsOf(A.page, uuid))['p:Cone'];
		const other = pre.findIndex((_, k) => !sel.includes(k));
		d0 = await undoDepth(A.page);
		const drag = (fn) =>
			A.page.evaluate((src) => {
				const s = window.__stores;
				let c;
				s.TControls.subscribe((v) => (c = v))();
				const proxy = c.object;
				s.scatterEdit.onScatterProxyDragChanged(true);
				new Function('proxy', src)(proxy);
				proxy.updateMatrixWorld(true);
				s.scatterEdit.onScatterProxyMoved();
				s.scatterEdit.onScatterProxyDragChanged(false);
				return !!proxy?.userData?.isScatterProxy;
			}, fn);
		h.check(await drag('proxy.position.x += 1.5;'), 'the gizmo sits on the scatter proxy');
		let post = (await listsOf(A.page, uuid))['p:Cone'];
		h.check(sel.every((k) => Math.abs(post[k].x - pre[k].x - 1.5) < 0.02 && Math.abs(post[k].z - pre[k].z) < 0.02), 'Move slides every selected instance 1.5 m');
		h.check(post[other].x === pre[other].x && post[other].z === pre[other].z, 'an unselected instance stays put');
		await drag('proxy.rotateY(0.5);');
		await drag('proxy.scale.set(2, 2, 2);');
		post = (await listsOf(A.page, uuid))['p:Cone'];
		const turned = sel.every((k) => {
			const d = (post[k].yaw - pre[k].yaw + Math.PI * 4) % (Math.PI * 2);
			return Math.abs(d - 0.5) < 0.03;
		});
		h.check(turned, 'Turn adds 0.5 rad to each selected yaw');
		h.check(sel.every((k) => Math.abs(post[k].scale / pre[k].scale - 2) < 0.02), 'Size doubles each selected instance');
		h.check((await undoDepth(A.page)) === d0 + 3, 'three gizmo drags = three undo entries');
		await h.eventually(async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B sees the gizmo edits', 10000);
		await A.page.evaluate(() => window.__stores.history.undo());
		post = (await listsOf(A.page, uuid))['p:Cone'];
		h.check(sel.every((k) => Math.abs(post[k].scale - pre[k].scale) < 0.01), 'undo takes the last drag (the size) back');

		// toolbox ops by their buttons (re-select: an undo drops the selection, by design)
		await A.page.evaluate(
			([u, ids]) => window.__stores.scatterEdit.setScatterSelection(u, new Map([['p:Cone', new Set(ids)]])),
			[uuid, sel]
		);
		const before = (await listsOf(A.page, uuid))['p:Cone'];
		await A.page.click('#sculpt-scatter-turn-left');
		await A.page.click('#sculpt-scatter-bigger');
		await A.page.click('#sculpt-scatter-reroll');
		post = (await listsOf(A.page, uuid))['p:Cone'];
		h.check(sel.every((k) => post[k].x === before[k].x && post[k].z === before[k].z), 'Turn / Bigger / Re-roll keep the selected positions');
		h.check(sel.some((k) => post[k].scale !== before[k].scale || post[k].yaw !== before[k].yaw), 'and change their look');
		h.check(post[other].yaw === before[other].yaw && post[other].scale === before[other].scale, 'Re-roll keeps every OTHER instance as it was');

		// Delete owns the key while instances are picked — the terrain survives
		const coneN = post.length;
		const objs = await objectCount(A.page);
		await A.page.mouse.move(pick.p.x, pick.p.y);
		await A.page.keyboard.press('Delete');
		await A.page.waitForTimeout(200);
		post = (await listsOf(A.page, uuid))['p:Cone'];
		h.check(post.length === coneN - sel.length, `Delete removes the selected instances (${coneN} -> ${post.length})`);
		h.check((await objectCount(A.page)) === objs, 'and NOT the terrain');
		await h.eventually(async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B sees the delete', 10000);
		await A.page.evaluate(() => window.__stores.history.undo());
		h.check((await listsOf(A.page, uuid))['p:Cone'].length === coneN, 'one undo brings them back');

		// Escape: first drops the selection, then leaves the session
		await A.page.evaluate((u) => window.__stores.scatterEdit.selectAllInstances(u), uuid);
		await A.page.keyboard.press('Escape');
		const afterEsc = await A.page.evaluate(() => {
			let o;
			window.__stores.terrainSculpt.sculptObject.subscribe((v) => (o = v))();
			return { count: window.__stores.scatterEdit.scatterEditState().count, sculpt: o };
		});
		h.check(afterEsc.count === 0 && afterEsc.sculpt === uuid, 'the first Escape drops the selection and stays in the session');
	}


	await h.finish(browser);
});
