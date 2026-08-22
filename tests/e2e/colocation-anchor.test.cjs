// CO3 — persistent anchors + drift, against the INJECTED fake (setXrAnchorApi): no
// desktop browser exposes the WebXR persistence trio, so the shim gets faked and the
// POLICY gets tested — persist-after-calibrate, session-start restore (exact re-derive,
// the which-room fallback, silent misses), the ~1 Hz drift correction (exact-landing
// ease, mid-ease retarget, the 0.5 m snap, suspension) and forget-vs-stop.
//
// "Presenting" is the same injected seam: the policy reads sessions/frames ONLY through
// xrAnchors.sessionContext(), so flipping the fake's flag drives the production
// rising-edge path bit for bit. GPU_ARGS because drift is TIME-based (a 1 Hz throttle +
// a 1 s ease): a 2.5 fps software page cannot exercise either.

const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

/** run an async body with ca = colocationAnchors, xa = xrAnchors, cal =
 * colocationCalibrate, co = colocation, F = the fake's state, S = the whole hook */
const co = (page, fn, arg) =>
	page.evaluate(
		([body, a]) =>
			new Function(
				'ca',
				'xa',
				'cal',
				'co',
				'F',
				'S',
				'arg',
				'return (async () => {' + body + '})()'
			)(
				window.__stores.colocationAnchors,
				window.__stores.xrAnchors,
				window.__stores.colocationCalibrate,
				window.__stores.colocation,
				/** @type {any} */ (window).__fakeXr,
				window.__stores,
				a
			),
		[fn, arg ?? null]
	);

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);

/** toasts matching one SPECIFIC text — never the whole stack (this box emits unrelated
 * peer-server toasts throughout a run) and never a broad theme filter (the ritual's own
 * "Colocate…"/"Colocated…" toasts would count too) */
const toastsMatching = (page, pattern) =>
	co(
		page,
		`let toasts = [];
		S.toastStore.subscribe((v) => (toasts = v))();
		return toasts
			.map((t) => (typeof t === 'string' ? t : t.text))
			.filter((t) => new RegExp(arg).test(String(t))).length;`,
		pattern
	);
const MINT_FAIL = 'Could not save a room anchor';
const RESTORE_FAIL = 'Room anchor restore failed';

