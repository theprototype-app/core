// 36-fb F24 + F25 + S3 + S8: flow paths, the Rotate / Motor and Float Along Flow nodes, and the
// scene-wide fluid budget, in the real app with two peers. A recycling river keeps its water
// (a closed loop never runs dry) — counterfactual in-suite: the same river without the loop
// runs dry; a motor turns a paddle that the fluid sees MOVING; a leaf rides the river on both
// peers; node edits undo/redo and replicate; the budget caps every emitter and replicates.
// Screenshots to FLUID_SHOTS when set.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.FLUID_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	await page.screenshot({ path: path.join(SHOTS, name) });
}
/** @param {any} page */
const em = (page) => page.evaluate(() => window.__stores.sim.fluidEmitterDebug()[0] ?? null);
/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			if (orbit?.target) {
				orbit.target.set(t[0], t[1], t[2]);
				orbit.update?.();
			}
			cam.lookAt(t[0], t[1], t[2]);
			cam.updateMatrixWorld(true);
		},
		[pos, target]
	);
}
/** create via the replicated /create and return the new object's uuid @param {any} page @param {string} cmd @param {number[]} at */
const make = (page, cmd, at) =>
	page.evaluate(
		([c, p]) => {
			const o = window.__stores.addObjects.spawnAtPoint(c, p);
			return o.uuid;
		},
		[cmd, at]
	);
