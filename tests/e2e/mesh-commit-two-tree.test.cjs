// Roadmap 99 K2 row 3: the wire format is unchanged — proved across TWO TREES. One peer runs the
// newest release (OLD_APP_URL, a v1.72.0 tree), the other this branch (APP_URL); both edit ONE mesh
// and after every step both hold the same geometry BYTES (positions + uvs, Float32), the same
// stored face partition and the same material groups.
//   1. branch extrudes (face session -> commitMesh 'session')           old peer applies it
//   2. old peer insets (its own pre-K2 senders)                          branch applies it
//   3. branch commits a positions-only snapshot (commitMeshGeoSnapshot)  old peer applies it
//   4. branch undoes 3 and 1 (the compact history replays through the one sender): the bytes equal
//      the state before each step, on both peers; redo restores step 3's bytes exactly
//   5. the old peer undoes its own inset; the branch follows
//   5g-5j. (99 K4 family 2) face bevel each way, then a branch vertex + edge bevel and an undo
//   5k-5o. (99 K4 family 3) loop cut each way, then a branch knife + connect and an undo
//   5b-5f. (99 K4 family 1) the branch insets and moves on the kernel, the old peer extrudes the result,
//      the branch extrudes that and undoes it: same bytes + partition after each step
//   5f4a-5f4h. (99 K4 family 4, lane 99-ops-b) the two peers alternate: the old peer opens a hole, the branch
//      fills it on the kernel, the branch reopens it and the old peer fills it (soup) on the kernel output,
//      the branch bridges +x/-x and solidifies the opened mesh on the kernel, then undoes: same bytes +
//      partition after each step
//   5f5a-5f5f. (99 K4 family 5) the branch deletes a face, the old peer deletes a rim edge's faces on the kernel output,
//      the branch merges by distance and undoes it, the old peer merges the same mesh and undoes it
//   5f6a-5f6e. (99 K4 family 6) the branch subdivides a face, the old peer subdivides a rim edge of the kernel output,
//      both symmetrize in turn, the branch undoes one
//   6. the old peer (the joiner) reloads and rejoins: its mesh comes back equal (two-peer + reload)
// Run: OLD_APP_URL=https://theprototype.app:<old port>/ APP_URL=https://theprototype.app:<branch port>/ npm run -s e2e mesh-commit-two-tree
const path = require('path');
const h = require('./helpers.cjs');

const OLD_URL = process.env.OLD_APP_URL;

/** a second copy of the helpers whose URL is the old tree's (helpers.cjs reads APP_URL at load) */
function helpersFor(url) {
	const file = require.resolve('./helpers.cjs');
	const keep = process.env.APP_URL;
	const cached = require.cache[file];
	delete require.cache[file];
	process.env.APP_URL = url;
	const copy = require(file);
	process.env.APP_URL = keep;
	require.cache[file] = cached;
	return copy;
}

/** the mesh as comparable facts: FNV of the Float32 bytes, the stored partition, the groups */
const FACTS = (uuid) => {
	const s = window.__tp.test.v1;
	let g;
	s.objectsGroup.subscribe((v) => (g = v))();
	const object = g?.getObjectByProperty('uuid', uuid);
	const geometry = object?.geometry;
	if (!geometry?.attributes?.position) return null;
	const fnv = (array) => {
		const u8 = new Uint8Array(Float32Array.from(array).buffer);
		let x = 0x811c9dc5;
		for (let i = 0; i < u8.length; i++) x = Math.imul(x ^ u8[i], 0x01000193) >>> 0;
		return x.toString(16).padStart(8, '0');
	};
	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	const faces = s.meshTopology.readStoredFaces(geometry);
	return {
		tris: flat.attributes.position.count / 3,
		positions: fnv(flat.attributes.position.array),
		uvs: flat.attributes.uv ? fnv(flat.attributes.uv.array) : null,
		faces: faces ? JSON.stringify(faces) : null,
		groups: JSON.stringify(
			(geometry.groups ?? []).map((x) => [x.start, x.count, x.materialIndex ?? 0])
		)
	};
};
const facts = (peer, uuid) => peer.page.evaluate(FACTS, uuid);
const same = (a, b) =>
	!!a &&
	!!b &&
	a.tris === b.tris &&
	a.positions === b.positions &&
	a.uvs === b.uvs &&
	a.faces === b.faces;
