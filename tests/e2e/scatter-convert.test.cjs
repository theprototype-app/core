// 51 E5 — CONVERT BOTH WAYS, two peers: picked instances -> real objects at their exact pose
// (one undo puts them back, on both peers), the confirm above 500 (Cancel makes nothing),
// copies of one object on a terrain -> instances of its scatter (one undo), and a save/reload
// that keeps the edited scatter. (The E4 editing tools: scatter-edit.)
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
	h.check(entered, 'A enters the sculpt session, Scatter brush');
	await stroke(A.page, uuid, 0, 0, 6);
	/** @type {any} */
	let lists = await listsOf(A.page, uuid);
	h.check(lists['p:Cone']?.length > 10, `cones scattered (${lists['p:Cone']?.length})`);
	let d0 = 0;

	// ---- E5 instances -> objects ------------------------------------------------------------------
	lists = await listsOf(A.page, uuid);
	const five = lists['p:Cone'].slice(0, 5).map((_, i) => i);
	const objsA = await objectCount(A.page);
	d0 = await undoDepth(A.page);
	const made = await A.page.evaluate(async ([u, ids]) => {
		const s = window.__stores;
		s.scatterEdit.setScatterTool('select');
		s.scatterEdit.setScatterSelection(u, new Map([['p:Cone', new Set(ids)]]));
		const uuids = await s.scatterConvert.instancesToObjects({ scope: 'selection' });
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const t = g.getObjectByProperty('uuid', u);
		const grid = s.terrainScatterCore.buildHeightGrid(t.geometry.attributes.position.array);
		return uuids.map((id) => {
			const o = g.getObjectByProperty('uuid', id);
			const p = o.position;
			return { name: o.name, x: p.x, y: p.y, z: p.z, ground: s.terrainScatterCore.sampleHeight(grid, p.x, p.z).y, type: o.geometry?.type };
		});
	}, [uuid, five]);
	h.check(made.length === 5 && made.every((m) => m.type === 'ConeGeometry'), `five instances became five Cone objects (${made.length})`);
	const firstFive = lists['p:Cone'].slice(0, 5);
	h.check(
		made.every((m, k) => Math.abs(m.x - firstFive[k].x) < 0.02 && Math.abs(m.z - firstFive[k].z) < 0.02),
		'each object stands where its instance stood'
	);
	h.check(made.every((m, k) => Math.abs(m.y - (m.ground + 0.5 * firstFive[k].scale)) < 0.03), 'its base on the ground (centre half a scaled cone up)');
	h.check((await objectCount(A.page)) === objsA + 5, 'A has five more objects (the template went)');
	h.check((await listsOf(A.page, uuid))['p:Cone'].length === lists['p:Cone'].length - 5, 'and five fewer instances');
	h.check((await undoDepth(A.page)) === d0 + 1, 'the whole conversion is ONE undo entry');
	await h.eventually(() => objectCount(B.page), (n) => n === objsA + 5, 'B has the five objects', 15000);
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await objectCount(A.page)) === objsA && (await listsOf(A.page, uuid))['p:Cone'].length === lists['p:Cone'].length, 'one undo: objects gone, instances back');
	await h.eventually(() => objectCount(B.page), (n) => n === objsA, 'on B too', 15000);

	// the confirm above 500
	const asked = await A.page.evaluate(async (u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const t = g.getObjectByProperty('uuid', u);
		const b = s.terrainSurface.terrainBounds(t);
		const block = JSON.parse(JSON.stringify(t.userData.terrainScatter));
		const many = Array.from({ length: 600 }, (_, i) => ({ x: -11 + (i % 30) * 0.7, z: -11 + Math.floor(i / 30) * 0.5, yaw: 0, scale: 1 }));
		block.sets.push({ id: 'p:Capsule', source: { kind: 'primitive', type: 'Capsule' }, align: false, data: s.terrainPaintCore.bytesToBase64(s.terrainScatterCore.encodeInstances(many, b)), count: 600 });
		s.terrainSurface.applyTerrainScatter(u, block);
		const pending = s.scatterConvert.instancesToObjects({ scope: 'set', uuid: u, setId: 'p:Capsule' });
		await new Promise((r) => setTimeout(r, 200));
		let dialog;
		s.confirmDialog.confirmDialog.subscribe((v) => (dialog = v))();
		const title = dialog?.title ?? null;
		s.confirmDialog.resolveConfirm(false);
		const made = await pending;
		return { title, made: made.length };
	}, uuid);
	h.check(/600 objects/.test(asked.title ?? '') && asked.made === 0, `600 instances ask first ("${asked.title}") and Cancel makes nothing`);

	// ---- E5 copies -> a scatter set ---------------------------------------------------------------
	const copies = await A.page.evaluate(async () => {
		const s = window.__stores;
		const out = [];
		for (const [x, z] of [
			[3, -8],
			[4, -8],
			[5, -8.5],
			[6, -8]
		]) {
			s.commandsHandler.sceneCommand('/create Cone 0.5 1 10');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[g.children.length - 1];
			o.position.set(x, 0.5, z);
			o.rotation.y = 0.3;
			o.updateMatrixWorld(true);
			out.push(o.uuid);
		}
		return out;
	});
	const cBefore = (await listsOf(A.page, uuid))['p:Cone'].length;
	const objsB4 = await objectCount(A.page);
	d0 = await undoDepth(A.page);
	const n = await A.page.evaluate((ids) => window.__stores.scatterConvert.objectsToScatter(ids), copies);
	lists = await listsOf(A.page, uuid);
	h.check(n === 4 && lists['p:Cone'].length === cBefore + 4, `four Cone copies became four instances (${cBefore} -> ${lists['p:Cone'].length})`);
	const added = lists['p:Cone'].slice(-4);
	h.check(Math.abs(added[0].x - 3) < 0.02 && Math.abs(added[0].z + 8) < 0.02 && Math.abs(added[0].yaw - 0.3) < 0.01 && Math.abs(added[0].scale - 1) < 0.01, 'at their ground position, turn and size');
	h.check((await objectCount(A.page)) === objsB4 - 4, 'the objects are gone');
	h.check((await undoDepth(A.page)) === d0 + 1, 'ONE undo entry');
	await h.eventually(async () => (await scatterOf(B.page, uuid)) === (await scatterOf(A.page, uuid)), (v) => v, 'B holds the new instances', 10000);
	await h.eventually(() => objectCount(B.page), (k) => k === objsB4 - 4, 'and lost the objects', 10000);
	const mixed = await A.page.evaluate(async ([a, b]) => window.__stores.scatterConvert.scatterableSelection([a, b], []), [uuid, uuid]);
	h.check(mixed.ok === false, 'one object (or none) is refused with a reason');

	// ---- save / reload keeps the edits --------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.terrainSculpt.exitSculpt());
	const saved = await scatterOf(A.page, uuid);
	const zip = await A.page.evaluate(async () => {
		const s = window.__stores.sessions;
		const out = await s.exportSessionZip(s.buildSessionPayload('Edited scatter'));
		return Array.from(new Uint8Array(out instanceof Blob ? await out.arrayBuffer() : out));
	});
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(800);
	await A.page.evaluate(async (arr) => {
		const s = window.__stores.sessions;
		await s.applySession(await s.readSessionZip(new Uint8Array(arr).buffer), { backup: false });
	}, zip);
	await h.eventually(() => scatterOf(A.page, uuid), (v) => v === saved, 'the edited scatter survives a save/load round-trip', 15000);

	await h.finish(browser);
});
