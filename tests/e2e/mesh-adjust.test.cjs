// 19-A P2: THE ADJUST ENGINE — apply-on-click + live re-run for the mesh ops.
//
// The contract under test, stated as PROPERTIES (never stack depths):
//   (a) apply -> scrub -> scrub -> settle is ONE undo entry: a single Ctrl+Z
//       returns the exact pre-op geometry, and redo returns the LAST scrubbed
//       state (the settle mutated the entry's `after` in place).
//   (b) ✕ Revert restores the pre-op geometry AND retracts the entry: the next
//       undo restores something EARLIER.
//   (c) a selection pick mid-adjust ends the adjust but keeps the applied op.
//   (d) the identity guard: undo during a live adjust drops it cleanly — a
//       later scrub is refused, nothing throws, the state mirror goes null.
//   (e) preconditions: an unmet bridge shows the hint and applies nothing;
//       a met one AUTO-APPLIES straight from the grid click.
//   (f) two peers: after apply + scrub + settle, B holds A's FINAL geometry
//       (the settle broadcast is unconditional — the live throttle may have
//       eaten the last preview).
const h = require('./helpers.cjs');

const editBox = (page, cmd = '/create Box 1 1 1') =>
	page.evaluate((c) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(c);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.exitFaceEdit?.();
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	}, cmd);

/** highlight the +Y face (granularity 'face') */
const pickTop = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		if (yi < 0) return 0;
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		return faces[yi].triIndices.length;
	});

