// 85 N1 / N2 / N4 — A SWINGING DOOR, A SIGN THAT SWAYS, A STRUCK BELL, A LIFT AND A LAMP YOU SWITCH,
// BUILT FROM NODES AND IDENTICAL ON TWO PEERS (owner voice session #2: the things the voice agent
// could not build). Every pose is a pure function of replicated trigger stamps and the shared clock,
// so the proof asks BOTH peers for the pose at the SAME shared moment (flowRuntime.effectPoseAt) and
// then compares the settled poses they actually draw.
const h = require('./helpers.cjs');

const GRAPH = {
	nodes: [
		// door: On Click -> Rotate To (toggle) on its left edge
		{ id: 'clickD', type: 'onclick', data: {} },
		{ id: 'rotD', type: 'rotateto', data: { axis: 'y', angle: 90, pivot: 'left', duration: 1, easing: 'smooth', repeat: 'none' } },
		{ id: 'selD', type: 'objectselector', obj: 'door' },
		// sign: a free-running sway about its top
		{ id: 'oscS', type: 'oscillate', data: { property: 'rotation', axis: 'z', amplitude: 25, period: 2, phase: 0, damping: 0, wave: 'sine', pivot: 'top' } },
		{ id: 'selS', type: 'objectselector', obj: 'sign' },
		// bell: On Click -> Oscillate (trigger) that dies away
		{ id: 'clickB', type: 'onclick', data: {} },
		{ id: 'oscB', type: 'oscillate', data: { property: 'rotation', axis: 'z', amplitude: 30, period: 0.8, phase: 0, damping: 3, wave: 'sine', pivot: 'top' } },
		{ id: 'selB', type: 'objectselector', obj: 'bell' },
		// lift: a Toggle input held true -> Move To (open)
		{ id: 'tgl', type: 'toggle', data: { on: false } },
		{ id: 'mvL', type: 'moveto', data: { x: 0, y: 2, z: 0, space: 'offset', duration: 1.2, easing: 'back', repeat: 'none' } },
		{ id: 'selL', type: 'objectselector', obj: 'lift' },
		// lamp: On Click -> Light Switch (toggle)
		{ id: 'clickL', type: 'onclick', data: {} },
		{ id: 'sw', type: 'lightswitch', data: { on: true, fade: 0.3, glow: true } },
		{ id: 'selLamp', type: 'objectselector', obj: 'lamp' },
		// party light: a colour cycle on a long period (one colour for minutes)
		{ id: 'cyc', type: 'lightcycle', data: { mode: 'list', period: 600, colors: '#ff3b30, #ffcc00, #34c759, #0a84ff', step: true, glow: true } },
		{ id: 'selP', type: 'objectselector', obj: 'party' },
		// N5: a plant in the wind, a flag on its pole, a flowing pool
		{ id: 'wsP', type: 'windsway', data: { mode: 'plant', anchor: 'bottom', strength: 0.3, frequency: 0.8, gust: 0.6, direction: 30 } },
		{ id: 'selPlant', type: 'objectselector', obj: 'plant' },
		{ id: 'wsF', type: 'windsway', data: { mode: 'flag', anchor: 'left', strength: 0.15, frequency: 1.2, wavelength: 0.8 } },
		{ id: 'selFlag', type: 'objectselector', obj: 'flag' },
		{ id: 'wf', type: 'waterflow', data: { speed: 0.2, direction: 45, swell: 0.05, swellSize: 2, ripples: true } },
		{ id: 'selPool', type: 'objectselector', obj: 'pool' }
	],
	edges: [
		['clickD', 'rotD', 'toggle'],
		['rotD', 'selD', null],
		['oscS', 'selS', null],
		['clickB', 'oscB', 'trigger'],
		['oscB', 'selB', null],
		['tgl', 'mvL', 'open'],
		['mvL', 'selL', null],
		['clickL', 'sw', 'toggle'],
		['sw', 'selLamp', null],
		['cyc', 'selP', null],
		['wsP', 'selPlant', null],
		['wsF', 'selFlag', null],
		['wf', 'selPool', null]
	]
};

