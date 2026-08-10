// M1: mesh edits must PRESERVE texture coordinates.
//
// The defect: every geometry swap in faceEdit rebuilt a BufferGeometry from
// positions alone, so editing a textured mesh silently destroyed its mapping —
// the texture snapped to a single texel or vanished. Every op, the live
// preview, the wire and undo/redo now carry uvs, and untextured meshes stay
// byte-identical (nothing computed, stored or sent).
const h = require('./helpers.cjs');

/** a box with a REAL uv attribute + a canvas texture, in face-edit mode */
const texturedBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		// a 2x2 canvas texture so the mapping is observable at all
		const c = document.createElement('canvas');
		c.width = c.height = 2;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f00';
		ctx.fillRect(0, 0, 1, 1);
		ctx.fillStyle = '#0f0';
		ctx.fillRect(1, 1, 1, 1);
		const tex = new w.THREE.CanvasTexture(c);
		box.material.map = tex;
		box.material.needsUpdate = true;
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	}, undefined);

/** uv health: does the attribute exist and cover every vertex? */
const uvInfo = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const uv = geo.attributes.uv;
		const pos = geo.attributes.position;
		const verts = geo.index ? geo.index.count : pos.count;
		if (!uv) return { has: false, verts, covers: false, spread: 0, allZero: true };
		let min = Infinity;
		let max = -Infinity;
		let nonZero = 0;
		for (let i = 0; i < uv.count; i++) {
			const u = uv.getX(i);
			const v = uv.getY(i);
			min = Math.min(min, u, v);
			max = Math.max(max, u, v);
			if (u !== 0 || v !== 0) nonZero++;
		}
		return {
			has: true,
			verts,
			uvCount: uv.count,
			covers: uv.count === pos.count,
			spread: +(max - min).toFixed(3),
			allZero: nonZero === 0,
			nonZero
		};
	}, uuid);

