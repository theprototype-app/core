// 86-fix B1/B2 — PHYSICS THROUGH THE CLAUDE CONNECTOR, against the fake relay (connectorFake.cjs).
//
//   B1: the connector's tool list carries set_physics / create_joints / control_simulation and the physics
//       node family while the person's own "Physics tools" checkbox stays OFF — their assistant is untouched.
//   B2: control_simulation runs IN the connector's tab (a person's full-speed page), as the host and as a
//       guest; it is never relayed (the host refuses a relay from a page that is not an agent's).
//   A (owner extra): a ball dropped 3 m falls in about real time (~0.78 s from rest) — printed as MEASURE.
//
// Timing gate: run it on a rendering slot (`e2e-slot --exclusive`); a headless page's frame rate caps sim
// speed (physics feeds at most 0.25 s of sim time per frame), so the bound scales with the measured fps.
// Run: APP_URL='https://theprototype.app:5890/' npm run e2e -- connector-physics
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

/** physics simulating/remote on a page */
const simState = (peer) =>
	peer.page.evaluate(() => {
		const s = {};
		window.__stores.physics.simulating.subscribe((v) => (s.on = v))();
		window.__stores.physics.remoteSimulating.subscribe((v) => (s.remote = v))();
		return s;
	});

/** the person's OWN assistant: its tool names and the checkbox-driven gate */
const ownAssistant = (peer) =>
	peer.page.evaluate(() => {
		const names = window.__stores.aiTools.getAiTools().map((t) => t?.function?.name ?? t?.name);
		return { physicsTools: ['set_physics', 'create_joints', 'control_simulation'].filter((n) => names.includes(n)) };
	});

/** time a dynamic ball's fall in-page, per frame, from its first motion to the ground @returns {Promise<any>} */
const timeFall = (peer, id, fromY, toY) =>
	peer.page.evaluate(
		({ id, fromY, toY }) =>
			new Promise((resolve) => {
				let g, t0 = 0, frames = 0;
				window.__stores.objectsGroup.subscribe((x) => (g = x))();
				const end = performance.now() + 60000;
				const step = (now) => {
					const y = g?.getObjectByProperty('uuid', id)?.position.y ?? 99;
					if (!t0 && y < fromY - 0.02) t0 = now;
					if (t0) frames++;
					if (t0 && y <= toY) return resolve({ ms: Math.round(now - t0), y: +y.toFixed(3), fps: +((frames * 1000) / Math.max(1, now - t0)).toFixed(1) });
					if (now > end) return resolve(null);
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			}),
		{ id, fromY, toY }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	const relayA = await fakeRelay(A.page);
	await installProvider(A.page);

	// ---- B1: the person's checkbox is OFF (no provider at all) ------------------------------------------
	const before = await ownAssistant(A);
	h.check(before.physicsTools.length === 0, `the person's assistant has no physics tools before (${before.physicsTools})`);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'A connected', 15000);
	const hello = relayA.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(['set_physics', 'create_joints', 'control_simulation'].every((n) => hello?.tools?.includes(n)), `the connector offers the physics tools (${hello?.tools?.filter((n) => /phys|joint|simul/.test(n))})`);
	const after = await ownAssistant(A);
	h.check(after.physicsTools.length === 0, `the person's own assistant still has none — their setting is untouched (${after.physicsTools})`);
	relayA.call('st', 'status', {}, 'read');
	const st = (await relayA.answer('st'))?.result;
	h.check(!!st && !(st.missingTools ?? []).some((m) => /physics/.test(m.reason)), `status() names no physics gap (${JSON.stringify(st?.missingTools ?? null).slice(0, 200)})`);
	relayA.call('dn', 'describe_node_types', { types: ['mass', 'motor'] }, 'read');
	const dn = (await relayA.answer('dn'))?.result;
	h.check(dn?.types?.length === 2 && dn.types.every((c) => !c.error && c.output !== undefined), `describe_node_types knows the physics nodes (${JSON.stringify(dn).slice(0, 160)})`);

	// ---- B1 + B2: build, make it dynamic, start the sim — all relayed; the tab steps it itself ------------
	relayA.call('mk', 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'DropBall', position: [6, 4, 0] }] });
	const ballId = (await relayA.answer('mk'))?.result?.created?.[0]?.uuid;
	h.check(!!ballId, 'a ball 3 m above the ground (radius 1, centre at 4 m)');
	relayA.call('sp', 'set_physics', { updates: [{ uuid: ballId, mode: 'dynamic', mass: 1 }] });
	const sp = await relayA.answer('sp');
	h.check(sp?.type === 'result' && !sp.result?.error, `set_physics runs through the connector (${JSON.stringify(sp).slice(0, 160)})`);
	relayA.call('fn', 'create_flow_nodes', { graph: ballId, nodes: [{ type: 'bounciness', data: { value: 0.1 } }] });
	const fn = await relayA.answer('fn');
	h.check(fn?.type === 'result' && !fn.result?.error, `a physics node lands through the connector (${JSON.stringify(fn).slice(0, 160)})`);
	const fall = timeFall(A, ballId, 4, 1.05);
	relayA.call('go', 'control_simulation', { action: 'start' });
	const go = await relayA.answer('go', 60000);
	h.check(go?.type === 'result' && go.result?.simulating === true && !go.result?.onHost, `control_simulation starts IN the tab, not relayed (${JSON.stringify(go).slice(0, 160)})`);
	const fell = await fall;
	// real time from rest is sqrt(2·3/9.81) = 0.78 s (this clock starts at the first 2 cm of motion: ~0.72 s).
	// A page drawing f fps advances at most 0.25·f s of sim per second, so a slow headless page gets a bound
	// that scales; a rendering slot (≥ 30 fps) must be real time ± frame jitter.
	console.log('MEASURE ' + JSON.stringify({ suite: 'connector-physics', fall3m: fell, realTimeMs: 782 }));
	const bound = fell ? (fell.fps >= 30 ? 1100 : Math.max(2500, (0.8 / Math.min(1, 0.25 * Math.max(0.2, fell.fps))) * 1000 * 2.5)) : 0;
	h.check(!!fell && fell.ms < bound, `the ball falls 3 m in ${fell?.ms} ms at ${fell?.fps} fps (bound ${Math.round(bound)} ms; real time ~720 ms from first motion)`);
	relayA.call('stop', 'control_simulation', { action: 'stop' });
	await relayA.answer('stop');
	await h.eventually(() => simState(A), (s) => s.on === false, 'A stopped', 10000);

	// ---- B2: a GUEST's connector simulates in its own tab (the host refuses a non-agent relay) -------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await B.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	const relayB = await fakeRelay(B.page);
	await installProvider(B.page);
	await B.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(B), (p) => p === 'connected', 'B connected', 15000);
	relayB.call('g1', 'control_simulation', { action: 'start' });
	const g1 = await relayB.answer('g1', 60000);
	h.check(g1?.type === 'result' && g1.result?.simulating === true && !g1.result?.onHost, `a guest tab's control_simulation runs in that tab (${JSON.stringify(g1).slice(0, 160)})`);
	const sims = await h.eventually(() => Promise.all([A, B].map(simState)), ([a, b]) => b.on === true && a.remote === B.id, 'B simulates, A sees it', 15000);
	h.check(sims?.[1]?.on === true && sims?.[0]?.remote === B.id, `the guest steps the world, the host sees it as remote (${JSON.stringify(sims)})`);
	relayB.call('g2', 'control_simulation', { action: 'stop' });
	await relayB.answer('g2');
	h.check((await ownAssistant(B)).physicsTools.length === 0, "B's own assistant has no physics tools either");

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
