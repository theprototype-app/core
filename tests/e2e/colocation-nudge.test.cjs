// CO7 — the fine-tune nudge: the maths, the persistence, the stick drive, and THE ONE
// interaction that makes or breaks the feature — a CO3 drift correction must not eat
// the user's own correction.
//
// Single page throughout, on purpose: the nudge is local per device by design (it
// corrects THIS headset's calibration error — see colocation.js's nudge block), so it
// is never replicated and a second peer would assert nothing this cannot.

const h = require('./helpers.cjs');

const near = (a, b, tol = 1e-9) => typeof a === 'number' && Math.abs(a - b) < tol;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 0. the hook slots (the positional trap) -------------------------------------
	const hook = await page.evaluate(() => ({
		nudge: typeof window.__stores?.colocationNudge?.setRoomNudge,
		math: typeof window.__stores?.colocation?.nudgeAlignment,
		colo: !!window.__stores?.colocation,
		anchors: !!window.__stores?.colocationAnchors,
		calib: !!window.__stores?.colocationCalibrate
	}));
	h.check(hook.nudge === 'function', '0.1 colocationNudge sits at its hook slot');
	h.check(hook.math === 'function', '0.2 the nudge maths is on the colocation leaf');
	h.check(hook.colo && hook.anchors && hook.calib, '0.3 its neighbour slots still resolve');

	// the three App.svelte tails must still agree — a missing entry SHIFTS every later
	// binding onto the wrong module, silently. Read from DISK: the served module is
	// vite-compiled, so the source shape only exists on the filesystem.
	const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "src", "App.svelte"), "utf8");
	const arrStart = src.indexOf("Promise.all([");
	const arrEnd = src.indexOf("]).then(([", arrStart);
	const importCount = (src.slice(arrStart, arrEnd).match(/import\(/g) || []).length;
	const destrMatch = src.slice(arrEnd).match(/\]\)\.then\(\(\[([^\]]+)\]\)/);
	const destrCount = destrMatch ? destrMatch[1].split(",").map((x) => x.trim()).filter(Boolean).length : -1;
	h.check(
		importCount === destrCount && importCount > 100,
		`0.4 App.svelte import/destructure tails agree (${importCount}/${destrCount})`
	);
	h.check(
		destrMatch ? /colocationNudgeLib/.test(destrMatch[1]) : false,
		"0.5 colocationNudge is in the destructure tail"
	);
	// ---- 1. the pure maths ------------------------------------------------------------
	const math = await page.evaluate(() => {
		const { nudgeAlignment, nudgeFromStick, normalizeNudge, nudgeIsZero, NUDGE_MAX_M } =
			window.__stores.colocation;
		const base = { px: 1, py: 0.5, pz: -2, yaw: 0 };
		return {
			flat: nudgeAlignment(base, { dx: 0.03, dy: -0.01, dz: 0.02, dyaw: 0 }),
			// yaw 90deg: rotY(pi/2) maps (1,0,0) -> (0,0,-1), so a +X ROOM offset must
			// arrive as -Z in tracking space. This is the term that is wrong if the
			// composition rotates by the wrong yaw, or not at all.
			turned: nudgeAlignment({ ...base, yaw: Math.PI / 2 }, { dx: 0.1, dy: 0, dz: 0, dyaw: 0 }),
			yawed: nudgeAlignment(base, { dx: 0, dy: 0, dz: 0, dyaw: 0.05 }),
			zero: nudgeAlignment(base, { dx: 0, dy: 0, dz: 0, dyaw: 0 }),
			nullNudge: nudgeAlignment(base, null),
			clamped: normalizeNudge({ dx: 99, dy: -99, dz: 0, dyaw: 99 }),
			straight: nudgeFromStick(1, 0, 0, 0),
			sideways: nudgeFromStick(1, 0, Math.PI / 2, 0),
			isZero: [
				nudgeIsZero(null),
				nudgeIsZero({ dx: 0, dy: 0, dz: 0, dyaw: 0 }),
				nudgeIsZero({ dx: 0.01, dy: 0, dz: 0, dyaw: 0 })
			],
			max: NUDGE_MAX_M
		};
	});
	h.check(
		near(math.flat.px, 1.03) && near(math.flat.py, 0.49) && near(math.flat.pz, -1.98),
		`1.1 yaw 0: the room offset applies straight through (${math.flat.px.toFixed(3)}, ${math.flat.py.toFixed(3)}, ${math.flat.pz.toFixed(3)})`
	);
	h.check(
		near(math.turned.px, 1) && near(math.turned.pz, -2.1),
		`1.2 yaw 90: a +X room offset arrives as -Z in tracking (pz ${math.turned.pz.toFixed(4)})`
	);
	h.check(near(math.yawed.yaw, 0.05), `1.3 the yaws ADD (${math.yawed.yaw.toFixed(4)})`);
	h.check(
		near(math.zero.px, 1) && near(math.zero.py, 0.5) && near(math.zero.pz, -2) && near(math.zero.yaw, 0),
		'1.4 a zero nudge leaves the base bit-identical'
	);
	h.check(near(math.nullNudge.px, 1) && near(math.nullNudge.yaw, 0), '1.5 a null nudge is the same as zero');
	h.check(
		math.clamped.dx === math.max && math.clamped.dy === -math.max && near(math.clamped.dyaw, (15 * Math.PI) / 180),
		`1.6 clamped to +/-${math.max}m and 15deg (${math.clamped.dx}, ${math.clamped.dyaw.toFixed(3)})`
	);
	h.check(
		math.isZero[0] && math.isZero[1] && !math.isZero[2],
		'1.7 nudgeIsZero: null and all-zero yes, any value no'
	);
	h.check(
		near(math.straight.dx, 1) && near(math.straight.dz, 0),
		`1.8 stick facing the room: right is room +X (${math.straight.dx.toFixed(3)}, ${math.straight.dz.toFixed(3)})`
	);
	h.check(
		near(math.sideways.dx, 0) && near(math.sideways.dz, -1),
		`1.9 head turned 90deg: "right" becomes room -Z — the head-relative rule (${math.sideways.dx.toFixed(3)}, ${math.sideways.dz.toFixed(3)})`
	);

	// ---- 2. no alignment, no fine-tune -------------------------------------------------
	const refused = await page.evaluate(() => {
		const n = window.__stores.colocationNudge;
		n.resetColocationNudge();
		window.__stores.colocationCalibrate.stopColocation();
		return { wrote: n.setRoomNudge({ dx: 0.05 }), armed: n.setNudgeMode(true), debug: n.nudgeDebug() };
	});
	h.check(
		refused.wrote === null && refused.debug.nudge === null,
		'2.1 a nudge with nothing colocated is refused (no frame to express it in)'
	);
	h.check(refused.armed === false && refused.debug.mode === false, '2.2 the stick mode refuses to arm without a room');

	// ---- 3. calibrate, then nudge ------------------------------------------------------
	const nudged = await page.evaluate(() => {
		const { colocateHere } = window.__stores.colocationCalibrate;
		const n = window.__stores.colocationNudge;
		const { colocationDebug } = window.__stores.colocation;
		colocateHere({ x: 2, y: 1.6, z: 3 }, { x: 0, y: 0, z: 0, w: 1 });
		const before = colocationDebug();
		const stored = n.setRoomNudge({ dx: 0.04, dy: 0.01, dz: -0.02 });
		return { base: before.alignment, stored, after: colocationDebug(), debug: n.nudgeDebug() };
	});
	h.check(!!nudged.base?.roomKey, '3.1 (premise) calibrated with a room key');
	h.check(
		near(nudged.stored.dx, 0.04) && near(nudged.stored.dy, 0.01) && near(nudged.stored.dz, -0.02),
		`3.2 the correction is stored (${JSON.stringify(nudged.stored)})`
	);
	h.check(
		near(nudged.after.alignment.px, nudged.base.px) &&
			near(nudged.after.alignment.py, nudged.base.py) &&
			near(nudged.after.alignment.pz, nudged.base.pz) &&
			near(nudged.after.alignment.yaw, nudged.base.yaw),
		'3.3 THE BASE ALIGNMENT IS UNTOUCHED — drift keeps tracking the anchor, not the nudge'
	);
	h.check(
		near(nudged.after.effective.px, nudged.base.px + 0.04) &&
			near(nudged.after.effective.py, nudged.base.py + 0.01) &&
			near(nudged.after.effective.pz, nudged.base.pz - 0.02),
		`3.4 the EFFECTIVE alignment carries it (px ${nudged.after.effective.px.toFixed(3)} vs base ${nudged.base.px.toFixed(3)})`
	);
	h.check(
		near(nudged.after.rig.pos[0], nudged.base.px + 0.04, 1e-6) &&
			near(nudged.after.rig.pos[1], nudged.base.py + 0.01, 1e-6),
		`3.5 the RIG moved by exactly the nudge (${nudged.after.rig.pos.map((v) => v.toFixed(3)).join(', ')})`
	);
	h.check(
		nudged.after.rig.scale.every((s) => near(s, 1)),
		'3.6 the world stays 1:1 while colocated'
	);
	h.check(!!nudged.debug.records[nudged.base.roomKey], '3.7 persisted under the room key');

	// ---- 4. THE GUARD: a drift correction must not eat the nudge ------------------------
	// Drives CO3's actual write path (setRoomAlignment source 'anchor' + applyRoomAlignment
	// — literally what an ease step and a snap do) and asserts the correction survives it.
	// This is the check that goes red if anyone folds the nudge into the stored base.
	const survives = await page.evaluate(() => {
		const { setRoomAlignment, applyRoomAlignment, colocationDebug } = window.__stores.colocation;
		const n = window.__stores.colocationNudge;
		const cur = colocationDebug().alignment;
		const nudgeBefore = { ...n.nudgeDebug().nudge };
		setRoomAlignment(
			{ px: cur.px + 0.03, py: cur.py, pz: cur.pz, yaw: cur.yaw },
			{ roomKey: cur.roomKey, source: 'anchor' }
		);
		applyRoomAlignment();
		return {
			nudgeBefore,
			nudgeAfter: n.nudgeDebug().nudge,
			after: colocationDebug(),
			expectedPx: cur.px + 0.03 + nudgeBefore.dx
		};
	});
	h.check(
		near(survives.nudgeAfter.dx, survives.nudgeBefore.dx) &&
			near(survives.nudgeAfter.dy, survives.nudgeBefore.dy) &&
			near(survives.nudgeAfter.dz, survives.nudgeBefore.dz),
		`4.1 the nudge SURVIVES a drift write (${JSON.stringify(survives.nudgeAfter)})`
	);
	h.check(
		near(survives.after.effective.px, survives.expectedPx),
		`4.2 the drift landed AND the nudge still rides on top (${survives.after.effective.px.toFixed(4)} = ${survives.expectedPx.toFixed(4)})`
	);
	h.check(
		near(survives.after.rig.pos[0], survives.expectedPx, 1e-6),
		'4.3 the rig reflects both the corrected base and the nudge'
	);

	// ---- 5. the stick drive -------------------------------------------------------------
	const stick = await page.evaluate(() => {
		const n = window.__stores.colocationNudge;
		n.resetRoomNudge();
		const armed = n.setNudgeMode(true);
		const dead = n.tickNudge({ lx: 0.1, ly: 0, rx: 0, ry: 0 }, 1);
		const afterDead = n.nudgeDebug().nudge;
		n.tickNudge({ lx: 1, ly: 0, rx: 0, ry: 0 }, 1); // one second, full right
		const afterRight = n.nudgeDebug().nudge;
		n.tickNudge({ lx: 0, ly: 0, rx: 0, ry: -1 }, 1); // right stick up (ry is down-positive)
		const afterUp = n.nudgeDebug().nudge;
		n.setNudgeMode(false);
		n.tickNudge({ lx: 1, ly: 0, rx: 0, ry: 0 }, 1);
		const afterDisarmed = n.nudgeDebug().nudge;
		return { armed, dead, afterDead, afterRight, afterUp, afterDisarmed, rates: n.nudgeDebug().rates };
	});
	h.check(stick.armed === true, '5.1 the mode arms while colocated');
	h.check(stick.dead === null && stick.afterDead === null, '5.2 a push inside the deadzone does nothing');
	// ASSERT THE MAGNITUDE, not dx: the drive is head-relative, so "push right" lands in
	// whatever MIX of room axes the head's yaw dictates (measured 0.0354/0.0354 here —
	// the editor camera sits 45deg off the room frame, so the motion splits evenly across
	// two axes while its length is exactly one second of rate). Pinning dx would be
	// asserting where the camera happened to be looking.
	const rightLen = Math.hypot(stick.afterRight.dx, stick.afterRight.dz);
	h.check(
		near(rightLen, stick.rates.m, 1e-6),
		`5.3 one second of full right = one second of rate (|${stick.afterRight.dx.toFixed(4)}, ${stick.afterRight.dz.toFixed(4)}| = ${rightLen.toFixed(4)} vs ${stick.rates.m})`
	);
	h.check(
		near(stick.afterUp.dy, stick.rates.m, 1e-6),
		`5.4 the right stick lifts on Y (${stick.afterUp.dy.toFixed(4)})`
	);
	h.check(
		near(stick.afterDisarmed.dx, stick.afterRight.dx) && near(stick.afterDisarmed.dy, stick.afterUp.dy),
		'5.5 disarmed, the sticks are inert'
	);
	h.check(
		stick.rates.m === 0.05 && stick.rates.deadzone === 0.15,
		`5.6 the shipped rates (${stick.rates.m} m/s, ${((stick.rates.yaw * 180) / Math.PI).toFixed(1)} deg/s, deadzone ${stick.rates.deadzone})`
	);

	const duringRitual = await page.evaluate(async () => {
		const { startCalibration, cancelCalibration } = window.__stores.colocationCalibrate;
		const n = window.__stores.colocationNudge;
		n.setNudgeMode(true);
		const before = { ...n.nudgeDebug().nudge };
		await startCalibration();
		const blocked = n.tickNudge({ lx: 1, ly: 0, rx: 0, ry: 0 }, 1);
		const during = { ...n.nudgeDebug().nudge };
		cancelCalibration();
		return { before, blocked, during };
	});
	h.check(
		duringRitual.blocked === null && near(duringRitual.during.dx, duringRitual.before.dx),
		'5.7 a calibration in progress suspends the trim (never fight the ritual)'
	);

	// ---- 6. per-room persistence, stop vs forget, reset ---------------------------------
	const persisted = await page.evaluate(() => {
		const { colocateHere, stopColocation } = window.__stores.colocationCalibrate;
		const { setRoomAlignment, applyRoomAlignment, colocationDebug } = window.__stores.colocation;
		const n = window.__stores.colocationNudge;
		stopColocation();
		colocateHere({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
		const keyA = colocationDebug().alignment.roomKey;
		n.setRoomNudge({ dx: 0.07, dy: 0, dz: 0, dyaw: 0 });
		const recA = n.nudgeFor(keyA);
		stopColocation();
		const liveAfterStop = n.nudgeDebug().nudge;
		const recAfterStop = n.nudgeFor(keyA);
		// re-align to the SAME room — exactly what a CO3 anchor restore does
		setRoomAlignment({ px: 0, py: 0, pz: 0, yaw: 0 }, { roomKey: keyA, source: 'anchor' });
		applyRoomAlignment();
		const restored = n.nudgeDebug().nudge;
		setRoomAlignment({ px: 5, py: 0, pz: 5, yaw: 0 }, { roomKey: 'room-other', source: 'anchor' });
		applyRoomAlignment();
		const otherRoom = n.nudgeDebug().nudge;
		setRoomAlignment({ px: 0, py: 0, pz: 0, yaw: 0 }, { roomKey: keyA, source: 'anchor' });
		applyRoomAlignment();
		const backToA = n.nudgeDebug().nudge;
		return { keyA, recA, liveAfterStop, recAfterStop, restored, otherRoom, backToA };
	});
	h.check(persisted.recA && near(persisted.recA.dx, 0.07), `6.1 room A's correction is recorded`);
	h.check(
		persisted.liveAfterStop === null && !!persisted.recAfterStop,
		'6.2 Stop drops the LIVE correction and KEEPS the record (stop is not forget)'
	);
	h.check(
		persisted.restored && near(persisted.restored.dx, 0.07),
		`6.3 re-aligning to that room restores it with no ritual (${persisted.restored?.dx})`
	);
	h.check(persisted.otherRoom === null, '6.4 a different room starts clean');
	h.check(persisted.backToA && near(persisted.backToA.dx, 0.07), '6.5 and coming back restores it again');

	const forgotten = await page.evaluate(() => {
		const n = window.__stores.colocationNudge;
		const { forgetRoom } = window.__stores.colocationAnchors;
		const key = window.__stores.colocation.colocationDebug().alignment.roomKey;
		n.setRoomNudge({ dx: 0.07 });
		const before = n.nudgeFor(key);
		const forgot = forgetRoom(key);
		return { before, forgot, after: n.nudgeFor(key), live: n.nudgeDebug().nudge };
	});
	h.check(!!forgotten.before, '6.6 (premise) a record existed to forget');
	h.check(
		forgotten.forgot === true && forgotten.after === null,
		'6.7 Forget drops the fine-tune record too (forgetting a room forgets everything)'
	);
	h.check(forgotten.live === null, '6.8 and clears the live correction');

	const resetBack = await page.evaluate(() => {
		const n = window.__stores.colocationNudge;
		const { colocationDebug } = window.__stores.colocation;
		const key = colocationDebug().alignment.roomKey;
		n.setRoomNudge({ dx: 0.09, dy: 0.02 });
		const posed = colocationDebug();
		n.resetRoomNudge();
		return { posed, after: colocationDebug(), rec: n.nudgeFor(key), live: n.nudgeDebug().nudge };
	});
	h.check(
		!near(resetBack.posed.rig.pos[0], resetBack.posed.alignment.px, 1e-6),
		'6.9 (premise) the nudge really had moved the rig off the raw alignment'
	);
	h.check(resetBack.live === null && resetBack.rec === null, '6.10 Reset clears the correction and its record');
	h.check(
		near(resetBack.after.rig.pos[0], resetBack.after.alignment.px, 1e-6) &&
			near(resetBack.after.rig.pos[1], resetBack.after.alignment.py, 1e-6),
		'6.11 and the rig goes back to the raw alignment'
	);

	// ---- 7. teardown -------------------------------------------------------------------
	const gone = await page.evaluate(() => {
		window.__stores.colocationCalibrate.stopColocation();
		const { colocationDebug } = window.__stores.colocation;
		return { d: colocationDebug(), mode: window.__stores.colocationNudge.nudgeDebug().mode };
	});
	h.check(gone.d.alignment === null, '7.1 stopping leaves no alignment');
	h.check(
		gone.d.rig.pos.every((n) => near(n, 0)) && gone.d.rig.scale.every((s) => near(s, 1)),
		'7.2 the rig is back to identity'
	);
	h.check(gone.mode === false, '7.3 and the stick mode disarms with it');

	await h.finish(browser);
});
