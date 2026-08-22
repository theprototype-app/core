// CO2 — the calibration UX: the point+aim session machine, the same-spot fallback,
// roomKey minting, the ghost markers, the suppression predicates, and the COLOCATED
// WORLD-GRAB divert (a grab writes the replicated roomAnchor instead of bending the
// local rig, so a colocated partner sees the scene move and alignment survives).
//
// Everything drives the SESSION API with synthetic poses — the machine was built to be
// drivable without XR precisely so this file can exist. The two-peer half reuses CO1's
// ground-truth pattern: each device's private tracking transform T_i is synthesized,
// its view of the agreed point/direction is fed through the REAL session calls, and the
// product claim is one number — a physical probe point reads the same content
// coordinate on both devices, before AND after one of them world-grabs the scene.

const h = require('./helpers.cjs');

/** run a body with `co` = colocation, `cal` = colocationCalibrate, `S` = the hook */
const co = (page, fn, arg) =>
	page.evaluate(
		([body, a]) =>
			new Function('co', 'cal', 'S', 'arg', body)(
				window.__stores.colocation,
				window.__stores.colocationCalibrate,
				window.__stores,
				a
			),
		[fn, arg ?? null]
	);

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);

// CO1's two synthetic devices: different tracking origins AND headings
const TRUTH_A = { yaw: 0.7, p: [1.2, 0.0, -3.4] };
const TRUTH_B = { yaw: -2.1, p: [-5.0, 0.15, 2.25] };

