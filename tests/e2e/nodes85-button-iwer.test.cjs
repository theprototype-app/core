// 85 I2 — A BUTTON THAT FEELS PRESSABLE IN VR, on an EMULATED QUEST (IWER, iwer.cjs), with a desktop
// peer watching. The laser on the button lights it up (Highlight, unwired = "while you point at it") —
// for the person pointing only; the trigger presses it: Press Button sinks it and springs it back, the
// same press at the same shared moment on both peers (the On Click stamp replicates).
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	const page = A.page;
	const peers = [A, B];

	// the button: a flat box with Highlight (unwired) + On Click -> Press Button
	const uuid = await page.evaluate(() => {
		const S = window.__stores;
		S.commandsHandler.sceneCommand('/create box');
		let g;
		S.objectsGroup.subscribe((x) => (g = x))();
		const o = g.children[g.children.length - 1];
		o.name = 'button';
		S.objectActions.deselectObject();
		return o.uuid;
	});
	await page.waitForTimeout(1500); // '/create box' re-seats after the call
	await iwer.enter(page);
	// VR's game mode: Interact (the Play FAB enters VR in Edit; the laser's game feel — and its hover — is Interact's)
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await iwer.frames(page, 6);
	await iwer.pose(page, 'head', [0, 1.6, 0]);
	await iwer.pose(page, 'right', [0.2, 1.3, -0.3], { yaw: 0, pitch: 0 });
	await iwer.pose(page, 'left', [-0.3, 1.0, -0.2], { yaw: 1.2, pitch: -0.8 }); // the other hand points away and down
	await iwer.frames(page, 6);
	/** put the button 1.5 m down the right controller's ray, facing it, in the objects group's frame */
	const placed = await page.evaluate((u) => {
		const THREE = window.__stores.THREE;
		let r;
		let g;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let c = null;
		for (const i of [0, 1]) if (r.xr.getController(i).userData.handedness === 'right') c = r.xr.getController(i);
		c.updateMatrixWorld(true);
		const at = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
		const dir = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
		const world = at.clone().addScaledVector(dir, 1.5);
		const o = g.getObjectByProperty('uuid', u);
		o.position.copy(g.worldToLocal(world.clone()));
		o.scale.set(0.3, 0.3, 0.06);
		o.quaternion.identity();
		o.updateMatrixWorld(true);
		window.__stores.objectActions?.broadcastTransform?.(o);
		return { world: world.toArray(), local: o.position.toArray() };
	}, uuid);
	console.log('  button placed at ' + JSON.stringify(placed));
	// tell B where it is (a plain move, the way a drag lands)
	await page.evaluate(([u, p]) => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		peer?.send({ type: 'move', uuid: u, pos: p, rot: [0, 0, 0], scale: [0.3, 0.3, 0.06] });
	}, [uuid, placed.local]);
	await h.eventually(
		() => B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', u)?.position.toArray(); }, uuid),
		(p) => !!p && p.every((v, i) => Math.abs(v - placed.local[i]) < 1e-4),
		'premise: B has the button where A put it',
		15000
	);

	const glow = (p) =>
		p.page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const m = g.getObjectByProperty('uuid', u).material;
			return { hex: m.emissive.getHex(), intensity: m.emissiveIntensity };
		}, uuid);
	// the authored look, read BEFORE the graph exists: the laser already rests on the button, so it lights at once
	const unlit = await glow(A);
	// the graph goes in AFTER the placement: a driven object's pose is restored to its base every frame
	await page.evaluate((u) => {
		const S = window.__stores;
		const nodes = [
			{ id: 'hl', type: 'highlight', data: { color: '#ffd54a', strength: 0.8, fade: 0.1 } },
			{ id: 'click', type: 'onclick', data: {} },
			{ id: 'press', type: 'pressbutton', data: { axis: '+z', depth: 0.08, down: 0.1, hold: 0.4, up: 0.4 } },
			{ id: 'sel', type: 'objectselector', data: { selected: u } }
		];
		nodes.forEach((n, i) => S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: i * 220, y: 0 }, data: { type: n.type, ...n.data } }));
		for (const [source, target, targetHandle] of [['hl', 'sel', null], ['click', 'press', 'trigger'], ['press', 'sel', null]])
			S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
	}, uuid);
	await h.eventually(() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))), (hs) => hs[0] === hs[1], 'premise: B holds the graph', 30000);

	// ---- the laser lights it — for A only
	await iwer.frames(page, 12);
	const hov = await page.evaluate(() => window.__stores.hoverState.hoverDebug());
	console.log('  hover (A): ' + JSON.stringify(hov));
	console.log('  vrGameInput (A): ' + JSON.stringify(await page.evaluate(() => window.__stores.vrGameInput.vrGameInputDebug())));
	console.log('  gameFeel / clickable / along: ' + JSON.stringify(await page.evaluate((u) => {
		const S = window.__stores;
		let mode;
		S.editorMode?.subscribe((v) => (mode = v))();
		let r;
		S.globalRenderer.subscribe((v) => (r = v))();
		const out = { mode, presenting: !!r?.xr?.isPresenting, hasClick: S.flowRuntime.objectHasOnClick(u), hasHl: S.flowRuntime.objectHasHoverHighlight(u), along: [] };
		for (const i of [0, 1]) {
			const ray = S.vrGameInput.controllerRayOf(i);
			const t = ray ? S.vrGameInput.clickTargetAlong(ray) : null;
			out.along.push({ hand: r.xr.getController(i).userData.handedness, key: t?.key ?? null, top: t?.top?.uuid ?? null });
		}
		return out;
	}, uuid)));
	h.check(Object.values(hov).includes(uuid), 'I2: the right laser on the button counts as pointing at it');
	await h.eventually(() => glow(A), (gw) => gw.hex !== unlit.hex && gw.intensity === 1, 'I2: the button lights up under the laser on A', 10000);
	const onB = await glow(B);
	h.check(onB.hex === unlit.hex, `I2: B (not pointing) sees it unlit (${onB.hex.toString(16)})`);

	// ---- the trigger presses it: same press at the same shared moment on both peers
	await iwer.tap(page, 'right', 'trigger');
	const stamp = await h.eventually(
		() => Promise.all(peers.map((p) => p.page.evaluate(() => { let t; window.__stores.flowTriggers.subscribe((v) => (t = v))(); return t?.click?.lastT ?? null; }))),
		(s) => s[0] !== null && s[0] === s[1],
		'I2: the trigger fired On Click and both peers hold the stamp',
		15000
	);
	const T = (await A.page.evaluate(() => { let t; window.__stores.flowTriggers.subscribe((v) => (t = v))(); return t.click.lastT; })) + 0.3;
	const poses = await Promise.all(peers.map((p) => p.page.evaluate(([u, t]) => window.__stores.flowRuntime.effectPoseAt('press', u, t), [uuid, T])));
	console.log('  press @stamp+0.3 (A, B): ' + JSON.stringify(poses.map((x) => x?.pos.map((v) => +v.toFixed(4)))));
	h.check(!!poses[0] && !!poses[1] && poses[0].pos.every((v, i) => Math.abs(v - poses[1].pos[i]) < 1e-9), 'I2: A and B give the same pressed pose for the same shared moment');
	h.check(!!poses[0] && Math.abs(poses[0].pos[2] - placed.local[2] - 0.08) < 1e-6, 'I2: held in, it sits 8 cm along its own +z');
	await h.eventually(
		() => Promise.all(peers.map((p) => p.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', u).position.toArray(); }, uuid))),
		(ps) => ps.every((p) => p.every((v, i) => Math.abs(v - placed.local[i]) < 1e-6)),
		'I2: it springs back to rest on both peers',
		10000
	);

	// ---- the laser leaves: the glow goes out, the authored look is back exactly
	await iwer.pose(page, 'right', [0.2, 1.3, -0.3], { yaw: -1.2, pitch: -0.8 });
	await h.eventually(() => glow(A), (gw) => gw.hex === unlit.hex && gw.intensity === unlit.intensity, 'I2: pointing away puts the authored glow back', 10000);

	await iwer.exit(page);
	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