const triCount = (page) =>
	page.evaluate(() => window.__stores.faceEdit.readTriangles(window.__box.geometry).length);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- (a) apply -> scrub -> scrub -> settle = ONE undo entry --------------
	await editBox(A.page);
	await pickTop(A.page);
	// geometry equality is compared as the CANONICAL soup (index-expanded corner
	// positions) — a fresh primitive is INDEXED while every meshgeo replay is a
	// soup, so raw attribute arrays differ in length for identical shapes
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		window.__soup = () => fe.trisToPositions(fe.readTriangles(window.__box.geometry));
	});
	const applied = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const pos = window.__soup;
		window.__preOp = pos();
		const ok = fe.beginOpAdjust('bevel', { width: 0.1, segments: 1 }, { kind: 'faces' });
		const tris = fe.readTriangles(window.__box.geometry).length;
		let state = null;
		fe.opAdjustState.subscribe((v) => (state = v))();
		fe.reapplyOpAdjust({ width: 0.2 });
		fe.reapplyOpAdjust({ width: 0.3 });
		fe.settleOpAdjust();
		window.__settled = pos();
		return { ok, tris, op: state?.op ?? null };
	});
	h.check(applied.ok, 'the bevel applied through the engine');
	h.check(applied.tris === 20, `one segment stitches the 4-quad ring (${applied.tris} tris)`);
	h.check(applied.op === 'bevel', `the state mirror holds the op (${applied.op})`);
	const undone = await A.page.evaluate(() => {
		window.__stores.history.undo();
		const now = window.__soup();
		const pre = window.__preOp;
		return {
			same: now.length === pre.length && now.every((v, i) => Math.abs(v - pre[i]) < 1e-6),
			len: now.length,
			preLen: pre.length
		};
	});
	h.check(
		undone.same,
		`ONE undo returns the exact pre-op geometry (${undone.len} floats) — apply+scrubs+settle recorded one entry`
	);
	const redone = await A.page.evaluate(() => {
		window.__stores.history.redo();
		const now = window.__soup();
		const settled = window.__settled;
		return {
			same: now.length === settled.length && now.every((v, i) => Math.abs(v - settled[i]) < 1e-6)
		};
	});
	h.check(
		redone.same,
		'redo restores the LAST SCRUBBED state — the settle mutated the entry in place'
	);

	// ---- (b) ✕ revert restores geometry AND removes the entry ---------------
	await editBox(A.page);
	await pickTop(A.page);
	const setupB = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		window.__soup = () => fe.trisToPositions(fe.readTriangles(window.__box.geometry));
		const pos = window.__soup;
		window.__preExtrude = pos();
		// an EARLIER entry for the post-revert undo to land on
		fe.commitFaceOp('extrude', 0.3);
		window.__midState = pos();
		// the extrude leaves its cap selected — adjust-bevel that cap
		const ok = fe.beginOpAdjust('bevel', { width: 0.1, segments: 1 }, { kind: 'faces' });
		fe.reapplyOpAdjust({ width: 0.2 });
		fe.settleOpAdjust();
		return { ok, tris: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(setupB.ok && setupB.tris > 20, `extrude then adjust-bevel applied (${setupB.tris} tris)`);
	const reverted = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.cancelOpAdjust();
		const now = window.__soup();
		const mid = window.__midState;
		const backToMid = now.length === mid.length && now.every((v, i) => Math.abs(v - mid[i]) < 1e-6);
		let state = null;
		fe.opAdjustState.subscribe((v) => (state = v))();
		// the PROPERTY that proves the entry is GONE: undo now restores the
		// EARLIER step (the extrude's before), not the bevel again
		window.__stores.history.undo();
		const afterUndo = window.__soup();
		const pre = window.__preExtrude;
		const backToPre =
			afterUndo.length === pre.length && afterUndo.every((v, i) => Math.abs(v - pre[i]) < 1e-6);
		return { backToMid, backToPre, state };
	});
	h.check(reverted.backToMid, '✕ revert restores the pre-bevel geometry');
	h.check(reverted.state === null, 'and clears the adjust state');
	h.check(
		reverted.backToPre,
		'undo after the revert restores the EARLIER step — the bevel entry was retracted'
	);

	// ---- (c) a pick mid-adjust ends the adjust, keeps the op ----------------
	await editBox(A.page);
	await pickTop(A.page);
	const picked = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const state = () => {
			let v = null;
			fe.opAdjustState.subscribe((x) => (v = x))();
			return v;
		};
		fe.beginOpAdjust('extrude', { distance: 0.3 });
		const live = state();
		const trisDuring = fe.readTriangles(window.__box.geometry).length;
		// pick a DIFFERENT face — the withSelectionHistory choke point
		const faces = fe.currentFaces();
		const other = faces.findIndex((f) => f.normal.x > 0.9);
		fe.pickFaceUnit(faces[other].triIndices[0]);
		return { live: live?.op ?? null, after: state(), trisDuring, trisAfter: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(picked.live === 'extrude', `the extrude adjust was live (${picked.live})`);
	h.check(picked.after === null, 'a selection pick ends the adjust');
	h.check(
		picked.trisAfter === picked.trisDuring && picked.trisDuring === 20,
		`but the applied extrude STAYS (${picked.trisAfter} tris) — its entry was recorded at apply`
	);

	// ---- (d) identity guard: undo during a live adjust ----------------------
	await editBox(A.page);
	await pickTop(A.page);
	const guarded = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const state = () => {
			let v = null;
			fe.opAdjustState.subscribe((x) => (v = x))();
			return v;
		};
		fe.beginOpAdjust('extrude', { distance: 0.3 });
		window.__stores.history.undo(); // replays the adjust's OWN entry -> geometry swap
		let threw = false;
		let result = null;
		try {
			result = fe.reapplyOpAdjust({ distance: 0.6 });
		} catch {
			threw = true;
		}
		return { threw, result, state: state(), tris: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(!guarded.threw && guarded.result === false, 'a scrub after undo is refused cleanly (no throw)');
	h.check(guarded.state === null, 'the identity guard dropped the adjust (state mirror is null)');
	h.check(guarded.tris === 12, `and the undone geometry stays undone (${guarded.tris} tris)`);

	// ---- (e) preconditions: bridge hint vs auto-apply ------------------------
	await editBox(A.page);
	await A.page.waitForTimeout(600); // let the toolbox render
	// 0 pieces selected: the grid click focuses + hints, applies nothing
	await A.page.evaluate(() => document.querySelector('#mesh-op-bridge').click());
	await A.page.waitForTimeout(300);
	const zeroPieces = await A.page.evaluate(() => {
		let st = null;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return {
			tris: window.__stores.faceEdit.readTriangles(window.__box.geometry).length,
			hint: document.querySelector('#mesh-op-hint')?.textContent?.trim() ?? '',
			revert: !!document.querySelector('#mesh-adjust-revert'),
			state: st
		};
	});
	h.check(zeroPieces.tris === 12 && !zeroPieces.state, 'bridge with 0 pieces applies nothing');
	h.check(!!zeroPieces.hint && !zeroPieces.revert, `and shows the hint ("${zeroPieces.hint}")`);
	// 1 piece: still refused, still explained
	await pickTop(A.page);
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		fe.faceEditSelectedTris.set([...faces[yi].triIndices]);
	});
	await A.page.evaluate(() => document.querySelector('#mesh-op-bridge').click());
	await A.page.waitForTimeout(300);
	const onePiece = await A.page.evaluate(() => {
		let st = null;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return {
			tris: window.__stores.faceEdit.readTriangles(window.__box.geometry).length,
			hint: document.querySelector('#mesh-op-hint')?.textContent?.trim() ?? '',
			state: st
		};
	});
	h.check(onePiece.tris === 12 && !onePiece.state, 'bridge with 1 piece applies nothing');
	h.check(!!onePiece.hint, `and still explains itself ("${onePiece.hint}")`);
	// two inset caps (the mesh-bridge-normals recipe): the grid click AUTO-APPLIES
	const capsReady = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const insetCap = (pick) => {
			const face = fe.currentFaces().find(pick);
			if (!face) return null;
			fe.faceEditSelectedTris.set([...face.triIndices]);
			fe.highlightFaceByTriangle(face.triIndices[0]);
			if (!fe.commitFaceOp('inset', 0.45)) return null;
			let cap;
			fe.faceEditSelectedTris.subscribe((v) => (cap = [...v]))();
			return cap;
		};
		const top = insetCap((f) => f.normal.y > 0.9);
		const bottom = insetCap((f) => f.normal.y < -0.9);
		if (!top?.length || !bottom?.length) return null;
		fe.faceEditSelectedTris.set([...top, ...bottom]);
		fe.highlightFaceByTriangle(top[0], false);
		return { before: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(!!capsReady, 'two inset caps selected (premise)');
	await A.page.evaluate(() => document.querySelector('#mesh-op-bridge').click());
	await A.page.waitForTimeout(400);
	const bridged = await A.page.evaluate(() => {
		let st = null;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return {
			tris: window.__stores.faceEdit.readTriangles(window.__box.geometry).length,
			op: st?.op ?? null,
			hint: document.querySelector('#mesh-op-hint')?.textContent?.trim() ?? '',
			revert: !!document.querySelector('#mesh-adjust-revert')
		};
	});
	h.check(
		bridged.tris !== capsReady.before && bridged.op === 'bridge',
		`a met bridge AUTO-APPLIES from the grid click (${capsReady.before} -> ${bridged.tris} tris)`
	);
	h.check(bridged.revert && !bridged.hint, 'and the pane becomes the live adjust');

	// ---- (e2) 19-A P3: SUBDIVIDE through the engine, with LEVELS -------------
	// levels=2 on a 2-tri quad target -> 16 sub-quads = 32 tris (16x the target,
	// 4^levels), the authored pairs survive as stored topology (the wireframe
	// draws no diagonals), and apply+scrub+settle is still ONE undo entry.
	await editBox(A.page);
	await pickTop(A.page);
	const subdiv = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const count = () => fe.readTriangles(window.__box.geometry).length;
		const ok = fe.beginOpAdjust('subdivide', { levels: 1 });
		const atOne = count(); // 10 untouched + 4 sub-quads (8 tris) = 18
		fe.reapplyOpAdjust({ levels: 2 });
		const atTwo = count(); // 10 untouched + 16 sub-quads (32 tris) = 42
		fe.settleOpAdjust();
		let sel = [];
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const stored = s.meshTopology.readStoredFaces(window.__box.geometry);
		const wire = fe.wireframeDebug();
		s.history.undo();
		const undone = count();
		s.history.redo();
		const redone = count();
		return {
			ok,
			atOne,
			atTwo,
			sel: sel.length,
			quads: stored ? stored.filter((f) => f.length === 2).length : -1,
			allPairs: stored ? stored.every((f) => f.length === 2) : false,
			diagonals: wire.diagonals,
			undone,
			redone
		};
	});
	h.check(subdiv.ok, 'subdivide applied through the engine');
	h.check(subdiv.atOne === 18, `levels=1 splits the quad 2x2 (12 -> ${subdiv.atOne} tris)`);
	h.check(subdiv.atTwo === 42, `scrubbing to levels=2 gives 16x the 2-tri target (${subdiv.atTwo} tris)`);
	h.check(subdiv.sel === 32, `the split area stays selected (${subdiv.sel} of 32 new tris)`);
	// 5 untouched box sides + 16 authored sub-quads = 21 faces, all 2-tri pairs
	h.check(
		subdiv.allPairs && subdiv.quads === 21,
		`the stored partition is 21 quad pairs — authored, not re-derived (${subdiv.quads})`
	);
	h.check(subdiv.diagonals === 0, 'the structure wireframe hides every pair diagonal');
	h.check(subdiv.undone === 12, `ONE undo removes both levels (${subdiv.atTwo} -> ${subdiv.undone})`);
	h.check(subdiv.redone === 42, 'redo replays the settled two-level split');

	// ---- (f) two peers: B holds A's FINAL geometry after apply+scrub+settle --
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
	await pickTop(A.page);
	const triCountOn = (page, uuid) =>
		page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', u);
			if (!object?.geometry) return null;
			return window.__stores.faceEdit.readTriangles(object.geometry).length;
		}, uuid);
	const geoSumOn = (page, uuid) =>
		page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const pos = g.getObjectByProperty('uuid', u)?.geometry?.attributes?.position;
			if (!pos) return null;
			let sum = 0;
			for (let i = 0; i < pos.array.length; i++) sum += pos.array[i] * (i + 1);
			return Math.round(sum * 1e3) / 1e3;
		}, uuid);
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n === 12,
		'B received the box (premise)',
		20000
	);
	const finalA = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.beginOpAdjust('bevel', { width: 0.1, segments: 2 }, { kind: 'faces' });
		fe.reapplyOpAdjust({ width: 0.25 });
		fe.settleOpAdjust();
		return fe.readTriangles(window.__box.geometry).length;
	});
	h.check(finalA === 28, `A settled a 2-segment bevel (${finalA} tris)`);
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n === finalA,
		`B's triangle count matches A's final (${finalA})`,
		20000
	);
	const sums = { a: await geoSumOn(A.page, netUuid), b: await geoSumOn(B.page, netUuid) };
	h.check(
		sums.a !== null && sums.a === sums.b,
		`B's geometry IS A's settled geometry (checksum ${sums.a} == ${sums.b})`
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
