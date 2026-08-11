// P9: the STORED TOPOLOGY channel. A face partition becomes DATA that survives the
// paths a derived one could not: a rigid/twisting positions commit, the wire, undo/redo
// and a toJSON session save. The adversarial case is measured in-test rather than
// assumed — the twist check computes the derived counterfactual and asserts derivation
// really would have lost the quads, so the guard cannot pass vacuously.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- validation + wire packing (pure) ----------------------------------
	const pure = await A.page.evaluate(() => {
		const t = window.__stores.meshTopology;
		const ok = t.facesValidFor(
			[
				[0, 1],
				[2, 3]
			],
			4
		);
		const dupe = t.facesValidFor([[0, 1], [1, 2], [3]], 4);
		const oob = t.facesValidFor([[0, 1], [2, 9]], 4);
		const partial = t.facesValidFor([[0, 1]], 4);
		const empty = t.facesValidFor([], 4);
		const faces = [[0, 1], [2, 3], [4], [5, 6]];
		const packed = t.packFaces(faces);
		const back = t.unpackFaces(packed.faceCounts, packed.faceTris);
		const roundTrip = JSON.stringify(back) === JSON.stringify(faces);
		// binarypack hands back a VIEW into a larger buffer — the exact bytes must be
		// sliced or the counts read a neighbouring message's numbers (assetShare trap)
		const big = new Int32Array(4 + packed.faceCounts.byteLength / 4);
		big.set(new Int32Array(packed.faceCounts), 4);
		const view = big.subarray(4);
		const fromView = t.unpackFaces(view, packed.faceTris);
		const viewOk = JSON.stringify(fromView) === JSON.stringify(faces);
		// a partition too big for the wire sends NOTHING rather than a truncated one
		const huge = [];
		for (let i = 0; i < t.MAX_FACE_TRIS + 10; i++) huge.push([i]);
		const capped = Object.keys(t.facesWireFields(huge)).length === 0;
		const none = Object.keys(t.facesWireFields(null)).length === 0;
		const fields = t.facesWireFields(faces);
		return { ok, dupe, oob, partial, empty, roundTrip, viewOk, capped, none, fieldKeys: Object.keys(fields).sort() };
	});
	h.check(pure.ok, 'a partition covering every triangle exactly once is valid');
	h.check(!pure.dupe, 'a triangle in two faces is REJECTED');
	h.check(!pure.oob, 'an out-of-range triangle index is REJECTED');
	h.check(!pure.partial, 'a partition that misses triangles is REJECTED');
	h.check(!pure.empty, 'an empty partition is REJECTED');
	h.check(pure.roundTrip, 'CSR pack/unpack round-trips a mixed quad/tri partition');
	h.check(pure.viewOk, 'unpack slices a typed-array VIEW into a larger buffer');
	h.check(pure.capped, 'a partition over MAX_FACE_TRIS sends no fields at all');
	h.check(pure.none, 'no partition means no wire fields');
	h.check(
		JSON.stringify(pure.fieldKeys) === JSON.stringify(['faceCounts', 'faceTris']),
		'the wire fields are faceCounts + faceTris (raw buffers, never nested arrays)'
	);

	// ---- a face op STORES its partition; the wire carries it ---------------
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__box = box;
		return box.uuid;
	});

	const stored = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		const fresh = t.readStoredFaces(window.__box.geometry); // nothing yet: derived world
		fe.enterFaceEdit(uuid);
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
		s.peers.set(original);
		const after = t.readStoredFaces(window.__box.geometry);
		const tris = window.__box.geometry.attributes.position.count / 3;
		const msg = captured.find((m) => m.type === 'meshgeo');
		const wire = msg?.faceCounts ? t.unpackFaces(msg.faceCounts, msg.faceTris) : null;
		return {
			fresh,
			hasAfter: !!after,
			valid: t.facesValidFor(after, tris),
			quads: after ? after.filter((f) => f.length === 2).length : 0,
			wireIsBuffer: msg?.faceCounts instanceof ArrayBuffer && msg?.faceTris instanceof ArrayBuffer,
			wireMatches: wire ? JSON.stringify(wire) === JSON.stringify(after) : false
		};
	}, uuid);
	h.check(stored.fresh === null, 'an untouched box carries NO stored topology (derivation still rules it)');
	h.check(stored.hasAfter && stored.valid, 'an extrude leaves a VALID partition stored on the geometry');
	h.check(stored.quads >= 6, `the stored partition holds the mesh's quads (${stored.quads})`);
	h.check(stored.wireIsBuffer, 'the meshgeo message carries the topology as raw Int32 buffers');
	h.check(stored.wireMatches, 'what went on the wire IS what the sender stored');

	// ---- the headline criterion: a twisted band KEEPS its quads ------------
	// Rotating an extruded band ~4 degrees leaves each wall quad's two triangles ~9
	// degrees apart, which no coplanarity threshold separates from a genuine crease.
	// The derived counterfactual is computed here so the check cannot pass vacuously.
	const twist = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		const THREE = s.THREE ?? window.__stores.three;
		const geom = window.__box.geometry;
		const position = geom.attributes.position;
		const before = [];
		for (let i = 0; i < position.count; i++)
			before.push(position.getX(i), position.getY(i), position.getZ(i));
		const quadCount = () => {
			let n = 0;
			const tris = window.__box.geometry.attributes.position.count / 3;
			for (let i = 0; i < tris; i++) if (fe.quadOfTriangle(i).length === 2) n++;
			return n / 2; // both halves report the pair
		};
		const quadsBefore = quadCount();
		// twist everything past the original +X wall (the extruded cap ring) about X
		const twisted = before.slice();
		const angle = (4 * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		for (let i = 0; i < twisted.length; i += 3)
			if (twisted[i] > 0.5 + 1e-4) {
				const y = twisted[i + 1];
				const z = twisted[i + 2];
				twisted[i + 1] = y * cos - z * sin;
				twisted[i + 2] = y * sin + z * cos;
			}
		fe.commitMeshGeoSnapshot(uuid, before, twisted);
		const quadsAfter = quadCount();
		const carried = t.readStoredFaces(window.__box.geometry);
		// the counterfactual: forget the stored partition and let derivation try
		t.clearStoredFaces(window.__box.geometry);
		fe.applyMeshGeo(uuid, twisted);
		const derivedQuads = quadCount();
		const derivedStored = t.readStoredFaces(window.__box.geometry);
		// put the real partition back so the undo checks below see the true state
		t.storeFaces(window.__box.geometry, carried);
		fe.applyMeshGeo(uuid, twisted);
		return { quadsBefore, quadsAfter, derivedQuads, carriedValid: !!carried, reDerived: !!derivedStored };
	}, uuid);
	h.check(twist.quadsBefore > 0, `the extruded mesh starts with quads (${twist.quadsBefore})`);
	h.check(
		twist.derivedQuads < twist.quadsBefore,
		`the twist IS adversarial: derivation alone drops to ${twist.derivedQuads} of ${twist.quadsBefore} quads`
	);
	h.check(
		twist.quadsAfter === twist.quadsBefore,
		`stored topology carries the twist: ${twist.quadsAfter} quads kept (derived would give ${twist.derivedQuads})`
	);
	h.check(twist.carriedValid, 'the carried partition still validates against the twisted mesh');
	h.check(!twist.reDerived, 'a cleared partition is NOT silently re-stored by a positions-only apply');

	// ---- A7: a triangle-count change DROPS topology, never corrupts --------
	const mismatch = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const t = s.meshTopology;
		const geom = window.__box.geometry;
		const position = geom.attributes.position;
		const positions = [];
		for (let i = 0; i < position.count; i++)
			positions.push(position.getX(i), position.getY(i), position.getZ(i));
		const had = !!t.readStoredFaces(geom);
		// one triangle FEWER: the stored partition addresses triangles that are gone
		const shorter = positions.slice(0, positions.length - 9);
		s.faceEdit.applyMeshGeo(uuid, shorter);
		const afterShrink = t.readStoredFaces(window.__box.geometry);
		// and a wire partition that does not fit is dropped rather than stored
		const bogus = t.packFaces([[0, 1], [2, 3]]);
		s.faceEdit.applyMeshGeo(uuid, shorter, undefined, undefined, bogus.faceCounts, bogus.faceTris);
		const afterBogus = t.readStoredFaces(window.__box.geometry);
		const alive = window.__box.geometry.attributes.position.count / 3;
		return { had, afterShrink, afterBogus, alive };
	}, uuid);
	h.check(mismatch.had, 'topology was present before the mismatch checks');
	h.check(mismatch.afterShrink === null, 'a triangle-count change DROPS the carried partition (A7)');
	h.check(mismatch.afterBogus === null, 'a wire partition that does not fit the mesh is DROPPED');
	h.check(mismatch.alive > 0, `the mesh survived both drops intact (${mismatch.alive} triangles)`);

	// ---- undo/redo carries topology inside the state object (A5) ----------
	const undo = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(uuid);
		// SEED: the mismatch checks above deliberately left the mesh without topology,
		// and an undo can only restore what the pre-op state actually held. One extrude
		// first, so the measured op's `before` carries a real partition.
		const seedFaces = fe.currentFaces();
		const seedIndex = seedFaces.findIndex((f) => f.normal.z > 0.9);
		if (seedIndex < 0) return { skipped: true };
		fe.highlightFaceByTriangle(seedFaces[seedIndex].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		if (yi < 0) return { skipped: true };
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
		const afterOp = t.readStoredFaces(window.__box.geometry);
		const trisAfterOp = window.__box.geometry.attributes.position.count / 3;
		s.history.undo();
		const afterUndo = t.readStoredFaces(window.__box.geometry);
		const trisAfterUndo = window.__box.geometry.attributes.position.count / 3;
		s.history.redo();
		const afterRedo = t.readStoredFaces(window.__box.geometry);
		const trisAfterRedo = window.__box.geometry.attributes.position.count / 3;
		return {
			opQuads: afterOp?.filter((f) => f.length === 2).length ?? 0,
			trisAfterOp,
			undoValid: t.facesValidFor(afterUndo, trisAfterUndo),
			trisAfterUndo,
			redoQuads: afterRedo?.filter((f) => f.length === 2).length ?? 0,
			redoSame: JSON.stringify(afterRedo) === JSON.stringify(afterOp),
			trisAfterRedo
		};
	}, uuid);
	h.check(!undo.skipped, 'the +Y face was pickable for the undo round trip');
	h.check(undo.trisAfterUndo < undo.trisAfterOp, `undo restored the pre-extrude mesh (${undo.trisAfterOp} -> ${undo.trisAfterUndo})`);
	h.check(undo.undoValid, 'the undone state carries a partition valid for the mesh it restored');
	h.check(undo.trisAfterRedo === undo.trisAfterOp, 'redo restored the extruded mesh');
	h.check(undo.redoSame && undo.redoQuads === undo.opQuads, `redo restored the SAME partition (${undo.redoQuads} quads)`);

	// ---- storage location survives a toJSON session save ------------------
	const save = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const THREE = s.THREE;
		const mine = t.readStoredFaces(window.__box.geometry);
		const json = window.__box.toJSON();
		const parsed = new THREE.ObjectLoader().parse(json);
		const theirs = t.readStoredFaces(parsed.geometry);
		return { same: JSON.stringify(theirs) === JSON.stringify(mine), had: !!mine, got: !!theirs };
	});
	h.check(save.had, 'the saved mesh had topology to save');
	h.check(save.got && save.same, 'geometry.userData topology round-trips through toJSON/ObjectLoader (sessions, .tpscene)');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());

	// ---- a peer STORES what arrived, and an old-style message still lands ----
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__net = box;
		return box.uuid;
	});
	const topoOf = (page, uuid) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			if (!object?.geometry) return null;
			const faces = s.meshTopology.readStoredFaces(object.geometry);
			return {
				// index-aware: a freshly created box is still INDEXED (24 verts, 12
				// triangles), and only becomes a soup once an edit swaps it
				tris: s.meshTopology.triangleCountOf(object.geometry),
				faces,
				quads: faces ? faces.filter((f) => f.length === 2).length : 0
			};
		}, uuid);
	await h.eventually(
		() => topoOf(B.page, netUuid),
		(info) => !!info && info.tris === 12,
		'B received the box (premise)',
		20000
	);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
	}, netUuid);
	await h.eventually(
		() => topoOf(B.page, netUuid),
		(info) => !!info && info.tris > 12,
		'B receives the extruded geometry',
		20000
	);
	const mine = await topoOf(A.page, netUuid);
	const theirs = await topoOf(B.page, netUuid);
	h.check(!!theirs.faces, 'B STORED the topology that came off the wire');
	h.check(
		JSON.stringify(theirs.faces) === JSON.stringify(mine.faces),
		`both peers hold the SAME partition (${theirs.quads} quads each)`
	);
	// An older peer sends positions only. The receiver must fall back to derivation
	// rather than keeping a partition that describes a mesh it no longer has.
	const legacy = await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const position = object.geometry.attributes.position;
		const positions = [];
		for (let i = 0; i < position.count; i++)
			positions.push(position.getX(i), position.getY(i), position.getZ(i));
		// drop the last triangle, exactly as a pre-P9 peer's message would arrive
		const shorter = positions.slice(0, positions.length - 9);
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send({ type: 'meshgeo', uuid, positions: new Float32Array(shorter).buffer });
		return shorter.length / 9;
	}, netUuid);
	await h.eventually(
		() => topoOf(B.page, netUuid),
		(info) => !!info && info.tris === legacy,
		'B applied a topology-less (old-peer) meshgeo message',
		20000
	);
	const afterLegacy = await topoOf(B.page, netUuid);
	h.check(afterLegacy.faces === null, '...and DROPPED the stale partition instead of trusting it');

	await h.finish(browser);
});
