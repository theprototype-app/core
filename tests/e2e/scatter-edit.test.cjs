// 51 E4 — EDITING scatter instances with the BRUSHES, two peers (the Select tool: scatter-select;
// E5 conversions: scatter-convert). The rotate / scale / relax brushes and the Affects-filtered
// (per-source) erase, each ONE undo entry, equal on the second peer; per-terrain splat detail.
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
	await h.eventuallyAfter(A, B, () => scatterOf(B.page, uuid), (v) => v !== 'missing', 'B has the terrain', 20000);
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
	await h.eventuallyAfter(A, B, async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B holds the same scatter', 15000);

	// ---- E4 brushes ---------------------------------------------------------------------------
	const near = (l, x, z, r) => l.filter((p) => Math.hypot(p.x - x, p.z - z) < r);
	let d0 = await undoDepth(A.page);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.scatterEdit.setScatterTool('rotate');
		s.scatterEdit.scatterAffects.set('');
		s.terrainSculpt.sculptStrength.set(1);
	});
	const yawBefore = near(lists['p:Cone'], 0, 0, 2).map((p) => p.yaw);
	await stroke(A.page, uuid, 0, 0, 8);
	lists = await listsOf(A.page, uuid);
	const yawAfter = near(lists['p:Cone'], 0, 0, 2).map((p) => p.yaw);
	h.check(yawAfter.some((y, i) => Math.abs(y - yawBefore[i]) > 0.05), 'the Rotate brush turns the instances under it');
	h.check((await undoDepth(A.page)) === d0 + 1, 'one rotate stroke = ONE undo entry');
	await h.eventuallyAfter(A, B, async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B sees the rotate', 10000);

	await A.page.evaluate(() => window.__stores.scatterEdit.setScatterTool('scale'));
	const scaleMean = (l) => l.reduce((a, p) => a + p.scale, 0) / Math.max(1, l.length);
	const sBefore = scaleMean(near(lists['p:Cone'], -6, -6, 1.5));
	await stroke(A.page, uuid, -6, -6, 8);
	lists = await listsOf(A.page, uuid);
	const sGrown = scaleMean(near(lists['p:Cone'], -6, -6, 1.5));
	h.check(sGrown > sBefore * 1.05, `the Scale brush grows them (${sBefore.toFixed(2)} -> ${sGrown.toFixed(2)})`);
	await A.page.evaluate(() => window.__stores.scatterEdit.scatterBrushReverse.set(true));
	await stroke(A.page, uuid, -6, -6, 8);
	lists = await listsOf(A.page, uuid);
	h.check(scaleMean(near(lists['p:Cone'], -6, -6, 1.5)) < sGrown * 0.97, 'with Shrink ticked it shrinks them back');
	await A.page.evaluate(() => window.__stores.scatterEdit.scatterBrushReverse.set(false));

	// relax: a clump of six on one spot spreads
	await A.page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const t = g.getObjectByProperty('uuid', u);
		const b = s.terrainSurface.terrainBounds(t);
		const block = JSON.parse(JSON.stringify(t.userData.terrainScatter));
		const clump = Array.from({ length: 6 }, (_, i) => ({ x: 7 + (i % 3) * 0.05, z: 7 + Math.floor(i / 3) * 0.05, yaw: 0, scale: 1 }));
		block.sets.push({ id: 'p:Sphere', source: { kind: 'primitive', type: 'Sphere' }, align: false, data: s.terrainPaintCore.bytesToBase64(s.terrainScatterCore.encodeInstances(clump, b)), count: 6 });
		s.terrainSurface.applyTerrainScatter(u, block);
	}, uuid);
	const gapOf = (l) => {
		let m = Infinity;
		for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) m = Math.min(m, Math.hypot(l[i].x - l[j].x, l[i].z - l[j].z));
		return m;
	};
	lists = await listsOf(A.page, uuid);
	const gap0 = gapOf(lists['p:Sphere']);
	await A.page.evaluate(() => {
		window.__stores.scatterEdit.setScatterTool('relax');
		window.__stores.scatterEdit.scatterAffects.set('p:Sphere');
	});
	await stroke(A.page, uuid, 7, 7, 20);
	lists = await listsOf(A.page, uuid);
	h.check(gapOf(lists['p:Sphere']) > gap0 * 3, `Relax evens a clump out (closest gap ${gap0.toFixed(3)} -> ${gapOf(lists['p:Sphere']).toFixed(3)} m)`);
	h.check(lists['p:Sphere'].every((p) => Math.hypot(p.x - 7, p.z - 7) <= 3.01), 'and keeps every instance inside the brush');

	// per-source erase: Affects = Box erases boxes only
	const cones0 = lists['p:Cone'].length;
	const boxes0 = lists['p:Box'].length;
	await A.page.evaluate(() => {
		window.__stores.scatterEdit.setScatterTool('erase');
		window.__stores.scatterEdit.scatterAffects.set('p:Box');
	});
	d0 = await undoDepth(A.page);
	await stroke(A.page, uuid, 0, 0, 2);
	lists = await listsOf(A.page, uuid);
	h.check((lists['p:Box']?.length ?? 0) < boxes0 && lists['p:Cone'].length === cones0, `Erase with Affects = Box removes boxes only (${boxes0} -> ${lists['p:Box']?.length ?? 0} boxes, cones ${cones0} kept)`);
	h.check((await undoDepth(A.page)) === d0 + 1, 'one erase stroke = ONE undo entry');
	await A.page.evaluate(() => window.__stores.history.undo());
	lists = await listsOf(A.page, uuid);
	h.check(lists['p:Box'].length === boxes0, 'one undo brings the boxes back');
	await h.eventuallyAfter(A, B, async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B agrees after the undo', 10000);

	// ---- per-terrain splat detail ---------------------------------------------------------------
	const res = await A.page.evaluate((u) => {
		const p = window.__stores.terrainPaint;
		const r0 = p.splatResolutionOf(u);
		const ok = p.setSplatResolution(u, 256);
		return { r0, ok, r1: p.splatResolutionOf(u) };
	}, uuid);
	h.check(res.r0 === 128 && res.ok && res.r1 === 256, `Detail sets this terrain's splat to 256 (${res.r0} -> ${res.r1})`);
	await h.eventuallyAfter(A, B, () => B.page.evaluate((u) => window.__stores.terrainPaint.splatResolutionOf(u), uuid), (r) => r === 256, 'B paints at 256 too', 10000);
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await A.page.evaluate((u) => window.__stores.terrainPaint.splatResolutionOf(u), uuid)) === 128, 'one undo puts it back');

	await h.finish(browser);
});
