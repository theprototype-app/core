// Phase 163: desktop face editing with a transform gizmo. Selecting a face
// attaches a gizmo (a scene-root proxy driving the shared 162 rigid grab); a
// drag moves the face + commits ONE meshgeo (undoable); 1/2/3 switch the gizmo
// mode without deselecting; leaving face mode detaches it. Pointer/gizmo feel
// is a desktop manual check — here we drive the proxy directly.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp; s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		s.faceEdit.enterFaceEdit(box.uuid);

		// pick the +X face + attach the gizmo
		const faces = s.faceEdit.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[xi].triIndices[0]);
		s.faceEdit.attachFaceGizmo();
		let controls; s.TControls.subscribe((c) => (controls = c))();
		const attached = controls?.object?.userData?.isFaceProxy === true;

		const maxX = () => {
			const p = box.geometry.attributes.position;
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getX(i));
			return m;
		};
		const before = maxX();

		// simulate a translate drag of the gizmo (+0.5 world x)
		const captured = []; let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.faceEdit.onFaceGizmoDragChanged(true); // begin grab
		controls.object.position.x += 0.5;
		s.faceEdit.onFaceGizmoMoved(); // apply live
		const dragged = maxX();
		s.faceEdit.onFaceGizmoDragChanged(false); // commit
		s.peers.set(original);
		const committed = maxX();
		const meshgeo = captured.filter((m) => m.type === 'meshgeo').length;

		// 1/2/3 switch the gizmo mode WITHOUT deselecting the face proxy
		s.objectActions.setTransformMode('rotate');
		const rotMode = controls.mode === 'rotate';
		const stillFace = controls.object?.userData?.isFaceProxy === true;

		s.history.undo();
		const undone = maxX();

		s.faceEdit.exitFaceEdit();
		const detached = controls.object?.userData?.isFaceProxy !== true;

		return { attached, before, dragged, committed, meshgeo, rotMode, stillFace, undone, detached };
	});

	h.check(res.attached, 'selecting a face attaches the transform gizmo');
	h.check(res.dragged > res.before + 0.4, `dragging the gizmo moves the face (+X ${res.before.toFixed(2)} -> ${res.dragged.toFixed(2)})`);
	h.check(res.meshgeo >= 1, 'the drag broadcasts a meshgeo snapshot (final + throttled previews)');
	h.check(res.committed > res.before + 0.4, 'the move persists after release');
	h.check(res.rotMode && res.stillFace, '1/2/3 switches the gizmo mode without deselecting');
	h.check(Math.abs(res.undone - res.before) < 1e-3, 'the face move is undoable');
	h.check(res.detached, 'leaving face mode detaches the gizmo');

	// ---- 15-E (E9/E8): face-basis gizmo, Local/World toggle + setSpace leak
	// fix, per-axis tangential scale, rotation-frame conjugation ----
	const e9 = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		fe.enterFaceEdit(box.uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.pickFaceUnit(faces[xi].triIndices[0]);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.attachFaceGizmo();
		// E9: proxy Z = the +X face WORLD normal (was: the object quaternion,
		// identical handles on every face of an axis-aligned box)
		const z = new T.Vector3(0, 0, 1).applyQuaternion(controls.object.quaternion);
		const zIsNormal = z.distanceTo(new T.Vector3(1, 0, 0)) < 1e-4;
		const spaceLocal = controls.space === 'local';
		fe.faceGizmoSpace.set('world');
		const spaceWorld = controls.space === 'world';
		fe.faceGizmoSpace.set('local');

		/** verts on the +X plane (cap + welded corner instances) */
		const readPlane = () => {
			const p = box.geometry.attributes.position;
			const out = { xs: [], ys: [], zs: [] };
			for (let i = 0; i < p.count; i++)
				if (p.getX(i) > 0.499) {
					out.xs.push(p.getX(i));
					out.ys.push(p.getY(i));
					out.zs.push(p.getZ(i));
				}
			return out;
		};
		const span = (/** @type {number[]} */ a) => Math.max(...a) - Math.min(...a);

		// E8: scale (2,1,1) in the PROXY frame stretches exactly one tangent —
		// for n=+X the deterministic tangent seed makes proxy X the world Z axis
		fe.onFaceGizmoDragChanged(true);
		controls.object.scale.set(2, 1, 1);
		fe.onFaceGizmoMoved();
		const scaled = readPlane();
		const zSpan = span(scaled.zs);
		const ySpan = span(scaled.ys);
		const xFlat = scaled.xs.every((x) => Math.abs(x - 0.5) < 1e-3);
		fe.cancelFaceGrab();

		// E9 invariant: rotate 90° about the face normal keeps the cap ON its plane
		fe.attachFaceGizmo();
		fe.onFaceGizmoDragChanged(true);
		const qz90 = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), Math.PI / 2);
		controls.object.quaternion.multiply(qz90); // a proxy-local delta
		fe.onFaceGizmoMoved();
		const rotFlat = readPlane().xs.every((x) => Math.abs(x - 0.5) < 1e-3);
		fe.cancelFaceGrab();

		// no tears: commit a GENERIC rotation (25° — corners land at generic
		// positions) and count odd edges (watertight = every edge shared by 2)
		fe.attachFaceGizmo();
		fe.onFaceGizmoDragChanged(true);
		const q25 = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), (25 * Math.PI) / 180);
		controls.object.quaternion.multiply(q25);
		fe.onFaceGizmoMoved();
		fe.onFaceGizmoDragChanged(false); // commit
		const tris = fe.readTriangles(box.geometry);
		const counts = new Map();
		const key = (/** @type {any} */ v) =>
			Math.round(v.x * 1e4) + ',' + Math.round(v.y * 1e4) + ',' + Math.round(v.z * 1e4);
		tris.forEach((t) => {
			for (let e = 0; e < 3; e++) {
				const k = [key(t[e]), key(t[(e + 1) % 3])].sort().join('|');
				counts.set(k, (counts.get(k) || 0) + 1);
			}
		});
		const oddEdges = [...counts.values()].filter((c) => c !== 2).length;

		// E9 leak fix: leaving face mode restores world space on the SHARED controls
		fe.exitFaceEdit();
		const spaceRestored = controls.space === 'world';
		return { zIsNormal, spaceLocal, spaceWorld, zSpan, ySpan, xFlat, rotFlat, oddEdges, spaceRestored };
	});

	h.check(e9.zIsNormal, 'E9: the gizmo Z axis is the face normal on the +X face');
	h.check(e9.spaceLocal && e9.spaceWorld, 'the Local/World toggle flips the live gizmo space');
	h.check(
		Math.abs(e9.zSpan - 2) < 1e-3 && Math.abs(e9.ySpan - 1) < 1e-3,
		`E8: per-axis (2,1,1) scale stretches one tangent only (z ${e9.zSpan.toFixed(2)}, y ${e9.ySpan.toFixed(2)})`
	);
	h.check(e9.xFlat, 'the tangential scale leaves the normal extent unchanged');
	h.check(e9.rotFlat, 'E9: rotating 90° about the normal keeps the cap on its plane');
	h.check(e9.oddEdges === 0, `a committed rotation leaves no tears (${e9.oddEdges} odd edges)`);
	h.check(e9.spaceRestored, 'E9 leak fix: exitFaceEdit restores world space');

	await h.finish(browser);
});