/** calibrate a page through the REAL session machine against a synthetic device truth */
const calibrateAgainst = (page, truth, key) =>
	co(
		page,
		`
		const T = S.THREE;
		const UP = new T.Vector3(0, 1, 0);
		const truth = arg.truth;
		const qm = new T.Quaternion().setFromAxisAngle(UP, truth.yaw);
		const M = new T.Matrix4().compose(
			new T.Vector3().fromArray(truth.p), qm, new T.Vector3(1, 1, 1));
		// this device's view of the agreed physical point and direction
		const point = new T.Vector3(0, 0, 0).applyMatrix4(M);
		const dir = new T.Vector3(0, 0, -1).applyQuaternion(qm);
		cal.startCalibration({ roomKey: arg.key });
		cal.samplePoint(point);
		const record = cal.sampleAim(dir);
		return { record: record ? JSON.parse(JSON.stringify(record)) : null };
		`,
		{ truth, key }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. the debug-hook slot (the positional-destructure guard) ===');
	const hook = await page.evaluate(() => ({
		calibrate: typeof window.__stores.colocationCalibrate?.startCalibration,
		grab: typeof window.__stores.colocationCalibrate?.colocatedWorldGrab,
		// the NEIGHBOUR slots must still be themselves — a positional mis-fold
		// shifts every later binding onto the wrong module silently
		colocation: typeof window.__stores.colocation?.applyRoomAlignment,
		triggerSync: typeof window.__stores.triggerSync?.applyRemoteTriggers
	}));
	h.check(hook.calibrate === 'function', '0.1 colocationCalibrate sits at its hook slot');
	h.check(hook.grab === 'function', '0.2 ...with the world-grab seam exported');
	h.check(
		hook.colocation === 'function' && hook.triggerSync === 'function',
		'0.3 the neighbouring slots are intact (no positional shift)'
	);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the session machine: point -> aim -> aligned, with refusals ===');

	const started = await co(
		page,
		`
		cal.stopColocation();
		co.roomAnchor.set(null);
		const key = cal.startCalibration();
		let own = null;
		S.peers.subscribe((p) => (own = p?.peer?.id))();
		let host = null;
		S.connectionState?.sessionHost?.subscribe?.((v) => (host = v))?.();
		return {
			key,
			state: cal.calibrateDebug().calibrating,
			expected: (host || own) ? 'room-' + String(host || own).slice(0, 6) : 'room-1',
			marker: !!S.globalScene && !!(function(){let s=null;S.globalScene.subscribe(v=>s=v)();return s.getObjectByName('colocate-calibration')})()
		};
		`
	);
	h.check(started.state === 'point', '1.1 startCalibration enters the POINT phase');
	h.check(
		started.key === started.expected,
		'1.2 the default roomKey follows the minting rule (' + started.key + ')'
	);
	h.check(started.marker, '1.3 the ghost-marker group exists at the SCENE ROOT (never objectsGroup)');

	const pointed = await co(
		page,
		`
		const ok = cal.samplePoint({ x: 1, y: 0.8, z: -2 });
		let scene = null;
		S.globalScene.subscribe((v) => (scene = v))();
		const group = scene.getObjectByName('colocate-calibration');
		const point = group?.getObjectByName('colocate-point');
		const arrow = group?.getObjectByName('colocate-aim');
		return {
			ok,
			state: cal.calibrateDebug().calibrating,
			pointAt: point ? point.position.toArray() : null,
			arrowVisible: arrow ? arrow.visible : null
		};
		`
	);
	h.check(pointed.ok === true && pointed.state === 'aim', '1.4 the first sample advances to AIM');
	h.check(
		pointed.pointAt && dist(pointed.pointAt, [1, 0.8, -2]) < 1e-9,
		'1.5 the ghost point sits exactly on the sampled point'
	);
	h.check(pointed.arrowVisible === true, '1.6 ...and the aim arrow appears');

	const degenerate = await co(
		page,
		`
		let toasts = [];
		S.toastStore.subscribe((v) => (toasts = v))();
		const before = toasts.length;
		const refused = cal.sampleAim({ x: 0, y: -1, z: 0 });
		S.toastStore.subscribe((v) => (toasts = v))();
		const texts = toasts.map((t) => (typeof t === 'string' ? t : t.text));
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		return {
			refused,
			state: cal.calibrateDebug().calibrating,
			alignment,
			grew: toasts.length > before,
			named: texts.some((t) => /vertical|level/i.test(String(t)))
		};
		`
	);
	h.check(degenerate.refused === null, '1.7 a vertical aim is REFUSED');
	h.check(degenerate.state === 'aim', '1.8 ...and the session STAYS in aim (re-aim, not restart)');
	h.check(degenerate.alignment === null, '1.9 ...with no alignment installed');
	h.check(degenerate.named, '1.10 ...and a toast NAMES the problem (aim more level)');

	const aligned = await co(
		page,
		`
		const record = cal.sampleAim({ x: 1, y: -0.2, z: 0 });
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		const expected = co.composeRigTransform(record, co.effectiveRoomAnchor());
		let scene = null;
		S.globalScene.subscribe((v) => (scene = v))();
		return {
			record: JSON.parse(JSON.stringify(record)),
			state: cal.calibrateDebug().calibrating,
			rig: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.toArray() },
			expected,
			markerGone: !scene.getObjectByName('colocate-calibration')
		};
		`
	);
	h.check(aligned.record?.source === 'calibration', '1.11 a level aim installs a CALIBRATION alignment');
	h.check(aligned.record?.roomKey === started.key, '1.12 ...stamped with the session roomKey');
	h.check(
		near(wrap(aligned.record.yaw - -Math.PI / 2), 0, 1e-9) &&
			aligned.record.px === 1 &&
			aligned.record.py === 0.8 &&
			aligned.record.pz === -2,
		'1.13 ...built from the sampled point and the aim HORIZONTAL yaw'
	);
	h.check(
		dist(aligned.rig.pos, aligned.expected.pos) < 1e-9 &&
			aligned.rig.scale.every((/** @type {number} */ s) => s === 1),
		'1.14 the rig is SEATED on the alignment, scale forced to 1'
	);
	h.check(aligned.state === null, '1.15 the session ENDS on success');
	h.check(aligned.markerGone, '1.16 ...and the ghost markers are removed by name');

	const cancelled = await co(
		page,
		`
		cal.startCalibration();
		cal.samplePoint({ x: 0, y: 1, z: 0 });
		cal.cancelCalibration();
		let scene = null;
		S.globalScene.subscribe((v) => (scene = v))();
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		return {
			state: cal.calibrateDebug().calibrating,
			markerGone: !scene.getObjectByName('colocate-calibration'),
			alignmentKept: alignment !== null && alignment.source === 'calibration'
		};
		`
	);
	h.check(cancelled.state === null, '1.17 cancel drops the session');
	h.check(cancelled.markerGone, '1.18 ...removes the marker group');
	h.check(cancelled.alignmentKept, '1.19 ...and leaves the WORKING alignment untouched');

	const spot = await co(
		page,
		`
		const q = new S.THREE.Quaternion().setFromAxisAngle(new S.THREE.Vector3(0, 1, 0), 0.6);
		const record = cal.colocateHere({ x: 2, y: 1.62, z: 3 }, q);
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		return {
			record: JSON.parse(JSON.stringify(record)),
			rigScale: rig.scale.toArray()
		};
		`
	);
	h.check(spot.record?.source === 'spot', '1.20 colocateHere installs a SPOT alignment');
	h.check(
		spot.record.px === 2 && spot.record.py === 0 && spot.record.pz === 3,
		'1.21 ...origin = the head FLOOR projection'
	);
	h.check(
		near(wrap(spot.record.yaw - 0.6), 0, 1e-9) && spot.rigScale.every((/** @type {number} */ s) => s === 1),
		'1.22 ...heading = the head yaw, rig applied at scale 1'
	);

	const stopped = await co(
		page,
		`
		cal.stopColocation();
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		let alignment = 'x', key = 'x';
		co.roomAlignment.subscribe((v) => (alignment = v))();
		co.roomKey.subscribe((v) => (key = v))();
		return {
			alignment, key,
			rig: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.toArray() }
		};
		`
	);
	h.check(stopped.alignment === null && stopped.key === null, '1.23 stopColocation drops alignment AND roomKey');
	h.check(
		stopped.rig.pos.every((/** @type {number} */ v) => v === 0) &&
			near(stopped.rig.quat[3], 1, 1e-12) &&
			stopped.rig.scale.every((/** @type {number} */ v) => v === 1),
		'1.24 ...and restores the rig to identity'
	);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the grab maths: scale pinned, the inversion, its counterfactual ===');

	const maths = await co(
		page,
		`
		const T = S.THREE;
		const ONE = new T.Vector3(1, 1, 1);
		// hands translate [0.8, 0, 0.4], yaw a little, AND double their distance
		const start = { a: [0.3, 1, 0.2], b: [-0.3, 1, 0.2] };
		const now = { a: [1.4, 1, 0.6], b: [0.2, 1, 0.6] };
		const rig0 = { pos: [0.5, 0, -1], quat: [0, Math.sin(0.35 / 2), 0, Math.cos(0.35 / 2)], scale: 1 };
		const pinned = cal.colocatedGrabRig(start, now, rig0);
		const scaled = S.vrControls.computeWorldGrabTransform(start, now, rig0);

		// the inversion: K' = R'^-1 . M must recompose to EXACTLY R'
		const alignment = { px: 1.2, py: 0, pz: -3.4, yaw: 0.7 };
		const K = cal.anchorFromRig(pinned, alignment);
		const good = co.composeRigTransform(alignment, co.normalizeRoomAnchor({ pos: K.pos, quat: K.quat }));
		// the COUNTERFACTUAL: the flipped order K'' = M . R'^-1 does NOT recompose
		const qr = new T.Quaternion().fromArray(pinned.quat);
		const qm = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), alignment.yaw);
		const Rmat = new T.Matrix4().compose(new T.Vector3().fromArray(pinned.pos), qr, ONE);
		const Mmat = new T.Matrix4().compose(new T.Vector3(1.2, 0, -3.4), qm, ONE);
		const Kflip = Mmat.clone().multiply(Rmat.clone().invert());
		const flipPos = new T.Vector3(), flipQuat = new T.Quaternion(), flipScale = new T.Vector3();
		Kflip.decompose(flipPos, flipQuat, flipScale);
		const bad = co.composeRigTransform(
			alignment,
			co.normalizeRoomAnchor({ pos: flipPos.toArray(), quat: flipQuat.toArray() })
		);
		return { pinned, scaled, good, bad };
		`
	);
	h.check(
		near(maths.pinned.stretch, 2, 1e-9),
		'2.1 the ATTEMPTED stretch is reported (' + maths.pinned.stretch.toFixed(2) + 'x)...'
	);
	h.check(
		maths.pinned.quat.every((/** @type {number} */ v, /** @type {number} */ i) => near(v, maths.scaled.quat[i], 1e-12)) &&
			dist(maths.pinned.pos, maths.scaled.pos) > 0.1 &&
			maths.scaled.scale > 1.5,
		'2.2 ...but the PINNED transform ignores it — same yaw as the scaled grab, rigid translation (the scaled one really would have zoomed ' +
			maths.scaled.scale.toFixed(2) +
			'x)'
	);
	h.check(
		dist(maths.good.pos, maths.pinned.pos) < 1e-9,
		'2.3 anchorFromRig INVERTS the composition: M . K\'^-1 recomposes to the intended rig'
	);
	h.check(
		dist(maths.bad.pos, maths.pinned.pos) > 0.5,
		'2.4 the FLIPPED inversion disagrees by ' +
			dist(maths.bad.pos, maths.pinned.pos).toFixed(2) +
			'm — the check is adversarial'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. suppression + the real trigger hook, headless ===');

	const clean = await co(page, 'cal.stopColocation(); return S.vrControls.vrNavigationSuppressed()');
	h.check(clean === false, '3.1 (premise) nothing suppresses navigation on a fresh page');
	const duringRitual = await co(
		page,
		'cal.startCalibration();' +
			'return { nav: S.vrControls.vrNavigationSuppressed(), swallow: S.vrControls.vrModuleSelectSwallowed() }'
	);
	h.check(duringRitual.nav === true, '3.2 locomotion/teleport stand DOWN while calibrating');
	h.check(duringRitual.swallow === true, '3.3 ...and the trailing select click is swallowed');

	// the REAL trigger hook, with no XR session: getController(0) is a lazy Group at
	// the origin, so press 1 samples (0,0,0) and the machine advances
	const hookPress = await co(
		page,
		'const consumed = S.vrControls.vrModuleTriggerStart(0);' +
			'return { consumed, state: cal.calibrateDebug().calibrating, point: cal.calibrateDebug().point }'
	);
	h.check(hookPress.consumed === true, '3.4 a trigger press mid-ritual is CONSUMED by the hook');
	h.check(
		hookPress.state === 'aim' && hookPress.point && dist(hookPress.point, [0, 0, 0]) < 1e-9,
		'3.5 ...and sampled the firing controller\'s tip (origin, headless)'
	);
	const afterCancel = await co(
		page,
		'cal.cancelCalibration();' +
			'const nav = S.vrControls.vrNavigationSuppressed();' +
			'const q = new S.THREE.Quaternion();' +
			'cal.colocateHere({ x: 0, y: 1.6, z: 0 }, q);' +
			'const colocated = S.vrControls.vrNavigationSuppressed();' +
			'cal.stopColocation();' +
			'return { nav, colocated, after: S.vrControls.vrNavigationSuppressed() }'
	);
	h.check(afterCancel.nav === false, '3.6 cancel releases the suppression');
	h.check(
		afterCancel.colocated === true,
		'3.7 COLOCATED also suppresses stick locomotion (it offsets the reference space, silently breaking the room mapping)'
	);
	h.check(afterCancel.after === false, '3.8 ...and stop releases it again');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. two peers calibrate through the SESSION machine (CO1 ground truths) ===');

	const B = await h.setupPage(browser, 'B');
	await co(page, 'cal.stopColocation(); co.roomAnchor.set(null)');
	await co(B.page, 'cal.stopColocation(); co.roomAnchor.set(null)');
	await h.connect(A, B);

	// the minting rule's whole point: both peers derive the SAME default key
	const keyA = await co(page, 'return cal.defaultRoomKey()');
	const keyB = await co(B.page, 'return cal.defaultRoomKey()');
	h.check(
		keyA === keyB && /^room-/.test(keyA),
		'4.1 both peers MINT THE SAME default roomKey without typing (' + keyA + ')'
	);

	const calA = await calibrateAgainst(page, TRUTH_A, keyA);
	const calB = await calibrateAgainst(B.page, TRUTH_B, keyB);
	h.check(
		calA.record &&
			near(calA.record.px, TRUTH_A.p[0], 1e-9) &&
			near(wrap(calA.record.yaw - TRUTH_A.yaw), 0, 1e-9),
		'4.2 (premise) A recovers its own tracking transform through the session calls'
	);
	h.check(
		calB.record &&
			near(calB.record.px, TRUTH_B.p[0], 1e-9) &&
			near(wrap(calB.record.yaw - TRUTH_B.yaw), 0, 1e-9),
		'4.3 (premise) B recovers its own'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. the colocated world-grab: anchor written, replicated, re-composed ===');

	const grabbed = await co(
		page,
		`
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		const rig0 = { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x };
		// drag the world 0.8m in x, 0.4m in z, with a slight yaw and a stretch ATTEMPT
		const start = { a: [0.3, 1, 0.2], b: [-0.3, 1, 0.2] };
		const now = { a: [1.35, 1, 0.62], b: [0.25, 1, 0.58] };
		let before = null;
		co.roomAnchor.subscribe((v) => (before = v))();
		const consumed = cal.colocatedWorldGrab({ start, now, rig0 });
		// a second frame of the same gesture — the monotonic stamp must keep advancing
		const consumed2 = cal.colocatedWorldGrab({
			start,
			now: { a: [1.4, 1, 0.65], b: [0.3, 1, 0.6] },
			rig0
		});
		let anchor = null;
		co.roomAnchor.subscribe((v) => (anchor = v))();
		const expected = cal.colocatedGrabRig(start, { a: [1.4, 1, 0.65], b: [0.3, 1, 0.6] }, rig0);
		return {
			consumed, consumed2,
			hadAnchorBefore: before !== null,
			anchor: JSON.parse(JSON.stringify(anchor)),
			rig: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.toArray() },
			expected
		};
		`
	);
	h.check(grabbed.consumed === true && grabbed.consumed2 === true, '5.1 a colocated grab is CONSUMED by the divert');
	h.check(!grabbed.hadAnchorBefore && grabbed.anchor !== null, '5.2 ...and MINTS the roomAnchor');
	h.check(grabbed.anchor.roomKey === keyA, '5.3 ...carrying the room key (' + grabbed.anchor.roomKey + ')');
	// quaternions double-cover: q and -q are ONE rotation, and normalizeRoomAnchor
	// re-mints the anchor quat through atan2, so compare the ROTATION (|dot| ~ 1)
	const qDot = Math.abs(
		grabbed.rig.quat.reduce(
			(/** @type {number} */ s, /** @type {number} */ v, /** @type {number} */ i) =>
				s + v * grabbed.expected.quat[i],
			0
		)
	);
	h.check(
		dist(grabbed.rig.pos, grabbed.expected.pos) < 1e-9 && near(qDot, 1, 1e-9),
		'5.4 A\'s rig follows the grab EXACTLY (through setRoomAnchor -> the re-apply subscription; |q.dot| ' +
			qDot.toFixed(12) +
			')'
	);
	h.check(
		grabbed.rig.scale.every((/** @type {number} */ s) => s === 1),
		'5.5 ...at scale 1 — the stretch attempt was flattened, not applied'
	);

	await h.eventually(
		() => co(B.page, 'let a = null; co.roomAnchor.subscribe((v) => (a = v))(); return a?.at ?? null'),
		(v) => v !== null && v === grabbed.anchor.at,
		'5.6 the anchor REPLICATES to B with the stamp intact'
	);
	const bRecomposed = await co(
		B.page,
		`
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		const expected = co.composeRigTransform(alignment, co.effectiveRoomAnchor());
		return {
			rig: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.toArray() },
			expected
		};
		`
	);
	h.check(
		bRecomposed.expected !== null && dist(bRecomposed.rig.pos, bRecomposed.expected.pos) < 1e-9,
		'5.7 B\'s rig RE-COMPOSES on the arriving anchor (the re-apply subscription, remote side)'
	);
	h.check(
		dist(bRecomposed.rig.pos, [0, 0, 0]) > 0.05,
		'5.8 (premise) ...and it really moved off B\'s pre-grab pose (' +
			dist(bRecomposed.rig.pos, [0, 0, 0]).toFixed(3) +
			'm from identity)'
	);

	// THE PRODUCT CLAIM after a grab: one physical point, one content coordinate
	const probeRoom = [1.1, 1.4, -0.6];
	const reads = [];
	for (const [p, truth] of [
		[page, TRUTH_A],
		[B.page, TRUTH_B]
	]) {
		reads.push(
			await co(
				p,
				`
				const T = S.THREE;
				const ONE = new T.Vector3(1, 1, 1);
				const truth = arg.truth;
				const qm = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), truth.yaw);
				const M = new T.Matrix4().compose(new T.Vector3().fromArray(truth.p), qm, ONE);
				const world = new T.Vector3().fromArray(arg.probeRoom).applyMatrix4(M);
				let rig = null;
				S.worldRig.subscribe((r) => (rig = r))();
				const content = world.clone();
				const q = new T.Quaternion();
				S.vrControls.worldToContentPose(rig, content, q);
				return { world: world.toArray(), content: content.toArray() };
				`,
				{ truth, probeRoom }
			)
		);
	}
	const worldSpread = dist(reads[0].world, reads[1].world);
	const contentSpread = dist(reads[0].content, reads[1].content);
	h.check(
		worldSpread > 1,
		'5.9 (premise) the devices see the probe ' + worldSpread.toFixed(2) + 'm apart in tracking space'
	);
	h.check(
		contentSpread < 1e-6,
		'5.10 ...and agree on its CONTENT coordinate to ' +
			contentSpread.toExponential(2) +
			'm AFTER the grab — colocation survived the world moving'
	);

	// the fall-through: a NON-colocated peer's grab takes the ordinary path
	const fallThrough = await co(
		B.page,
		`
		cal.stopColocation();
		const consumed = cal.colocatedWorldGrab({
			start: { a: [0, 1, 0], b: [1, 1, 0] },
			now: { a: [0.5, 1, 0], b: [1.5, 1, 0] },
			rig0: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 }
		});
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		return { consumed, rigPos: rig.position.toArray() };
		`
	);
	h.check(fallThrough.consumed === false, '5.11 a NON-colocated grab falls through to the ordinary rig path');
	h.check(
		fallThrough.rigPos.every((/** @type {number} */ v) => v === 0),
		'5.12 ...after stop restored B\'s rig to identity'
	);

	await h.finish(browser);
});
