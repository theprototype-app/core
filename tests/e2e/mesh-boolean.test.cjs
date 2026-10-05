// B10 (36-mesh-ops): CSG booleans from the object menu, end to end.
//
//   MENU     — "Boolean" appears for exactly TWO meshes (never for one), its four
//              entries run union / subtract / intersect / subtract-keep-cutter.
//   RESULT   — the first-clicked object takes the result: the derived volume, CLOSED
//              (0 open welded edges — the T-junction repair), the cutter removed.
//   UNDO     — ONE Ctrl+Z restores the shape AND the cutter (one history batch).
//   PEERS    — B holds A's result byte for byte (a meshgeo snapshot, never a re-run
//              of the CSG), loses the cutter, and gets both back on A's undo.
//   REFUSALS — a disjoint intersect leaves both objects untouched.
// Volumes are DERIVED from the box arithmetic in-test.
const h = require('./helpers.cjs');

const info = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		if (!object?.geometry) return null;
		object.updateMatrixWorld(true);
		const tris = s.faceEdit.readTriangles(object.geometry);
		let volume = 0;
		for (const t of tris) {
			const w = t.map((v) => v.clone().applyMatrix4(object.matrixWorld));
			volume += w[0].dot(w[1].clone().cross(w[2])) / 6;
		}
		const pos = object.geometry.attributes.position.array;
		let sum = 0;
		for (let i = 0; i < pos.length; i++) sum += pos[i] * ((i % 89) + 1);
		return {
			tris: tris.length,
			volume,
			open: s.meshBoolean.openEdgeCount(tris),
			checksum: Math.round(sum * 1e3) / 1e3
		};
	}, uuid);

const exists = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !!g.getObjectByProperty('uuid', uuid);
	}, uuid);

/** two unit boxes, the second at (dx, 0, 0) — moved through the replicated path */
const twoBoxes = (page, dx) =>
	page.evaluate((dx) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [a, b] = g.children.slice(-2);
		a.position.set(0, 0, 0);
		b.position.set(dx, 0, 0);
		let peer;
		s.peers.subscribe((v) => (peer = v))();
		for (const o of [a, b])
			peer?.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
		return [a.uuid, b.uuid];
	}, dx);

/** run a Boolean menu entry the way the context menu does */
const runMenu = (page, a, b, label) =>
	page.evaluate(
		async ({ a, b, label }) => {
			const items = window.__stores.objectMenu.buildObjectMenuItems(a, { selection: [a, b] });
			const boolean = items.find((i) => i.label === 'Boolean');
			if (!boolean) return { found: false };
			const entry = boolean.children.find((c) => c.label === label);
			const result = await entry.action();
			return { found: true, result, labels: boolean.children.map((c) => c.label) };
		},
		{ a, b, label }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ------------------------------------------------------------ MENU gating
	let [a, b] = await twoBoxes(A.page, 0.5);
	const gating = await A.page.evaluate(
		({ a, b }) => {
			const m = window.__stores.objectMenu;
			const one = m.buildObjectMenuItems(a, { selection: [a] }).some((i) => i.label === 'Boolean');
			const two = m.buildObjectMenuItems(a, { selection: [a, b] }).find((i) => i.label === 'Boolean');
			return { one, labels: two?.children.map((c) => c.label) ?? [] };
		},
		{ a, b }
	);
	h.check(gating.one === false, 'no Boolean entry for a single object');
	h.check(
		gating.labels.join('|') === 'Union|Subtract|Intersect|Subtract, keep the cutter',
		`two meshes get Boolean ▸ ${gating.labels.join(' / ')}`
	);
	await h.eventually(() => exists(B.page, b), (v) => v === true, 'B has both boxes (premise)', 20000);

	// ---------------------------------------------------- SUBTRACT + replication
	const before = await info(A.page, a);
	h.check(Math.abs(before.volume - 1) < 1e-6 && before.open === 0, 'premise: a closed unit box');
	const sub = await runMenu(A.page, a, b, 'Subtract');
	h.check(sub.found && sub.result === true, 'Subtract runs from the menu');
	let after = await info(A.page, a);
	// the boxes overlap in a 0.5 x 1 x 1 slab
	h.check(Math.abs(after.volume - 0.5) < 1e-4, `the first box lost the overlap: volume ${after.volume.toFixed(4)} = 1 - 0.5`);
	h.check(after.open === 0, 'the result is CLOSED — 0 open welded edges (T-junctions repaired)');
	h.check(!(await exists(A.page, b)), 'the cutter is removed');
	await h.eventually(() => info(B.page, a), (v) => v && v.checksum === after.checksum, `B holds A's result byte for byte (${after.checksum})`, 20000);
	await h.eventually(() => exists(B.page, b), (v) => v === false, 'B lost the cutter too', 20000);

	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await info(A.page, a);
	h.check(Math.abs(undone.volume - 1) < 1e-6 && undone.tris === 12, 'ONE undo restores the box...');
	h.check(await exists(A.page, b), '...AND brings the cutter back in the same step');
	await h.eventually(() => info(B.page, a), (v) => v && v.tris === 12, "B's box is whole again", 20000);
	await h.eventually(() => exists(B.page, b), (v) => v === true, 'B has the cutter back', 20000);

	// ------------------------------------------------------- UNION / INTERSECT
	const uni = await runMenu(A.page, a, b, 'Union');
	after = await info(A.page, a);
	h.check(uni.result === true && Math.abs(after.volume - 1.5) < 1e-4 && after.open === 0, `Union: volume ${after.volume.toFixed(4)} = 1 + 1 - 0.5, closed`);
	await A.page.evaluate(() => window.__stores.history.undo());
	const inter = await runMenu(A.page, a, b, 'Intersect');
	after = await info(A.page, a);
	h.check(inter.result === true && Math.abs(after.volume - 0.5) < 1e-4 && after.open === 0, `Intersect: volume ${after.volume.toFixed(4)} = the slab, closed`);
	await A.page.evaluate(() => window.__stores.history.undo());

	// ------------------------------------------------------------ KEEP CUTTER
	const keep = await runMenu(A.page, a, b, 'Subtract, keep the cutter');
	after = await info(A.page, a);
	h.check(keep.result === true && Math.abs(after.volume - 0.5) < 1e-4, 'Subtract, keep the cutter: the same cut...');
	h.check(await exists(A.page, b), '...and the cutter stays');
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await info(A.page, a)).tris === 12, 'undo restores it');

	// --------------------------------------------------------------- REFUSALS
	[a, b] = await twoBoxes(A.page, 5);
	const pre = await info(A.page, a);
	const disjoint = await runMenu(A.page, a, b, 'Intersect');
	h.check(disjoint.result === false, 'a disjoint Intersect is refused (nothing would be left)');
	h.check((await info(A.page, a)).checksum === pre.checksum && (await exists(A.page, b)), '...and both objects are untouched');

	await h.finish(browser);
});