/** select the top face and run an op */
const runOp = (page, op, amount) =>
	page.evaluate(
		({ op, amount }) => {
			const w = window.__stores;
			const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
			w.faceEdit.pickFaceUnit(top.triIndices[0]);
			return w.faceEdit.commitFaceOp(op, amount);
		},
		{ op, amount }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ------------------------------------------------------ 1. premise
	const uuid = await texturedBox(A.page);
	const start = await uvInfo(A.page, uuid);
	h.check(start.has && start.covers, 'the box starts with a full uv attribute (premise)');
	h.check(start.spread > 0.9, '...spanning the 0..1 range (premise, spread ' + start.spread + ')');

	// --------------------------------- 2. every topology op keeps the mapping
	for (const [op, amount] of [
		['extrude', 0.4],
		['inset', 0.3],
		['subdivide', 0],
		['flip', 0]
	]) {
		const ok = await runOp(A.page, op, amount);
		const info = await uvInfo(A.page, uuid);
		h.check(ok === true, op + ' commits on the textured mesh');
		h.check(info.has, 'THE BUG: ' + op + ' keeps the uv attribute');
		h.check(info.covers, '...covering every vertex (' + info.uvCount + '/' + info.verts + ')');
		h.check(!info.allZero && info.spread > 0.5, '...with real, spread-out coordinates (' + info.spread + ')');
	}

	// ------------------------------------------- 3. undo/redo round-trips uvs
	const beforeUndo = await uvInfo(A.page, uuid);
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await uvInfo(A.page, uuid);
	h.check(undone.has && undone.covers, 'undo restores a fully-mapped mesh');
	await A.page.evaluate(() => window.__stores.history.redo());
	const redone = await uvInfo(A.page, uuid);
	h.check(
		redone.has && redone.covers && redone.uvCount === beforeUndo.uvCount,
		'redo returns exactly the same uv count (' + redone.uvCount + ')'
	);

	// ------------------------------------------------- 4. bridge + weld paths
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const merged = await A.page.evaluate(async () => {
		const w = window.__stores;
		const mk = async (x) => {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const b = g.children[g.children.length - 1];
			b.position.set(x, 0, 0);
			return b.uuid;
		};
		const a = await mk(0);
		const b = await mk(3);
		const uuid = await w.objectActions.convertToMesh([a, b]);
		w.faceEdit.enterFaceEdit(uuid);
		// bridge the two facing sides
		const fs = w.faceEdit.currentFaces();
		const plus = fs.filter((f) => f.normal.x > 0.99).sort((p, q) => p.centroid.x - q.centroid.x)[0];
		const minus = fs.filter((f) => f.normal.x < -0.99).sort((p, q) => q.centroid.x - p.centroid.x)[0];
		w.faceEdit.faceEditSelectedTris.set([...plus.triIndices, ...minus.triIndices]);
		return { uuid, ok: w.faceEdit.bridgeFaces() };
	});
	const bridged = await uvInfo(A.page, merged.uuid);
	h.check(merged.ok === true, 'bridge commits on a merged mesh');
	h.check(
		bridged.covers,
		'bridge leaves a complete uv attribute — the tunnel gets a strip mapping (' +
			bridged.uvCount + '/' + bridged.verts + ')'
	);

	// weld snapshots INDEX-EXPANDED positions, so the uv carry-over has to read
	// through the previous index or it zero-pads
	const welded = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.meshEdit.enterEditMode(box.uuid);
		w.meshEdit.selectHandle(0);
		w.meshEdit.toggleVertexSelection(1);
		const ok = w.meshEdit.weldSelectedVerts();
		w.meshEdit.exitEditMode();
		return { uuid: box.uuid, ok };
	});
	const weldUv = await uvInfo(A.page, welded.uuid);
	h.check(welded.ok === true, 'weld commits (premise)');
	h.check(weldUv.has && weldUv.covers, 'weld keeps a complete uv attribute');
	h.check(
		!weldUv.allZero && weldUv.nonZero > weldUv.uvCount / 2,
		'...read through the OLD index, not zero-padded (' + weldUv.nonZero + '/' + weldUv.uvCount + ' non-zero)'
	);

	// ----------------------------------- 5. untextured meshes stay untouched
	const plain = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const s = g.children[g.children.length - 1];
		// drop the parametric uv so the mesh is genuinely untextured
		s.geometry.deleteAttribute('uv');
		const captured = [];
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		peer.send = (m) => captured.push({ type: m.type, hasUv: 'uvs' in m });
		w.faceEdit.enterFaceEdit(s.uuid);
		const top = w.faceEdit.currentFaces()[0];
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.commitFaceOp('extrude', 0.2);
		delete peer.send;
		w.faceEdit.exitFaceEdit();
		const geo = g.getObjectByProperty('uuid', s.uuid).geometry;
		return { uv: !!geo.attributes.uv, sent: captured.filter((m) => m.type === 'meshgeo') };
	});
	h.check(!plain.uv, 'an untextured mesh gains NO uv attribute');
	h.check(
		plain.sent.length > 0 && plain.sent.every((m) => !m.hasUv),
		'...and puts no uvs on the wire (' + plain.sent.length + ' meshgeo msgs, none with uvs)'
	);

	// ------------------------------------------------------- 6. two peers
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await texturedBox(A.page);
	await h.eventually(
		() => uvInfo(B.page, netUuid),
		(info) => !!info && info.verts > 0,
		'B received the box (premise)',
		20000
	);
	await runOp(A.page, 'extrude', 0.4);
	await h.eventually(
		() => uvInfo(B.page, netUuid),
		(info) => !!info && info.verts === 20 * 3,
		'B receives the extruded geometry',
		20000
	);
	const remote = await uvInfo(B.page, netUuid);
	h.check(remote.has && remote.covers, 'B rebuilds a complete uv attribute from the wire');
	h.check(!remote.allZero && remote.spread > 0.5, '...with the real coordinates, not zeros');

	await h.finish(browser);
});
