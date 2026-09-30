// 31 (Stars Room S2 / S3 / S4) — POINT TO MOVE, MAKE A STAR WITH A CLAP, AND THE NEW STAR IS A
// REAL ONE. The user, on a Quest 3: "in menu settings allow to disable pointing at stars but
// only move them with touching by controllers or hands. allow extra option to make a star by
// moving controllers or hands close to each other (star should appear and it should be done
// with effect and sound), when star appears i should be able to push it so it will fly around
// scene as other stars when moved."
//
// Core pieces, proven on a small fixture graph (the Stars Room wires the same nodes):
// 1 Game Setting nodes register rows in the game's settings (31-game-shell's leaf) · 2 a clap
// (two hands 6 cm apart, held) spawns ONE copy AT the meeting point with a burst, a sound and a
// buzz, and the pulse goes on the wire WITH the point · 3 holding the hands together is one clap;
// a brush is none · 4 the clap setting OFF makes a clap do nothing · 5 the spawn cap recycles
// oldest-out · 6 the copy is a real body: a hand knocks it and it flies, and the TEMPLATE's On Hit
// counts the copy's hit · 7 a received trigger carries its point (not "by me") · 8 POINT GRAB
// off: the VR grip RAY and the desktop cursor carry refuse, a hand INSIDE still holds, Edit is
// untouched — and on again restores it.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	// a template (under the floor, like the Stars Room's) and a ball to point at
	const ids = await page.evaluate(async () => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const make = async (cmd, name, pos) => {
			s.commandsHandler.sceneCommand(cmd);
			await new Promise((r) => setTimeout(r, 500));
			const o = group.children[group.children.length - 1];
			o.name = name;
			o.position.set(...pos);
			o.userData.physics = { mode: 'dynamic', mass: 0.2, collider: 'sphere', restitution: 0.9 };
			o.updateMatrixWorld(true);
			return o.uuid;
		};
		const tpl = await make('/create Sphere 0.15', 'Clap template', [0, -2, 0]);
		const ball = await make('/create Sphere 0.3', 'Target', [0, 1.4, -2]);
		s.objectsGroup.update((v) => v);
		s.objectActions.deselectObject();
		return { tpl, ball };
	});
	h.check(!!ids.tpl && !!ids.ball, 'a template and a target ball (' + JSON.stringify(ids) + ')');

	await page.evaluate(async ({ tpl }) => {
		const s = window.__stores;
		const N = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data }, class: 'w-[150px]' });
		const E = (a, b, th, sh) => ({
			id: 'e-' + a + (sh ? '.' + sh : '') + '-' + b + (th ? '.' + th : ''),
			source: a, target: b, ...(sh ? { sourceHandle: sh } : {}), ...(th ? { targetHandle: th } : {})
		});
		const nodes = [
			N('cSetClap', 'gamesetting', { setting: 't31-clap', title: 'Make stars with a clap', kind: 'toggle', value: true }),
			N('cSetPoint', 'gamesetting', { setting: 't31-point', title: 'Point to move stars', kind: 'toggle', value: true }),
			N('cPoint', 'pointgrab', {}),
			N('cClap', 'onclap', { who: 'anyone', distance: 0.1, hold: 0.25, cooldown: 1, pulse: 0.3 }),
			N('cClapMe', 'onclap', { who: 'me', distance: 0.1, hold: 0.25, cooldown: 1, pulse: 0.3 }),
			N('cTpl', 'objectselector', { selected: tpl }),
			N('cSpawn', 'spawn', { x: 0, y: 3, z: 0, count: 1, maxAlive: 3, interval: 0, spread: 0 }),
			N('cFx', 'effectburst', { kind: 'sparkle', count: 40, lift: 0 }),
			N('cSnd', 'gamesound', { sound: 'sparkle' }),
			N('cBuzz', 'hapticpulse', { pattern: 'success', hand: 'both' }),
			N('cHit', 'onhit', { pulse: 0.3, minSpeed: 0, who: 'anyone' }),
			N('cCount', 'counter', { op: 'up', step: 1 })
		];
		const edges = [
			E('cSetPoint', 'cPoint', 'enabled'),
			E('cSetClap', 'cClap', 'enabled'),
			E('cSetClap', 'cClapMe', 'enabled'),
			E('cClap', 'cSpawn', 'trigger'),
			E('cClap', 'cSpawn', 'position', 'point'),
			E('cTpl', 'cSpawn', 'source'),
			E('cClap', 'cFx', 'trigger'),
			E('cClap', 'cFx', 'at', 'point'),
			E('cClap', 'cSnd', 'trigger'),
			E('cClap', 'cSnd', 'at', 'point'),
			E('cClapMe', 'cBuzz', 'trigger'),
			E('cHit', 'cTpl'),
			E('cHit', 'cCount', 'pulse')
		];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		s.gameKit.gameFeelActions.resetGameFeelActionsDebug();
		let peer;
		s.peers.subscribe((v) => (peer = v))();
		window.__sent = [];
		const send = peer.send.bind(peer);
		peer.send = (msg) => {
			window.__sent.push(JSON.parse(JSON.stringify(msg)));
			return send(msg);
		};
		await new Promise((r) => setTimeout(r, 900)); // past the nodes' first-seen (actionSeenAt)
	}, ids);

	console.log('\n=== 1. Game Setting nodes are rows in the game\'s settings ===');
	const rows = await page.evaluate(async () => {
		const m = window.__stores.gameKit.gameSettings;
		let rows;
		m.gameSettingRows.subscribe((v) => (rows = v))();
		return rows.map((r) => ({ id: r.id, label: r.label, type: r.type, def: r.default, owner: r.owner }));
	});
	const clapRow = rows.find((r) => r.id === 't31-clap');
	const pointRow = rows.find((r) => r.id === 't31-point');
	h.check(!!clapRow && clapRow.label === 'Make stars with a clap' && clapRow.type === 'toggle' && clapRow.def === true, '1.1 the clap row is declared: label, toggle, default on (' + JSON.stringify(clapRow) + ')');
	h.check(!!pointRow && pointRow.owner === 'node:cSetPoint', '1.2 the pointing row is declared, owned by its node (' + JSON.stringify(pointRow) + ')');

	// the game: a running sim, knocks on, Interact (the game-feel gate a headset puts you in)
	await page.evaluate(async () => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ gravity: 0, damping: { linear: 0 }, knock: { enabled: true } });
		await s.physics.toggleSimulation();
		s.objectActions.setEditorMode('interact');
	});
	await h.eventually(
		() => page.evaluate((u) => window.__stores.physics.physicsDebug().find((b) => b.uuid === u)?.mode ?? null, ids.ball),
		(m) => m === 'dynamic',
		'(premise) the sim runs and the ball is a dynamic body'
	);

	// a clap at P: both hands 6 cm apart for `ms`, 16 ms frames on the caller's clock
	const P = [0.4, 1.3, -1];
	const clap = (t0, ms, gap = 0.06, at = P) =>
		page.evaluate(({ t0, ms, gap, at }) => {
			const k = window.__stores.gameKit.clap;
			const L = [at[0] - gap / 2, at[1], at[2]];
			const R = [at[0] + gap / 2, at[1], at[2]];
			const out = [];
			for (let t = t0; t <= t0 + ms; t += 16) {
				const p = k.feedClap(L, R, t);
				if (p) out.push({ t, p });
			}
			return out;
		}, { t0, ms, gap, at });
	const part = (t) =>
		page.evaluate((t) => window.__stores.gameKit.clap.feedClap([-0.4, 1.3, -1], [0.4, 1.3, -1], t), t);
	const alive = () => page.evaluate(() => window.__stores.spawner.spawnedBy('cSpawn'));

	console.log('\n=== 2. a clap makes one thing at the meeting point, with a burst, a sound and a buzz ===');
	await page.evaluate(() => (window.__sent = []));
	const c1 = await clap(10000, 400);
	await page.waitForTimeout(400);
	const after1 = await page.evaluate(({ tpl }) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const copies = s.spawner.spawnedBy('cSpawn').map((u) => group.getObjectByProperty('uuid', u)).filter(Boolean);
		const dbg = s.gameKit.gameFeelActions.gameFeelActionsDebug();
		const body = copies[0] ? s.physics.physicsDebug().find((b) => b.uuid === copies[0].uuid) : null;
		return {
			n: copies.length,
			pos: copies[0]?.position.toArray(),
			from: copies[0]?.userData?.spawnedFrom === tpl,
			body: body?.mode ?? null,
			fired: dbg.fired,
			burstAt: dbg.last.find((e) => e.type === 'effectburst')?.where ?? null,
			sound: dbg.last.find((e) => e.type === 'gamesound') ?? null,
			sent: window.__sent.filter((m) => m.type === 'nodetrigger').map((m) => ({ id: m.id, at: m.at ?? null })),
			point: s.flowRuntime.triggerPointOf('cClap')
		};
	}, ids);
	const near = (a, b, tol) => !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
	h.check(c1.length === 1 && near(c1[0].p, P, 1e-6), '2.1 one clap landed, at the midpoint of the hands (' + JSON.stringify(c1) + ')');
	h.check(after1.n === 1 && near(after1.pos, P, 0.05), '2.2 ...and ONE copy of the template appeared there (' + JSON.stringify(after1.pos) + ')');
	h.check(after1.body === 'dynamic', '2.3 the copy is a live DYNAMIC body in the running sim (' + after1.body + ')');
	h.check(after1.from, '2.4 the copy remembers its template (userData.spawnedFrom)');
	h.check(near(after1.burstAt, P, 0.05), '2.5 the Effect Burst went off AT the clap point (' + JSON.stringify(after1.burstAt) + ')');
	h.check(!!after1.sound && after1.sound.sound === 'sparkle' && after1.sound.spatial, '2.6 the Game Sound played, placed at the point (' + JSON.stringify(after1.sound) + ')');
	h.check((after1.fired.hapticpulse ?? 0) === 1, '2.7 the `me` On Clap buzzed this player\'s controllers (' + JSON.stringify(after1.fired) + ')');
	const wire = after1.sent.find((m) => m.id === 'cClap');
	h.check(!!wire && near(wire.at, P, 1e-6), '2.8 the pulse went on the wire as a nodetrigger CARRYING the point (' + JSON.stringify(after1.sent) + ')');
	h.check(!after1.sent.some((m) => m.id === 'cClapMe'), '2.9 the `who: me` pulse stayed on this device');
	h.check(!!after1.point && after1.point.byMe === true, '2.10 the point is read back as "by me" (' + JSON.stringify(after1.point) + ')');

	console.log('\n=== 3. held together is one clap; a brush is none ===');
	const held = await clap(10420, 3000);
	h.check(held.length === 0, '3.1 keeping the hands together 3 more seconds claps nothing more (' + held.length + ')');
	await part(13500);
	const brush = await clap(15000, 160);
	h.check(brush.length === 0, '3.2 a 160 ms brush is not a clap');
	await part(15300);

	console.log('\n=== 4. the clap setting OFF: a clap does nothing ===');
	await page.evaluate(async () => (window.__stores.gameKit.gameSettings).setGameSetting('t31-clap', false));
	await page.waitForTimeout(200);
	const offClap = await clap(20000, 500);
	await page.waitForTimeout(300);
	h.check(offClap.length === 0 && (await alive()).length === 1, '4.1 with "Make stars with a clap" off, the hands meet and nothing appears (' + offClap.length + ' claps, ' + (await alive()).length + ' alive)');
	await page.evaluate(async () => (window.__stores.gameKit.gameSettings).setGameSetting('t31-clap', true));
	await part(20600);
	const onClap = await clap(22000, 400);
	await page.waitForTimeout(300);
	h.check(onClap.length === 1 && (await alive()).length === 2, '4.2 back on, a clap makes the second one (' + (await alive()).length + ' alive)');

	console.log('\n=== 5. the cap recycles oldest-out ===');
	const firstTwo = await alive();
	for (let i = 0; i < 3; i++) {
		await part(24000 + i * 2000);
		await clap(24100 + i * 2000, 400, 0.06, [P[0] + 0.5 * (i + 1), P[1], P[2]]);
		await page.waitForTimeout(250);
	}
	const capped = await alive();
	h.check(capped.length === 3, '5.1 five claps under maxAlive 3 leave three (' + capped.length + ')');
	h.check(!capped.includes(firstTwo[0]) && !capped.includes(firstTwo[1]), '5.2 ...the two oldest went first');

	console.log('\n=== 6. the new star is a real one: a hand knocks it, it flies, the template\'s On Hit counts it ===');
	const knocked = await page.evaluate(() => {
		const s = window.__stores;
		s.isLocked.set(true); // a desktop hand knocks in Play (the knock's own play gate)
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const uuid = s.spawner.spawnedBy('cSpawn').slice(-1)[0];
		const o = group.getObjectByProperty('uuid', uuid);
		const [cx, cy, cz] = o.position.toArray();
		const before = (() => { let tr; s.flowTriggers.subscribe((v) => (tr = v))(); return tr.cCount?.count ?? 0; })();
		s.knock.dropProbe('hand');
		let t = 5e6;
		let hits = 0;
		let v = null;
		// along -Z: the copies stand in a row along x, so an x sweep would knock the others first
		for (let z = cz + 1.2; z >= cz - 1e-9; z -= 0.032) {
			const r = s.knock.feedProbe('hand', [cx, cy, z], t);
			if (r.hits && !v) {
				const b = s.physics.physicsDebug().find((e) => e.uuid === uuid);
				v = b?.linvel ? [b.linvel.x, b.linvel.y, b.linvel.z] : null;
			}
			hits += r.hits;
			t += 16;
		}
		return { uuid, hits, v, before };
	});
	h.check(knocked.hits === 1 && !!knocked.v && knocked.v[2] < -1.5, '6.1 a 2 m/s hand sweep knocks the clapped star and it leaves at hand speed (' + JSON.stringify(knocked) + ')');
	await page.waitForTimeout(600);
	const flew = await page.evaluate((u) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		let tr;
		s.flowTriggers.subscribe((v) => (tr = v))();
		return { z: group.getObjectByProperty('uuid', u)?.position.z ?? null, count: tr.cCount?.count ?? 0 };
	}, knocked.uuid);
	h.check(flew.z !== null && flew.z < P[2] - 0.5, '6.2 ...and it FLIES: 0.6 s later it has moved on (z ' + flew.z + ')');
	await page.evaluate(() => window.__stores.isLocked.set(null));
	h.check(flew.count === knocked.before + 1, '6.3 the TEMPLATE\'s On Hit heard the copy\'s hit — a clapped star counts in the game (count ' + knocked.before + ' -> ' + flew.count + ')');

	console.log('\n=== 7. a received clap carries its point ===');
	const recv = await page.evaluate(() => {
		const s = window.__stores;
		const t = (Date.now() % 86400000) / 1000;
		s.flowRuntime.applyNodeTrigger('cClap', t, false, null, [1, 2, 3]);
		return s.flowRuntime.triggerPointOf('cClap');
	});
	h.check(!!recv && recv.at.join() === '1,2,3' && recv.byMe === false, '7.1 a nodetrigger from a peer lands its point, not "by me" (' + JSON.stringify(recv) + ')');

	console.log('\n=== 8. POINT GRAB off: the ray and the cursor refuse, touch still holds ===');
	const grip = (inside) =>
		page.evaluate(({ ball, inside }) => {
			const s = window.__stores;
			const THREE = s.THREE;
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			const o = group.getObjectByProperty('uuid', ball);
			o.updateMatrixWorld(true);
			const target = o.getWorldPosition(new THREE.Vector3());
			const hand = inside ? target.clone() : new THREE.Vector3(0, 1.4, 0.5);
			const dir = target.clone().sub(hand).normalize();
			const ray = new THREE.Raycaster(inside ? hand.clone().addScaledVector(dir, -1) : hand, inside ? dir : dir);
			const pick = (mode) => s.vrControls.gripTargetOf(ray, hand, mode)?.uuid ?? null;
			return { interact: pick('interact'), edit: pick('edit') };
		}, { ball: ids.ball, inside });
	const cursor = () =>
		page.evaluate((ball) => {
			const s = window.__stores;
			const THREE = s.THREE;
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			let cam;
			s.globalCamera.subscribe((v) => (cam = v))();
			const o = group.getObjectByProperty('uuid', ball);
			const target = o.getWorldPosition(new THREE.Vector3());
			const ndc = target.clone().project(cam);
			const ray = new THREE.Raycaster();
			ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
			const ok = s.playInteract.cursorGrabStart(ray, { x: ndc.x, y: ndc.y }, cam);
			if (ok) s.playInteract.cursorGrabEnd();
			return ok;
		}, ids.ball);
	const onRay = await grip(false);
	h.check(onRay.interact === ids.ball, '8.1 (premise) with pointing ON, the Interact grip ray takes the ball (' + onRay.interact + ')');
	h.check((await cursor()) === true, '8.2 (premise) ...and the desktop cursor carries it');
	await page.evaluate(async () => (window.__stores.gameKit.gameSettings).setGameSetting('t31-point', false));
	await h.eventually(
		() => page.evaluate(() => window.__stores.gameKit.pointGrab.pointGrabAllowed()),
		(v) => v === false,
		'8.3 the setting OFF reaches the pointing switch (the Point Grab node reads it)'
	);
	const offRay = await grip(false);
	h.check(offRay.interact === null, '8.4 pointing OFF: the grip ray takes nothing (' + offRay.interact + ')');
	h.check(offRay.edit === ids.ball, '8.5 ...while Edit\'s grip is untouched (' + offRay.edit + ')');
	h.check((await cursor()) === false, '8.6 ...and the desktop cursor carry refuses');
	const inHand = await grip(true);
	h.check(inHand.interact === ids.ball, '8.7 a hand INSIDE the ball still holds it — touching is not pointing (' + inHand.interact + ')');
	await page.evaluate(async () => (window.__stores.gameKit.gameSettings).setGameSetting('t31-point', true));
	await h.eventually(
		() => page.evaluate(() => window.__stores.gameKit.pointGrab.pointGrabAllowed()),
		(v) => v === true,
		'8.8 back ON'
	);
	h.check((await grip(false)).interact === ids.ball, '8.9 ...and the ray takes the ball again');

	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
