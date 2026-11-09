// 78 F25 — A SLOW PHYSICS INITIATOR SLOWED THE WHOLE SESSION. Only the initiator steps the world,
// so its frame rate was everybody's clock, and the feed was capped at 0.25 s / 8 substeps a frame
// with the backlog thrown away: below ~30 fps the world ran in slow motion for every peer.
//
// Two peers. A is CPU-throttled 8x (CDP Emulation.setCPUThrottlingRate) and starts a run of six
// dynamic boxes; B is not throttled.
//   1. THE HANDOFF: within ~15 s the world moves to B (A stops stepping, B steps), the boxes carry
//      their velocity across (a sliding box keeps sliding), and B's sim time keeps pace with wall
//      time (within 5 %). Reset on B still goes back to the run's START poses (they rode along).
//   2. THE PACE: the handoff switched off on A (the debug knob), A alone steps throttled, and the
//      adaptive caps keep its sim time within 5 % of wall time.
const h = require('./helpers.cjs');

const phys = (page, body, arg) => page.evaluate(([b, a]) => new Function('p', 'arg', b)(window.__stores.physics, a), [body, arg]);
const pace = (page) => phys(page, 'return p.physicsPace ? p.physicsPace() : null');
/** sim seconds per wall second over `ms`, measured on the stepping page at its own last step */
async function ratioOver(page, ms) {
	const a = await pace(page);
	await page.waitForTimeout(ms);
	const b = await pace(page);
	if (!a || !b || !a.running || !b.running) return { ratio: null, a, b };
	const sim = b.simTime - a.simTime;
	const wall = (b.steppedWallMs - a.steppedWallMs) / 1000;
	return { ratio: wall > 0 ? sim / wall : null, sim, wall, a, b };
}
const posOf = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		return o ? o.position.toArray() : null;
	}, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 14000);
	await A.page.evaluate(() => window.__stores.physics.warmup());
	await B.page.evaluate(() => window.__stores.physics.warmup());

	// six boxes: five resting in a row, one SLIDER on a frictionless zero-g lane
	const uuids = await A.page.evaluate(() => {
		const st = window.__stores;
		st.scenePhysics.setScenePhysics({ gravity: 0, damping: { linear: 0, angular: 0 } });
		let g;
		st.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		for (let i = 0; i < 6; i++) {
			st.commandsHandler.sceneCommand('/create Box 0.5 0.5 0.5');
			const o = g.children[g.children.length - 1];
			o.position.set(i * 1.5 - 4, 2, i === 5 ? 4 : 0);
			o.userData.physics = { mode: 'dynamic', mass: 1 };
			o.name = i === 5 ? 'Slider' : 'Box' + i;
			out.push(o.uuid);
		}
		st.objectsGroup.update((v) => v);
		st.objectActions.deselectObject();
		return out;
	});
	const slider = uuids[5];
	await h.eventually(
		() => B.page.evaluate((us) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return us.filter((u) => g.getObjectByProperty('uuid', u)).length; }, uuids),
		(n) => n === 6,
		'premise: the six boxes reached B',
		30000
	);

	console.log('\n=== 1. the slow initiator hands the world to the faster peer ===');
	const cdp = await A.page.context().newCDPSession(A.page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
	const startPos = await posOf(A.page, slider);
	await phys(A.page, 'return p.toggleSimulation()');
	await h.eventually(() => pace(A.page), (p) => !!p && p.running, 'premise: A steps the world', 20000);
	// the slider moves along +x at 1 m/s from here on (no gravity, no damping, nothing in its lane)
	await phys(A.page, 'return p.applyThrow({ uuid: arg, linvel: [1, 0, 0], angvel: [0, 0, 0] })', slider);
	const fA = await pace(A.page);
	const fB = await pace(B.page);
	console.log('  frame ms: A', fA?.frameMs, 'B', fB?.frameMs);

	await h.eventually(
		async () => ({ a: await pace(A.page), b: await pace(B.page) }),
		(s) => !!s.a && !!s.b && !s.a.running && s.b.running,
		'1.1 the world moves to B within ~15 s (A stops stepping, B steps)',
		20000
	);
	const took = { a: await pace(A.page), b: await pace(B.page) };
	if (took.a && took.b) console.log('  A', JSON.stringify({ frameMs: took.a.frameMs, handoffs: took.a.handoffs }), 'B', JSON.stringify({ frameMs: took.b.frameMs, handoffs: took.b.handoffs, votes: took.b.votes.length }));
	const remoteOnA = await A.page.evaluate(() => { let r; window.__stores.physics.remoteSimulating.subscribe((v) => (r = v))(); return r; });
	h.check(remoteOnA === B.id, `1.2 A now watches B's run (remoteSimulating ${remoteOnA}, B ${B.id})`);
	const vel = await phys(B.page, 'return p.bodyVelocityOf(arg)', slider);
	h.check(!!vel && Math.abs(vel.linvel[0] - 1) < 0.05, `1.3 the slider kept its velocity across the handoff (${vel ? vel.linvel.map((n) => n.toFixed(3)).join(',') : null})`);
	const r1 = await ratioOver(B.page, 8000);
	console.log('  B over 8 s:', JSON.stringify({ sim: r1.sim, wall: r1.wall, maxSub: r1.b?.maxSub, dropped: r1.b?.dropped, frameMs: r1.b?.frameMs }));
	h.check(r1.ratio != null && r1.ratio > 0.95 && r1.ratio < 1.05, `1.4 B's sim time keeps pace with wall time (ratio ${r1.ratio?.toFixed(3)})`);
	const slid = await posOf(B.page, slider);
	h.check(!!slid && slid[0] - startPos[0] > 5, `1.5 the slider travelled on B (x ${startPos[0].toFixed(2)} -> ${slid?.[0].toFixed(2)})`);
	const undoSize = () => A.page.evaluate(() => { let s; window.__stores.history.undoStack.subscribe((v) => (s = v))(); return s.length; });
	const undoBefore = await undoSize();
	await phys(B.page, 'return p.resetSimulation()');
	await h.eventually(() => posOf(A.page, slider), (p) => !!p && Math.abs(p[0] - startPos[0]) < 0.05, '1.6 Reset on B puts the slider back at the RUN\'s start (on A too)', 10000);
	const undoAfter = await undoSize();
	h.check(undoBefore === undoAfter, `1.7 the handoff and the reset left no undo entry on A (${undoBefore} -> ${undoAfter})`);

	console.log('\n=== 2. alone and slow: the adaptive caps keep the pace ===');
	await phys(A.page, 'return p.setSimHandoffEnabled(false)');
	await phys(A.page, 'return p.toggleSimulation()');
	await h.eventually(() => pace(A.page), (p) => !!p && p.running, 'premise: A steps the world again', 20000);
	await A.page.waitForTimeout(2000); // let the substep cost settle
	const r2 = await ratioOver(A.page, 8000);
	console.log('  A over 8 s:', JSON.stringify({ sim: r2.sim, wall: r2.wall, maxSub: r2.b?.maxSub, feed: r2.b?.feed, substepMs: r2.b?.substepMs, frameMs: r2.b?.frameMs, dropped: r2.b?.dropped }));
	h.check(!!r2.b && r2.b.running, '2.1 A still steps (no handoff while switched off)');
	h.check(r2.ratio != null && r2.ratio > 0.95 && r2.ratio < 1.05, `2.2 throttled A keeps sim time within 5 % of wall time (ratio ${r2.ratio?.toFixed(3)})`);
	const bPace = await pace(B.page);
	h.check(!!bPace && !bPace.running, '2.3 B did not take the world');
	await phys(A.page, 'return p.stopSimulation()');
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

	const errors = [...A.page.__errors, ...B.page.__errors];
	h.check(errors.length === 0, `no page error (${errors.slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
