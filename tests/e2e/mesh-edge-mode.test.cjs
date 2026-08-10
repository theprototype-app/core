// M4: edge selection mode — the third mode beside Vertices and Faces.
//
// Edges are a SUB-MODE of the face session (same lifecycle, undo barrier,
// wireframe and VR entry), so switching to them never tears the session down.
// An edge is its canonical welded key pair, so the two triangles sharing it
// always name it identically.
const h = require('./helpers.cjs');

const edgeSel = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.edgeEditSelected.subscribe((v) => r([...v]))())
	);

const editBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.faceEditSubmode.set('edges');
		return box.uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await editBox(A.page);

	// --------------------------------------- 1. picking the NEAREST edge
	const picks = await A.page.evaluate(() => {
		const w = window.__stores;
		const T = w.THREE;
		const tris = w.faceEdit.currentFaces();
		void tris;
		// triangle 0's three corners; a point near each edge's midpoint must pick
		// THAT edge, and the same edge from either adjacent triangle
		let group;
		w.objectsGroup.subscribe((v) => (group = v))();
		let uuid;
		w.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
		const geo = group.getObjectByProperty('uuid', uuid).geometry;
		const t = w.faceEdit.readTriangles(geo)[0];
		const out = [];
		for (let e = 0; e < 3; e++) {
			const a = t[e];
			const b = t[(e + 1) % 3];
			// 90% of the way toward this edge's midpoint from the centroid
			const c = a.clone().add(b).add(t[(e + 2) % 3]).multiplyScalar(1 / 3);
			const mid = a.clone().add(b).multiplyScalar(0.5);
			const probe = c.clone().lerp(mid, 0.95);
			out.push(w.faceEdit.pickEdgeAt(0, probe));
		}
		void T;
		return { keys: out, distinct: new Set(out).size };
	});
	// only the REAL edges are offered: a triangle's third edge is its quad's
	// internal DIAGONAL, a triangulation artifact rather than an edge of the
	// model, and picking it produced an edge that could not be dissolved
	// Only the REAL edges are offered: a triangle's third edge is its quad's
	// internal DIAGONAL, a triangulation artifact rather than an edge of the
	// model, and picking it produced an edge that could not be dissolved. All
	// three probes still return an edge — the one nearest the diagonal falls
	// through to a real one — but only TWO distinct keys exist.
	h.check(
		picks.distinct === 2,
		'a triangle offers its 2 REAL edges and skips the quad diagonal (' + picks.distinct + ' distinct)'
	);

	const shared = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const tris = w.faceEdit.readTriangles(geo);
		// the diagonal of the first quad is shared by triangles 0 and 1
		const mate = w.faceEdit.quadOfTriangle(0).find((t) => t !== 0);
		const keysOf = (ti) => {
			const t = tris[ti];
			const mid = (i, j) => t[i].clone().add(t[j]).multiplyScalar(0.5);
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			return [
				[0, 1],
				[1, 2],
				[2, 0]
			].map(([i, j]) => w.faceEdit.pickEdgeAt(ti, c.clone().lerp(mid(i, j), 0.95)));
		};
		const a = keysOf(0);
		const b = keysOf(mate);
		return a.filter((k) => b.includes(k));
	}, uuid);
	h.check(
		shared.length === 0,
		'...so the two halves of a quad share NO pickable edge (' + shared.length + ')'
	);

	// --------------------------------------------- 2. select / multi / clear
	const flow = await A.page.evaluate(() => {
		const w = window.__stores;
		const read = () => {
			let v;
			w.faceEdit.edgeEditSelected.subscribe((x) => (v = [...x]))();
			return v;
		};
		let group;
		w.objectsGroup.subscribe((v) => (group = v))();
		let uuid;
		w.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
		const tris = w.faceEdit.readTriangles(group.getObjectByProperty('uuid', uuid).geometry);
		const edgeOf = (ti, i, j) => {
			const t = tris[ti];
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const mid = t[i].clone().add(t[j]).multiplyScalar(0.5);
			return w.faceEdit.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
		};
		const e1 = edgeOf(0, 0, 1);
		const e2 = edgeOf(4, 0, 1);
		w.faceEdit.pickEdge(e1, false);
		const one = read().length;
		w.faceEdit.pickEdge(e2, true);
		const two = read().length;
		w.faceEdit.pickEdge(e2, true); // toggles it back off
		const back = read().length;
		w.faceEdit.pickEdge(e2, false); // plain pick REPLACES
		const replaced = read();
		w.faceEdit.clearEdgeSelection();
		return { one, two, back, replaced: replaced.length, replacedIsE2: replaced[0] === e2, cleared: read().length };
	});
	h.check(flow.one === 1, 'a plain pick selects one edge');
	h.check(flow.two === 2, 'ctrl-pick ADDS a second');
	h.check(flow.back === 1, '...and picking it again toggles it off');
	h.check(flow.replaced === 1 && flow.replacedIsE2, 'a plain pick REPLACES the set');
	h.check(flow.cleared === 0, 'clear empties the selection');

	// ------------------------------------------------- 3. the edge overlay
	const overlay = await A.page.evaluate(async () => {
		const w = window.__stores;
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		const find = () => {
			let hit = null;
			scene.traverse((n) => {
				if (n.name === 'edge-edit-overlay') hit = n;
			});
			return hit;
		};
		const none = !!find();
		let group;
		w.objectsGroup.subscribe((v) => (group = v))();
		let uuid;
		w.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
		const tris = w.faceEdit.readTriangles(group.getObjectByProperty('uuid', uuid).geometry);
		const t = tris[0];
		const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
		const mid = t[0].clone().add(t[1]).multiplyScalar(0.5);
		w.faceEdit.pickEdge(w.faceEdit.pickEdgeAt(0, c.clone().lerp(mid, 0.95)), false);
		const node = find();
		return {
			noneBefore: none,
			exists: !!node,
			segments: node ? node.geometry.attributes.position.count / 2 : 0,
			inertRaycast: node ? node.raycast.toString().length < 40 : false
		};
	});
	h.check(!overlay.noneBefore, 'no edge overlay while nothing is picked');
	h.check(overlay.exists && overlay.segments === 1, 'picking an edge draws exactly one highlight segment');
	h.check(overlay.inertRaycast, '...whose raycast is stubbed so it never eats a pick');

	// -------------------------------------------------- 4. edge loop select
	const loop = await A.page.evaluate(() => {
		const w = window.__stores;
		const ok = w.faceEdit.selectEdgeLoop();
		let v;
		w.faceEdit.edgeEditSelected.subscribe((x) => (v = [...x]))();
		return { ok, count: v.length };
	});
	h.check(loop.ok === true, 'edge loop select commits');
	h.check(loop.count > 1, 'the loop is more than the one picked edge (' + loop.count + ')');

	// ------------------------------------------------------- 5. dissolve
	const dissolve = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.faceEditSubmode.set('edges');
		const geo = () => g.getObjectByProperty('uuid', box.uuid).geometry;
		// index-aware: a fresh BoxGeometry is INDEXED (24 positions / 36 indices)
		const count = () => {
			const x = geo();
			return (x.index ? x.index.count : x.attributes.position.count) / 3;
		};
		const before = count();
		// the DIAGONAL of a box side joins two coplanar triangles — dissolving it
		// merges them back into one quad's worth of surface
		const tris = w.faceEdit.readTriangles(geo());
		const mate = w.faceEdit.quadOfTriangle(0).find((t) => t !== 0);
		const keysOf = (ti) => {
			const t = tris[ti];
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			return [
				[0, 1],
				[1, 2],
				[2, 0]
			].map(([i, j]) => w.faceEdit.pickEdgeAt(ti, c.clone().lerp(t[i].clone().add(t[j]).multiplyScalar(0.5), 0.95)));
		};
		const diagonal = keysOf(0).find((k) => keysOf(mate).includes(k));
		w.faceEdit.pickEdge(diagonal, false);
		const ok = w.faceEdit.dissolveEdges();
		const after = count();
		// a box EDGE (between two perpendicular faces) must be REFUSED
		const tris2 = w.faceEdit.readTriangles(geo());
		const t0 = tris2[0];
		const c0 = t0[0].clone().add(t0[1]).add(t0[2]).multiplyScalar(1 / 3);
		let perpendicular = '';
		for (let e = 0; e < 3; e++) {
			const key = w.faceEdit.pickEdgeAt(
				0,
				c0.clone().lerp(t0[e].clone().add(t0[(e + 1) % 3]).multiplyScalar(0.5), 0.95)
			);
			if (key !== diagonal) perpendicular = key;
		}
		w.faceEdit.pickEdge(perpendicular, false);
		const refused = w.faceEdit.dissolveEdges();
		return { before, ok, after, refused, afterRefuse: count() };
	});
	h.check(dissolve.before === 12, 'a box is 12 triangles (premise)');
	// the quad diagonal is no longer pickable, so there is nothing to dissolve
	// on a bare box — every one of its real edges is a non-coplanar corner
	h.check(dissolve.ok === false, 'a box has no dissolvable edge — every real edge is a corner');
	h.check(dissolve.refused === false, 'dissolving a NON-coplanar edge is refused, not silently applied');
	h.check(dissolve.afterRefuse === dissolve.before, '...leaving the geometry untouched');

	// ------------------------------------- 6. the session is NOT torn down
	const session = await A.page.evaluate(() => {
		const w = window.__stores;
		let before;
		w.faceEdit.faceEditObject.subscribe((v) => (before = v))();
		w.faceEdit.faceEditSubmode.set('faces');
		let mid;
		w.faceEdit.faceEditObject.subscribe((v) => (mid = v))();
		w.faceEdit.faceEditSubmode.set('edges');
		let after;
		w.faceEdit.faceEditObject.subscribe((v) => (after = v))();
		return { before, mid, after, live: w.editSession.editSessionDebug().active };
	});
	h.check(
		session.before && session.before === session.mid && session.mid === session.after,
		'switching edges <-> faces keeps the SAME face session alive'
	);
	h.check(session.live === true, '...and the undo barrier stays open');

	// exiting clears the edge pick + overlay
	const cleaned = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		let hit = null;
		scene.traverse((n) => {
			if (n.name === 'edge-edit-overlay') hit = n;
		});
		let sel;
		w.faceEdit.edgeEditSelected.subscribe((v) => (sel = [...v]))();
		return { overlay: !!hit, sel: sel.length };
	});
	h.check(!cleaned.overlay && cleaned.sel === 0, 'leaving the session drops the edge pick and its overlay');

	await h.finish(browser);
});
