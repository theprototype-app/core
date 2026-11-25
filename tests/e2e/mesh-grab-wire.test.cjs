// Lane 99-scrub: the face-grab COMMIT keeps the edit wire when it can, and only then.
// The quad wire is a function of the weld (which corners share a vertex) and the stored partition; a grab that
// kept both leaves the wire's structure as it was, and the drag already rewrote its points in place. Rebuilding it
// at commit was the largest part of a 67k commit (~190 ms of string edge keys), and at the FIRST move of every grab
// (the grab's private geometry copy looked like a different geometry to the wire).
//   1. a quad grab on a stored-partition grid: the wire OBJECT survives the first move and the commit (no rebuild),
//      and what it draws equals a wire built from scratch from the committed geometry, point for point
//   2. a vertex dragged ONTO its neighbour changes the weld: the commit REBUILDS the wire (a new object), and that
//      one equals a scratch build too
//   3. undo after each brings the pre-grab bytes back (the commit's entry is unchanged by the lane)
// Run with mesh-live-edit and mesh-edge-gizmo for a change to the grab commit or the edit wire.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const r = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const fe = s.faceEdit;
		const raf = () => new Promise((res) => requestAnimationFrame(res));
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		let obj = g.children[g.children.length - 1];
		const V3 = obj.position.constructor;
		fe.enterFaceEdit(obj.uuid);
		fe.setFaceGranularity('quad');
		for (let i = 0; i < 3; i++) await raf();
		const out = {};
		const wireOf = () => obj.children.find((c) => c.isLineSegments && c.name === 'edit-overlay');
		const bytes = () => Array.from(obj.geometry.attributes.position.array).join(',');
		// what a rebuild would draw now: the same builder on a clone carrying the same stored partition
		const scratchSame = () => {
			const w = wireOf();
			const ref = fe.editWireGeometry(obj.geometry.clone()).attributes.position.array;
			const got = w?.geometry?.attributes?.position?.array;
			return !!got && got.length === ref.length && got.every((x, i) => x === ref[i]);
		};
		/** the triangle whose centroid is nearest (x, y) on the plane */
		const triNear = (x, y) => {
			const P = obj.geometry.attributes.position.array;
			let best = -1;
			let bd = Infinity;
			for (let t = 0; t < P.length / 9; t++) {
				const cx = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3;
				const cy = (P[t * 9 + 1] + P[t * 9 + 4] + P[t * 9 + 7]) / 3;
				const d = (cx - x) ** 2 + (cy - y) ** 2;
				if (d < bd) ((bd = d), (best = t));
			}
			return best;
		};
		const quadGrab = (x, y, dz) => {
			fe.pickFaceUnit(triNear(x, y));
			const target = fe.currentTargetFace();
			const ok = fe.beginFaceGrab(target);
			fe.applyFaceGrab({ dPos: new V3(0, 0, dz) });
			const afterFirst = wireOf();
			for (let i = 2; i <= 4; i++) fe.applyFaceGrab({ dPos: new V3(0, 0, dz * i) });
			return { ok, afterFirst };
		};

		// 0. the FIRST edit stores the derived partition; a small move pairs the same quads, so the wire stays
		out.unstoredBefore = !obj.geometry.userData.__topo;
		const wFirst = wireOf();
		const gFirst = quadGrab(-1.25, -1.25, 0.002);
		fe.commitFaceGrab();
		await raf();
		out.storedAfterFirst = !!obj.geometry.userData.__topo;
		out.firstKept = !!wFirst && gFirst.afterFirst === wFirst && wireOf() === wFirst;
		out.firstSameAsScratch = scratchSame();

		// 1. a quad grab on the stored partition keeps the wire
		const w0 = wireOf();
		const b1 = bytes();
		const g1 = quadGrab(0.75, 0.75, 0.1);
		out.grabOk = g1.ok;
		out.keptOnFirstMove = !!w0 && g1.afterFirst === w0;
		fe.commitFaceGrab();
		await raf();
		out.keptOnCommit = wireOf() === w0;
		out.moved = bytes() !== b1;
		out.sameAsScratch = scratchSame();
		s.history.undo();
		await raf();
		out.undo1 = bytes() === b1;
		out.sameAsScratchAfterUndo = scratchSame();

		// 2. a vertex dragged onto its neighbour: the weld changes, the wire is rebuilt
		fe.setFaceSubmode('edges');
		const w1 = wireOf();
		const b2 = bytes();
		const ok2 = fe.beginFaceGrab({
			vertexKeys: new Set(['0,0,0']), // the plane's centre vertex (the weld grid is 1e-4)
			triIndices: [],
			centroid: new V3(0, 0, 0),
			normal: new V3(0, 0, 1)
		});
		fe.applyFaceGrab({ dPos: new V3(0.25, 0, 0) });
		fe.applyFaceGrab({ dPos: new V3(0.5, 0, 0) }); // exactly onto (0.5, 0, 0)
		fe.commitFaceGrab();
		await raf();
		out.weldGrabOk = ok2;
		out.weldMoved = bytes() !== b2;
		out.rebuiltOnWeldChange = !!wireOf() && wireOf() !== w1;
		out.weldSameAsScratch = scratchSame();
		s.history.undo();
		await raf();
		out.undo2 = bytes() === b2;
		fe.setFaceSubmode('faces');
		fe.exitFaceEdit();

		// 0b. on a FRESH plane, a big first move tilts the neighbours out of plane: the derived pairing changes and
		// the wire is rebuilt
		s.commandsHandler.sceneCommand('/create Plane 4 4 8 8');
		s.objectsGroup.subscribe((v) => (g = v))();
		obj = g.children[g.children.length - 1];
		fe.enterFaceEdit(obj.uuid);
		fe.setFaceGranularity('quad');
		for (let i = 0; i < 3; i++) await raf();
		out.bigUnstored = !obj.geometry.userData.__topo;
		const wBig = wireOf();
		quadGrab(-1.25, -1.25, 0.25);
		fe.commitFaceGrab();
		await raf();
		out.bigRebuilt = !!wireOf() && wireOf() !== wBig;
		out.bigSameAsScratch = scratchSame();
		fe.exitFaceEdit();
		return out;
	});
	console.log('[grab-wire] ' + JSON.stringify(r));
	h.check(r.unstoredBefore === true, '0. the plane starts with no stored partition (premise)');
	h.check(r.storedAfterFirst === true, '0. the first commit stores the derived partition');
	h.check(
		r.firstKept === true,
		'0. ...and, the move being small (same pairing), keeps the wire object'
	);
	h.check(
		r.firstSameAsScratch === true,
		'0. ...which equals a scratch build of the committed geometry'
	);
	h.check(
		r.bigRebuilt === true,
		'0b. a big first move changes the derived pairing: the wire is rebuilt'
	);
	h.check(r.bigSameAsScratch === true, '0b. ...and equals a scratch build');
	h.check(r.grabOk === true && r.moved === true, '1. a quad grab moved the quad (premise)');
	h.check(
		r.keptOnFirstMove === true,
		'1. the first move of the grab keeps the wire object (no rebuild at drag start)'
	);
	h.check(
		r.keptOnCommit === true,
		'1. the commit keeps the wire object (the weld and partition did not change)'
	);
	h.check(
		r.sameAsScratch === true,
		'1. ...and the kept wire equals a wire built from scratch, point for point'
	);
	h.check(r.undo1 === true, '1. undo brings the pre-grab bytes back');
	h.check(r.sameAsScratchAfterUndo === true, '1. ...and the wire follows the undo');
	h.check(
		r.weldGrabOk === true && r.weldMoved === true,
		'2. a vertex grab moved the centre vertex (premise)'
	);
	h.check(
		r.rebuiltOnWeldChange === true,
		'2. a vertex dropped onto its neighbour changes the weld: the commit rebuilds the wire'
	);
	h.check(r.weldSameAsScratch === true, '2. ...and that wire equals a scratch build');
	h.check(r.undo2 === true, '2. undo brings the pre-grab bytes back');
	h.check(
		h.pageErrors(A).length === 0,
		`no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 3))})`
	);
	await h.finish(browser);
});
