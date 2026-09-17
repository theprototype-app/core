// 24-A A1 — THE KNOCK: a hand (or a walking player) hits a dynamic body, and the body
// leaves at the speed it was hit.
//
// Section 0 is PURE: knockMath.js imports THREE + throwVelocity and nothing else, so
// the contact test, the response, the spin sign and the one-knock-per-pass cooldown
// are imported straight into node (the throw-velocity precedent).
//
// Sections 1-2 drive the runtime through `feedProbe`, the test hook that pushes a probe
// through a body at an EXACT speed on its own clock: every feed runs the contact test
// synchronously, so a body's velocity is read on the very next line, before rapier has
// stepped once. Section 1 is the initiator alone; section 2 is a non-initiator whose
// hit must cross the wire as `hit` and be applied — clamped — by the stepping peer,
// with the log agreeing on both, the prediction proven and withdrawn, and the
// capability gate dropping it.
//
// THE COUNTERFACTUALS: 1.12 (the block off = zero hits, nothing sent, the body
// untouched — what makes Towers and every saved scene byte-identical), 1.13 (not in
// play = nothing), 2.7 (a gated hit is applied nowhere and its prediction is withdrawn).
//
// Two-peer sections need PEER_CONFIG (the self-hosted signaling box) and GPU_ARGS: the
// prediction is advanced by the frame loop, and a software-rendered page ticks ~2.5 fps.

const { pathToFileURL } = require('url');
const path = require('path');
const h = require('./helpers.cjs');

const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

const sp = (page, body) =>
	page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);
const phys = (page, body) =>
	page.evaluate((b) => new Function('p', b)(window.__stores.physics), body);
const knock = (page, body) =>
	page.evaluate((b) => new Function('k', b)(window.__stores.knock), body);
const bodyOf = (page, uuid) =>
	page.evaluate(
		(uuid) => window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid) ?? null,
		uuid
	);
const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return o ? o.position.toArray() : null;
	}, uuid);
const speedOf = (b) => (b?.linvel ? Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z) : 0);

/** park the ball at (0,1,0) with zero velocity — applyThrow reseats AND zeroes */
const park = (page, uuid) =>
	phys(
		page,
		'return p.applyThrow({ uuid: "' +
			uuid +
			'", pos: [0, 1, 0], rot: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0] })'
	);

/**
 * Sweep a probe along +x (or -x) through y=1, z=0 at `speed` m/s in `dtMs` steps on a
 * synthetic clock. A fresh probe id per sweep unless `keep` — the cooldown state is
 * per probe, and most sections want a clean pair.
 *
 * `atHit` is the body's velocity read IN THE SAME EVALUATE, on the line after the first
 * hit fired. The first version read it from a second evaluate and measured 0.769 x the
 * hand speed on every sweep — exactly (1/(1 + 2/60))^8, the scene's damping over the
 * 8-substep backlog the frame loop ran between the two round trips. The number to
 * assert is the one the knock wrote, so it is read before rapier steps once.
 */
const sweep = (page, id, opts) =>
	page.evaluate(
		({ id, uuid, from, to, speed, dtMs, t0, y, z, keep }) => {
			const k = window.__stores.knock;
			const p = window.__stores.physics;
			if (!keep) k.dropProbe(id);
			const step = (speed * dtMs) / 1000;
			const dir = Math.sign(to - from) || 1;
			let hits = 0;
			let overlaps = 0;
			let armed = true;
			let calls = 0;
			let t = t0;
			let x = from;
			let atHit = null;
			while (dir > 0 ? x <= to + 1e-9 : x >= to - 1e-9) {
				const r = k.feedProbe(id, [x, y, z], t);
				if (r.hits > 0 && !atHit && uuid) {
					const b = p.physicsDebug().find((entry) => entry.uuid === uuid);
					atHit = b?.linvel ? [b.linvel.x, b.linvel.y, b.linvel.z] : null;
				}
				hits += r.hits;
				overlaps += r.overlaps;
				armed = armed && r.armed;
				calls++;
				x += dir * step;
				t += dtMs;
			}
			return { hits, overlaps, armed, calls, lastT: t, atHit };
		},
		{ dtMs: 16, t0: 1000, y: 1, z: 0, keep: false, uuid: null, ...opts, id }
	);
