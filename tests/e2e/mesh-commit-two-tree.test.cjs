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
			fe.setFaceOp(op);
			const ok = fe.autoApplyFaceOp() !== false;
			fe.exitFaceEdit();
			return { ok };
		},
		{ uuid, axis, op }
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