/** an object by uuid on a page @param {any} page @param {string} uuid @param {(o: any) => any} fn */
const on = (page, uuid, fn) =>
	page.evaluate(
		([u, src]) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			return o ? new Function('o', 'return (' + src + ')(o)')(o) : null;
		},
		[uuid, fn.toString()]
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	// ---------- a Flow path: created from Add ▸ Water, shaped through its record ----------
	const labels = await A.page.evaluate(() => window.__stores.addObjects.buildAddChildren(() => [0, 0, 0]).find((g) => g.label === 'Water')?.children.map((c) => c.label));
	h.check(labels?.includes('Flow path'), `Add ▸ Water lists Flow path (${JSON.stringify(labels)})`);
	const river = await make(A.page, '/create FlowPath', [0, 0.62, 0]);
	await A.page.evaluate(
		(u) => window.__stores.sim.setFlowPathFor(u, { points: [[-1.6, 0, 0], [1.6, 0, 0]], width: 0.5, depth: 0.3, speed: 1.6, strength: 8, recycle: true }),
		river
	);
	const stamp = await on(A.page, river, (o) => ({ name: o.name, sensor: o.userData.physics?.sensor, n: o.geometry.attributes.position.count }));
	h.check(stamp.name === 'Flow path' && stamp.sensor === true, `a flow path is a physics SENSOR (bodies pass its surface) (${JSON.stringify(stamp)})`);
	// every peer rebuilds the same ribbon from the record
	const sig = (page) => on(page, river, (o) => Array.from(o.geometry.attributes.position.array).map((v) => v.toFixed(3)).join(','));
	await h.eventually(async () => [await sig(A.page), await sig(B.page)], ([a, b]) => !!a && a === b, 'peer B rebuilds the identical ribbon from the replicated record', 10000);

	// a bed under it (the chute floor the water runs on) + an emitter pouring onto its start
	const bed = await make(A.page, '/create Box 3.6 0.1 0.7', [0, 0.5, 0]);
	await on(A.page, bed, (o) => {
		delete o.userData.physics;
		return true;
	});
	const emitter = await A.page.evaluate(() => {
		const o = window.__stores.addObjects.spawnAtPoint('/create FluidEmitter', [-1.3, 1.4, 0]);
		window.__em = o;
		return o.uuid;
	});
	await A.page.evaluate(() =>
		window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { rate: 400, maxParticles: 900, lifetime: 3, area: { size: [4.4, 2.4, 1.6], offset: [1.3, -0.9, 0] } })
	);
	await look(A.page, [0, 2.4, 4.2], [0, 0.6, 0]);
	await look(B.page, [0, 2.4, 4.2], [0, 0.6, 0]);
	await h.eventually(() => em(A.page), (e) => !!e && e.count > 300 && e.flows === 1, 'the emitter fills and its solver sees the flow path', 15000);
	await A.page.waitForTimeout(2000);
	const flowing = await A.page.evaluate(() => {
		const p = window.__stores.sim.fluidEmitterParticles(window.__em.uuid);
		const onBed = p.filter((q) => Math.abs(q[2]) < 0.3 && q[1] > 0.52 && q[1] < 0.9);
		return { n: p.length, onBed: onBed.length };
	});
	h.check(flowing.onBed > 100, `water runs along the bed (${flowing.onBed}/${flowing.n} on it)`);
	await shot(A.page, '06-flow-path-river.png');

	// ---------- the closed loop: stop pouring; with a 3 s lifetime the loop keeps its water ----------
	const loopKeeps = async (recycle) => {
		await A.page.evaluate(
			([u, r]) => window.__stores.sim.setFlowPathFor(u, { recycle: r }),
			[river, recycle]
		);
		await A.page.evaluate(() => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { on: true, generation: Math.round(Math.random() * 1e6) }));
		await A.page.waitForTimeout(3000);
		await A.page.evaluate(() => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { on: false }));
		const before = (await em(A.page)).count;
		await A.page.waitForTimeout(6000);
		return { before, after: (await em(A.page)).count };
	};
	const looped = await loopKeeps(true);
	h.check(looped.before > 200 && looped.after > looped.before * 0.5, `a recycling river is a closed loop: 6 s after the pour stopped (3 s lifetime) it still holds its water (${looped.before} → ${looped.after})`);
	const open = await loopKeeps(false);
	h.check(open.after < open.before * 0.3, `counterfactual: the same river without the loop runs dry (${open.before} → ${open.after})`);
	await A.page.evaluate((u) => window.__stores.sim.setFlowPathFor(u, { recycle: true }), river);
	await A.page.evaluate(() => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { on: true, lifetime: 20 }));

	// ---------- Float Along Flow: a leaf rides the river, on both peers ----------
	const leaf = await make(A.page, '/create Box 0.2 0.04 0.14', [-1.2, 0.66, 0]);
	await on(A.page, leaf, (o) => {
		delete o.userData.physics;
		o.name = 'Leaf';
		return true;
	});
	const made = await A.page.evaluate((u) => window.__stores.aiTools.executeAiTool('create_flow_nodes', { graph: u, nodes: [{ type: 'flowfloat', data: { speed: 1, bob: 0 } }] }), leaf);
	h.check(!made?.error, `a Float Along Flow node on the leaf (${JSON.stringify(made).slice(0, 120)})`);
	await A.page.waitForTimeout(800);
	const xs = async () => [await on(A.page, leaf, (o) => o.position.x), await on(B.page, leaf, (o) => o.position.x)];
	const x0 = await xs();
	await A.page.waitForTimeout(700);
	const x1 = await xs();
	const moved = (a, b) => ((b - a + 3.2 * 3) % 3.2) > 0.3; // moved downstream (wrapping on the 3.2 m path)
	h.check(moved(x0[0], x1[0]) && moved(x0[1], x1[1]), `the leaf rides the river on BOTH peers (A ${x0[0].toFixed(2)}→${x1[0].toFixed(2)}, B ${x0[1].toFixed(2)}→${x1[1].toFixed(2)})`);
	const lag = Math.min(Math.abs(x1[0] - x1[1]), 3.2 - Math.abs(x1[0] - x1[1]));
	h.check(lag < 0.4, `both peers put it at the same place on the shared clock (|Δx| ${lag.toFixed(3)} m, ~1.6 m/s × read skew)`);
	const parked = await A.page.evaluate((u) => {
		const restore = window.__stores.flowRuntime.parkAnimatedAtBase();
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const x = g.getObjectByProperty('uuid', u).position.x;
		restore();
		return x;
	}, leaf);
	h.check(Math.abs(parked - -1.2) < 1e-6, `a save sees where you PUT the leaf, not where it drifted (${parked})`);

	// ---------- Rotate / Motor: a paddle turns; the fluid sees it moving; undo/redo synced (S8) ----------
	const paddle = await make(A.page, '/create Box 1.2 0.08 0.4', [0.8, 0.95, 0]);
	await on(A.page, paddle, (o) => {
		delete o.userData.physics;
		o.name = 'Paddle';
		return true;
	});
	const motor = await A.page.evaluate(
		(u) => window.__stores.aiTools.executeAiTool('create_flow_nodes', { graph: u, nodes: [{ type: 'rotor', data: { axis: 'z', rpm: 20, spinUp: 0 } }] }),
		paddle
	);
	h.check(!motor?.error, `a Rotate / Motor node on the paddle (${JSON.stringify(motor).slice(0, 120)})`);
	const nodeId = await A.page.evaluate((u) => {
		let gs;
		window.__stores.flowGraphs.subscribe((v) => (gs = v))();
		return gs[u]?.nodes.find((n) => n.type === 'rotor')?.id ?? null;
	}, paddle);
	h.check(!!nodeId, 'the rotor node is in the paddle\'s graph');
	const angle = (page) => on(page, paddle, (o) => Math.atan2(o.quaternion.z, o.quaternion.w) * 2);
	const a0 = await angle(A.page);
	await A.page.waitForTimeout(600);
	const a1 = await angle(A.page);
	h.check(Math.abs(a1 - a0) > 0.3, `the paddle turns (Δ ${(a1 - a0).toFixed(2)} rad in 0.6 s at 20 rpm)`);
	await h.eventually(() => em(A.page), (e) => e.moving > 0, 'the fluid sees a MOVING collider (the turning paddle carries water)', 6000);
	const rpmOn = (page) =>
		page.evaluate((u) => {
			let gs;
			window.__stores.flowGraphs.subscribe((v) => (gs = v))();
			return gs[u]?.nodes.find((n) => n.type === 'rotor')?.data?.rpm ?? null;
		}, paddle);
	await h.eventually(() => rpmOn(B.page), (r) => r === 20, 'peer B holds the motor node (sync)', 10000);
	await A.page.evaluate(([u, id]) => window.__stores.aiTools.executeAiTool('update_flow_nodes', { graph: u, updates: [{ id, data: { rpm: 45 } }] }), [paddle, nodeId]);
	await h.eventually(() => rpmOn(B.page), (r) => r === 45, 'a motor edit replicates (rpm 45 on B)', 8000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(async () => [await rpmOn(A.page), await rpmOn(B.page)], ([a, b]) => a === 20 && b === 20, 'undo restores rpm 20 on both peers', 8000);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(async () => [await rpmOn(A.page), await rpmOn(B.page)], ([a, b]) => a === 45 && b === 45, 'redo brings rpm 45 back on both peers', 8000);
	await A.page.waitForTimeout(600);
	await shot(A.page, '07-flow-motor-leaf.png');

	// ---------- S8: the emitter's settings undo/redo + sync ----------
	const rateOn = (page) => on(page, emitter, (o) => o.userData.fluidEmitter?.rate ?? null);
	await A.page.evaluate(() => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { rate: 123 }));
	await h.eventually(() => rateOn(B.page), (r) => r === 123, 'an emitter edit replicates', 8000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(async () => [await rateOn(A.page), await rateOn(B.page)], ([a, b]) => a === 400 && b === 400, 'emitter undo on both peers', 8000);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(async () => [await rateOn(A.page), await rateOn(B.page)], ([a, b]) => a === 123 && b === 123, 'emitter redo on both peers', 8000);

	// ---------- S3: ONE budget for the scene ----------
	await A.page.evaluate(() => window.__stores.sim.setFluidEmitterFor(window.__em.uuid, { rate: 1500, maxParticles: 2000 }));
	await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ fluidBudget: 300 }));
	await h.eventually(() => em(A.page), (e) => e.limit === 300 && e.count <= 300, 'the scene budget caps the emitter (limit 300)', 8000);
	let peak = 0;
	for (let i = 0; i < 10; i++) {
		peak = Math.max(peak, (await em(A.page)).count);
		await A.page.waitForTimeout(150);
	}
	h.check(peak <= 300, `a 1500/s emitter never exceeds the scene budget (peak ${peak})`);
	await h.eventually(() => B.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug().fluidBudget), (b) => b === 300, 'the budget is scene data: it replicates', 8000);
	await h.eventually(() => em(B.page), (e) => !!e && e.limit === 300, 'peer B runs under the same budget', 8000);
	// the governor lowers it: pin a lower quality level, the limit drops
	const governed = await A.page.evaluate(async () => {
		window.__stores.scenePhysics.setScenePhysics({ fluidBudget: 2000 });
		await new Promise((r) => setTimeout(r, 400));
		const full = window.__stores.sim.fluidEmitterDebug()[0].limit;
		window.__stores.qualityGovernor.qualityState.update((s) => ({ ...s, level: 6 }));
		await new Promise((r) => setTimeout(r, 400));
		const low = window.__stores.sim.fluidEmitterDebug()[0].limit;
		window.__stores.qualityGovernor.qualityState.update((s) => ({ ...s, level: 0 }));
		return { full, low };
	});
	h.check(governed.full === 2000 && governed.low < governed.full * 0.6, `the quality governor lowers the fluid budget as frames drop (${governed.full} → ${governed.low} at level 6)`);

	// ---------- the Flow path Inspector in dark + light ----------
	await A.page.evaluate((u) => window.__stores.objectActions.applySelectionSet([u], true), river);
	await A.page.waitForTimeout(500);
	const kind = A.page.locator('#flow-path-kind').first();
	await kind.scrollIntoViewIfNeeded().catch(() => {});
	h.check(await kind.isVisible().catch(() => false), 'the Inspector shows the Flow path section');
	for (const theme of ['dark', 'light']) {
		await A.page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
		await A.page.waitForTimeout(400);
		await shot(A.page, `08-inspector-flow-path-${theme}.png`);
	}
	await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2))})`);
	await h.finish(browser);
});