const mag = (v) => (Array.isArray(v) ? Math.hypot(v[0], v[1], v[2]) : NaN);
const fmt = (v) => (Array.isArray(v) ? v.map((n) => n.toFixed(3)).join(', ') : 'none');

h.run(async () => {
	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. the pure half (no browser) ===');
	{
		const THREE = await import('three');
		const m = await import(src('knockMath.js'));
		const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

		const far = m.contactOf(v3(-1, 0, 0), 0.12, v3(2, 0, 0), v3(0, 0, 0), 0.3, v3(0, 0, 0));
		h.check(!far.overlap && far.approach === 2, '0.1 a probe 1 m away closing at 2 m/s: no overlap, approach 2');
		h.check(far.n.x === 1 && far.n.y === 0, '0.2 the normal points FROM the probe INTO the body');
		const near = m.contactOf(v3(-0.4, 0, 0), 0.12, v3(2, 0, 0), v3(0, 0, 0), 0.3, v3(0, 0, 0));
		h.check(near.overlap, '0.3 inside r_probe + r_body it overlaps');
		const receding = m.contactOf(v3(-0.4, 0, 0), 0.12, v3(-2, 0, 0), v3(0, 0, 0), 0.3, v3(0, 0, 0));
		h.check(receding.overlap && receding.approach === -2, '0.4 a receding probe overlaps with NEGATIVE approach');
		const outrun = m.contactOf(v3(-0.4, 0, 0), 0.12, v3(2, 0, 0), v3(0, 0, 0), 0.3, v3(3, 0, 0));
		h.check(outrun.approach === -1, '0.5 a probe slower than the ball it chases reads as receding (' + outrun.approach + ')');
		const coincident = m.contactOf(v3(0, 0, 0), 0.12, v3(0, 0, 0), v3(0, 0, 0), 0.3, v3(0, 0, 0));
		h.check(coincident.overlap && coincident.approach === 0, '0.6 coincident centres with no motion: overlap, approach 0, no NaN');

		const base = { bodyVel: v3(0, 0, 0), bodyAngvel: v3(0, 0, 0), n: v3(1, 0, 0), bodyRadius: 0.3, gain: 1, spin: 0, maxSpeed: 12 };
		const two = m.knockResponse({ ...base, probeVel: v3(2, 0, 0), approach: 2 });
		const six = m.knockResponse({ ...base, probeVel: v3(6, 0, 0), approach: 6 });
		h.check(
			Math.abs(two.linvel.x - 2) < 1e-9 && Math.abs(six.linvel.x - 6) < 1e-9,
			'0.7 the response is the approach speed along n (2 -> 2, 6 -> 6): MONOTONIC in probe speed'
		);
		const gained = m.knockResponse({ ...base, probeVel: v3(6, 0, 0), approach: 6, gain: 1.5 });
		h.check(Math.abs(gained.linvel.x - 9) < 1e-9, '0.8 gain scales it (6 x 1.5 = ' + gained.linvel.x + ')');
		const moving = m.knockResponse({ ...base, bodyVel: v3(-1, 0, 0), probeVel: v3(2, 0, 0), approach: 3 });
		h.check(
			Math.abs(moving.linvel.x - 2) < 1e-9,
			'0.9 a ball coming AT the hand leaves at hand speed (infinite-mass hand: -1 + 3 = ' + moving.linvel.x + ')'
		);
		const capped = m.knockResponse({ ...base, probeVel: v3(15, 0, 0), approach: 15 });
		h.check(Math.abs(capped.linvel.length() - 12) < 1e-9, '0.10 maxSpeed 12 caps a 15 m/s knock at 12');
		const ceiling = m.knockResponse({ ...base, probeVel: v3(30, 0, 0), approach: 30, maxSpeed: 999 });
		h.check(Math.abs(ceiling.linvel.length() - 20) < 1e-9, '0.11 ...and the throw ceiling (20) binds ABOVE any maxSpeed');
		const notBinding = m.knockResponse({ ...base, probeVel: v3(15, 0, 0), approach: 15, maxSpeed: 30 });
		h.check(Math.abs(notBinding.linvel.x - 15) < 1e-9, '0.12 a maxSpeed above the knock leaves it alone (15)');

		// spin: a probe brushing UP the left side of the ball (n = +x, tangential +y)
		// drags the surface point at -x upward, which is a turn about -z
		const brushed = m.knockResponse({ ...base, probeVel: v3(0, 1, 0), approach: 0, spin: 0.5 });
		h.check(
			brushed.angvel.z < 0 && Math.abs(brushed.angvel.z + 0.5 / 0.3) < 1e-9,
			'0.13 a tangential brush curls the ball about -z at spin/r (' + brushed.angvel.z.toFixed(3) + ' rad/s)'
		);
		const central = m.knockResponse({ ...base, probeVel: v3(2, 0, 0), approach: 2, spin: 0.5 });
		h.check(central.angvel.length() < 1e-9, '0.14 a dead-centre hit spins nothing');

		// cooldown: one knock per pass, hysteresis on the way back in
		const probe = m.createProbe('t', 0.12);
		h.check(m.cooldownStep(probe, 'b', true, 0) === true, '0.15 a fresh pair may fire');
		m.markSpent(probe, 'b');
		h.check(m.cooldownStep(probe, 'b', true, 16) === false, '0.16 ...and not again while still inside');
		m.cooldownStep(probe, 'b', false, 100); // left
		h.check(m.cooldownStep(probe, 'b', true, 130) === false, '0.17 back in after 30 ms out: a flicker, still spent');
		m.cooldownStep(probe, 'b', false, 140); // left again
		h.check(m.cooldownStep(probe, 'b', true, 140 + m.REARM_MS + 10) === true, '0.18 back in after the hysteresis: re-armed');

		// the ring: capped by count and window, velocity read over it
		const ring = m.createProbe('r', 0.12);
		for (let i = 0; i < 10; i++) m.pushSample(ring, v3(i * 0.032, 0, 0), null, 1000 + i * 16);
		h.check(ring.samples.length <= m.PROBE_SAMPLES, '0.19 the ring holds at most ' + m.PROBE_SAMPLES + ' samples (' + ring.samples.length + ')');
		h.check(Math.abs(m.probeVelocity(ring).x - 2) < 1e-6, '0.20 ...and reads 2 m/s off them (quat-less samples are fine)');
		const sparse = m.createProbe('s', 0.12);
		for (let i = 0; i < 5; i++) m.pushSample(sparse, v3(i * 0.12, 0, 0), null, 1000 + i * 60);
		h.check(sparse.samples.length === 2 && Math.abs(m.probeVelocity(sparse).x - 2) < 1e-6, '0.21 a slow page trims to the window but keeps two samples: still 2 m/s');

		const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8));
		const sb = m.localBoundsOf(sphere);
		h.check(Math.abs(sb.radius - 0.3) < 1e-6, '0.22 a sphere mesh bounds to its radius (' + sb.radius.toFixed(3) + ')');
		const group = new THREE.Group();
		const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		b.position.set(2, 0, 0);
		group.add(a, b);
		const gb = m.localBoundsOf(group);
		h.check(gb.radius > 1.4 && Math.abs(gb.center.x - 1) < 1e-6, '0.23 a group bounds to the union of its meshes (centre x ' + gb.center.x.toFixed(2) + ', r ' + gb.radius.toFixed(2) + ')');
		sphere.scale.set(2, 1, 1);
		h.check(m.radiusScaleOf(sphere) === 2, '0.24 the radius scale is the largest scale component');
	}

	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');

	const ball = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Sphere 0.3');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const sphere = group.children[group.children.length - 1];
		sphere.name = 'Ball';
		sphere.position.set(0, 1, 0);
		sphere.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		window.__stores.objectActions.deselectObject();
		return sphere.uuid;
	});

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the initiator knocks its own body ===');

	// zero-g so the ball stays where it is parked, and NO damping in this section: every
	// speed below is read the instant the knock wrote it, and a knocked ball is simply
	// parked again (applyThrow reseats and zeroes it) before the next sweep
	await sp(
		A.page,
		'sp.setScenePhysics({ gravity: 0, damping: { linear: 0 }, knock: { enabled: true } })'
	);
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => bodyOf(A.page, ball),
		(b) => !!b && b.mode === 'dynamic',
		'1.1 (premise) the ball is a dynamic body on the simulating peer'
	);
	await A.page.waitForTimeout(300);
	await park(A.page, ball);
	const parked = await bodyOf(A.page, ball);
	h.check(speedOf(parked) < 0.01, '1.2 (premise) parked at rest in zero-g (|v| = ' + speedOf(parked).toFixed(3) + ')');

	const two = await sweep(A.page, 'p', { uuid: ball, from: -1.2, to: 0, speed: 2 });
	h.check(two.armed, '1.3 (premise) the probe was armed (play + enabled + a sim)');
	h.check(two.hits === 1, '1.4 a 2 m/s sweep through the ball knocks it ONCE (' + two.hits + ' hits over ' + two.overlaps + ' overlapping feeds)');
	h.check(
		!!two.atHit && Math.abs(two.atHit[0] - 2) < 0.2 && Math.abs(two.atHit[1]) < 0.05 && Math.abs(two.atHit[2]) < 0.05,
		'1.5 ...and the ball leaves at ~2 m/s along the hand\'s direction (' + fmt(two.atHit) + ')'
	);

	await park(A.page, ball);
	const six = await sweep(A.page, 'p', { uuid: ball, from: -1.2, to: 0, speed: 6 });
	h.check(six.hits === 1 && !!six.atHit && Math.abs(six.atHit[0] - 6) < 0.6, '1.6 a 6 m/s sweep leaves it at ~6 m/s (' + fmt(six.atHit) + '): monotonic in probe speed');

	await park(A.page, ball);
	await sp(A.page, 'sp.setScenePhysics({ knock: { gain: 2 } })');
	const gained = await sweep(A.page, 'p', { uuid: ball, from: -1.2, to: 0, speed: 2 });
	h.check(!!gained.atHit && Math.abs(gained.atHit[0] - 4) < 0.4, '1.7 gain 2 doubles it (2 m/s -> ' + fmt(gained.atHit) + ')');
	await sp(A.page, 'sp.setScenePhysics({ knock: { gain: 1 } })');

	await park(A.page, ball);
	await sp(A.page, 'sp.setScenePhysics({ knock: { maxSpeed: 3 } })');
	const capped = await sweep(A.page, 'p', { uuid: ball, from: -1.2, to: 0, speed: 6 });
	h.check(mag(capped.atHit) <= 3.001 && mag(capped.atHit) > 2.9, '1.8 maxSpeed 3 caps a 6 m/s knock at 3 (' + mag(capped.atHit).toFixed(3) + ')');
	await sp(A.page, 'sp.setScenePhysics({ knock: { maxSpeed: 12 } })');

	await park(A.page, ball);
	const receding = await sweep(A.page, 'p', { from: 0.1, to: 1.2, speed: 2 });
	const afterReceding = await bodyOf(A.page, ball);
	h.check(receding.overlaps > 0, '1.9 (premise) a probe starting inside and moving away DID overlap');
	h.check(receding.hits === 0 && speedOf(afterReceding) < 0.01, '1.10 ...and a receding probe does nothing');

	const resting = await A.page.evaluate((uuid) => {
		const k = window.__stores.knock;
		k.dropProbe('p');
		let hits = 0;
		let overlaps = 0;
		for (let i = 0; i < 12; i++) {
			const r = k.feedProbe('p', [0.2, 1, 0], 1000 + i * 16);
			hits += r.hits;
			overlaps += r.overlaps;
		}
		return { hits, overlaps };
	}, ball);
	const afterResting = await bodyOf(A.page, ball);
	h.check(resting.overlaps > 0 && resting.hits === 0 && speedOf(afterResting) < 0.01, '1.11 a hand RESTING inside the ball does nothing (' + resting.overlaps + ' overlaps, ' + resting.hits + ' hits)');
	const slow = await sweep(A.page, 'p', { from: -0.6, to: -0.2, speed: 0.2 });
	h.check(slow.overlaps > 0 && slow.hits === 0, '1.11b a hand slower than minSpeed (0.2 < 0.3 m/s) does nothing either');

	// ONE per pass: in, dither inside, out for longer than the hysteresis, back in.
	// The second pass is FASTER on purpose: after the first knock the ball is already
	// moving away at 2 m/s, and a hand at 2 m/s cannot catch it (approach 0 — the
	// first version swept at the same speed and read the correct "no hit"). At 4 m/s
	// the approach is 2, and the knock ADDS it: the ball leaves at 4.
	await park(A.page, ball);
	const passes = await A.page.evaluate((uuid) => {
		const k = window.__stores.knock;
		const p = window.__stores.physics;
		k.dropProbe('q');
		let t = 1000;
		let hits = 0;
		const feed = (x) => {
			hits += k.feedProbe('q', [x, 1, 0], t).hits;
			t += 16;
		};
		for (let x = -1.2; x <= -0.2; x += 0.032) feed(x);
		const first = hits;
		for (let i = 0; i < 20; i++) feed(i % 2 ? -0.3 : -0.2); // dithering INSIDE
		const dithered = hits;
		for (let i = 0; i < 8; i++) feed(-1.0); // out for 128 ms (> REARM_MS)
		for (let x = -1.0; x <= -0.2; x += 0.064) feed(x); // 4 m/s
		const b = p.physicsDebug().find((entry) => entry.uuid === uuid);
		return { first, dithered, again: hits, speed: b ? Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z) : NaN };
	}, ball);
	h.check(passes.first === 1, '1.12 the first pass knocks once');
	h.check(passes.dithered === 1, '1.13 dithering inside the ball adds nothing (' + passes.dithered + ')');
	h.check(passes.again === 2, '1.14 leaving for longer than the hysteresis and coming back FASTER knocks again (' + passes.again + ')');
	h.check(Math.abs(passes.speed - 4) < 0.4, '1.14b ...and the second knock adds its approach on top of the ball\'s own speed (2 + 2 = ' + passes.speed.toFixed(3) + ')');

	await park(A.page, ball);
	await phys(A.page, 'p.holdBody("' + ball + '")');
	const held = await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 2 });
	const afterHeld = await bodyOf(A.page, ball);
	h.check(held.hits === 0 && afterHeld.hold === 'user', '1.15 a body somebody is carrying is never knocked (hold ' + afterHeld.hold + ', ' + held.hits + ' hits)');
	await phys(A.page, 'p.releaseBody("' + ball + '", { linvel: [0,0,0], angvel: [0,0,0] })');

	await park(A.page, ball);
	await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 2 });
	const logged = await knock(A.page, 'return { last: k.lastHitOf("' + ball + '"), snap: k.hitLogSnapshot() }');
	h.check(logged.last && logged.last.by === A.id, '1.16 the log names the hitter (' + (logged.last?.by ?? 'nobody') + ')');
	h.check(logged.last && Math.abs(logged.last.speed - 2) < 0.2 && logged.last.probe === 'p', '1.17 ...with the approach speed and the probe (' + logged.last?.speed.toFixed(2) + ' m/s, ' + logged.last?.probe + ')');
	h.check(logged.snap.recent.length >= 5 && logged.snap.last[ball], '1.18 the snapshot carries the recent ring and the per-body last hit (' + logged.snap.recent.length + ')');

	// THE COUNTERFACTUAL: the block off leaves the scene byte-identical to today
	await park(A.page, ball);
	const sentBefore = await knock(A.page, 'return k.knockDebug().sent');
	await sp(A.page, 'sp.setScenePhysics({ knock: { enabled: false } })');
	const off = await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 6 });
	const afterOff = await bodyOf(A.page, ball);
	const sentAfter = await knock(A.page, 'return k.knockDebug().sent');
	h.check(off.armed === false && off.hits === 0, '1.19 knock.enabled:false — nothing is armed, nothing hits');
	h.check(speedOf(afterOff) < 0.01 && sentAfter === sentBefore, '1.20 ...the body is untouched and nothing goes on the wire (sent ' + sentBefore + ' -> ' + sentAfter + ')');
	await sp(A.page, 'sp.setScenePhysics({ knock: { enabled: true } })');

	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	const editor = await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 6 });
	h.check(editor.armed === false && editor.hits === 0, '1.21 out of play mode the probes stand down');
	await A.page.evaluate(() => window.__stores.isLocked.set(true));

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	const stopped = await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 6 });
	h.check(stopped.armed === false && stopped.hits === 0, '1.22 with no simulation anywhere the probes stand down');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. a non-initiator knocks: the hit crosses the wire ===');

	const B = await h.setupPage(browser, 'B');
	// the Connect pill lives in the editor chrome, which play mode hides — leave play
	// to dial, and come back once the mesh has settled
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await h.connect(A, B);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	// damping in THIS section, so a knocked ball comes to rest for the convergence
	// reads; the applied speed is read through a hit LISTENER on A at the instant the
	// message lands, before damping has had a step
	await sp(A.page, 'sp.setScenePhysics({ damping: { linear: 1 } })');
	await A.page.evaluate((uuid) => {
		window.__applied = null;
		window.__stores.knock.registerHitListener((hit, local) => {
			if (local || hit.uuid !== uuid) return;
			const b = window.__stores.physics.physicsDebug().find((entry) => entry.uuid === uuid);
			window.__applied = b?.linvel ? [b.linvel.x, b.linvel.y, b.linvel.z] : null;
		});
	}, ball);
	await B.page.evaluate(() => {
		window.__stores.isLocked.set(true);
		window.__sent = [];
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send.bind(peer);
		peer.send = (message) => {
			window.__sent.push(message);
			return original(message);
		};
	});
	// the sim starts AFTER B joined (the throw-peer order): `simulate` is sent at
	// start/stop and not in the handshake, so a LATE JOINER is never told a sim is
	// running and its probes never arm — a pre-existing gap (moveSmoothing's header
	// records it for the same reason), noted in STATUS-24a as a follow-up
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => bodyOf(A.page, ball), (b) => !!b, '2.0 (premise) A is simulating again');
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => window.__stores.physics.remoteSimulating.subscribe(r)())),
		(v) => !!v,
		'2.1 (premise) B knows A is simulating'
	);
	await h.eventually(() => sp(B.page, 'return sp.scenePhysicsDebug().knock.enabled'), (v) => v === true, '2.2 (premise) the knock block reached B over scenephysics');
	await park(A.page, ball);
	await h.eventually(
		() => posOf(B.page, ball),
		(p) => !!p && Math.hypot(p[0], p[1] - 1, p[2]) < 0.05,
		'2.3 (premise) B sees the ball parked at (0,1,0)'
	);

	const remote = await B.page.evaluate((uuid) => {
		const k = window.__stores.knock;
		k.dropProbe('b');
		let hits = 0;
		let t = 1000;
		for (let x = -1.2; x <= 0; x += 0.064) {
			hits += k.feedProbe('b', [x, 1, 0], t).hits;
			t += 16;
		}
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const object = group.getObjectByProperty('uuid', uuid);
		return { hits, predicting: k.knockDebug().predictions.includes(uuid), x0: object.position.x, local: k.lastHitOf(uuid) };
	}, ball);
	h.check(remote.hits === 1, '2.4 B\'s 4 m/s sweep registers one knock locally');
	const message = await B.page.evaluate(() => window.__sent.find((m) => m.type === 'hit') ?? null);
	h.check(!!message && message.uuid === ball, '2.5 ...and a `hit` message left B');
	h.check(
		!!message && Math.abs(message.linvel[0] - 4) < 0.4 && Math.abs(message.linvel[1]) < 0.05,
		'2.6 carrying the RESULT velocity (~4 m/s along x: ' + (message?.linvel ?? []).map((v) => v.toFixed(2)).join(', ') + ')'
	);
	h.check(!!message && !('by' in message), '2.7 the message carries no `by` — the receiver stamps the connection');
	h.check(remote.predicting, '2.8 B started a local PREDICTION for the ball the instant it sent');

	await h.eventually(
		() => A.page.evaluate(() => window.__applied),
		(v) => Array.isArray(v),
		'2.9a the hit reached A'
	);
	const applied = await A.page.evaluate(() => window.__applied);
	const appliedBody = await bodyOf(A.page, ball);
	h.check(
		appliedBody?.hold === null && !!applied && Math.abs(applied[0] - 4) < 0.4 && Math.abs(applied[1]) < 0.05,
		'2.9 A applied it to the body the instant it landed (' + fmt(applied) + ' m/s)'
	);
	const logs = await Promise.all([
		knock(A.page, 'return k.lastHitOf("' + ball + '")'),
		knock(B.page, 'return k.lastHitOf("' + ball + '")')
	]);
	h.check(logs[0]?.by === B.id && logs[1]?.by === B.id, '2.10 both logs name B as the hitter (A says ' + logs[0]?.by + ')');
	h.check(logs[0] && logs[1] && logs[0].at === logs[1].at && Math.abs(logs[0].speed - logs[1].speed) < 1e-6, '2.11 ...with the SAME stamp and speed on both peers (A2 keys onhit by that stamp)');

	const advanced = await B.page.evaluate(
		([uuid, x0]) =>
			new Promise((resolve) =>
				setTimeout(() => {
					let group = null;
					window.__stores.objectsGroup.subscribe((v) => (group = v))();
					const object = group.getObjectByProperty('uuid', uuid);
					resolve(object.position.x - x0);
				}, 60)
			),
		[ball, remote.x0]
	);
	h.check(advanced > 0.04, '2.12 within 60 ms B\'s rendered ball has moved along the hit (' + advanced.toFixed(3) + ' m) — prediction, or authority already landing on it');
	await h.eventually(
		async () => {
			const a = await posOf(A.page, ball);
			const b = await posOf(B.page, ball);
			return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		},
		(gap) => gap < 0.3,
		'2.13 the two peers converge on where the ball came to rest, over the ordinary move stream',
		12000
	);
	const stillPredicting = await knock(B.page, 'return k.knockDebug().predictions');
	h.check(stillPredicting.length === 0, '2.14 the prediction ended when authority\'s moves arrived');

	// prediction OFF: still applied, nothing moved locally ahead of authority
	await sp(A.page, 'sp.setScenePhysics({ knock: { predict: false } })');
	await h.eventually(() => sp(B.page, 'return sp.scenePhysicsDebug().knock.predict'), (v) => v === false, '2.15 (premise) predict:false reached B');
	await park(A.page, ball);
	await A.page.evaluate(() => (window.__applied = null));
	await B.page.waitForTimeout(600);
	const noPredict = await B.page.evaluate((uuid) => {
		const k = window.__stores.knock;
		k.dropProbe('b');
		let hits = 0;
		let t = 5000;
		for (let x = -1.2; x <= 0; x += 0.064) {
			hits += k.feedProbe('b', [x, 1, 0], t).hits;
			t += 16;
		}
		return { hits, predicting: k.knockDebug().predictions.includes(uuid) };
	}, ball);
	h.check(noPredict.hits === 1 && !noPredict.predicting, '2.16 with predict:false B sends but predicts nothing');
	await h.eventually(
		() => A.page.evaluate(() => window.__applied),
		(v) => Array.isArray(v),
		'2.17a the hit reached A'
	);
	const appliedNoPredict = await A.page.evaluate(() => window.__applied);
	h.check(!!appliedNoPredict && Math.abs(appliedNoPredict[0] - 4) < 0.4, '2.17 ...and A still applies it (' + fmt(appliedNoPredict) + ' m/s)');
	await h.eventually(
		async () => {
			const a = await posOf(A.page, ball);
			const b = await posOf(B.page, ball);
			return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		},
		(gap) => gap < 0.3,
		'2.18 prediction OFF still converges (one move interval of latency instead)',
		12000
	);
	await sp(A.page, 'sp.setScenePhysics({ knock: { predict: true } })');
	await h.eventually(() => sp(B.page, 'return sp.scenePhysicsDebug().knock.predict'), (v) => v === true, '2.19 (premise) predict:true is back on B');

	// the capability gate: `hit` is CONTENT, so a plugin may refuse it — nothing applies,
	// nothing is logged on A, and B's prediction is WITHDRAWN rather than stranded
	await park(A.page, ball);
	await B.page.waitForTimeout(600);
	const logBefore = await knock(A.page, 'return k.lastHitOf("' + ball + '")?.at ?? 0');
	await A.page.evaluate(() => window.__stores.cloudHooks.setCapabilityProvider((peerId, type) => type !== 'hit'));
	const gated = await B.page.evaluate((uuid) => {
		const k = window.__stores.knock;
		k.dropProbe('b');
		let hits = 0;
		let t = 9000;
		for (let x = -1.2; x <= 0; x += 0.064) {
			hits += k.feedProbe('b', [x, 1, 0], t).hits;
			t += 16;
		}
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return { hits, predicting: k.knockDebug().predictions.includes(uuid), x0: group.getObjectByProperty('uuid', uuid).position.x };
	}, ball);
	h.check(gated.hits === 1 && gated.predicting, '2.20 (premise) B knocked and is predicting');
	await A.page.waitForTimeout(250);
	const refused = await bodyOf(A.page, ball);
	const logAfter = await knock(A.page, 'return k.lastHitOf("' + ball + '")?.at ?? 0');
	h.check(speedOf(refused) < 0.01, '2.21 a `hit` the capability gate refuses is applied nowhere (|v| ' + speedOf(refused).toFixed(3) + ')');
	h.check(logAfter === logBefore, '2.22 ...and never reaches A\'s log');
	await h.eventually(
		() => B.page.evaluate((uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const k = window.__stores.knock;
			return { x: group.getObjectByProperty('uuid', uuid).position.x, predicting: k.knockDebug().predictions.includes(uuid) };
		}, ball),
		(v) => !v.predicting && Math.abs(v.x) < 0.05,
		'2.23 B\'s unconfirmed prediction is WITHDRAWN: the ball is back where it started (the PREDICT_MAX_MS revert)',
		4000
	);
	await A.page.evaluate(() => window.__stores.cloudHooks.setCapabilityProvider(null));

	// the initiator's own knock reaches the other peer's log
	await park(A.page, ball);
	await B.page.waitForTimeout(600);
	await sweep(A.page, 'p', { from: -1.2, to: 0, speed: 2 });
	await h.eventually(
		() => knock(B.page, 'return k.lastHitOf("' + ball + '")?.by ?? null'),
		(by) => by === A.id,
		'2.24 A\'s own knock is broadcast too, so B\'s log names A'
	);

	// the block off on the AUTHOR replicates, and B then sends nothing
	await sp(A.page, 'sp.setScenePhysics({ knock: { enabled: false } })');
	await h.eventually(() => sp(B.page, 'return sp.scenePhysicsDebug().knock.enabled'), (v) => v === false, '2.25 (premise) enabled:false reached B');
	const sentBeforeOff = await B.page.evaluate(() => window.__sent.filter((m) => m.type === 'hit').length);
	const offOnB = await sweep(B.page, 'b', { from: -1.2, to: 0, speed: 6 });
	const sentAfterOff = await B.page.evaluate(() => window.__sent.filter((m) => m.type === 'hit').length);
	h.check(offOnB.armed === false && offOnB.hits === 0 && sentAfterOff === sentBeforeOff, '2.26 with the block off B knocks nothing and sends nothing (' + sentBeforeOff + ' -> ' + sentAfterOff + ' hit messages)');

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
