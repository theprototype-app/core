// CO1 — the colocation alignment core: the maths, the rig seam, the replicated anchor.
//
// THE ONE CHECK THAT MATTERS is section 2. Two synthetic devices with different
// tracking origins and different headings calibrate on the SAME physical point and
// direction; if the composition is right they read a third physical point at the same
// CONTENT coordinate, and if `M` and `K⁻¹` are swapped they do not. That is asserted
// with its own COUNTERFACTUAL computed in the page (the stored-topology rule): the
// flipped composition is built from the same numbers in the same evaluate and shown to
// DISAGREE, so the check carries its own proof that the scenario is adversarial rather
// than relying on a reader trusting the sign.
//
// Everything here is device state, so nothing needs a headset: an alignment is four
// numbers and the rig is a THREE.Group that exists on the desktop too.

const h = require('./helpers.cjs');

/** run a body with `co` = the colocation module, `S` = the whole debug hook */
const co = (page, fn, arg) =>
	page.evaluate(
		([body, a]) =>
			new Function('co', 'S', 'arg', body)(
				window.__stores.colocation,
				window.__stores,
				a
			),
		[fn, arg ?? null]
	);

/** wrap an angle into (-PI, PI] so 2*PI and 0 compare equal */
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const near = (a, b, eps) => Math.abs(a - b) <= eps;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the pure maths: the yaw convention and its refusals ===');

	// room -Z is the facing convention, so aiming along -Z must be yaw 0 and aiming
	// along +X must be -90 degrees. Pinning both ends is what stops a sign error that
	// only shows up as "we are mirrored" in a real room.
	const yaws = await co(
		page,
		'return {' +
			' back: co.yawFromDirection({x: 0, y: 0, z: -1}),' +
			' fwd: co.yawFromDirection({x: 0, y: 0, z: 1}),' +
			' right: co.yawFromDirection({x: 1, y: 0, z: 0}),' +
			' left: co.yawFromDirection({x: -1, y: 0, z: 0}),' +
			// a steeply tilted aim still yaws — only its horizontal part is read
			' tilted: co.yawFromDirection({x: 1, y: -9, z: 0}),' +
			// scale-free: a 1mm controller-tip delta along the floor is a valid aim
			' tiny: co.yawFromDirection({x: 0.0005, y: 0, z: -0.0005})' +
			'}'
	);
	h.check(near(yaws.back, 0, 1e-12), '1.1 aiming along -Z is yaw 0 (the facing convention)');
	h.check(near(Math.abs(wrap(yaws.fwd)), Math.PI, 1e-12), '1.2 aiming along +Z is a half turn');
	h.check(near(yaws.right, -Math.PI / 2, 1e-12), '1.3 aiming along +X is -90 deg (got ' + yaws.right + ')');
	h.check(near(yaws.left, Math.PI / 2, 1e-12), '1.4 aiming along -X is +90 deg');
	h.check(near(yaws.tilted, -Math.PI / 2, 1e-12), '1.5 a steeply tilted aim reads its HORIZONTAL yaw');
	h.check(near(wrap(yaws.tiny), -Math.PI / 4, 1e-9), '1.6 a millimetre-long aim still yaws (scale-free guard)');

	const refusals = await co(
		page,
		'return {' +
			' down: co.alignmentFromPointAim({x: 1, y: 2, z: 3}, {x: 0, y: -1, z: 0}),' +
			' up: co.alignmentFromPointAim({x: 1, y: 2, z: 3}, {x: 0, y: 1, z: 0}),' +
			' zero: co.alignmentFromPointAim({x: 1, y: 2, z: 3}, {x: 0, y: 0, z: 0}),' +
			' nanPoint: co.alignmentFromPointAim({x: NaN, y: 0, z: 0}, {x: 0, y: 0, z: -1}),' +
			' spotDown: co.alignmentFromSpot({x: 0, y: 1.6, z: 0}, new S.THREE.Quaternion()' +
			'   .setFromAxisAngle(new S.THREE.Vector3(1, 0, 0), -Math.PI / 2))' +
			'}'
	);
	h.check(refusals.down === null, '1.7 aiming straight DOWN is refused (no yaw information)');
	h.check(refusals.up === null, '1.8 aiming straight UP is refused');
	h.check(refusals.zero === null, '1.9 a zero-length aim is refused');
	h.check(refusals.nanPoint === null, '1.10 a non-finite calibration point is refused');
	h.check(refusals.spotDown === null, '1.11 the same-spot fallback refuses a head looking straight down');

	// the spot fallback: floor projection + head facing, through the SAME atan2
	const spot = await co(
		page,
		'const q = new S.THREE.Quaternion().setFromAxisAngle(new S.THREE.Vector3(0, 1, 0), 0.5);' +
			'return co.alignmentFromSpot({x: 2, y: 1.62, z: -1}, q)'
	);
	h.check(spot && spot.px === 2 && spot.pz === -1, '1.12 the spot origin is the head XZ');
	h.check(spot && spot.py === 0, '1.13 ...projected to the FLOOR (local-floor gives a shared y=0)');
	h.check(spot && near(wrap(spot.yaw - 0.5), 0, 1e-9), '1.14 ...and its yaw is the head heading (got ' + spot.yaw + ')');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. CONVERGENCE: two devices, one room, the same content coords ===');

	// The ritual DEFINES the room frame: the agreed physical point is the room origin
	// and the agreed physical direction is room -Z. Each device sees that same point and
	// direction through its own private tracking transform T_i, so feeding its view in
	// must recover T_i, and reading a third physical point back out through the rig must
	// give the same CONTENT coordinate on both.
	const conv = await co(
		page,
		`
		const T = S.THREE;
		const UP = new T.Vector3(0, 1, 0);
		const ONE = new T.Vector3(1, 1, 1);
		// ground truth: two devices, different origins AND different headings
		const truth = [
			{ yaw: 0.7, p: [1.2, 0.0, -3.4] },
			{ yaw: -2.1, p: [-5.0, 0.15, 2.25] }
		];
		// a NON-TRIVIAL anchor: the room origin sits away from the content origin and
		// turned. Both halves matter — with an identity anchor the flip is invisible.
		const anchor = co.normalizeRoomAnchor({
			pos: [4, 0.5, -2],
			quat: new T.Quaternion().setFromAxisAngle(UP, 1.1).toArray()
		});
		// the physical probe point, expressed in ROOM coords
		const probeRoom = new T.Vector3(0.8, 1.5, -2.6);

		const rows = [];
		for (const t of truth) {
			const qm = new T.Quaternion().setFromAxisAngle(UP, t.yaw);
			const M = new T.Matrix4().compose(new T.Vector3().fromArray(t.p), qm, ONE);
			// what THIS device sees of the agreed point and direction
			const point = new T.Vector3(0, 0, 0).applyMatrix4(M);
			const dir = new T.Vector3(0, 0, -1).applyQuaternion(qm);
			const a = co.alignmentFromPointAim(point, dir);

			// the rig the module would seat, and the same thing with M and K^-1 SWAPPED
			const good = co.composeRigTransform(a, anchor);
			const Mgood = new T.Matrix4().compose(
				new T.Vector3().fromArray(good.pos),
				new T.Quaternion().fromArray(good.quat),
				ONE
			);
			const Kmat = new T.Matrix4().compose(
				new T.Vector3().fromArray(anchor.pos),
				new T.Quaternion().fromArray(anchor.quat),
				ONE
			);
			const Mmat = new T.Matrix4().compose(
				new T.Vector3().fromArray([a.px, a.py, a.pz]),
				new T.Quaternion().setFromAxisAngle(UP, a.yaw),
				ONE
			);
			const Mflip = Kmat.clone().invert().multiply(Mmat); // the WRONG order

			// where the probe physically is, for this device
			const world = probeRoom.clone().applyMatrix4(M);
			const content = world.clone().applyMatrix4(Mgood.clone().invert());
			const flipped = world.clone().applyMatrix4(Mflip.clone().invert());
			// and what content coord the anchor says that room point should have
			const expected = probeRoom.clone().applyMatrix4(Kmat);

			rows.push({
				recovered: a,
				truth: t,
				world: world.toArray(),
				content: content.toArray(),
				flipped: flipped.toArray(),
				expected: expected.toArray()
			});
		}
		const d = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
		return {
			rows,
			agree: d(rows[0].content, rows[1].content),
			flipDisagree: d(rows[0].flipped, rows[1].flipped),
			vsAnchor: d(rows[0].content, rows[0].expected)
		};
		`
	);

	// premise: the calibration really recovers each device's own tracking transform
	for (let i = 0; i < 2; i++) {
		const r = conv.rows[i];
		const posOk =
			near(r.recovered.px, r.truth.p[0], 1e-9) &&
			near(r.recovered.py, r.truth.p[1], 1e-9) &&
			near(r.recovered.pz, r.truth.p[2], 1e-9);
		h.check(posOk, '2.' + (i + 1) + ' (premise) device ' + (i + 1) + ' recovers its own tracking origin');
		h.check(
			near(wrap(r.recovered.yaw - r.truth.yaw), 0, 1e-9),
			'2.' + (i + 1) + 'b (premise) device ' + (i + 1) + ' recovers its own heading'
		);
	}
	// premise: the two devices really are in different places, or convergence is free
	const sep = Math.hypot(
		conv.rows[0].world[0] - conv.rows[1].world[0],
		conv.rows[0].world[1] - conv.rows[1].world[1],
		conv.rows[0].world[2] - conv.rows[1].world[2]
	);
	h.check(sep > 1, '2.3 (premise) the two devices see the probe ' + sep.toFixed(2) + 'm apart in their own tracking space');

	h.check(
		conv.agree < 1e-6,
		'2.4 both devices read the same physical point at the SAME content coord (delta ' +
			conv.agree.toExponential(2) +
			'm)'
	);
	h.check(
		conv.vsAnchor < 1e-6,
		'2.5 ...and that coord is K applied to the room point, as the anchor promises'
	);
	// THE COUNTERFACTUAL: the same numbers with M and K^-1 swapped do NOT converge.
	// Without this the check above could be passing for a reason unrelated to the order.
	h.check(
		conv.flipDisagree > 1,
		'2.6 the FLIPPED composition (K-inverse then M) disagrees by ' +
			conv.flipDisagree.toFixed(2) +
			'm — the check is adversarial'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. yaw only: no roll, no pitch, not even from a hostile anchor ===');

	const upright = await co(
		page,
		`
		const T = S.THREE;
		// a TILTED anchor: 35 degrees of pitch and 20 of roll on top of a real yaw. A
		// newer peer, a bad calibration or a hostile payload could all send this, and
		// applying it verbatim would tip a colocated user's horizon.
		const tilt = new T.Quaternion().setFromEuler(new T.Euler(0.61, 0.9, 0.35, 'YXZ'));
		const norm = co.normalizeRoomAnchor({ pos: [1, 2, 3], quat: tilt.toArray() });
		const a = co.alignmentFromPointAim({ x: 1, y: 0.2, z: -2 }, { x: 0.4, y: -0.9, z: 0.3 });
		const rig = co.composeRigTransform(a, norm);
		const q = new T.Quaternion().fromArray(rig.quat);
		const vertical = new T.Vector3(0, 1, 0).applyQuaternion(q);
		// what the tilt would have done, for contrast
		const tiltedVertical = new T.Vector3(0, 1, 0).applyQuaternion(tilt);
		const normQ = new T.Quaternion().fromArray(norm.quat);
		return {
			vertical: vertical.toArray(),
			tiltedVertical: tiltedVertical.toArray(),
			// the flattened anchor keeps the YAW it was sent
			normYaw: co.yawFromDirection(new T.Vector3(0, 0, -1).applyQuaternion(normQ)),
			tiltYaw: co.yawFromDirection(new T.Vector3(0, 0, -1).applyQuaternion(tilt)),
			normUpright: new T.Vector3(0, 1, 0).applyQuaternion(normQ).toArray()
		};
		`
	);
	h.check(
		near(upright.vertical[0], 0, 1e-9) && near(upright.vertical[1], 1, 1e-9) && near(upright.vertical[2], 0, 1e-9),
		'3.1 up stays up through the FULL compose (' + upright.vertical.map((v) => v.toFixed(6)).join(', ') + ')'
	);
	h.check(
		Math.hypot(upright.tiltedVertical[0], upright.tiltedVertical[2]) > 0.3,
		'3.2 (premise) the raw tilt really would have tipped it (' +
			Math.hypot(upright.tiltedVertical[0], upright.tiltedVertical[2]).toFixed(3) +
			' off vertical)'
	);
	h.check(
		near(upright.normUpright[1], 1, 1e-9),
		'3.3 normalizeRoomAnchor flattens the stored quaternion itself, not just the result'
	);
	h.check(
		near(wrap(upright.normYaw - upright.tiltYaw), 0, 1e-9),
		'3.4 ...while KEEPING the yaw it was sent (' + upright.normYaw.toFixed(4) + ')'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the rig seam: apply, idempotence, scale, clear ===');

	const rigPresent = await co(page, 'return !!S.colocation.colocationDebug().rig');
	h.check(rigPresent, '4.1 (premise) worldRig is mounted on the desktop too');

	const applied = await co(
		page,
		`
		co.clearAlignment();
		co.roomAnchor.set(null);
		co.roomKey.set(null);
		let ref = null;
		S.worldRig.subscribe((r) => (ref = r))();
		// pretend a two-grip world-grab had zoomed and shoved the world first
		ref.scale.setScalar(2.5);
		ref.position.set(9, 9, 9);
		const before = { pos: ref.position.toArray(), scale: ref.scale.toArray() };

		const a = co.alignmentFromPointAim({ x: 1.5, y: 0.1, z: -2.5 }, { x: 1, y: 0, z: -1 });
		co.setRoomAlignment(a, { source: 'calibration' });
		const first = co.applyRoomAlignment();
		const after1 = {
			pos: ref.position.toArray(),
			quat: ref.quaternion.toArray(),
			scale: ref.scale.toArray()
		};
		// twice must be byte-identical: applying is a function of state, not a nudge
		const second = co.applyRoomAlignment();
		const after2 = {
			pos: ref.position.toArray(),
			quat: ref.quaternion.toArray(),
			scale: ref.scale.toArray()
		};
		// a REFUSED alignment must leave the working one alone
		const refused = co.setRoomAlignment(co.alignmentFromPointAim({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
		const stillAligned = JSON.parse(JSON.stringify(co.colocationDebug().alignment));
		// and clearing puts the rig back to identity through the same seam
		co.clearAlignment();
		const cleared = {
			pos: ref.position.toArray(),
			quat: ref.quaternion.toArray(),
			scale: ref.scale.toArray(),
			alignment: co.colocationDebug().alignment
		};
		const noop = co.applyRoomAlignment();
		return { before, first, second, after1, after2, refused, stillAligned, cleared, noop };
		`
	);
	h.check(applied.before.scale[0] === 2.5, '4.2 (premise) the rig really was scaled 2.5x first');
	h.check(applied.first !== null, '4.3 applyRoomAlignment reports what it wrote');
	h.check(
		applied.after1.scale.every((/** @type {number} */ s) => s === 1),
		'4.4 SCALE IS FORCED TO 1 — a scaled rig cannot be 1:1 with a physical room'
	);
	h.check(
		JSON.stringify(applied.after1) === JSON.stringify(applied.after2),
		'4.5 applying twice is byte-identical (idempotent)'
	);
	h.check(applied.refused === null, '4.6 a degenerate calibration is refused by the write path too');
	h.check(applied.stillAligned !== null, '4.7 ...and leaves the working alignment in place');
	h.check(
		applied.cleared.pos.every((/** @type {number} */ v) => v === 0) &&
			applied.cleared.scale.every((/** @type {number} */ v) => v === 1) &&
			applied.cleared.alignment === null,
		'4.8 clearAlignment restores the rig to identity and drops the alignment'
	);
	h.check(applied.noop === null, '4.9 applying with no alignment is a silent no-op');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. the rig agrees with worldToContentPose (the presence seam) ===');

	// VR presence is broadcast in the CONTENT frame through worldToContentPose, so if
	// the composition and that helper disagree the avatars land somewhere else than the
	// objects. The reference here is computed ANALYTICALLY from the alignment and anchor
	// numbers (K . M^-1), not read back off the rig, so agreement is a real claim.
	//
	// MEASURED while proving the flip: only 5.2 goes red when M and K^-1 are swapped in
	// the source; 5.3 stays green at 0.00e+0 rad, and that is not a weak check, it is a
	// consequence of the yaw-only rule. Both rotations turn about +Y, so they COMMUTE and
	// the two orders have literally the same rotation — the whole difference lives in the
	// TRANSLATION. Anything asserting the composition order must therefore measure a
	// POSITION; a rotation-only guard here could never fail.
	const consistent = await co(
		page,
		`
		const T = S.THREE;
		const UP = new T.Vector3(0, 1, 0);
		const ONE = new T.Vector3(1, 1, 1);
		let ref = null;
		S.worldRig.subscribe((r) => (ref = r))();

		const anchor = co.setRoomAnchor({
			pos: [-1.5, 0.25, 3],
			quat: new T.Quaternion().setFromAxisAngle(UP, -0.8).toArray()
		});
		const a = co.setRoomAlignment(
			co.alignmentFromPointAim({ x: 2.2, y: 0.05, z: 1.1 }, { x: -1, y: 0.2, z: -3 }),
			{ source: 'calibration' }
		);
		co.applyRoomAlignment();

		// analytic K . M^-1, built from the stored numbers
		const Kmat = new T.Matrix4().compose(
			new T.Vector3().fromArray(anchor.pos),
			new T.Quaternion().fromArray(anchor.quat),
			ONE
		);
		const qm = new T.Quaternion().setFromAxisAngle(UP, a.yaw);
		const Mmat = new T.Matrix4().compose(new T.Vector3(a.px, a.py, a.pz), qm, ONE);
		const analytic = Kmat.clone().multiply(Mmat.clone().invert());

		const worldPos = new T.Vector3(0.4, 1.7, -2.9);
		const worldQuat = new T.Quaternion().setFromEuler(new T.Euler(0.2, 1.3, -0.4, 'YXZ'));

		const gotPos = worldPos.clone();
		const gotQuat = worldQuat.clone();
		S.vrControls.worldToContentPose(ref, gotPos, gotQuat);

		const wantPos = worldPos.clone().applyMatrix4(analytic);
		// the rotation half: content = qRig^-1 * world, and qRig^-1 == qk * qm^-1
		const wantQuat = new T.Quaternion()
			.fromArray(anchor.quat)
			.multiply(qm.clone().invert())
			.multiply(worldQuat);

		return {
			posDelta: gotPos.distanceTo(wantPos),
			quatAngle: gotQuat.angleTo(wantQuat),
			// (premise) the transform is not the identity, or "agrees" is meaningless
			moved: gotPos.distanceTo(worldPos)
		};
		`
	);
	h.check(consistent.moved > 1, '5.1 (premise) the rig really moves the pose (' + consistent.moved.toFixed(2) + 'm)');
	h.check(
		consistent.posDelta < 1e-6,
		'5.2 worldToContentPose matches the analytic K.M-inverse position (delta ' +
			consistent.posDelta.toExponential(2) +
			')'
	);
	h.check(
		consistent.quatAngle < 1e-6,
		'5.3 ...and its rotation (angle ' + consistent.quatAngle.toExponential(2) + ' rad)'
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the anchor singleton: stamps, refusals, unknown fields, scoping ===');

	const stamps = await co(
		page,
		'const out = [];' +
			'for (let i = 0; i < 5; i++) out.push(co.setRoomAnchor({ pos: [i, 0, 0] }).at);' +
			'return out'
	);
	h.check(
		stamps.every((/** @type {number} */ v, /** @type {number} */ i) => i === 0 || v > stamps[i - 1]),
		'6.1 five writes inside one gesture get STRICTLY increasing stamps (' + stamps.join(',') + ')'
	);

	const merged = await co(
		page,
		'const before = co.colocationDebug().anchor;' +
			'const after = co.setRoomAnchor({ roomKey: "kitchen" });' +
			'return { before, after }'
	);
	h.check(
		JSON.stringify(merged.after.pos) === JSON.stringify(merged.before.pos),
		'6.2 a partial write MERGES — the untouched position survives'
	);
	h.check(merged.after.roomKey === 'kitchen', '6.3 ...and the written field lands');

	const staleAndUnknown = await co(
		page,
		'const live = co.colocationDebug().anchor;' +
			'const stale = co.applyRoomAnchorRemote({ pos: [99, 99, 99], at: 1 });' +
			'const afterStale = co.colocationDebug().anchor;' +
			// an EQUAL stamp is accepted: an ordered conn means it arrived LATER
			'const equal = co.applyRoomAnchorRemote({ pos: [7, 0, 0], at: live.at });' +
			'const afterEqual = co.colocationDebug().anchor;' +
			// a newer peer\'s unknown field survives our editor and our re-send
			'co.applyRoomAnchorRemote({ pos: [1, 1, 1], futureField: { magic: 42 }, at: Date.now() + 20000 });' +
			'const wire = co.roomAnchorState();' +
			'return { live, stale, afterStale, equal, afterEqual, wire }'
	);
	h.check(staleAndUnknown.stale === false, '6.4 a STRICTLY older record is refused');
	h.check(
		JSON.stringify(staleAndUnknown.afterStale.pos) === JSON.stringify(staleAndUnknown.live.pos),
		'6.5 ...and changes nothing'
	);
	h.check(staleAndUnknown.equal === true, '6.6 an EQUAL stamp is accepted (an ordered conn delivered it later)');
	h.check(staleAndUnknown.afterEqual.pos[0] === 7, '6.7 ...and applies');
	h.check(
		staleAndUnknown.wire.futureField && staleAndUnknown.wire.futureField.magic === 42,
		'6.8 a newer peer\'s unknown field survives normalize -> store -> the wire payload'
	);
	h.check(staleAndUnknown.wire.type === 'roomanchor', '6.9 the wire payload carries its own type');

	const pristine = await co(
		page,
		'co.roomAnchor.set(null);' +
			'const snap = co.roomAnchorSnapshot();' +
			'const state = co.roomAnchorState();' +
			'co.setRoomAnchor({ pos: [1, 2, 3] });' +
			'return { snap, state, dirty: co.roomAnchorSnapshot() }'
	);
	h.check(pristine.snap === null, '6.10 a pristine scene snapshots to null — no key in the file');
	h.check(pristine.state === null, '6.11 ...and has NOTHING to say on the handshake');
	h.check(pristine.dirty !== null, '6.12 a set anchor does snapshot (so 6.10 is not vacuous)');

	// roomKey scoping: an anchor minted in another room must not place MY content
	const scoped = await co(
		page,
		'co.roomAnchor.set(null);' +
			'co.setRoomAnchor({ pos: [5, 0, 5], roomKey: "kitchen" });' +
			'co.setRoomAlignment(co.alignmentFromPointAim({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),' +
			'  { roomKey: "kitchen" });' +
			'const matching = !!co.effectiveRoomAnchor();' +
			'co.setRoomAlignment(co.alignmentFromPointAim({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),' +
			'  { roomKey: "garage" });' +
			'const mismatched = co.effectiveRoomAnchor();' +
			'co.roomKey.set(null);' +
			'co.setRoomAlignment(co.alignmentFromPointAim({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),' +
			'  { roomKey: null });' +
			'const unkeyed = !!co.effectiveRoomAnchor();' +
			'return { matching, mismatched, unkeyed }'
	);
	h.check(scoped.matching, '6.13 an anchor for MY room composes');
	h.check(scoped.mismatched === null, '6.14 an anchor for ANOTHER room is ignored (identity, not a wrong placement)');
	h.check(scoped.unkeyed, '6.15 with no key on either side the anchor composes (today\'s only path)');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. two peers + a late joiner: the roomanchor wire ===');

	// pristine FIRST, so "the joiner gets nothing" is measured before anything is set
	await co(page, 'co.roomAnchor.set(null); co.clearAlignment(); co.roomKey.set(null)');
	const B = await h.setupPage(browser, 'B');
	await co(B.page, 'co.roomAnchor.set(null)');
	await h.connect(A, B);

	const bPristine = await co(B.page, 'return co.colocationDebug().anchor');
	h.check(bPristine === null, '7.1 a joiner to a NEVER-colocated scene receives nothing (anchor stays null)');

	const sent = await co(
		page,
		'return co.setRoomAnchor({ pos: [3.25, 0.75, -1.5], roomKey: "studio" })'
	);
	await h.eventually(
		() => co(B.page, 'return co.colocationDebug().anchor?.pos?.[0] ?? null'),
		(v) => v !== null && Math.abs(v - sent.pos[0]) < 1e-6,
		'7.2 a live set on A replicates to B over the `roomanchor` type'
	);
	const bGot = await co(B.page, 'return co.colocationDebug().anchor');
	h.check(bGot && bGot.roomKey === sent.roomKey, '7.3 ...carrying the roomKey (' + (bGot && bGot.roomKey) + ')');
	h.check(bGot && bGot.at === sent.at, '7.4 ...and the sender\'s stamp verbatim, so latest-wins can work');

	// a stale replay at B must be refused — the receiving guard, not the sender's
	const staleAtB = await co(
		B.page,
		'const live = co.colocationDebug().anchor;' +
			'const applied = co.applyRoomAnchorRemote({ ...live, pos: [-42, -42, -42], at: live.at - 1 });' +
			'return { applied, pos: co.colocationDebug().anchor.pos, want: live.pos }'
	);
	h.check(staleAtB.applied === false, '7.5 a STALE roomanchor replayed at B is refused');
	h.check(
		JSON.stringify(staleAtB.pos) === JSON.stringify(staleAtB.want),
		'7.6 ...and B keeps the record it had'
	);

	// B answers too — the anchor is scene state, so either side may write it
	const fromB = await co(B.page, 'return co.setRoomAnchor({ pos: [-2, 0.1, 4] })');
	await h.eventually(
		() => co(page, 'return co.colocationDebug().anchor?.pos?.[0] ?? null'),
		(v) => v !== null && Math.abs(v - fromB.pos[0]) < 1e-6,
		'7.7 a write on B replicates back to A (either peer may move the anchor)'
	);

	// the LATE JOINER pulls it through the handshake — C dials, A approves
	const C = await h.setupPage(browser, 'C');
	await co(C.page, 'co.roomAnchor.set(null)');
	const cBefore = await co(C.page, 'return co.colocationDebug().anchor');
	h.check(cBefore === null, '7.8 (premise) C starts with no anchor');
	await h.connect(C, A);

	await h.eventually(
		() => co(C.page, 'return co.colocationDebug().anchor?.pos?.[0] ?? null'),
		(v) => v !== null && Math.abs(v - fromB.pos[0]) < 1e-6,
		'7.9 the LATE JOINER pulls the anchor through `getroomanchor` on the handshake'
	);
	const cGot = await co(C.page, 'return co.colocationDebug().anchor');
	h.check(cGot && cGot.at === fromB.at, '7.10 ...with the stamp intact (' + (cGot && cGot.at) + ')');
	h.check(cGot && cGot.roomKey === fromB.roomKey, '7.11 ...and the roomKey it was minted with');

	// SECTION 2 END TO END, across the real wire: three DIFFERENT devices, each with its
	// own private tracking frame, each calibrating on the same physical point/direction,
	// all composing against the anchor they pulled — and reading one physical point at
	// one content coordinate. This is the product claim in a single number.
	const perDevice = [
		{ yaw: 0.35, p: [2.0, 0.0, 1.0] },
		{ yaw: -1.4, p: [-3.5, 0.05, -0.75] },
		{ yaw: 2.9, p: [0.5, -0.1, 4.2] }
	];
	const reads = [];
	for (let i = 0; i < 3; i++) {
		const p = [page, B.page, C.page][i];
		reads.push(
			await co(
				p,
				`
				const T = S.THREE;
				const UP = new T.Vector3(0, 1, 0);
				const ONE = new T.Vector3(1, 1, 1);
				const truth = arg.device;
				const qm = new T.Quaternion().setFromAxisAngle(UP, truth.yaw);
				const M = new T.Matrix4().compose(new T.Vector3().fromArray(truth.p), qm, ONE);
				// this device's view of the agreed point and the agreed direction
				const point = new T.Vector3(0, 0, 0).applyMatrix4(M);
				const dir = new T.Vector3(0, 0, -1).applyQuaternion(qm);
				co.setRoomAlignment(co.alignmentFromPointAim(point, dir), { source: 'calibration' });
				const rig = co.composeRigTransform(co.colocationDebug().alignment, co.effectiveRoomAnchor());
				const rigMat = new T.Matrix4().compose(
					new T.Vector3().fromArray(rig.pos),
					new T.Quaternion().fromArray(rig.quat),
					ONE
				);
				// the shared probe, physically the same spot in the room, seen by this device
				const world = new T.Vector3().fromArray(arg.probeRoom).applyMatrix4(M);
				const content = world.clone().applyMatrix4(rigMat.clone().invert());
				return {
					world: world.toArray(),
					content: content.toArray(),
					anchorAt: co.effectiveRoomAnchor()?.at ?? null
				};
				`,
				{ device: perDevice[i], probeRoom: [1.1, 1.4, -0.6] }
			)
		);
	}
	const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
	const worldSpread = Math.max(
		dist(reads[0].world, reads[1].world),
		dist(reads[1].world, reads[2].world),
		dist(reads[0].world, reads[2].world)
	);
	const contentSpread = Math.max(
		dist(reads[0].content, reads[1].content),
		dist(reads[1].content, reads[2].content),
		dist(reads[0].content, reads[2].content)
	);
	h.check(
		worldSpread > 1,
		'7.12 (premise) the three devices see the probe ' + worldSpread.toFixed(2) + 'm apart in their own tracking spaces'
	);
	h.check(
		contentSpread < 1e-6,
		'7.13 ...and agree on its CONTENT coordinate to ' + contentSpread.toExponential(2) + 'm — colocated'
	);
	h.check(
		reads.every((/** @type {any} */ r) => r.anchorAt === reads[0].anchorAt && r.anchorAt !== null),
		'7.14 ...off ONE converged anchor stamp (' + reads[0].anchorAt + ')'
	);

	await h.finish(browser);
});