const PI2 = Math.PI / 2;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const ids = await A.page.evaluate(() => {
		const S = window.__stores;
		/** @type {Record<string, any>} */
		const made = {};
		const last = () => {
			let g;
			S.objectsGroup.subscribe((x) => (g = x))();
			return g.children[g.children.length - 1];
		};
		const box = (name) => {
			S.commandsHandler.sceneCommand('/create box');
			const o = last();
			o.name = name;
			made[name] = o.uuid;
		};
		box('door');
		box('sign');
		box('bell');
		box('lift');
		box('plant');
		box('flag');
		box('pool');
		S.commandsHandler.sceneCommand('/light point');
		const lamp = last();
		lamp.name = 'lamp';
		lamp.position.set(0, 3, 3);
		made.lamp = lamp.uuid;
		S.commandsHandler.sceneCommand('/light point');
		const party = last();
		party.name = 'party';
		party.position.set(4, 3, 3);
		made.party = party.uuid;
		S.objectActions.deselectObject();
		return made;
	});
	// '/create box' re-seats the object after the call returns (CLAUDE.md): shape and place them after
	await A.page.waitForTimeout(1500);
	await A.page.evaluate(({ nodes, edges, made }) => {
		const S = window.__stores;
		let g;
		S.objectsGroup.subscribe((x) => (g = x))();
		const put = (name, sx, sy, sz, x, y, z) => {
			const o = g.getObjectByProperty('uuid', made[name]);
			o.scale.set(sx, sy, sz);
			o.position.set(x, y, z);
			o.userData.physics = { mode: 'static' };
			o.updateMatrix();
		};
		put('door', 1, 2, 0.1, 0, 1, 0);
		put('sign', 1, 0.5, 0.05, 3, 2, 0);
		put('bell', 0.4, 0.6, 0.4, -3, 2, 0);
		put('lift', 1.5, 0.2, 1.5, 6, 0, 0);
		put('plant', 0.2, 1.6, 0.2, -6, 0.8, 0);
		put('flag', 1.5, 1, 0.02, -6, 3, 2);
		put('pool', 4, 0.1, 4, 0, -0.05, 6);
		nodes.forEach((n, i) => {
			const data = n.type === 'objectselector' ? { selected: made[n.obj] } : n.data;
			S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: (i % 5) * 220, y: Math.floor(i / 5) * 180 }, data: { type: n.type, ...data } });
		});
		for (const [source, target, targetHandle] of edges)
			S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
	}, { ...GRAPH, made: ids });
	console.log('  objects: ' + JSON.stringify(ids));
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const peers = [A, B];
	await h.eventually(() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))), (hs) => hs[0] === hs[1], 'premise: B holds the graph', 30000);
	await h.eventually(
		() => B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return u.every((id) => !!g.getObjectByProperty('uuid', id)); }, Object.values(ids)),
		(ok) => ok,
		'premise: B holds every object',
		30000
	);
	await A.page.waitForTimeout(800); // the actionSeenAt settle (a stamp minted before B's next tick is refused)

	/** the pose node `nodeId` gives `uuid` at shared time T, on page p */
	const poseAt = (p, nodeId, uuid, T) => p.page.evaluate(([n, u, t]) => window.__stores.flowRuntime.effectPoseAt(n, u, t), [nodeId, uuid, T]);
	const clock = (p) => p.page.evaluate(() => window.__stores.flowRuntime.effectClockNow());
	const stampOf = (p, nodeId) => p.page.evaluate((n) => { let t; window.__stores.flowTriggers.subscribe((v) => (t = v))(); return t?.[n]?.lastT ?? null; }, nodeId);
	const drawn = (p, uuid) =>
		p.page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', u);
			return { pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], intensity: o.intensity ?? null, color: o.color ? '#' + o.color.getHexString() : null };
		}, uuid);
	const same = (a, b, eps = 1e-6) => a && b && ['pos', 'rot'].every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) < eps));
	/** both peers answer for the same moment with the same pose */
	const samePoseAt = async (nodeId, uuid, T, label) => {
		const [a, b] = await Promise.all(peers.map((p) => poseAt(p, nodeId, uuid, T)));
		console.log(`  ${label} @T: A ${JSON.stringify(a?.rot.map((v) => +v.toFixed(4)))} B ${JSON.stringify(b?.rot.map((v) => +v.toFixed(4)))} pos A ${JSON.stringify(a?.pos.map((v) => +v.toFixed(3)))}`);
		h.check(!!a && !!b && same(a, b), `${label}: A and B give the same pose for the same shared moment`);
		return a;
	};
	const click = (p, uuid) => p.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), uuid);
	/** wait until both peers hold node's stamp and they agree */
	const sharedStamp = async (nodeId, label) => {
		const st = await h.eventually(() => Promise.all(peers.map((p) => stampOf(p, nodeId))), (s) => s[0] !== null && s[0] === s[1], `${label}: both peers hold the same trigger stamp`, 20000);
		return (await Promise.all(peers.map((p) => stampOf(p, nodeId))))[0];
	};

	// ---- N1: the sign sways the same on both peers, about its hook
	const T0 = (await clock(A)) + 0.3;
	const s1 = await samePoseAt('oscS', ids.sign, T0, 'N1 sign sway');
	const s2 = await samePoseAt('oscS', ids.sign, T0 + 0.5, 'N1 sign sway +0.5 s');
	h.check(Math.abs(s1.rot[2] - s2.rot[2]) > 0.01, 'N1: the sign is actually swaying (two moments differ)');
	h.check(Math.abs(s1.rot[2]) <= (25 * Math.PI) / 180 + 1e-6, 'N1: within the amplitude');

	// ---- N2: the door, opened on A, closed on B
	const doorBefore = await drawn(A, ids.door);
	await click(A, ids.door);
	const stD = await sharedStamp('clickD', 'N2 door open');
	const mid = await samePoseAt('rotD', ids.door, stD + 0.5, 'N2 door half-way');
	h.check(mid.rot[1] > 0.3 && mid.rot[1] < 1.3, `N2: half-way the door is part open (${mid.rot[1].toFixed(3)} rad)`);
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.door))), (d) => d.every((x) => Math.abs(x.rot[1] - PI2) < 1e-3), 'N2: both peers draw the door open (90 degrees)', 15000);
	const open = await Promise.all(peers.map((p) => drawn(p, ids.door)));
	h.check(same(open[0], open[1], 1e-5), 'N2: the open door is the same pose on A and B');
	// the hinge (the left edge, local x -0.5) stayed put: x 0 - 0.5 = -0.5 before; after the turn it is still at x -0.5, z 0
	const hingeAfter = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		o.updateMatrixWorld(true);
		const v = o.localToWorld(o.position.clone().set(-0.5, 0, 0));
		return v.toArray();
	}, ids.door);
	h.check(Math.abs(hingeAfter[0] - (doorBefore.pos[0] - 0.5)) < 1e-3 && Math.abs(hingeAfter[2] - doorBefore.pos[2]) < 1e-3, `N2: the door turned on its left edge (hinge at ${hingeAfter.map((v) => v.toFixed(3))})`);
	await A.page.waitForTimeout(300);
	await click(B, ids.door);
	await h.eventually(() => Promise.all(peers.map((p) => stampOf(p, 'clickD'))), (s) => s[0] !== stD && s[0] === s[1], 'N2 door close: the new stamp reached both', 20000);
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.door))), (d) => d.every((x) => Math.abs(x.rot[1]) < 1e-3), 'N2: a click on B shuts the door on both peers', 15000);

	// ---- N1: the struck bell swings and comes to rest exactly
	await click(A, ids.bell);
	const stB = await sharedStamp('clickB', 'N1 bell');
	const ring = await samePoseAt('oscB', ids.bell, stB + 0.2, 'N1 bell struck');
	h.check(Math.abs(ring.rot[2]) > 0.05, `N1: the bell swings when struck (${ring.rot[2].toFixed(3)} rad)`);
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.bell))), (d) => d.every((x) => x.rot[2] === 0), 'N1: the bell comes to rest on both peers', 15000);

	// ---- N2: the lift goes up while a boolean is true (Toggle input -> open), with a back ease
	const liftBase = await drawn(A, ids.lift);
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('tgl', { on: true }));
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.lift))), (d) => d.every((x) => Math.abs(x.pos[1] - (liftBase.pos[1] + 2)) < 1e-3), 'N2: the lift rises 2 m on both peers', 15000);
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('tgl', { on: false }));
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.lift))), (d) => d.every((x) => Math.abs(x.pos[1] - liftBase.pos[1]) < 1e-3), 'N2: and comes back down on both', 15000);

	// ---- N4: the lamp, switched off on A and on again on B
	const lampOn = await drawn(A, ids.lamp);
	h.check(lampOn.intensity > 0, `premise: the lamp is on (${lampOn.intensity})`);
	await click(A, ids.lamp);
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.lamp))), (d) => d.every((x) => x.intensity === 0), 'N4: a click switches the lamp off on both peers', 15000);
	// a save while it is off writes the AUTHORED intensity
	const parked = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		const un = window.__stores.flowRuntime.parkAnimatedAtBase();
		const during = o.intensity;
		un?.();
		return { during, after: o.intensity };
	}, ids.lamp);
	h.check(parked.during === lampOn.intensity && parked.after === 0, `N4: a save sees the authored intensity, the lamp stays off after (${JSON.stringify(parked)})`);
	await A.page.waitForTimeout(300);
	await click(B, ids.lamp);
	await h.eventually(() => Promise.all(peers.map((p) => drawn(p, ids.lamp))), (d) => d.every((x) => Math.abs(x.intensity - lampOn.intensity) < 1e-9), 'N4: a click on B switches it back on for both', 15000);

	// ---- N4: the colour cycle shows the same colour on both peers
	const cols = await Promise.all(peers.map((p) => drawn(p, ids.party)));
	console.log('  party light colours (A, B): ' + JSON.stringify(cols.map((c) => c.color)));
	h.check(cols[0].color === cols[1].color && ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff'].includes(cols[0].color), 'N4: the colour cycle shows the same list colour on both peers');

	// ---- N5: the plant and the flag sway, the pool flows — on both peers, look only
	const sway = (p) => p.page.evaluate(() => window.__stores.swayNodes.swayNodesDebug());
	await h.eventually(() => Promise.all(peers.map(sway)), (all) => all.every((d) => Object.values(d).filter((x) => x.kind === 'windsway').length === 2 && Object.values(d).some((x) => x.kind === 'waterflow' && x.flowing === 1)), 'N5: both peers sway the plant + flag and flow the pool', 20000);
	console.log('  sway runtime (A): ' + JSON.stringify(await sway(A)));
	const look = (p, u) =>
		p.page.evaluate((id) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', id);
			const m = o.material;
			return { key: m.customProgramCacheKey?.() ?? '', normal: !!m.normalMap, pos: o.position.toArray() };
		}, u);
	for (const p of peers) {
		const plant = await look(p, ids.plant);
		const pool = await look(p, ids.pool);
		h.check(plant.key.includes('windsway') && pool.key.includes('waterflow') && pool.normal, `N5 ${p.id}: the plant's material carries the sway deformer, the pool flows with borrowed ripples (${plant.key} / ${pool.key})`);
		h.check(Math.abs(plant.pos[1] - 0.8) < 1e-9, `N5 ${p.id}: the sway moves the look only (the plant's transform is untouched)`);
	}
	// a save while it flows writes the AUTHORED material (no borrowed ripple map)
	const parkedPool = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		const un = window.__stores.flowRuntime.parkAnimatedAtBase();
		const during = !!o.material.normalMap;
		un?.();
		return { during, after: !!o.material.normalMap };
	}, ids.pool);
	h.check(!parkedPool.during && parkedPool.after, `N5: a save sees the pool's own material, the ripples come back after (${JSON.stringify(parkedPool)})`);

	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
