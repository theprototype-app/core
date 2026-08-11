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

	// ---- P10: composition, and the operators that AUTHOR their faces ---------
	const compose = await A.page.evaluate(() => {
		const t = window.__stores.meshTopology;
		// authored faces WIN over the carry-over: subdivide's eight children all
		// descend from one old quad, and calling them one face is the pinwheel bug
		const composed = t.composeFaces(
			[[0, 1], [2, 3]],
			[0, 0, 0, 0, 1, 1, 1, 1, 2, 3],
			[[0, 1], [2, 3], [4, 5], [6, 7]]
		);
		const authoredKept = JSON.stringify(composed.slice(0, 4)) === JSON.stringify([[0, 1], [2, 3], [4, 5], [6, 7]]);
		const carried = JSON.stringify(composed.slice(4)) === JSON.stringify([[8, 9]]);
		const covers = t.facesValidFor(composed, 10);
		// a brand-new triangle nobody claimed becomes its own face
		const orphan = t.composeFaces([[0]], [0, -1], []);
		const orphanOwn = JSON.stringify(orphan) === JSON.stringify([[1], [0]]);
		const pairs = t.appendedQuads(4, 10);
		const odd = t.appendedQuads(4, 9);
		return {
			authoredKept,
			carried,
			covers,
			orphanOwn,
			pairsOk: JSON.stringify(pairs) === JSON.stringify([[4, 5], [6, 7], [8, 9]]),
			oddTail: JSON.stringify(odd) === JSON.stringify([[4, 5], [6, 7], [8]])
		};
	});
	h.check(compose.authoredKept, 'composeFaces takes authored faces verbatim');
	h.check(compose.carried, '...and the unclaimed triangles rejoin their old face');
	h.check(compose.covers, '...producing a partition that still covers the mesh');
	h.check(compose.orphanOwn, 'a triangle with no ancestor becomes its own face');
	h.check(compose.pairsOk, 'appended pushQuad output reads as consecutive quads');
	h.check(compose.oddTail, '...and an odd tail stays a single triangle, not a false pair');

	// The pinwheel: subdividing a quad gives 8 triangles. Derivation can pair the
	// corner-and-centre "kites" instead of the grid, which made "subdivide then Loop"
	// behave randomly. The authored partition says four sub-quads, and then survives a
	// twist that derivation could not have survived either way.
	const subdiv = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__sub = box;
		fe.exitFaceEdit?.(); // a stale session targets the PREVIOUS object
		fe.enterFaceEdit(box.uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		const committed = fe.commitFaceOp('subdivide', 0);
		const stored = t.readStoredFaces(box.geometry);
		if (!stored) return { committed, missing: true };
		const tris = t.triangleCountOf(box.geometry);
		// the +X wall now holds 4 sub-quads: 8 triangles in 4 two-triangle faces
		const wall = [];
		const position = box.geometry.attributes.position;
		for (let ti = 0; ti < tris; ti++) {
			let minX = 1e9;
			for (let c = 0; c < 3; c++) minX = Math.min(minX, position.getX(ti * 3 + c));
			if (minX > 0.49) wall.push(ti);
		}
		const wallSet = new Set(wall);
		const wallFaces = stored.filter((f) => f.every((ti) => wallSet.has(ti)));
		return {
			committed,
			tris,
			wall: wall.length,
			wallFaces: wallFaces.length,
			allPairs: wallFaces.every((f) => f.length === 2),
			valid: t.facesValidFor(stored, tris)
		};
	});
	h.check(subdiv.committed && !subdiv.missing, 'subdivide committed and stored a partition (premise)');
	h.check(subdiv.wall === 8, `subdivide split the +X quad into 8 triangles (${subdiv.wall})`);
	h.check(
		subdiv.wallFaces === 4 && subdiv.allPairs,
		`...stored as FOUR sub-quads, not one 8-triangle face (${subdiv.wallFaces} faces)`
	);
	h.check(subdiv.valid, '...and the whole partition still validates');

	// The case that PROVES authoring rather than describing it: subdivide a quad that
	// is already NON-PLANAR (a twisted extrusion wall). Deriving at commit time cannot
	// pair the four sub-quads — each one is twisted, so pairQuads rejects it and the
	// grid becomes eight loose triangles. Only the operator knows what it built.
	const twistedSub = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(box.uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
		// twist the extruded cap so every wall quad is non-planar
		const read = () => {
			const position = box.geometry.attributes.position;
			const out = [];
			for (let i = 0; i < position.count; i++)
				out.push(position.getX(i), position.getY(i), position.getZ(i));
			return out;
		};
		const before = read();
		const twisted = before.slice();
		const angle = (6 * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		for (let i = 0; i < twisted.length; i += 3)
			if (twisted[i] > 0.5 + 1e-4) {
				const y = twisted[i + 1];
				const z = twisted[i + 2];
				twisted[i + 1] = y * cos - z * sin;
				twisted[i + 2] = y * sin + z * cos;
			}
		fe.commitMeshGeoSnapshot(box.uuid, before, twisted);
		// pick ONE twisted wall quad through the stored pairing and subdivide it
		const stored = t.readStoredFaces(box.geometry);
		const position = box.geometry.attributes.position;
		const spansGap = (ti) => {
			let lo = 1e9;
			let hi = -1e9;
			for (let c = 0; c < 3; c++) {
				lo = Math.min(lo, position.getX(ti * 3 + c));
				hi = Math.max(hi, position.getX(ti * 3 + c));
			}
			return lo < 0.51 && hi > 0.51; // a wall: it bridges base and cap
		};
		const wall = stored.find((f) => f.length === 2 && f.every(spansGap));
		if (!wall) return { missing: true };
		fe.faceEditSelectedTris.set([...wall]);
		fe.highlightFaceByTriangle(wall[0]);
		const committed = fe.commitFaceOp('subdivide', 0);
		const after = t.readStoredFaces(box.geometry);
		const tris = t.triangleCountOf(box.geometry);
		// the 8 children are the last 8 emitted (pushQuad appends), so count the
		// stored faces that live entirely inside that range
		const range = new Set();
		for (let ti = tris - 8; ti < tris; ti++) range.add(ti);
		const children = after.filter((f) => f.every((ti) => range.has(ti)));
		// and the counterfactual: what derivation alone would have made of them
		const live = read();
		t.clearStoredFaces(box.geometry);
		fe.applyMeshGeo(box.uuid, live);
		const derived = [];
		for (let ti = tris - 8; ti < tris; ti++)
			if (fe.quadOfTriangle(ti).length === 2) derived.push(ti);
		return {
			committed,
			childFaces: children.length,
			childPairs: children.filter((f) => f.length === 2).length,
			derivedQuads: derived.length / 2,
			valid: t.facesValidFor(after, tris)
		};
	});
	h.check(twistedSub.committed && !twistedSub.missing, 'subdivided a NON-PLANAR wall quad (premise)');
	h.check(
		twistedSub.childPairs === 4 && twistedSub.childFaces === 4,
		`the twisted quad's grid is stored as 4 sub-quads (${twistedSub.childPairs} pairs)`
	);
	h.check(
		twistedSub.derivedQuads < 4,
		`derivation alone recovers only ${twistedSub.derivedQuads} of the 4 sub-quads — authoring is what saves the rest`
	);
	h.check(twistedSub.valid, 'the authored partition validates against the subdivided mesh');

	// Extrude/inset carry the INPUT partition and author only their new walls. The
	// proof is a non-planar cap: extruding a twisted wall quad moves a face derivation
	// can no longer recognise, so if the op did not carry the partition forward the cap
	// would stop being a quad the moment it was extruded.
	const twistedExtrude = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(box.uuid);
		const read = () => {
			const p = box.geometry.attributes.position;
			const out = [];
			for (let i = 0; i < p.count; i++) out.push(p.getX(i), p.getY(i), p.getZ(i));
			return out;
		};
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.setFaceOp('extrude');
		fe.autoApplyFaceOp();
		const before = read();
		const twisted = before.slice();
		const angle = (6 * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		for (let i = 0; i < twisted.length; i += 3)
			if (twisted[i] > 0.5 + 1e-4) {
				const y = twisted[i + 1];
				const z = twisted[i + 2];
				twisted[i + 1] = y * cos - z * sin;
				twisted[i + 2] = y * sin + z * cos;
			}
		fe.commitMeshGeoSnapshot(box.uuid, before, twisted);
		const position = box.geometry.attributes.position;
		const spansGap = (ti) => {
			let lo = 1e9;
			let hi = -1e9;
			for (let c = 0; c < 3; c++) {
				lo = Math.min(lo, position.getX(ti * 3 + c));
				hi = Math.max(hi, position.getX(ti * 3 + c));
			}
			return lo < 0.51 && hi > 0.51;
		};
		const wall = (t.readStoredFaces(box.geometry) ?? []).find(
			(f) => f.length === 2 && f.every(spansGap)
		);
		if (!wall) return { missing: true };
		const trisBefore = t.triangleCountOf(box.geometry);
		fe.faceEditSelectedTris.set([...wall]);
		fe.highlightFaceByTriangle(wall[0]);
		const committed = fe.commitFaceOp('extrude', 0.3);
		const after = t.readStoredFaces(box.geometry);
		const trisAfter = t.triangleCountOf(box.geometry);
		// the cap keeps the input indices (cloneTris preserves order), so the extruded
		// wall quad must still be ONE two-triangle face
		const capIntact = !!after?.some(
			(f) => f.length === 2 && f[0] === wall[0] && f[1] === wall[1]
		);
		const capPaired = fe.quadOfTriangle(wall[0]).length === 2;
		const newWalls = (after ?? []).filter(
			(f) => f.length === 2 && f.every((ti) => ti >= trisBefore)
		).length;
		return { committed, capIntact, capPaired, newWalls, trisBefore, trisAfter };
	});
	h.check(twistedExtrude.committed && !twistedExtrude.missing, 'extruded a NON-PLANAR wall quad (premise)');
	h.check(twistedExtrude.capIntact, 'the extruded cap keeps its face through the op (the input partition is carried, not re-guessed)');
	h.check(twistedExtrude.capPaired, '...so the live session still treats it as a quad');
	h.check(
		twistedExtrude.newWalls === 4,
		`...and the four new side walls are authored as quads (${twistedExtrude.newWalls})`
	);

	// loop cut authors its band the same way, and the band keeps its quads after a
	// twist — the operation users reach for immediately after cutting
	const loop = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__loop = box;
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(box.uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.faceEditSelectedTris.set([...faces[xi].triIndices]);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		const cut = fe.commitLoopCut(1);
		const stored = t.readStoredFaces(box.geometry);
		const tris = t.triangleCountOf(box.geometry);
		const quads = stored ? stored.filter((f) => f.length === 2).length : 0;
		// twist the whole band's far side and commit positions-only
		const position = box.geometry.attributes.position;
		const before = [];
		for (let i = 0; i < position.count; i++)
			before.push(position.getX(i), position.getY(i), position.getZ(i));
		const twisted = before.slice();
		const angle = (4 * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		for (let i = 0; i < twisted.length; i += 3)
			if (twisted[i] > 0) {
				const y = twisted[i + 1];
				const z = twisted[i + 2];
				twisted[i + 1] = y * cos - z * sin;
				twisted[i + 2] = y * sin + z * cos;
			}
		fe.commitMeshGeoSnapshot(box.uuid, before, twisted);
		const after = t.readStoredFaces(box.geometry);
		return {
			cut,
			tris,
			quads,
			valid: t.facesValidFor(stored, tris),
			keptQuads: after ? after.filter((f) => f.length === 2).length : 0
		};
	});
	h.check(loop.cut, 'loop cut committed (premise)');
	h.check(loop.valid, 'the loop cut authored a partition valid for its output');
	h.check(loop.quads >= 8, `the cut band is stored as quads (${loop.quads})`);
	h.check(loop.keptQuads === loop.quads, `a 4-degree twist of the cut mesh keeps all ${loop.quads} quads`);

	// ---- P11: wave-2 operators, and the n-gon the soup could never hold ------
	// Dissolving an edge between two coplanar quads makes a SIX-sided polygon. The
	// triangle soup has to fan it, and derivation can only ever see loose triangles
	// there; the stored partition holds it as one face, and the structure wireframe
	// hides its internal spokes for the same reason it hides a quad's diagonal.
	const ngon = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(box.uuid);
		fe.setFaceSubmode?.('faces');
		// loop cut the box so the top has two quads sharing a real (non-diagonal) edge
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		fe.faceEditSelectedTris.set([...faces[yi].triIndices]);
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		fe.commitLoopCut(1);
		const wireBefore = fe.wireframeDebug();
		// find the shared edge between the two coplanar top quads and dissolve it
		fe.setFaceSubmode?.('edges');
		const tris0 = fe.readTriangles(box.geometry);
		const candidates = new Set();
		tris0.forEach((t, ti) => {
			if (!t.every((v) => v.y > 0.49)) return; // top surface only
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			for (let e = 0; e < 3; e++) {
				const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
				const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
				if (key) candidates.add(key);
			}
		});
		let dissolved = false;
		for (const key of candidates) {
			fe.pickEdge(key, false);
			if (fe.dissolveEdges()) {
				dissolved = true;
				break;
			}
		}
		if (!dissolved) return { skipped: true };
		const stored = t.readStoredFaces(box.geometry);
		const tris = t.triangleCountOf(box.geometry);
		// the dissolved region is the appended fan: the LAST face, and it has 3+ tris
		const big = (stored ?? []).filter((f) => f.length >= 3);
		fe.setFaceSubmode?.('faces');
		const wireAfter = fe.wireframeDebug();
		return {
			dissolved,
			tris,
			valid: t.facesValidFor(stored, tris),
			ngons: big.length,
			biggest: Math.max(0, ...(stored ?? []).map((f) => f.length)),
			wireBeforeDiagonals: wireBefore.diagonals,
			wireAfterDiagonals: wireAfter.diagonals
		};
	});
	if (ngon.skipped) {
		h.check(false, 'dissolve had a coplanar edge to work with (premise)');
	} else {
		h.check(ngon.valid, 'dissolve left a partition valid for its output');
		h.check(
			ngon.ngons >= 1 && ngon.biggest >= 3,
			`the dissolved region is stored as ONE n-gon of ${ngon.biggest} triangles, not loose tris`
		);
		h.check(
			ngon.wireAfterDiagonals === 0,
			`the structure wireframe draws no face-internal edges (${ngon.wireAfterDiagonals}) — the n-gon's fan spokes are hidden like a quad diagonal`
		);
	}

	// delete / bridge / weld all REINDEX their survivors, so their partitions must be
	// re-keyed rather than carried. The check that matters is that nothing is lost or
	// duplicated: an invalid partition would be dropped and silently fall back.
	const rekey = await A.page.evaluate(() => {
		const s = window.__stores;
		const t = s.meshTopology;
		const fe = s.faceEdit;
		const out = {};
		const freshBox = (cmd = '/create Box 1 1 1') => {
			s.commandsHandler.sceneCommand(cmd);
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const box = g.children[g.children.length - 1];
			fe.exitFaceEdit?.();
			fe.enterFaceEdit(box.uuid);
			return box;
		};
		// delete: the face goes, the rest keeps its grouping
		let box = freshBox();
		let faces = fe.currentFaces();
		let yi = faces.findIndex((f) => f.normal.y > 0.9);
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		const trisBefore = t.triangleCountOf(box.geometry);
		out.deleted = fe.commitFaceOp('delete', 0);
		out.deleteTris = t.triangleCountOf(box.geometry);
		out.deleteValid = t.facesValidFor(t.readStoredFaces(box.geometry), out.deleteTris);
		out.deleteShrank = out.deleteTris < trisBefore;
		// weld: a barely-extruded face gives real near-duplicates to merge, and the
		// collapse drops the wall triangles — the reindexing case
		box = freshBox();
		faces = fe.currentFaces();
		yi = faces.findIndex((f) => f.normal.y > 0.9);
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		fe.commitFaceOp('extrude', 0.002);
		const beforeWeld = t.triangleCountOf(box.geometry);
		out.welded = fe.mergeByDistance(0.01);
		out.weldTris = t.triangleCountOf(box.geometry);
		out.weldDropped = out.weldTris < beforeWeld;
		out.weldValid = t.facesValidFor(
			t.readStoredFaces(box.geometry),
			t.triangleCountOf(box.geometry)
		);
		return out;
	});
	h.check(rekey.deleted && rekey.deleteShrank, 'delete committed and removed triangles (premise)');
	h.check(rekey.deleteValid, 'delete re-keyed its partition across the survivor reindexing');
	h.check(rekey.welded && rekey.weldDropped, 'merge-by-distance collapsed a thin extrusion (premise)');
	h.check(rekey.weldValid, 'weld re-keyed its partition after dropping degenerate triangles');

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