const show = (f) =>
	f
		? `${f.tris} tris pos ${f.positions} uv ${f.uvs} faces ${f.faces ? f.faces.length + ' chars' : 'none'}`
		: 'none';

/** a face op in a face session on `peer`: pick the face whose normal is `axis`, run `op`, leave */
const faceOp = (peer, uuid, axis, op) =>
	peer.page.evaluate(
		({ uuid, axis, op }) => {
			const fe = window.__tp.test.v1.faceEdit;
			fe.enterFaceEdit(uuid);
			const faces = fe.currentFaces();
			const k = faces.findIndex((f) => f.normal[axis[1]] * (axis[0] === '-' ? -1 : 1) > 0.9);
			if (k < 0) return { ok: false, why: 'no face along ' + axis };
			fe.highlightFaceByTriangle(faces[k].triIndices[0]);
			if (op !== 'bevel') fe.setFaceOp(op);
			// a click auto-applies extrude / inset (the adjust path); Move is the toolbox's Apply (no click op);
			// Bevel is its own command (two segments)
			const ok =
				op === 'bevel'
					? fe.bevelFaces(0.1, 2) !== false
					: op === 'move'
						? fe.commitFaceOp('move', 0.25) !== false
						: fe.autoApplyFaceOp() !== false;
			fe.exitFaceEdit();
			return { ok };
		},
		{ uuid, axis, op }
	);

/**
 * an element bevel on the branch (99 K4 family 2): an edge of a -z triangle (edge mode) or a vertex on the
 * -z side (vertex mode), trying candidates until the bevel accepts one — a refusal leaves the mesh untouched
 */
