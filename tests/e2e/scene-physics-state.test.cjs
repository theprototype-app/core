// 21-B B1 — scenePhysics v2: the widened shared physics state.
//
// The whole point of B1 is that widening the payload costs NO wire surface: the
// message `type` is unchanged, so what has to be proven is (a) the default state
// is what it always was, (b) a partial payload normalizes without dropping its
// siblings, (c) an UNKNOWN key from a newer peer survives a round trip through
// our normalizer, and (d) a default scene writes no `physics` key at all.
//
// Two checks carry their own counterfactual: the unknown-key check re-runs the
// normalizer on its own output (a normalizer that dropped the key would report
// the same thing twice and still be wrong, so the value is compared, not the
// presence), and the merge check asserts the SIBLING it did not write.

const h = require('./helpers.cjs');

const sp = (page, fn, arg) =>
	page.evaluate(
		([body, a]) => new Function('sp', 'arg', body)(window.__stores.scenePhysics, a),
		[fn, arg ?? null]
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. defaults are what they always were ===');

	const state = await sp(page, 'return sp.scenePhysicsDebug()');
	h.check(state.gravity === -9.81, '1.1 default gravity is still -9.81 (got ' + state.gravity + ')');
	h.check(state.changedAt === 0, '1.2 a fresh scene has never been stamped');
	h.check(
		state.ground.enabled === true && state.ground.height === 0,
		'1.3 ground defaults to enabled at height 0'
	);
	h.check(
		state.bounds.limit === -100 && state.bounds.action === 'respawn',
		'1.4 out-of-bounds defaults to respawn below -100'
	);
	h.check(
		state.material.friction === null && state.material.restitution === null,
		'1.5 the scene material defaults to null = "use rapier\'s own"'
	);
	h.check(
		state.play.interaction === 'grab' && state.play.grounded === false && state.play.simOnPlay === false,
		'1.6 the play block ships {grab, not grounded, no sim on play}'
	);
	const defaultsMatch = await sp(
		page,
		'const { changedAt: a, ...live } = sp.scenePhysicsDebug();' +
			'const { changedAt: b, ...def } = sp.DEFAULT_SCENE_PHYSICS;' +
			'return JSON.stringify(live) === JSON.stringify(def)'
	);
	h.check(defaultsMatch, '1.7 the live default state deep-equals DEFAULT_SCENE_PHYSICS');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the normalizer clamps, and clamps live in ONE place ===');

	const clamped = await sp(
		page,
		'return sp.normalizeScenePhysics({ gravity: -900, timeScale: 99, ground: { height: 9e9 },' +
			' bounds: { limit: 500, action: "explode" }, damping: { linear: -3, angular: 99 },' +
			' play: { interaction: "telekinesis" } })'
	);
	h.check(clamped.gravity === -20, '2.1 gravity clamps to -20 (got ' + clamped.gravity + ')');
	h.check(clamped.timeScale === 2, '2.2 timeScale clamps to 2');
	h.check(clamped.ground.height === 500, '2.3 ground height clamps to 500');
	h.check(clamped.bounds.limit === 0, '2.4 a positive bounds limit clamps to 0');
	h.check(clamped.bounds.action === 'respawn', '2.5 an unknown bounds action falls back to respawn');
	h.check(clamped.damping.linear === 0 && clamped.damping.angular === 5, '2.6 damping clamps 0..5');
	h.check(
		clamped.play.interaction === 'grab',
		'2.7 an unknown interaction falls back to grab, not through to the UI'
	);
	// the clamp must be in the NORMALIZER, so a hostile wire payload cannot dodge it
	const viaWire = await sp(
		page,
		'sp.applyRemoteScenePhysics({ gravity: -1e6, changedAt: Date.now() + 5000 });' +
			'return sp.scenePhysicsDebug().gravity'
	);
	h.check(viaWire === -20, '2.8 a hostile REMOTE gravity is clamped too (the normalizer is the boundary)');
	await sp(page, 'sp.resetSceneGravity()');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. a partial write merges instead of replacing ===');

	const merged = await sp(
		page,
		'sp.setScenePhysics({ ground: { height: 2 } });' +
			'return { g: sp.scenePhysicsDebug().ground, bounds: sp.scenePhysicsDebug().bounds }'
	);
	h.check(merged.g.height === 2, '3.1 the written field lands');
	h.check(
		merged.g.friction === 0.6 && merged.g.restitution === 0 && merged.g.enabled === true,
		'3.2 its SIBLINGS survive (friction ' + merged.g.friction + ', enabled ' + merged.g.enabled + ')'
	);
	h.check(merged.bounds.limit === -100, '3.3 an untouched block is untouched');

	const stamps = await sp(
		page,
		'const out = [];' +
			'for (let i = 0; i < 5; i++) out.push(sp.setScenePhysics({ gravity: -9 - i * 0.1 }).changedAt);' +
			'return out'
	);
	const monotonic = stamps.every((v, i) => i === 0 || v > stamps[i - 1]);
	h.check(monotonic, '3.4 five writes inside one gesture get STRICTLY increasing stamps (' + stamps.join(',') + ')');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. an unknown key from a newer peer survives our editor ===');

	const survived = await sp(
		page,
		'sp.applyRemoteScenePhysics({ gravity: -5, futureField: { magic: 42 }, ground: { height: 3, futureGround: "keep" },' +
			' changedAt: Date.now() + 10000 });' +
			'sp.setScenePhysics({ gravity: -6 });' + // an edit of OURS, after their doc
			'const s = sp.scenePhysicsState();' +
			'return { top: s.futureField, ground: s.ground.futureGround, gravity: s.gravity }'
	);
	h.check(
		survived.top && survived.top.magic === 42,
		'4.1 an unknown TOP-LEVEL key survives apply -> our edit -> scenePhysicsState()'
	);
	h.check(survived.ground === 'keep', '4.2 an unknown key INSIDE a block survives too');
	h.check(survived.gravity === -6, '4.3 and our own edit still applied');

	// counterfactual: the presence of the key is not the claim — its VALUE is,
	// and a normalizer that re-defaulted the block would report a fresh object
	const twice = await sp(
		page,
		'const once = sp.normalizeScenePhysics({ ground: { height: 4, futureGround: "keep" } });' +
			'const again = sp.normalizeScenePhysics(once);' +
			'return { h: again.ground.height, k: again.ground.futureGround }'
	);
	h.check(twice.h === 4 && twice.k === 'keep', '4.4 normalizing twice is idempotent for known AND unknown fields');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. snapshot / restore ===');

	const noKey = await sp(
		page,
		'sp.scenePhysicsRestore(sp.DEFAULT_SCENE_PHYSICS);' + 'return sp.scenePhysicsSnapshot()'
	);
	h.check(noKey === null, '5.1 a DEFAULT scene snapshots to null — no `physics` key in the file');

	const round = await sp(
		page,
		'sp.setScenePhysics({ ground: { height: 5, friction: 0.1 }, bounds: { action: "delete" }, ccd: true });' +
			'const snap = sp.scenePhysicsSnapshot();' +
			'sp.scenePhysicsRestore(sp.DEFAULT_SCENE_PHYSICS);' + // wipe
			'const wiped = sp.scenePhysicsDebug().ground.height;' +
			'const before = sp.scenePhysicsDebug().changedAt;' +
			'sp.scenePhysicsRestore({ ...snap, changedAt: 1 });' + // a STALE file stamp
			'const s = sp.scenePhysicsDebug();' +
			'return { snap, wiped, before, height: s.ground.height, action: s.bounds.action, ccd: s.ccd, stamp: s.changedAt }'
	);
	h.check(round.snap !== null, '5.2 a non-default scene snapshots to a payload');
	h.check(round.wiped === 0, '5.3 (premise) the wipe really wiped');
	h.check(
		round.height === 5 && round.action === 'delete' && round.ccd === true,
		'5.4 restore brings back every changed field'
	);
	h.check(
		round.stamp > round.before,
		'5.5 a restore stamps FRESH — an old file\'s stale changedAt cannot lose to live state'
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. two peers: B joins mid-session and inherits A\'s config ===');

	const B = await h.setupPage(browser, 'B');
	await sp(page, 'sp.setScenePhysics({ ground: { height: 7.5 }, play: { interaction: "click" } })');
	await h.connect(A, B);

	const bState = await sp(B.page, 'return sp.scenePhysicsDebug()');
	h.check(bState.ground.height === 7.5, '6.1 the late joiner inherits the ground height (' + bState.ground.height + ')');
	h.check(bState.play.interaction === 'click', '6.2 ...and the play block, over the SAME message type');

	// a live edit on A reaches B — over the SAME `scenephysics` type, which is the
	// whole reason the widened payload needed no protocol work
	await sp(page, 'sp.setScenePhysics({ bounds: { limit: -42 } })');
	await h.eventually(
		() => sp(B.page, 'return sp.scenePhysicsDebug().bounds.limit'),
		(v) => v === -42,
		'6.3 a live edit on A replicates the bounds limit to B'
	);

	await h.finish(browser);
});