/** drive the REAL ritual (point + aim) against a synthetic device truth */
const calibrate = (page, key, truth) =>
	co(
		page,
		`
		const T = S.THREE;
		const qm = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), arg.truth.yaw);
		const M = new T.Matrix4().compose(
			new T.Vector3().fromArray(arg.truth.p), qm, new T.Vector3(1, 1, 1));
		cal.startCalibration({ roomKey: arg.key });
		cal.samplePoint(new T.Vector3(0, 0, 0).applyMatrix4(M));
		const record = cal.sampleAim(new T.Vector3(0, 0, -1).applyQuaternion(qm));
		return record ? JSON.parse(JSON.stringify(record)) : null;
		`,
		{ key, truth }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. hook slots + the three-tail count (the positional trap) ===');
	const hook = await page.evaluate(() => ({
		shim: typeof window.__stores.xrAnchors?.setXrAnchorApi,
		policy: typeof window.__stores.colocationAnchors?.startColocationAnchors,
		forget: typeof window.__stores.colocationAnchors?.forgetRoom,
		// neighbours must still be themselves — a positional mis-fold shifts silently
		presence: typeof window.__stores.colocationPresence?.publishColocation,
		calibrate: typeof window.__stores.colocationCalibrate?.startCalibration,
		registered: window.__stores.colocationAnchors?.colocationAnchorsDebug?.().registered
	}));
	h.check(hook.shim === 'function', '0.1 xrAnchors sits at its hook slot (setXrAnchorApi)');
	h.check(hook.policy === 'function' && hook.forget === 'function', '0.2 colocationAnchors at its slot');
	h.check(
		hook.presence === 'function' && hook.calibrate === 'function',
		'0.3 the neighbouring slots are intact (no positional shift)'
	);
	h.check(hook.registered === true, '0.4 startColocationAnchors ran at boot (App.svelte onMount)');

	// the three tails of App.svelte's debug hook must have the same length — read the
	// SOURCE, because a shifted destructure is exactly the failure the page cannot see
	const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'App.svelte'), 'utf8');
	const block = appSrc.slice(appSrc.indexOf('Promise.all(['), appSrc.indexOf('window.__stores'));
	const imports = (block.match(/import\(/g) || []).length;
	const destructured = block
		.slice(block.indexOf('.then(([') + 8, block.indexOf(']) => {'))
		.split(',').length;
	const objLine = appSrc.slice(
		appSrc.indexOf('window.__stores = {'),
		appSrc.indexOf('\n', appSrc.indexOf('window.__stores = {'))
	);
	const storeKeys = objLine.slice(objLine.indexOf('{') + 1, objLine.lastIndexOf('}')).split(',').length;
	h.check(
		imports === destructured && storeKeys === imports,
		'0.5 the three tails agree (' + imports + '/' + destructured + '/' + storeKeys + ')'
	);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. install the fake + persist-after-calibrate ===');
	const truthA = { yaw: 0.7, p: [1.2, 0.0, -3.4] };
	const installed = await co(
		page,
		`
		cal.stopColocation();
		co.roomAnchor.set(null);
		localStorage.removeItem('colocation-anchors-v1');
		ca.reloadAnchorRecords();
		ca.resetColocationAnchors();
		window.__fakeXr = {
			presenting: false,
			session: { id: 'fake-session' },
			frame: { id: 'fake-frame' },
			refSpace: { id: 'fake-ref' },
			nextHandle: 1,
			anchors: {},      // handle -> stored pose (what persist recorded)
			livePose: {},     // handle -> the RUNTIME's live pose (drift moves this)
			restoreMode: {},  // handle -> 'ok' | 'notfound' | 'security'
			createBehavior: 'ok',
			log: { creates: [], persists: 0, restores: [], deletes: [] }
		};
		const F2 = window.__fakeXr;
		xa.setXrAnchorApi({
			sessionContext: () =>
				F2.presenting
					? { session: F2.session, frame: F2.frame, refSpace: F2.refSpace, presenting: true }
					: { session: null, frame: null, refSpace: null, presenting: false },
			createAnchorAt: (frame, ref, pose) => {
				if (F2.createBehavior === 'reject') return Promise.reject(new Error('create refused'));
				F2.log.creates.push(JSON.parse(JSON.stringify(pose)));
				return Promise.resolve({ fake: true, pose: JSON.parse(JSON.stringify(pose)) });
			},
			persistHandle: (anchor) => {
				const handle = 'fh-' + F2.nextHandle++;
				F2.anchors[handle] = JSON.parse(JSON.stringify(anchor.pose));
				anchor.handle = handle;
				F2.log.persists += 1;
				return Promise.resolve(handle);
			},
			restoreHandle: (session, handle) => {
				F2.log.restores.push(handle);
				const mode = F2.restoreMode[handle] ?? 'notfound';
				if (mode === 'ok')
					return Promise.resolve({
						fake: true,
						handle,
						pose: F2.anchors[handle] ?? { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
					});
				const err = new Error(mode);
				err.name = mode === 'notfound' ? 'NotFoundError' : 'SecurityError';
				return Promise.reject(err);
			},
			readAnchorPose: (frame, anchor, ref) => {
				const live = (anchor.handle && F2.livePose[anchor.handle]) || anchor.pose;
				return Promise.resolve(JSON.parse(JSON.stringify(live)));
			},
			deleteHandle: (session, handle) => {
				F2.log.deletes.push(handle);
				delete F2.anchors[handle];
				return Promise.resolve(true);
			}
		});
		return { kind: xa.xrAnchorApiKind(), records: ca.colocationAnchorsDebug().records };
		`
	);
	h.check(installed.kind === 'fake', '1.1 (premise) the injected fake is live');
	h.check(Object.keys(installed.records).length === 0, '1.2 (premise) no records stored');

	// a ritual with NO session presenting: silent skip — persistence is an upgrade
	const desktop = await calibrate(page, 'room-alpha', truthA);
	await page.waitForTimeout(400);
	const desktopAfter = await co(
		page,
		`return { records: ca.colocationAnchorsDebug().records, creates: F.log.creates.length }`
	);
	h.check(desktop?.source === 'calibration', '1.3 (premise) a desktop ritual still aligns');
	h.check(
		Object.keys(desktopAfter.records).length === 0 && desktopAfter.creates === 0,
		'1.4 ...but with NO session presenting nothing is minted (silent skip)'
	);
	h.check(
		(await toastsMatching(page, MINT_FAIL)) === 0,
		'1.5 ...and the skip added no failure toast (persistence is an upgrade, not a gate)'
	);

	// now "enter XR" and calibrate: the anchor is minted AT THE ROOM ORIGIN
	await co(page, `cal.stopColocation(); F.presenting = true;`);
	await page.waitForTimeout(200);
	const record1 = await calibrate(page, 'room-alpha', truthA);
	await h.eventually(
		() => co(page, `return ca.colocationAnchorsDebug().records['room-alpha']?.handle ?? null`),
		(v) => v === 'fh-1',
		'1.6 the calibration MINTS + PERSISTS an anchor and stores the record'
	);
	const persisted = await co(
		page,
		`return {
			record: ca.colocationAnchorsDebug().records['room-alpha'],
			create: F.log.creates[0],
			stored: JSON.parse(localStorage.getItem('colocation-anchors-v1') || '{}'),
			liveKey: ca.colocationAnchorsDebug().liveKey,
			createYaw: ca.yawOfQuat(F.log.creates[0].quat)
		}`
	);
	h.check(
		near(persisted.create.pos[0], record1.px, 1e-9) &&
			near(persisted.create.pos[1], record1.py, 1e-9) &&
			near(persisted.create.pos[2], record1.pz, 1e-9),
		'1.7 the anchor position IS the room origin (the alignment translation)'
	);
	h.check(
		near(wrap(persisted.createYaw - record1.yaw), 0, 1e-9),
		'1.8 ...and its orientation is the room frame yaw'
	);
	h.check(
		persisted.record &&
			near(persisted.record.alignment.px, record1.px, 1e-9) &&
			near(persisted.record.alignment.yaw, record1.yaw, 1e-9) &&
			typeof persisted.record.at === 'number',
		'1.9 the record carries the alignment snapshot + a stamp'
	);
	h.check(
		persisted.stored['room-alpha']?.handle === 'fh-1',
		'1.10 ...and it is IN localStorage (colocation-anchors-v1), not only in memory'
	);
	h.check(persisted.liveKey === 'room-alpha', '1.11 the minted anchor stays live for drift');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. recalibrating a room OVERWRITES its record + deletes the old handle ===');
	const truthA2 = { yaw: 1.1, p: [0.4, 0.0, -2.0] };
	await calibrate(page, 'room-alpha', truthA2);
	await h.eventually(
		() => co(page, `return ca.colocationAnchorsDebug().records['room-alpha']?.handle ?? null`),
		(v) => v === 'fh-2',
		'2.1 a second ritual in the SAME room replaces the record (fh-1 -> fh-2)'
	);
	const overwrote = await co(
		page,
		`return { deletes: [...F.log.deletes], count: Object.keys(ca.colocationAnchorsDebug().records).length }`
	);
	h.check(overwrote.deletes.includes('fh-1'), '2.2 ...and best-effort DELETES the superseded handle');
	h.check(overwrote.count === 1, '2.3 one room, one record — overwrite, never accumulate');

	// a second room, so restore has a which-room decision to make later
	const truthB = { yaw: -2.1, p: [-5.0, 0.15, 2.25] };
	await co(page, `cal.stopColocation()`);
	await calibrate(page, 'room-beta', truthB);
	await h.eventually(
		() => co(page, `return ca.colocationAnchorsDebug().records['room-beta']?.handle ?? null`),
		(v) => v === 'fh-3',
		'2.4 a DIFFERENT room mints its own record beside the first'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a session that cannot mint: ONE toast, calibration keeps working ===');
	const failed = await co(
		page,
		`
		cal.stopColocation();
		F.createBehavior = 'reject';
		const T = S.THREE;
		cal.startCalibration({ roomKey: 'room-broken' });
		cal.samplePoint(new T.Vector3(1, 0.8, -2));
		const rec = cal.sampleAim(new T.Vector3(1, -0.1, 0));
		return rec ? JSON.parse(JSON.stringify(rec)) : null;
		`
	);
	await page.waitForTimeout(500);
	await co(
		page,
		`
		// a SECOND failing ritual in the same session must not toast again
		cal.stopColocation();
		const T = S.THREE;
		cal.startCalibration({ roomKey: 'room-broken' });
		cal.samplePoint(new T.Vector3(0, 1, 0));
		cal.sampleAim(new T.Vector3(0, 0, -1));
		`
	);
	await page.waitForTimeout(500);
	const failState = await co(
		page,
		`
		F.createBehavior = 'ok';
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		const expected = co.composeRigTransform(alignment, co.effectiveRoomAnchor());
		return {
			rigPos: rig.position.toArray(),
			expected,
			records: Object.keys(ca.colocationAnchorsDebug().records)
		};
		`
	);
	h.check(failed?.source === 'calibration', '3.1 (premise) the failing ritual still ALIGNED');
	h.check(
		failState.expected !== null && dist(failState.rigPos, failState.expected.pos) < 1e-9,
		'3.2 ...and the rig is seated — persistence failing gated NOTHING'
	);
	h.check(!failState.records.includes('room-broken'), '3.3 no record was written for the failed mint');
	h.check(
		(await toastsMatching(page, MINT_FAIL)) === 1,
		'3.4 the failure toasted exactly ONCE across two failing rituals'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. session-start restore: zero ritual, EXACT re-derive, presence published ===');
	// leave "XR", drop the alignment, and give room-beta's anchor a restorable pose that
	// has MOVED (a new session's tracking origin never matches the old one)
	const restorePose = await co(
		page,
		`
		F.presenting = false;
		cal.stopColocation();
		co.roomAnchor.set(null);
		await new Promise((r) => setTimeout(r, 150)); // let the falling edge tick
		const T = S.THREE;
		const yaw = 0.35;
		const pose = {
			pos: [2.5, 0.01, -1.75],
			quat: new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw).toArray()
		};
		F.anchors['fh-3'] = JSON.parse(JSON.stringify(pose)); // room-beta, the NEWEST record
		F.restoreMode['fh-3'] = 'ok';
		F.restoreMode['fh-2'] = 'notfound';
		F.log.restores = [];
		F.presenting = true; // the rising edge IS the session-start signal
		return { pose, yaw };
		`
	);
	await h.eventually(
		() =>
			co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a ? JSON.parse(JSON.stringify(a)) : null`),
		(v) => v && v.source === 'anchor',
		'4.1 a stored room restores on session start with NO ritual'
	);
	const restored = await co(
		page,
		`
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		let rig = null;
		S.worldRig.subscribe((r) => (rig = r))();
		const expected = co.composeRigTransform(alignment, co.effectiveRoomAnchor());
		return {
			alignment: JSON.parse(JSON.stringify(alignment)),
			rig: { pos: rig.position.toArray(), scale: rig.scale.toArray() },
			expected,
			presence: S.colocationPresence.colocationPresenceDebug(),
			liveKey: ca.colocationAnchorsDebug().liveKey,
			restores: [...F.log.restores]
		};
		`
	);
	h.check(restored.alignment.roomKey === 'room-beta', '4.2 ...into the room the anchor NAMES');
	h.check(
		near(restored.alignment.px, restorePose.pose.pos[0], 1e-9) &&
			near(restored.alignment.py, restorePose.pose.pos[1], 1e-9) &&
			near(restored.alignment.pz, restorePose.pose.pos[2], 1e-9),
		'4.3 alignment position == the anchor pose EXACTLY (1e-9)'
	);
	h.check(
		near(wrap(restored.alignment.yaw - restorePose.yaw), 0, 1e-9),
		'4.4 alignment yaw == yawOf(anchorQuat) EXACTLY'
	);
	h.check(
		restored.expected !== null &&
			dist(restored.rig.pos, restored.expected.pos) < 1e-9 &&
			restored.rig.scale.every((/** @type {number} */ s) => s === 1),
		'4.5 the rig is POSED through the one compose path, scale 1'
	);
	h.check(
		restored.presence.mine === 'room-beta' && restored.presence.sentKey === 'room-beta',
		"4.6 CO5's presence published for source 'anchor' (re-verified, not trusted)"
	);
	h.check(restored.liveKey === 'room-beta', '4.7 the restored anchor is live for drift');
	h.check(restored.restores[0] === 'fh-3', '4.8 (premise) the NEWEST record was tried first');
	h.check(
		(await toastsMatching(page, 'room-beta \\(restored\\)')) >= 1,
		'4.9 ...and the toast says so: "Colocated — room room-beta (restored)"'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. which-room: the newer handle rejects, the OLDER room restores ===');
	const whichRoom = await co(
		page,
		`
		F.presenting = false;
		cal.stopColocation();
		await new Promise((r) => setTimeout(r, 150));
		// make room-beta (newest) REJECT — we are standing in room-alpha now — and give
		// room-alpha's anchor a pose of its own
		const T = S.THREE;
		const pose = {
			pos: [-0.8, 0.0, 0.6],
			quat: new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), -1.2).toArray()
		};
		F.anchors['fh-2'] = JSON.parse(JSON.stringify(pose));
		F.restoreMode['fh-3'] = 'notfound';
		F.restoreMode['fh-2'] = 'ok';
		F.log.restores = [];
		F.presenting = true;
		return pose;
		`
	);
	await h.eventually(
		() =>
			co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a?.roomKey ?? null`),
		(v) => v === 'room-alpha',
		'5.1 the SECOND room lands when the first (newer) handle rejects'
	);
	const which = await co(
		page,
		`
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		return { alignment: JSON.parse(JSON.stringify(alignment)), restores: [...F.log.restores] }
		`
	);
	h.check(
		which.restores.length === 2 && which.restores[0] === 'fh-3' && which.restores[1] === 'fh-2',
		'5.2 restore tried newest -> older (restore success IS the which-room test)'
	);
	h.check(
		near(which.alignment.px, whichRoom.pos[0], 1e-9) && which.alignment.source === 'anchor',
		"5.3 ...and room-alpha's own pose re-derived the alignment"
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. restore-none: every handle rejects — silence, and the ritual remains ===');
	await co(
		page,
		`
		F.presenting = false;
		cal.stopColocation();
		await new Promise((r) => setTimeout(r, 150));
		F.restoreMode['fh-2'] = 'notfound';
		F.restoreMode['fh-3'] = 'notfound';
		F.log.restores = [];
		`
	);
	const noneBefore = await co(
		page,
		`let toasts = []; S.toastStore.subscribe((v) => (toasts = v))(); return toasts.length`
	);
	await co(page, `F.presenting = true`);
	await h.eventually(
		() => co(page, `return F.log.restores.length`),
		(v) => v === 2,
		'6.1 (premise) BOTH records were tried'
	);
	await page.waitForTimeout(600);
	const none = await co(
		page,
		`
		let alignment = null;
		co.roomAlignment.subscribe((v) => (alignment = v))();
		let toasts = [];
		S.toastStore.subscribe((v) => (toasts = v))();
		return {
			alignment,
			toasts: toasts.length,
			records: Object.keys(ca.colocationAnchorsDebug().records).length
		}
		`
	);
	h.check(none.alignment === null, '6.2 no alignment was installed — an unknown room is the NORMAL case');
	h.check(none.toasts === noneBefore, '6.3 ...and not one toast (NotFoundError is silent)');
	h.check(none.records === 2, '6.4 the records survive the miss (they belong to OTHER rooms)');

	// an UNEXPECTED error is the one thing that speaks
	await co(
		page,
		`
		F.presenting = false;
		await new Promise((r) => setTimeout(r, 150));
		F.restoreMode['fh-3'] = 'security';
		F.restoreMode['fh-2'] = 'notfound';
		F.presenting = true;
		`
	);
	await h.eventually(
		() => toastsMatching(page, RESTORE_FAIL),
		(v) => v === 1,
		'6.5 an UNEXPECTED restore error toasts once (SecurityError, not NotFound)'
	);

	// while already ALIGNED, a session start attempts NO restore
	await co(
		page,
		`
		F.presenting = false;
		F.restoreMode['fh-3'] = 'notfound';
		await new Promise((r) => setTimeout(r, 150));
		cal.colocateHere({ x: 0, y: 1.6, z: 0 }, new S.THREE.Quaternion(), { roomKey: 'room-manual' });
		ca.resetColocationAnchors(); // zero the counters; the fake still answers
		F.log.restores = [];
		F.presenting = true;
		`
	);
	await page.waitForTimeout(600);
	const aligned = await co(
		page,
		`return { tries: ca.colocationAnchorsDebug().stats.restoreTries, restores: F.log.restores.length }`
	);
	h.check(
		aligned.tries === 0 && aligned.restores === 0,
		'6.6 a session starting ALREADY ALIGNED restores nothing (the ritual won)'
	);

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. drift: 5 cm eases to the EXACT target; a mid-ease move re-targets ===');
	// re-arm a clean restored state in room-alpha
	await co(
		page,
		`
		F.presenting = false;
		cal.stopColocation();
		ca.resetColocationAnchors();
		await new Promise((r) => setTimeout(r, 150));
		F.restoreMode['fh-2'] = 'ok';
		F.restoreMode['fh-3'] = 'notfound';
		delete F.livePose['fh-2'];
		F.presenting = true;
		`
	);
	await h.eventually(
		() =>
			co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a?.roomKey ?? null`),
		(v) => v === 'room-alpha',
		'7.1 (premise) restored into room-alpha for the drift run'
	);
	const constants = await co(
		page,
		`return {
			pos: ca.DRIFT_POS_M, yaw: ca.DRIFT_YAW_RAD, snap: ca.SNAP_POS_M,
			ease: ca.EASE_MS, check: ca.DRIFT_CHECK_MS
		}`
	);
	h.check(
		constants.pos === 0.02 &&
			near(constants.yaw, Math.PI / 180, 1e-12) &&
			constants.snap === 0.5 &&
			constants.ease === 1000 &&
			constants.check === 1000,
		'7.2 the drift constants ship as planned (2 cm / 1 deg / 0.5 m / 1 s / ~1 Hz)'
	);
	// the runtime refines the anchor 5 cm away
	const target1 = await co(
		page,
		`
		const base = F.anchors['fh-2'];
		const moved = { pos: [base.pos[0] + 0.05, base.pos[1], base.pos[2]], quat: [...base.quat] };
		F.livePose['fh-2'] = moved;
		return moved;
		`
	);
	await h.eventually(
		() => co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a?.px ?? null`),
		(v) => v !== null && near(v, target1.pos[0], 1e-9),
		'7.3 the alignment CONVERGES to the exact target within the ease window',
		8000
	);
	const eased = await co(
		page,
		`
		let a = null; co.roomAlignment.subscribe((v) => (a = v))();
		let rig = null; S.worldRig.subscribe((r) => (rig = r))();
		const expected = co.composeRigTransform(a, co.effectiveRoomAnchor());
		const d = ca.colocationAnchorsDebug();
		return {
			a: JSON.parse(JSON.stringify(a)),
			rigPos: rig.position.toArray(), expected,
			stats: d.stats
		};
		`
	);
	h.check(
		near(eased.a.px, target1.pos[0], 1e-12) &&
			near(eased.a.pz, target1.pos[2], 1e-12) &&
			eased.a.source === 'anchor',
		'7.4 ...EXACTLY — the ease lands the target, never a near-miss (1e-12)'
	);
	h.check(
		eased.stats.eases >= 1 && eased.stats.snaps === 0,
		'7.5 ...and it was an EASE, not a snap (' + eased.stats.eases + ' ease, 0 snaps)'
	);
	h.check(dist(eased.rigPos, eased.expected.pos) < 1e-9, '7.6 the rig FOLLOWED through the one compose path');

	// mid-ease retarget: start a second correction, move the anchor AGAIN while easing
	await co(
		page,
		`
		const base = F.anchors['fh-2'];
		F.livePose['fh-2'] = { pos: [base.pos[0] + 0.05, base.pos[1], base.pos[2] + 0.08], quat: [...base.quat] };
		`
	);
	await h.eventually(
		() => co(page, `return ca.colocationAnchorsDebug().easing`),
		(v) => v === true,
		'7.7 (premise) a second ease is underway'
	);
	const target3 = await co(
		page,
		`
		const base = F.anchors['fh-2'];
		F.livePose['fh-2'] = { pos: [base.pos[0] + 0.02, base.pos[1], base.pos[2] + 0.15], quat: [...base.quat] };
		return F.livePose['fh-2'];
		`
	);
	await h.eventually(
		() =>
			co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a ? [a.px, a.py, a.pz] : null`),
		(v) => v && near(v[0], target3.pos[0], 1e-9) && near(v[2], target3.pos[2], 1e-9),
		'7.8 a mid-ease anchor move RE-TARGETS cleanly and lands the NEW target exactly',
		8000
	);

	// ---------------------------------------------------------------- section 8
	console.log('\n=== 8. drift: a 0.6 m jump SNAPS (tracking was lost — a smear is worse) ===');
	const snapTarget = await co(
		page,
		`
		const base = F.anchors['fh-2'];
		F.livePose['fh-2'] = { pos: [base.pos[0] + 0.6, base.pos[1], base.pos[2] + 0.15], quat: [...base.quat] };
		return F.livePose['fh-2'];
		`
	);
	await h.eventually(
		() =>
			co(page, `
			let a = null; co.roomAlignment.subscribe((v) => (a = v))();
			return { px: a?.px ?? null, snaps: ca.colocationAnchorsDebug().stats.snaps };
			`),
		(v) => v.snaps >= 1 && v.px !== null && near(v.px, snapTarget.pos[0], 1e-12),
		'8.1 past 0.5 m the alignment SNAPS to the exact pose (snaps counter proves the path)',
		6000
	);

	// ---------------------------------------------------------------- section 9
	console.log('\n=== 9. drift SUSPENDED: the ritual and a colocated grab hold the correction ===');
	const suspendedRun = await co(
		page,
		`
		cal.startCalibration({ roomKey: 'room-alpha' }); // a ritual is OPEN
		const statsBefore = ca.colocationAnchorsDebug().stats;
		const base = F.anchors['fh-2'];
		F.livePose['fh-2'] = { pos: [base.pos[0] + 0.1, base.pos[1], base.pos[2]], quat: [...base.quat] };
		let a = null; co.roomAlignment.subscribe((v) => (a = v))();
		return {
			suspended: ca.colocationAnchorsDebug().suspended,
			easesBefore: statsBefore.eases, snapsBefore: statsBefore.snaps,
			px: a?.px ?? null
		};
		`
	);
	h.check(suspendedRun.suspended === true, '9.1 an open ritual reads as SUSPENDED');
	await page.waitForTimeout(2500);
	const held = await co(
		page,
		`
		let a = null; co.roomAlignment.subscribe((v) => (a = v))();
		const d = ca.colocationAnchorsDebug();
		return { px: a?.px ?? null, eases: d.stats.eases, snaps: d.stats.snaps, easing: d.easing };
		`
	);
	h.check(
		near(held.px, suspendedRun.px, 1e-12) &&
			held.eases === suspendedRun.easesBefore &&
			held.snaps === suspendedRun.snapsBefore &&
			!held.easing,
		'9.2 2.5 s of 10 cm drift moved NOTHING while the ritual was open'
	);
	const resumeTarget = await co(page, `cal.cancelCalibration(); return F.livePose['fh-2'].pos`);
	await h.eventually(
		() =>
			co(page, `let a = null; co.roomAlignment.subscribe((v) => (a = v))(); return a ? [a.px, a.py, a.pz] : null`),
		(v) => v && near(v[0], resumeTarget[0], 1e-9) && near(v[2], resumeTarget[2], 1e-9),
		'9.3 ...and the correction resumes the moment the ritual closes',
		8000
	);
	// the grab half: the divert stamps worldGrabActive, and the policy reads it
	const grab = await co(
		page,
		`
		let rig = null; S.worldRig.subscribe((r) => (rig = r))();
		const rig0 = { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x };
		const hands = { a: [0.3, 1, 0.2], b: [-0.3, 1, 0.2] };
		const consumed = cal.colocatedWorldGrab({ start: hands, now: hands, rig0 });
		return {
			consumed,
			active: cal.worldGrabActive(),
			suspended: ca.colocationAnchorsDebug().suspended
		};
		`
	);
	h.check(
		grab.consumed === true && grab.active === true && grab.suspended === true,
		'9.4 a colocated grab frame stamps worldGrabActive and SUSPENDS drift'
	);
	await page.waitForTimeout(700);
	const released = await co(
		page,
		`return { active: cal.worldGrabActive(), suspended: ca.colocationAnchorsDebug().suspended }`
	);
	h.check(
		released.active === false && released.suspended === false,
		'9.5 ...and the stamp expires when the hands let go (~400 ms)'
	);

	// ---------------------------------------------------------------- section 10
	console.log('\n=== 10. forgetRoom forgets; stopColocation does NOT ===');
	const forgot = await co(
		page,
		`
		const before = Object.keys(ca.colocationAnchorsDebug().records);
		const handle = ca.colocationAnchorsDebug().records['room-beta']?.handle;
		const ok = ca.forgetRoom('room-beta');
		const d = ca.colocationAnchorsDebug();
		return {
			before, ok,
			after: Object.keys(d.records),
			stored: Object.keys(JSON.parse(localStorage.getItem('colocation-anchors-v1') || '{}')),
			deleted: F.log.deletes.includes(handle),
			missing: ca.forgetRoom('room-never')
		};
		`
	);
	h.check(
		forgot.ok === true && forgot.before.includes('room-beta') && !forgot.after.includes('room-beta'),
		'10.1 forgetRoom drops the record'
	);
	h.check(!forgot.stored.includes('room-beta'), '10.2 ...from localStorage too');
	h.check(forgot.deleted === true, '10.3 ...and best-effort deletes the persisted handle');
	h.check(forgot.missing === false, '10.4 forgetting a room with no record answers false');
	// the candidate rule the Settings row derives from
	const candidate = await co(
		page,
		`
		let a = null; co.roomAlignment.subscribe((v) => (a = v))();
		const records = ca.colocationAnchorsDebug().records;
		return {
			aligned: ca.forgetCandidate(records, a),
			unaligned: ca.forgetCandidate(records, null),
			noRecord: ca.forgetCandidate(records, { roomKey: 'room-nowhere' })
		};
		`
	);
	h.check(
		candidate.aligned === 'room-alpha' && candidate.unaligned === 'room-alpha' && candidate.noRecord === null,
		'10.5 forgetCandidate: current room when recorded, newest when idle, null when unsaved'
	);
	const stopKeeps = await co(
		page,
		`
		cal.stopColocation();
		return {
			records: Object.keys(ca.colocationAnchorsDebug().records),
			stored: Object.keys(JSON.parse(localStorage.getItem('colocation-anchors-v1') || '{}'))
		};
		`
	);
	h.check(
		stopKeeps.records.includes('room-alpha') && stopKeeps.stored.includes('room-alpha'),
		'10.6 stopColocation KEEPS the record — stopping is not forgetting'
	);

	// restore the real shim so nothing leaks past this suite
	await co(page, `xa.setXrAnchorApi(null); return xa.xrAnchorApiKind()`);

	await h.finish(browser);
});