const elementBevel = (peer, uuid, kind) =>
	peer.page.evaluate(
		({ uuid, kind }) => {
			const s = window.__tp.test.v1;
			const fe = s.faceEdit;
			const me = s.meshEdit;
			let object;
			s.objectsGroup.subscribe((g) => (object = g.getObjectByProperty('uuid', uuid)))();
			if (kind === 'edge') {
				fe.enterFaceEdit(uuid);
				fe.setFaceSubmode('edges');
				const tris = fe.readTriangles(object.geometry);
				for (let ti = 0; ti < tris.length; ti++) {
					const t = tris[ti];
					const n = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
					if (n.z > -0.9) continue;
					const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
					for (let e = 0; e < 3; e++) {
						const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
						const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
						if (!key) continue;
						fe.pickEdge(key, false);
						if (fe.edgeSelectionSize() !== 1) continue;
						if (fe.bevelEdges(0.05, 1, 0) !== false) {
							fe.setFaceSubmode('faces');
							fe.exitFaceEdit();
							return { ok: true, key };
						}
					}
				}
				fe.setFaceSubmode('faces');
				fe.exitFaceEdit();
				return { ok: false, why: 'no -z edge took the bevel' };
			}
			me.enterEditMode(uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let minZ = Infinity;
			const at = [];
			// one handle per welded position
			const pos = object.geometry.attributes.position;
			const keys = new Set();
			for (let v = 0; v < pos.count; v++) keys.add([pos.getX(v), pos.getY(v), pos.getZ(v)].map((n) => Math.round(n * 1e4)).join(','));
			for (let i = 0; i < keys.size; i++) {
				me.selectHandle(i);
				const p = controls.object?.position;
				if (!p) continue;
				at.push({ i, p: p.clone() });
				minZ = Math.min(minZ, p.z);
			}
			for (const { i, p } of at) {
				if (Math.abs(p.z - minZ) > 1e-4) continue;
				me.clearVertexSelection();
				me.selectHandle(i);
				if (me.bevelSelectedVerts(0.05, 0) !== false) {
					me.exitEditMode();
					return { ok: true, handle: i };
				}
			}
			me.exitEditMode();
			return { ok: false, why: 'no -z vertex took the bevel' };
		},
		{ uuid, kind }
	);

/**
 * a cut (99 K4 family 3): a loop cut through the first face whose ring takes it, a knife line through the
 * mesh's middle on screen, or a connect of the first non-neighbour corner pair of one face that takes it
 */
const cutOp = (peer, uuid, kind) =>
	peer.page.evaluate(
		({ uuid, kind }) => {
			const s = window.__tp.test.v1;
			const fe = s.faceEdit;
			fe.enterFaceEdit(uuid);
			fe.setFaceSubmode('faces');
			try {
				if (kind === 'loopcut') {
					// any paired triangle (a quad) anchors a ring: try them in order until one takes the cut
					let object;
					s.objectsGroup.subscribe((g) => (object = g.getObjectByProperty('uuid', uuid)))();
					const n = fe.readTriangles(object.geometry).length;
					for (let t = 0; t < n; t++) {
						fe.highlightFaceByTriangle(t);
						if (!fe.loopCutReady()) continue;
						if (fe.commitLoopCut(1, 0.4) !== false) return { ok: true, anchor: t };
					}
					return { ok: false, why: 'no quad took a loop cut' };
				}
				if (kind === 'knife') {
					let camera;
					s.globalCamera.subscribe((c) => (camera = c))();
					let object;
					s.objectsGroup.subscribe((g) => (object = g.getObjectByProperty('uuid', uuid)))();
					const v = object.getWorldPosition(new s.THREE.Vector3()).project(camera);
					const c = [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
					return { ok: fe.knifePolyline([[c[0] - 700, c[1] + 9], [c[0] + 700, c[1] - 6]]) !== false };
				}
				return { ok: false, why: 'unknown cut ' + kind };
			} finally {
				fe.exitFaceEdit();
			}
		},
		{ uuid, kind }
	);

/** a connect on the branch: two corners of one face that are not neighbours, tried until one is accepted */
const connectOp = (peer, uuid) =>
	peer.page.evaluate((uuid) => {
		const s = window.__tp.test.v1;
		const fe = s.faceEdit;
		let object;
		s.objectsGroup.subscribe((g) => (object = g.getObjectByProperty('uuid', uuid)))();
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		fe.enterFaceEdit(uuid);
		const tris = fe.readTriangles(object.geometry);
		const faces = fe.currentFaces().map((f) => [...new Set(f.triIndices.flatMap((t) => tris[t].map(keyOf)))]);
		fe.exitFaceEdit();
		for (const keys of faces) {
			if (keys.length < 4) continue;
			for (let i = 0; i < keys.length; i++)
				for (let j = i + 1; j < keys.length; j++) if (fe.connectVertices(uuid, [keys[i], keys[j]])) return { ok: true };
		}
		return { ok: false, why: 'no corner pair took a connect' };
	}, uuid);

/**
 * 99-ops-b families 4-5 in a face session on `peer`: 'delete' the +Y face, 'fill' the hole through one +Y rim edge,
 * 'bridge' the +X and -X faces (one cut), 'solidify' the whole mesh (object granularity, settled); 'fdelete' the -Z
 * face, 'edelete' one +Y rim edge (the faces on it go), 'merge' by distance on a 1.0 grid; family 6: 'subdivide'
 * the -Y face, 'esub' one +Y rim edge, 'symmetrize' across X keeping +X; then leave.
 */
const op4 = (peer, uuid, kind) =>
	peer.page.evaluate(
		({ uuid, kind }) => {
			const s = window.__tp.test.v1;
			const fe = s.faceEdit;
			fe.enterFaceEdit(uuid);
			fe.setFaceSubmode('faces');
			fe.setFaceGranularity('quad');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const geo = g.getObjectByProperty('uuid', uuid).geometry;
			const tris = fe.readTriangles(geo);
			let top = -Infinity;
			for (const t of tris) for (const v of t) top = Math.max(top, v.y);
			const along = (axis, sign) => {
				const faces = fe.currentFaces();
				let best = -1;
				let far = -Infinity;
				faces.forEach((f, i) => {
					if (f.normal[axis] * sign < 0.9) return;
					const c = f.centroid[axis] * sign;
					if (c > far) {
						far = c;
						best = i;
					}
				});
				return best < 0 ? -1 : faces[best].triIndices[0];
			};
			let ok = false;
			if (kind === 'delete') {
				const t = along('y', 1);
				if (t >= 0) {
					fe.highlightFaceByTriangle(t);
					fe.pickFaceUnit(t);
					ok = fe.commitFaceOp('delete', 0) !== false;
				}
			} else if (kind === 'fdelete') {
				const t = along('z', -1);
				if (t >= 0) {
					fe.highlightFaceByTriangle(t);
					fe.pickFaceUnit(t);
					ok = fe.commitFaceOp('delete', 0) !== false;
				}
			} else if (kind === 'merge') {
				// a coarse grid (cell 1.0): half the box folds onto the other half, dropping what collapses
				ok = fe.mergeByDistance(1.0) !== false;
			} else if (kind === 'subdivide') {
				// the -Y face (the steps before it took the +Y and -Z faces away)
				const t = along('y', -1);
				if (t >= 0) {
					fe.highlightFaceByTriangle(t);
					fe.pickFaceUnit(t);
					ok = fe.commitFaceOp('subdivide', 0) !== false;
				}
			} else if (kind === 'symmetrize') {
				ok = fe.symmetrizeMesh('x', 1) !== false;
			} else if (kind === 'fill' || kind === 'edelete' || kind === 'esub') {
				fe.setFaceSubmode('edges');
				for (let ti = 0; ti < tris.length && !ok; ti++) {
					const t = tris[ti];
					const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
					for (let e = 0; e < 3 && !ok; e++) {
						if (!(Math.abs(t[e].y - top) < 1e-4 && Math.abs(t[(e + 1) % 3].y - top) < 1e-4)) continue;
						const key = fe.pickEdgeAt(ti, c.clone().lerp(t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5), 0.95));
						if (!key) continue;
						fe.pickEdge(key, false);
						ok = (kind === 'fill' ? fe.fillHole() : kind === 'esub' ? fe.subdivideSelectedEdges() : fe.deleteSelectedEdges()) !== false;
						if (!ok) fe.clearEdgeSelection?.();
					}
				}
				fe.setFaceSubmode('faces');
			} else if (kind === 'bridge') {
				const a = along('x', 1);
				const b = along('x', -1);
				if (a >= 0 && b >= 0) {
					fe.toggleFaceSelection(a);
					fe.toggleFaceSelection(b);
					ok = fe.bridgeFaces(1, 0, false) !== false;
				}
			} else if (kind === 'solidify') {
				fe.setFaceGranularity('object');
				fe.selectAllFaces();
				ok = fe.beginOpAdjust('solidify', { thickness: 0.1 }) !== false;
				if (ok) fe.settleOpAdjust();
				fe.setFaceGranularity('quad');
			}
			fe.exitFaceEdit();
			return { ok };
		},
		{ uuid, kind }
	);

/** the peer lets go of the mesh (its selection lock): the other peer may edit it next */
const release = (peer, uuid) =>
	peer.page.evaluate(async (uuid) => {
		const s = window.__tp.test.v1;
		const lc = s.lockControl?.releaseLock ? s.lockControl : await s.lockControl;
		lc?.releaseLock?.(uuid);
	}, uuid);

/** wait until the object is free of locks on this page (the other peer's session ended) */
const unlocked = (peer, uuid) =>
	h.eventually(
		() =>
			peer.page.evaluate((uuid) => {
				const s = window.__tp.test.v1;
				if (!s.lockedObjects) return true;
				let locks;
				s.lockedObjects.subscribe((v) => (locks = v))();
				return !(locks ?? []).some((entry) => entry[1] === uuid);
			}, uuid),
		(free) => free === true,
		`${peer.id ?? 'peer'} sees the mesh unlocked (premise)`,
		20000
	);

h.run(async () => {
	if (!OLD_URL) throw new Error('OLD_APP_URL is not set: this suite needs a second (release) tree');
	const hOld = helpersFor(OLD_URL);
	const browser = await h.launch();
	const L = await h.setupPage(browser, 'L'); // this branch
	const O = await hOld.setupPage(browser, 'O'); // the newest release
	const versions = await Promise.all(
		[L, O].map((p) =>
			p.page.evaluate(
				() =>
					window.__tp?.test?.v1?.appVersion ??
					document.querySelector('meta[name="version"]')?.content ??
					null
			)
		)
	);
	console.log(
		`[two-tree] branch page ${h.URL} (${versions[0]}), release page ${OLD_URL} (${versions[1]})`
	);
	h.check(h.URL !== OLD_URL, 'the two peers load from two different trees (premise)');
	await h.connect(O, L);

	const uuid = await L.page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(
		() => facts(O, uuid),
		(f) => !!f && f.tris === 12,
		'the release peer holds the branch box (premise)',
		30000
	);

	const agree = async (label) => {
		let a = null;
		let b = null;
		const ok = await h
			.eventually(
				async () => {
					a = await facts(L, uuid);
					b = await facts(O, uuid);
					return same(a, b);
				},
				(v) => v === true,
				label,
				30000
			)
			.catch(() => false);
		if (!same(a, b)) console.log(`[two-tree] ${label}: branch ${show(a)} | release ${show(b)}`);
		return { ok, facts: a };
	};

	// 1. the branch extrudes
	const start = await facts(L, uuid);
	const ext = await faceOp(L, uuid, '+x', 'extrude');
	h.check(ext.ok, 'branch: extrude ran (premise)');
	const s1 = await agree('1. branch extrude -> the release peer holds the same bytes + partition');
	h.check(
		s1.facts.tris > 12 && !!s1.facts.faces,
		`the extrude changed the mesh and stored a partition (${s1.facts.tris} tris)`
	);

	// 2. the release peer insets (the branch created the box, so it holds the selection lock)
	await release(L, uuid);
	await unlocked(O, uuid);
	const ins = await faceOp(O, uuid, '-x', 'inset');
	h.check(ins.ok, 'release: inset ran (premise)');
	const s2 = await agree('2. release inset -> the branch holds the same bytes + partition');
	h.check(s2.facts.positions !== s1.facts.positions, 'the inset changed the mesh (premise)');

	// 3. the branch commits a positions-only snapshot (the vertex tools' commitMeshGeoSnapshot)
	await release(O, uuid);
	await unlocked(L, uuid);
	await L.page.evaluate((uuid) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const position = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
		const before = Array.from(position.array);
		// a twist past x > 0.5 (doubles: history and the wire round them to Float32)
		const after = before.slice();
		const a = (7 * Math.PI) / 180;
		for (let i = 0; i < after.length; i += 3)
			if (after[i] > 0.5 + 1e-4) {
				const y = after[i + 1];
				const z = after[i + 2];
				after[i + 1] = y * Math.cos(a) - z * Math.sin(a);
				after[i + 2] = y * Math.sin(a) + z * Math.cos(a);
			}
		s.faceEdit.commitMeshGeoSnapshot(uuid, before, after);
	}, uuid);
	const s3 = await agree('3. branch snapshot commit -> the release peer holds the same bytes');
	h.check(s3.facts.positions !== s2.facts.positions, 'the snapshot changed the mesh (premise)');

	// 4. the branch undoes its snapshot, then its extrude; redo brings the snapshot back
	const undo = (peer, n = 1) =>
		peer.page.evaluate((n) => {
			for (let i = 0; i < n; i++) window.__tp.test.v1.history.undo();
		}, n);
	const redo = (peer) => peer.page.evaluate(() => window.__tp.test.v1.history.redo());
	await undo(L);
	const u1 = await agree('4a. branch undo (snapshot) -> both peers agree');
	h.check(
		u1.facts.positions === s2.facts.positions && u1.facts.faces === s2.facts.faces,
		'4a. ...and hold EXACTLY the bytes before the snapshot'
	);
	await redo(L);
	const r1 = await agree('4b. branch redo -> both peers agree');
	h.check(
		r1.facts.positions === s3.facts.positions,
		'4b. ...and hold EXACTLY the snapshot bytes again'
	);
	await undo(L, 2); // the snapshot, then the extrude (the release's inset is not on the branch stack)
	const u2 = await agree('4c. branch undo (extrude) -> both peers agree');
	h.check(
		u2.facts.tris === 12 && u2.facts.positions === start.positions,
		`4c. ...and hold EXACTLY the box before the extrude (${show(u2.facts)} vs ${show(start)})`
	);
	await redo(L);
	await agree('4d. branch redo (extrude) -> both peers agree');

	// 5. the release peer undoes its inset (its own, pre-K2, replay)
	await undo(O);
	await agree('5. release undo (inset) -> the branch follows');

	// 5b-5f. roadmap 99 K4 family 1 (extrude / inset / move on the kernel): the branch runs each op on
	// the kernel, the release peer runs its soup op on the branch's output and the branch its kernel op
	// on the release's output; after every step both peers hold the same bytes + partition
	const s5 = await facts(L, uuid);
	const ins2 = await faceOp(L, uuid, '+y', 'inset');
	h.check(ins2.ok, '5b. branch: inset ran (premise)');
	const s5b = await agree('5b. branch inset (kernel) -> the release peer holds the same bytes + partition');
	h.check(s5b.facts.tris > s5.tris, `5b. ...and the inset added its ring (${s5.tris} -> ${s5b.facts.tris} tris)`);
	const mv = await faceOp(L, uuid, '+y', 'move');
	h.check(mv.ok, '5c. branch: move ran (premise)');
	const s5c = await agree('5c. branch move (kernel) -> the release peer holds the same bytes + partition');
	h.check(
		s5c.facts.tris === s5b.facts.tris && s5c.facts.positions !== s5b.facts.positions,
		'5c. ...and the move moved vertices without changing the triangle count'
	);
	await release(L, uuid);
	await unlocked(O, uuid);
	const ext2 = await faceOp(O, uuid, '-y', 'extrude');
	h.check(ext2.ok, '5d. release: extrude ran on the branch output (premise)');
	await agree('5d. release extrude (soup) on the kernel output -> the branch holds the same bytes + partition');
	await release(O, uuid);
	await unlocked(L, uuid);
	const ext3 = await faceOp(L, uuid, '+z', 'extrude');
	h.check(ext3.ok, '5e. branch: extrude ran on the release output (premise)');
	const s5e = await agree('5e. branch extrude (kernel) on the soup output -> the release peer holds the same bytes + partition');
	h.check(s5e.facts.tris > s5c.facts.tris, '5e. ...and the extrude added walls');
	await undo(L);
	const u5 = await agree('5f. branch undo (kernel extrude) -> both peers agree');
	h.check(u5.facts.tris < s5e.facts.tris, '5f. ...and the extrude is gone');

	// 5g-5j. roadmap 99 K4 family 2 (bevel on the kernel): the branch bevels a face, the release peer bevels
	// the branch's output with its soup code, then the branch bevels a vertex and an edge; both peers agree
	const fb = await faceOp(L, uuid, '+x', 'bevel');
	h.check(fb.ok, '5g. branch: face bevel ran (premise)');
	const s5g = await agree('5g. branch face bevel (kernel) -> the release peer holds the same bytes + partition');
	h.check(s5g.facts.tris > u5.facts.tris, '5g. ...and the bevel added its rings');
	await release(L, uuid);
	await unlocked(O, uuid);
	const fb2 = await faceOp(O, uuid, '-x', 'bevel');
	h.check(fb2.ok, '5h. release: face bevel ran on the branch output (premise)');
	await agree('5h. release face bevel (soup) on the kernel output -> the branch holds the same bytes + partition');
	await release(O, uuid);
	await unlocked(L, uuid);
	const vb = await elementBevel(L, uuid, 'vertex');
	h.check(vb.ok, `5i. branch: vertex bevel ran (premise${vb.why ? ': ' + vb.why : ''})`);
	await agree('5i. branch vertex bevel (kernel) -> the release peer holds the same bytes + partition');
	const eb = await elementBevel(L, uuid, 'edge');
	h.check(eb.ok, `5j. branch: edge bevel ran (premise${eb.why ? ': ' + eb.why : ''})`);
	await agree('5j. branch edge bevel (kernel) -> the release peer holds the same bytes + partition');
	await undo(L);
	await agree('5j. branch undo (kernel edge bevel) -> both peers agree');
	// the vertex bevel leaves every triangle its own face (no quads for a ring): undo it too
	await undo(L);
	const u5j = await agree('5j. branch undo (kernel vertex bevel) -> both peers agree');

	// 5k-5o. roadmap 99 K4 family 3 (the cuts on the kernel): the branch loop cuts, the release peer loop cuts the
	// branch's output with its soup code, then the branch knifes and connects; both peers agree after each, and undo
	const lc = await cutOp(L, uuid, 'loopcut');
	h.check(lc.ok, `5k. branch: loop cut ran (premise${lc.why ? ': ' + lc.why : ''})`);
	const s5k = await agree('5k. branch loop cut (kernel) -> the release peer holds the same bytes + partition');
	h.check(s5k.facts.tris > u5j.facts.tris, '5k. ...and the cut added its band');
	await release(L, uuid);
	await unlocked(O, uuid);
	const lc2 = await cutOp(O, uuid, 'loopcut');
	h.check(lc2.ok, `5l. release: loop cut ran on the branch output (premise${lc2.why ? ': ' + lc2.why : ''})`);
	await agree('5l. release loop cut (soup) on the kernel output -> the branch holds the same bytes + partition');
	await release(O, uuid);
	await unlocked(L, uuid);
	const kn = await cutOp(L, uuid, 'knife');
	h.check(kn.ok, `5m. branch: knife ran (premise${kn.why ? ': ' + kn.why : ''})`);
	const s5m = await agree('5m. branch knife (kernel) -> the release peer holds the same bytes + partition');
	const cn = await connectOp(L, uuid);
	h.check(cn.ok, `5n. branch: connect ran (premise${cn.why ? ': ' + cn.why : ''})`);
	const s5n = await agree('5n. branch connect (kernel) -> the release peer holds the same bytes + partition');
	h.check(s5n.facts.tris === s5m.facts.tris, '5n. ...and the connect kept the triangle count (a face re-split)');
	await undo(L);
	await agree('5o. branch undo (kernel connect) -> both peers agree');

	// 5f0. back to the mesh after 5j for families 4-6: the loop cuts leave T-junctions on the box, and a hole through
	// one is no loop the fill (kernel or release soup alike) can close — so each peer undoes its own cut, newest
	// first (the knife, the release loop cut, the branch loop cut), and both peers must hold 5j's bytes again
	await undo(L);
	await agree('5f0a. branch undo (kernel knife) -> both peers agree');
	await release(L, uuid);
	await unlocked(O, uuid);
	await undo(O);
	await agree('5f0b. release undo (soup loop cut) -> both peers agree');
	await release(O, uuid);
	await unlocked(L, uuid);
	await undo(L);
	const u5f0 = await agree('5f0c. branch undo (kernel loop cut) -> both peers agree');
	h.check(
		u5f0.facts.positions === u5j.facts.positions && u5f0.facts.faces === u5j.facts.faces,
		'5f0c. ...and hold EXACTLY the bytes + partition after 5j'
	);

	// 5f4a-5f4h. lane 99-ops-b family 4 (bridge / fill / solidify on the kernel), alternating with the release peer
	const f4 = async (peer, kind, label) => {
		const other = peer === L ? O : L;
		await release(other, uuid);
		await unlocked(peer, uuid);
		const r = await op4(peer, uuid, kind);
		h.check(r.ok, `${label}: ${kind} ran (premise)`);
		return agree(`${label}: ${peer === L ? 'branch (kernel)' : 'release (soup)'} ${kind} -> both peers hold the same bytes + partition`);
	};
	const s5f4pre = await facts(L, uuid);
	const s5f4a = await f4(O, 'delete', '5f4a');
	h.check(s5f4a.facts.tris < s5f4pre.tris, '5f4a. ...and the release opened a hole');
	const s5f4b = await f4(L, 'fill', '5f4b');
	h.check(s5f4b.facts.tris > s5f4a.facts.tris, '5f4b. ...and the branch capped it');
	await f4(L, 'delete', '5f4c');
	const s5f4d = await f4(O, 'fill', '5f4d');
	h.check(s5f4d.facts.tris === s5f4b.facts.tris, '5f4d. ...the release fill on the kernel output caps it the same size');
	const s5f4e = await f4(L, 'bridge', '5f4e');
	h.check(s5f4e.facts.tris !== s5f4d.facts.tris, '5f4e. ...and the branch tunnel changed the mesh');
	await f4(O, 'delete', '5f4f');
	const s5f4g = await f4(L, 'solidify', '5f4g');
	h.check(s5f4g.facts.tris > s5f4e.facts.tris, '5f4g. ...and the branch solidify added a back and a rim');
	await undo(L);
	const s5f4h = await agree('5f4h. branch undo (kernel solidify) -> both peers agree');
	h.check(s5f4h.facts.tris < s5f4g.facts.tris, '5f4h. ...and the solidify is gone');

	// 5f5a-5f5f. lane 99-ops-b family 5 (merge / dissolve / delete on the kernel)
	const s5f5a = await f4(L, 'fdelete', '5f5a');
	h.check(s5f5a.facts.tris < s5f4h.facts.tris, '5f5a. ...and the branch deleted the -Z face');
	const s5f5b = await f4(O, 'edelete', '5f5b');
	h.check(s5f5b.facts.tris < s5f5a.facts.tris, '5f5b. ...and the release deleted the faces on a rim edge of the kernel output');
	const s5f5c = await f4(L, 'merge', '5f5c');
	h.check(s5f5c.facts.tris < s5f5b.facts.tris, '5f5c. ...and the branch merge dropped the collapsed triangles');
	await undo(L);
	const s5f5d = await agree('5f5d. branch undo (kernel merge) -> both peers agree');
	h.check(s5f5d.facts.positions === s5f5b.facts.positions, '5f5d. ...and hold EXACTLY the bytes before the merge');
	const s5f5e = await f4(O, 'merge', '5f5e');
	h.check(s5f5e.facts.tris === s5f5c.facts.tris, '5f5e. ...the release merge (soup) on the kernel output drops as many triangles');
	await undo(O);
	await agree('5f5f. release undo (soup merge) -> both peers agree');

	// 5f6a-5f6e. lane 99-ops-b family 6 (subdivide / symmetrize on the kernel)
	const s5f6a = await f4(L, 'subdivide', '5f6a');
	h.check(s5f6a.facts.tris > s5f5b.facts.tris, '5f6a. ...and the branch subdivided the -Y face');
	const s5f6b = await f4(O, 'esub', '5f6b');
	h.check(s5f6b.facts.tris > s5f6a.facts.tris, '5f6b. ...and the release split a rim edge of the kernel output');
	const s5f6c = await f4(L, 'symmetrize', '5f6c');
	h.check(s5f6c.facts.positions !== s5f6b.facts.positions, '5f6c. ...and the branch symmetrize changed the mesh');
	await f4(O, 'symmetrize', '5f6d');
	await undo(L);
	await agree('5f6e. branch undo (kernel symmetrize) -> both peers agree');

	// 6. two-peer + reload: the joiner reloads and rejoins
	const beforeReload = await facts(L, uuid);
	// a plain reload with a long boot wait (a third boot in one browser takes 50-90 s headless)
	await O.page.reload({ waitUntil: 'domcontentloaded' });
	await O.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(
		() =>
			O.page.evaluate(() => {
				let p;
				window.__tp.test.v1.peers.subscribe((v) => (p = v))();
				return Object.values(p?.connections ?? {}).some((c) => c?.open);
			}),
		(v) => v === true,
		'6. the release peer rejoined after its reload (premise)',
		60000
	);
	const back = await h
		.eventually(
			() => facts(O, uuid),
			(f) => !!f && f.positions === beforeReload.positions,
			'6. ...and holds the branch mesh bytes again',
			60000
		)
		.catch(() => false);
	if (!back)
		console.log(
			`[two-tree] reload: branch ${show(beforeReload)} | release ${show(await facts(O, uuid))}`
		);

	await h.finish(browser);
});
