// The geometry size ceilings (meshBudget.js).
//
// The old single 45000-float cap refused to edit, sculpt or UV-drag exactly the
// dense models the tools exist for. A two-peer measurement showed the WIRE was
// never the limit (12 MB of raw bytes arrives in ~5s), so the cap became three
// separate numbers: a high COMMIT ceiling, a low LIVE-PREVIEW ceiling, and a byte
// budget on the undo stack.
//
// What is asserted here, in the order it matters:
//  1. a mesh between the old cap and the new one is genuinely editable end to end
//     (the point of the change) — and the counterfactual, that it would have been
//     refused under the old number;
//  2. a gesture above the PREVIEW ceiling streams nothing but still commits — the
//     trade that keeps a big edit from flooding the session;
//  3. the undo stack drops its OLDEST entries rather than growing without bound,
//     and never the newest one.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the ceilings themselves ---------------------------------------
	const budget = await A.page.evaluate(() => window.__stores.meshBudget);
	h.check(!!budget, 'meshBudget is on the debug hook (premise)');
	h.check(budget.MAX_SNAPSHOT === 1500000, `commit ceiling is 1.5M floats (${budget.MAX_SNAPSHOT})`);
	h.check(
		budget.MAX_LIVE_PREVIEW === 45000,
		`preview ceiling stays at the old cap (${budget.MAX_LIVE_PREVIEW})`
	);
	h.check(
		budget.MAX_SNAPSHOT > budget.MAX_LIVE_PREVIEW * 30,
		'the commit ceiling is far above the preview one — that is the whole change'
	);

	// ---- 1b. the face-edit ENTRY cap, measured (R3) ------------------------
	// A separate ceiling from the sync ones: it bounds INTERACTION cost, and it is
	// what actually decides whether an imported model can be face-edited. R3
	// measured the per-frame grab (5.4 us/triangle) and set the default from it.
	const faceCap = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		let live;
		fe.vrFaceCap.subscribe((v) => (live = v))();
		return { def: fe.VR_FACE_CAP, live };
	});
	h.check(faceCap.def === 2500, `the face-edit cap default is the measured 2500 (${faceCap.def})`);
	h.check(
		faceCap.live >= faceCap.def,
		`and the live setting starts at least there (${faceCap.live})`
	);

	// ---- 2. a mesh in the newly-allowed band edits for real ----------------
	// A sphere dense enough to be over the OLD cap and under the new one.
	const built = await A.page.evaluate(async () => {
		const { THREE, commandsHandler, objectsGroup } = window.__stores;
		commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		let object = null;
		objectsGroup.subscribe((g) => (object = g?.children?.[g.children.length - 1]))();
		if (!object) return { ok: false };
		// ~120k floats: 3.5x the old cap, well under the new one
		const geometry = new THREE.SphereGeometry(1, 100, 100).toNonIndexed();
		object.geometry.dispose();
		object.geometry = geometry;
		objectsGroup.update((v) => v);
		const floats = geometry.attributes.position.count * 3;
		return { ok: true, uuid: object.uuid, floats };
	});
	h.check(built.ok, 'a dense sphere exists (premise)');
	h.check(
		built.floats > 45000 && built.floats < 1500000,
		`and it sits in the newly-allowed band (${built.floats} floats, old cap 45000)`
	);

	// commitMeshGeoSnapshot is the shared commit path every op ends in
	const commit = await A.page.evaluate((uuid) => {
		const { faceEdit, objectsGroup, history } = window.__stores;
		let object = null;
		objectsGroup.subscribe((g) => (object = g?.children?.find((c) => c.uuid === uuid)))();
		const before = Array.from(object.geometry.attributes.position.array);
		const after = before.slice();
		for (let i = 1; i < after.length; i += 3) after[i] += 0.25; // lift every vertex in y
		let undoDepth = 0;
		history.undoStack.subscribe((s) => (undoDepth = s.length))();
		const ok = faceEdit.commitMeshGeoSnapshot(uuid, before, after);
		let after2 = 0;
		history.undoStack.subscribe((s) => (after2 = s.length))();
		let moved = 0;
		objectsGroup.subscribe((g) => {
			const o = g?.children?.find((c) => c.uuid === uuid);
			moved = o?.geometry?.attributes?.position?.array?.[1] ?? 0;
		})();
		return { ok, undoBefore: undoDepth, undoAfter: after2, y: moved, first: before[1] };
	}, built.uuid);

	h.check(commit.ok === true, 'a 120k-float commit is ACCEPTED (it was refused before)');
	h.check(
		Math.abs(commit.y - (commit.first + 0.25)) < 1e-4,
		`and the geometry really changed (y ${commit.first.toFixed(3)} -> ${commit.y.toFixed(3)})`
	);
	h.check(commit.undoAfter === commit.undoBefore + 1, 'it recorded exactly one undo entry');

	// THE COUNTERFACTUAL: the same payload under the OLD number would have been
	// refused, so the check above cannot pass vacuously.
	const counterfactual = await A.page.evaluate(
		({ floats }) => {
			const { meshBudget } = window.__stores;
			return {
				underOld: floats <= 45000,
				underNew: !meshBudget.overSnapshotBudget(floats),
				refusedByOld: floats > 45000
			};
		},
		{ floats: built.floats }
	);
	h.check(
		counterfactual.refusedByOld && counterfactual.underNew,
		'counterfactual: the same edit fails the old 45000 test and passes the new one'
	);

	// ---- 3. the preview trade ---------------------------------------------
	const preview = await A.page.evaluate(() => {
		const { meshBudget } = window.__stores;
		return {
			small: meshBudget.previewReplicable(30000),
			atCap: meshBudget.previewReplicable(45000),
			big: meshBudget.previewReplicable(120000),
			huge: meshBudget.previewReplicable(1400000)
		};
	});
	h.check(preview.small && preview.atCap, 'previews still stream at and below the old cap');
	h.check(
		!preview.big && !preview.huge,
		'and stop streaming above it — big gestures are local until they commit'
	);

	// the refusal message names the real numbers instead of "too large"
	const message = await A.page.evaluate(() =>
		window.__stores.meshBudget.tooLargeMessage(1800000, 'bevel')
	);
	h.check(/bevel/.test(message), 'the refusal keeps the noun of the operation');
	h.check(
		/600,000/.test(message) && /500,000/.test(message),
		`and states both the size and the limit ("${message}")`
	);

	// ---- 3b. the preview trade, at the CALL SITE --------------------------
	// The checks above read the predicate, which would stay green with the guard
	// deleted from liveGeometryUpdate. This one watches the WIRE: a live gesture on
	// a mesh over the preview ceiling must send nothing, and the commit that ends it
	// must send exactly one meshgeo. (A capture stub, not a second peer — the
	// question is "did it broadcast", which needs no receiver.)
	const streamed = await A.page.evaluate(async (uuid) => {
		const { peers, faceEdit, objectsGroup } = window.__stores;
		let original = null;
		peers.subscribe((p) => (original = p))();
		const sent = [];
		peers.set({ ...original, send: (m) => sent.push(m?.type) });
		try {
			// The face-edit ENTRY cap is a third, unrelated ceiling: it bounds how many
			// triangles the overlays and pick handles stay interactive over, and the
			// user raises it in Settings ▸ VR. Raise it here — this section is about
			// what the SYNC budget does, not about that setting.
			faceEdit.vrFaceCap.set(200000);
			faceEdit.enterFaceEdit(uuid);
			await new Promise((r) => setTimeout(r, 300));
			// a SYNTHESIZED target, the shape the gizmo passes (mesh-proportional's
			// recipe) — a bare face index depends on how derivation grouped the
			// sphere, which is not what this section is about
			const THREE = window.__stores.THREE;
			const tris = faceEdit.readTriangles(
				(() => {
					let o = null;
					objectsGroup.subscribe((g) => (o = g?.children?.find((c) => c.uuid === uuid)))();
					return o.geometry;
				})()
			);
			const triIndices = tris.map((_, i) => i).slice(0, 12);
			const centroid = new THREE.Vector3();
			for (const ti of triIndices) for (const v of tris[ti]) centroid.add(v);
			centroid.multiplyScalar(1 / (triIndices.length * 3));
			const grabbed = faceEdit.beginFaceGrab({
				triIndices,
				centroid,
				normal: new THREE.Vector3(0, 1, 0)
			});
			// six moves over ~1.4s: far more than the 200ms preview throttle allows,
			// so a missing guard would show up as several meshgeo messages
			for (let i = 0; i < 6; i++) {
				faceEdit.applyFaceGrab({ x: 0, y: 0.02 * (i + 1), z: 0 });
				await new Promise((r) => setTimeout(r, 240));
			}
			const duringGesture = sent.filter((t) => t === 'meshgeo').length;
			faceEdit.commitFaceGrab();
			await new Promise((r) => setTimeout(r, 200));
			const afterCommit = sent.filter((t) => t === 'meshgeo').length;
			faceEdit.exitFaceEdit?.();
			let floats = 0;
			objectsGroup.subscribe((g) => {
				const o = g?.children?.find((c) => c.uuid === uuid);
				floats = o?.geometry?.attributes?.position?.array?.length ?? 0;
			})();
			return { grabbed: !!grabbed, duringGesture, afterCommit, floats };
		} finally {
			peers.set(original);
		}
	}, built.uuid);

	h.check(streamed.grabbed, 'a live face grab started on the dense mesh (premise)');
	h.check(
		streamed.floats > 45000,
		`premise: the mesh is over the preview ceiling (${streamed.floats} floats)`
	);
	h.check(
		streamed.duringGesture === 0,
		`no preview left the machine during a ${'6-move'} gesture (${streamed.duringGesture} sent)`
	);
	h.check(
		streamed.afterCommit > streamed.duringGesture,
		`...but the commit DID replicate (${streamed.afterCommit} meshgeo total)`
	);

	// ---- 4. the history byte budget ---------------------------------------
	const budgeted = await A.page.evaluate(() => {
		const { meshBudget } = window.__stores;
		// entryBytes counts both sides of a geometry entry, and nothing for a
		// transform — that is what makes the eviction target the expensive ones
		const geo = { kind: 'meshgeo', before: new Array(1000).fill(0), after: new Array(1000).fill(0) };
		const triple = {
			kind: 'meshgeo',
			before: { positions: new Array(500).fill(0), uvs: new Array(200).fill(0) },
			after: { positions: new Array(500).fill(0), uvs: new Array(200).fill(0) }
		};
		const move = { kind: 'transform', before: { pos: [0, 0, 0] }, after: { pos: [1, 0, 0] } };
		return {
			geo: meshBudget.entryBytes(geo),
			triple: meshBudget.entryBytes(triple),
			move: meshBudget.entryBytes(move),
			budget: meshBudget.HISTORY_BYTES
		};
	});
	h.check(budgeted.geo === 8000, `a bare positions entry counts both sides (${budgeted.geo} bytes)`);
	h.check(
		budgeted.triple === 5600,
		`a {positions, uvs} triple counts every array (${budgeted.triple} bytes)`
	);
	h.check(budgeted.move === 0, 'a transform entry costs nothing — eviction targets geometry');
	h.check(budgeted.budget === 256 * 1024 * 1024, 'the budget is 256 MB');

	// and the eviction really runs: push entries past the budget and watch the
	// OLDEST go while the newest survives
	const evicted = await A.page.evaluate(() => {
		const { history } = window.__stores;
		const bytesPerEntry = 8 * 1024 * 1024; // 2M floats over both sides
		const big = () => ({
			kind: 'meshgeo',
			uuid: 'budget-probe',
			tag: Math.random(),
			before: new Array(1_000_000).fill(0),
			after: new Array(1_000_000).fill(0)
		});
		const first = big();
		first.tag = 'OLDEST';
		history.recordEntry(first);
		for (let i = 0; i < 34; i++) history.recordEntry(big()); // ~280 MB total
		const last = big();
		last.tag = 'NEWEST';
		history.recordEntry(last);
		let stack = [];
		history.undoStack.subscribe((s) => (stack = s))();
		return {
			hasOldest: stack.some((e) => e.tag === 'OLDEST'),
			hasNewest: stack.some((e) => e.tag === 'NEWEST'),
			depth: stack.length,
			bytesPerEntry
		};
	});
	h.check(!evicted.hasOldest, 'the OLDEST geometry entry is evicted once the budget is exceeded');
	h.check(evicted.hasNewest, '...and the newest one is always kept');
	h.check(
		evicted.depth > 1 && evicted.depth < 50,
		`the stack settles below the count limit on size alone (${evicted.depth} entries)`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
