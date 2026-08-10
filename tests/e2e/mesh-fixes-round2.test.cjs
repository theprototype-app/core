// Round-2 fixes from real user reports on the M1-M6 mesh tools.
const h = require('./helpers.cjs');

const sel = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditSelectedTris.subscribe((v) => r([...v]))())
	);

const editBox = (page, textured = false) =>
	page.evaluate(async (textured) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		if (textured) {
			const c = document.createElement('canvas');
			c.width = c.height = 2;
			box.material.map = new w.THREE.CanvasTexture(c);
		}
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	}, textured);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- REPORT: "second extrude on the same face breaks texture UV" --------
	// Cause: the wall's far corners took their BASE corner's uv, so the wall's v
	// range was zero — one texel line smeared up the whole side. Each extra
	// extrude stacked another degenerate band.
	const uuid = await editBox(A.page, true);
	const uvSpans = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		/** the uv AREA of the side-wall triangles (n.y ~ 0) — zero means smeared */
		const wallUvArea = () => {
			const geo = g.getObjectByProperty('uuid', uuid).geometry;
			const pos = geo.attributes.position;
			const uv = geo.attributes.uv;
			let area = 0;
			for (let i = 0; i < pos.count; i += 3) {
				const p = [0, 1, 2].map((k) => new w.THREE.Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
				const n = new w.THREE.Vector3()
					.subVectors(p[1], p[0])
					.cross(new w.THREE.Vector3().subVectors(p[2], p[0]))
					.normalize();
				if (Math.abs(n.y) > 0.5) continue; // caps + original sides, not walls
				const u = [0, 1, 2].map((k) => [uv.getX(i + k), uv.getY(i + k)]);
				area += Math.abs(
					(u[1][0] - u[0][0]) * (u[2][1] - u[0][1]) - (u[2][0] - u[0][0]) * (u[1][1] - u[0][1])
				) / 2;
			}
			return area;
		};
		const out = [];
		for (let i = 0; i < 3; i++) {
			w.faceEdit.commitFaceOp('extrude', 0.3);
			out.push(+wallUvArea().toFixed(5));
		}
		return out;
	}, uuid);
	h.check(uvSpans[0] > 0.001, 'THE BUG: extrude walls get a real UV AREA, not a smeared line (' + uvSpans[0] + ')');
	h.check(
		uvSpans[1] > uvSpans[0] && uvSpans[2] > uvSpans[1],
		'each further extrude adds another mapped band (' + JSON.stringify(uvSpans) + ')'
	);

	// ---- REPORT: "all faces selected + extrude moves the whole object" ------
	// A closed surface has no border to extrude from, so every vertex just
	// translates. Refuse and say why instead of silently sliding the object.
	const closed = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		const bbox = () => {
			const geo = g.getObjectByProperty('uuid', box.uuid).geometry;
			const b = new w.THREE.Box3().setFromBufferAttribute(geo.attributes.position);
			return [...b.min.toArray(), ...b.max.toArray()].map((v) => +v.toFixed(3));
		};
		w.faceEdit.selectAllFaces();
		const before = bbox();
		const all = w.faceEdit.commitFaceOp('extrude', 0.3);
		const afterAll = bbox();
		// Shell / Object granularity are the same closed-surface case
		w.faceEdit.clearFaceSelection();
		w.faceEdit.setFaceGranularity('shell');
		w.faceEdit.pickFaceUnit(0);
		const shell = w.faceEdit.commitFaceOp('extrude', 0.3);
		w.faceEdit.setFaceGranularity('quad');
		// ...but a single face still extrudes normally
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const one = w.faceEdit.commitFaceOp('extrude', 0.3);
		return { all, shell, one, before, afterAll, afterOne: bbox() };
	});
	h.check(closed.all === false, 'extruding EVERY face is refused (closed surface, nothing to extrude from)');
	h.check(
		closed.afterAll.join() === closed.before.join(),
		'...and the object did NOT move (' + JSON.stringify(closed.afterAll) + ')'
	);
	h.check(closed.shell === false, 'Shell granularity on a one-piece mesh is the same closed case — also refused');
	h.check(closed.one === true, 'a single face still extrudes normally');
	h.check(closed.afterOne[4] > closed.before[4], '...and grows the mesh (max Y ' + closed.before[4] + ' -> ' + closed.afterOne[4] + ')');

	// ---- REPORT: "shift-click on a selected quad should DESELECT it" --------
	// Driven through the REAL pointer path, not the store: the report is about
	// what the click handler does.
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const clickUuid = await editBox(A.page);
	// park the camera so the top face is unambiguous, then click its centre.
	// NOTE duration must be > 0: flyTo divides by it, and 0 makes the first frame
	// NaN the camera (which then NaNs the spatial-audio panner too).
	await A.page.evaluate(() =>
		window.__stores.objectActions.flyTo([2.2, 2.4, 2.6], [0, 0, 0], 200)
	);
	await A.page.waitForTimeout(700);
	const topPt = await h.projectPoint(A.page, [0, 0.5, 0]);
	const errors = [];
	A.page.on('pageerror', (e) => errors.push(e.message));
	await A.page.mouse.click(topPt.x, topPt.y);
	await A.page.waitForTimeout(200);
	const afterClick = (await sel(A.page)).length;
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(topPt.x, topPt.y);
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(200);
	const afterShift = (await sel(A.page)).length;
	h.check(afterClick > 0, 'a plain click selects the face under the cursor (premise, ' + afterClick + ')');
	h.check(
		afterShift === 0,
		'THE BUG: shift-clicking the SAME face deselects it (' + afterClick + ' -> ' + afterShift + ')'
	);
	h.check(errors.length === 0, 'no page errors during the click path (' + errors.join('; ') + ')');

	// ---- REPORT: "edge loop with two edges of a quad picked" ---------------
	const edges = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.faceEditSubmode.set('edges');
		const geo = g.getObjectByProperty('uuid', box.uuid).geometry;
		const tris = w.faceEdit.readTriangles(geo);
		const topTris = [];
		tris.forEach((t, ti) => {
			const n = new w.THREE.Vector3()
				.subVectors(t[1], t[0])
				.cross(new w.THREE.Vector3().subVectors(t[2], t[0]))
				.normalize();
			if (n.y > 0.99) topTris.push(ti);
		});
		const edgeOf = (ti, i, j) => {
			const t = tris[ti];
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const mid = t[i].clone().add(t[j]).multiplyScalar(0.5);
			return w.faceEdit.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
		};
		// every edge pickable on the two top triangles — the shared DIAGONAL must
		// no longer be offered (it is a triangulation artifact, not a model edge)
		const offered = new Set();
		for (const ti of topTris)
			for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
				const k = edgeOf(ti, i, j);
				if (k) offered.add(k);
			}
		// pick two border edges of the top quad, then Loop
		const border = [...offered];
		w.faceEdit.pickEdge(border[0], false);
		w.faceEdit.pickEdge(border[1], true);
		const picked = 2;
		const ok = w.faceEdit.selectEdgeLoop();
		let after;
		w.faceEdit.edgeEditSelected.subscribe((v) => (after = [...v]))();
		return { offeredCount: offered.size, picked, ok, after: after.length, containsPicks: [border[0], border[1]].every((k) => after.includes(k)) };
	});
	h.check(
		edges.offeredCount === 4,
		'the quad DIAGONAL is no longer pickable — only the 4 real edges are (' + edges.offeredCount + ')'
	);
	h.check(edges.ok === true, 'edge loop commits with two edges picked');
	h.check(
		edges.after === 4 && edges.containsPicks,
		'THE BUG: two edges of a quad complete to that quad\'s 4 borders (' + edges.after + ')'
	);

	// ---- REPORT: "dissolve on a quad's edge does nothing" ------------------
	const dissolve = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		// a PLANE of 2x1 quads so there is a real edge between two coplanar quads
		w.faceEdit.applyMeshGeo(box.uuid, [
			// quad A (0..1)
			0,0,0, 1,0,0, 1,1,0,  0,0,0, 1,1,0, 0,1,0,
			// quad B (1..2)
			1,0,0, 2,0,0, 2,1,0,  1,0,0, 2,1,0, 1,1,0
		]);
		w.faceEdit.enterFaceEdit(box.uuid);
		w.faceEdit.faceEditSubmode.set('edges');
		const keyOf = (v) => [Math.round(v.x*1e4), Math.round(v.y*1e4), Math.round(v.z*1e4)].join(',');
		const shared = (() => {
			const a = keyOf({ x: 1, y: 0, z: 0 });
			const b = keyOf({ x: 1, y: 1, z: 0 });
			return a < b ? a + '|' + b : b + '|' + a;
		})();
		w.faceEdit.pickEdge(shared, false);
		const ok = w.faceEdit.dissolveEdges();
		const tris = w.faceEdit.readTriangles(g.getObjectByProperty('uuid', box.uuid).geometry);
		const stillThere = tris.some((t) => {
			for (let e = 0; e < 3; e++) {
				const ka = keyOf(t[e]);
				const kb = keyOf(t[(e + 1) % 3]);
				if ((ka < kb ? ka + '|' + kb : kb + '|' + ka) === shared) return true;
			}
			return false;
		});
		return { ok, stillThere, tris: tris.length };
	});
	h.check(dissolve.ok === true, 'dissolving the edge between two coplanar quads commits');
	h.check(
		!dissolve.stillThere,
		'THE BUG: the dissolved edge is really GONE from the mesh, not re-triangulated back'
	);
	// the merged patch is fan-triangulated over its FULL boundary, which still
	// carries the two split points where the dissolved edge met it — they are
	// kept deliberately so a neighbouring face never gets a T-junction, so the
	// hexagon fans into 4 triangles rather than a bare rectangle's 2
	h.check(dissolve.tris === 4, '...fanned over the full 6-corner boundary (' + dissolve.tris + ' tris)');

	// ---- REPORT: "keep selections when switching modes" --------------------
	const memory = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		const readF = () => {
			let v;
			w.faceEdit.faceEditSelectedTris.subscribe((x) => (v = [...x]))();
			return v.length;
		};
		const picked = readF();
		// leave to edges and come back
		w.faceEdit.stashSelections();
		w.faceEdit.faceEditSubmode.set('edges');
		w.faceEdit.faceEditSelectedTris.set([]);
		const away = readF();
		w.faceEdit.faceEditSubmode.set('faces');
		const restored = w.faceEdit.restoreSelection('faces');
		const back = readF();
		// now CHANGE the geometry and try again — the stash must be invalidated
		w.faceEdit.stashSelections();
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.commitFaceOp('subdivide', 0);
		const staleOk = w.faceEdit.restoreSelection('faces');
		return { picked, away, restored, back, staleOk };
	});
	h.check(memory.picked === 2 && memory.away === 0, 'the face pick is dropped while away (premise)');
	h.check(memory.restored === true && memory.back === 2, 'coming back to Faces RESTORES the previous pick');
	h.check(
		memory.staleOk === false,
		'...but a geometry change invalidates the stash (stale indices are never restored)'
	);

	// ---- the key list is now a movable window ------------------------------
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await editBox(A.page);
	await A.page.waitForSelector('#mesh-keys-help');
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());
	await A.page.waitForSelector('#mesh-keys-popover', { timeout: 5000 });
	const sheet = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-keys-popover');
		return {
			fixed: getComputedStyle(el).position === 'fixed',
			header: !!el.querySelector('.toolbox-header.move-handle'),
			text: el.innerText
		};
	});
	h.check(sheet.fixed && sheet.header, 'the key list is a movable window with its own drag header');
	h.check(/Weld/.test(sheet.text), '...still listing the bindings');
	const moved = await A.page.evaluate(async () => {
		const el = document.querySelector('#mesh-keys-popover');
		const before = el.getBoundingClientRect().left;
		const head = el.querySelector('.toolbox-header');
		const r = head.getBoundingClientRect();
		const opts = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
		head.dispatchEvent(new PointerEvent('pointerdown', opts));
		el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: opts.clientX + 90, movementX: 90, movementY: 0 }));
		el.dispatchEvent(new PointerEvent('pointerup', opts));
		await new Promise((r2) => setTimeout(r2, 50));
		return { before, after: el.getBoundingClientRect().left };
	});
	h.check(moved.after > moved.before + 50, 'dragging its header moves it (' + moved.before + ' -> ' + moved.after + ')');

	await h.finish(browser);
});
