// 34 R2 (kit-entities) — kit.spawner v2 / kit.health / kit.mover in the REAL app, two peers.
//
// The rules themselves (steering, stuck recovery, the W1 wall, agreement after every flush, the
// host leaving, a joiner promoted on connect) are proven in vitest on the logic sim
// (tests/unit/sim/kitEntities.test.js, tests/unit/kitEntities.sim.test.js). This suite proves
// the WIRING the sim cannot: the `kitentity` wire through peerHandler + wireValidate + the room
// gate, the handshake, the drawn copies of a real template object on both peers, the movers
// reading a real scene wall, `api.kit.*` as a module sees it, and the generated node face.
//
// Run: APP_URL=https://theprototype.app:5296/ ~/.local/bin/e2e-slot -- node tests/e2e/kit-entities.test.cjs
const h = require('./helpers.cjs');

/** @param {any} peer @param {(...a: any[]) => any} fn @param {any} [arg] */
const ev = (peer, fn, arg) => peer.page.evaluate(fn, arg);
/** poll until `fn` answers true (or time runs out) @param {() => Promise<boolean>} fn @param {number} ms */
async function waitFor(fn, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}
const dbg = (peer) => ev(peer, () => window.__stores.kitEntities.kitEntitiesDebug());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.kitEntities && !!window.__stores?.kit, {
			timeout: 30000
		});
	await h.connect(A, B);

	// ---- who writes: both peers agree on ONE authority ---------------------------------------
	const auth = await Promise.all(
		[A, B].map((p) => ev(p, () => window.__stores.kit.kitAuthorityId()))
	);
	h.check(
		!!auth[0] && auth[0] === auth[1],
		`both peers name the same authority (${auth.join(' / ')})`
	);
	const W = auth[0] === A.id ? A : B; // the writer
	const R = W === A ? B : A; // the reader
	console.log('authority', W === A ? 'A' : 'B');

	// ---- the scene: a template robot and a wall between the portal and the player -----------
	const made = await ev(A, () => {
		const cmd = window.__stores.commandsHandler;
		cmd.sceneCommand('/create box');
		cmd.sceneCommand('/create box');
		return true;
	});
	await A.page.waitForTimeout(1500); // /create re-seats after the call returns
	const ids = await ev(A, () => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const kids = g.children.slice(-2);
		const [tpl, wall] = kids;
		tpl.name = 'Robot template';
		wall.name = 'Wall';
		const peer = window.__stores.peers
			? (() => {
					let p;
					window.__stores.peers.subscribe((v) => (p = v))();
					return p;
				})()
			: null;
		const move = (o, pos, scale) => {
			o.position.fromArray(pos);
			o.scale.fromArray(scale);
			o.updateMatrix();
			peer?.send({ type: 'move', uuid: o.uuid, pos, rot: [0, 0, 0], scale });
		};
		move(tpl, [0, -20, 0], [0.6, 1.6, 0.6]); // parked under the floor: only its copies show
		move(wall, [-3, 0.8, 0], [12, 1.6, 0.4]); // x -9..3: the way round is at the +x end
		return { tpl: tpl.uuid, wall: wall.uuid };
	});
	h.check(made && !!ids.tpl && !!ids.wall, 'a template and a wall exist');
	await A.page.waitForTimeout(1500);
	// a /create box is dynamic: make the wall solid scenery on BOTH peers (the authority reads it)
	for (const p of [A, B])
		await ev(
			p,
			(u) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const w = g.getObjectByProperty('uuid', u);
				if (w) w.userData.physics = { mode: 'static' };
				window.__stores.objectsGroup.update((v) => v);
			},
			ids.wall
		);
	const wallOnB = await ev(
		B,
		(u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const w = g.getObjectByProperty('uuid', u);
			return w ? w.scale.x : null;
		},
		ids.wall
	);
	h.check(wallOnB === 12, `the wall reached the other peer (scale.x ${wallOnB})`);

	// ---- 1. spawn 20 on the READER: the call travels to the authority (kitreq) ---------------
	await ev(
		R,
		(tpl) =>
			window.__stores.kitEntities
				.kitEntitiesApi()
				.spawner.spawn({
					kind: 'robot',
					template: tpl,
					at: [-4, 0, -6],
					count: 20,
					spread: 3,
					hp: 30,
					removeAfter: 0.8,
					mover: { speed: 2.4, reach: 1.2 }
				}),
		ids.tpl
	);
	await waitFor(
		async () => (await dbg(W)).runtime.count === 20 && (await dbg(R)).runtime.count === 20,
		8000
	);
	const dW = await dbg(W);
	const dR = await dbg(R);
	h.check(dW.runtime.count === 20, `the authority made 20 entities (${dW.runtime.count})`);
	h.check(dR.runtime.count === 20, `the reader holds the same 20 (${dR.runtime.count})`);
	h.check(
		dW.drawnIds.length === 20 && dR.drawnIds.length === 20,
		`both peers DRAW 20 copies (${dW.drawnIds.length} / ${dR.drawnIds.length})`
	);
	h.check(
		dW.fallback === 0 && dR.fallback === 0,
		'drawn from the template, not the fallback capsule'
	);
	const sceneCheck = await ev(R, () => {
		let s;
		window.__stores.globalScene.subscribe((v) => (s = v))();
		const root = s.getObjectByName('kit-entities');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let inGroup = 0;
		g.traverse((o) => {
			if (o.userData?.kitEntity) inGroup++;
		});
		return { copies: root?.children.length ?? 0, inGroup, sceneRoot: root?.parent === s };
	});
	h.check(
		sceneCheck.sceneRoot && sceneCheck.copies === 20,
		`the copies live in ONE scene-root group (${sceneCheck.copies})`
	);
	h.check(
		sceneCheck.inGroup === 0,
		'and never inside objectsGroup (nothing replicates, nothing is saved)'
	);

	// ---- 2. chase the player round the wall -----------------------------------------------------
	const world = (await dbg(W)).world;
	h.check(
		world.obstacles >= 1,
		`the authority's movers see the wall as an obstacle (${world.obstacles})`
	);
	// the player: park the WRITER's camera beyond the wall (the nearest player for everyone)
	await ev(W, () => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		c.position.set(-4, 1.6, 8);
	});
	await ev(W, () => window.__stores.kitEntities.kitEntitiesApi().mover.chase('robot', 'player'));
	const t0 = Date.now();
	let past = 0;
	await waitFor(async () => {
		const d = await dbg(R);
		past = d.entities.filter((e) => e.pos[2] > 0.6).length;
		return past === 20;
	}, 40000);
	h.check(
		past === 20,
		`all 20 got round the wall to the player's side, seen on the reader (${past}/20 in ${((Date.now() - t0) / 1000).toFixed(1)} s)`
	);
	const stuck = await ev(W, () => {
		const rt = window.__stores.kitEntities.kitEntitiesDebug();
		return rt.runtime;
	});
	console.log('runtime after chase', JSON.stringify(stuck));

	// ---- 3. agreement: after a flush the reader's records equal the writer's -----------------
	await ev(W, () => window.__stores.kitEntities.kitEntitiesApi().mover.halt('robot'));
	await W.page.waitForTimeout(2500); // everyone at rest, the last flush delivered
	const [ea, eb] = await Promise.all([dbg(W), dbg(R)]);
	const key = (d) =>
		JSON.stringify(
			d.entities.map((e) => [e.id, e.hp, e.dead, e.pos.map((v) => v.toFixed(3))]).sort()
		);
	h.check(key(ea) === key(eb), 'at rest, both peers hold the SAME entities (id, hp, dead, pose)');

	// ---- 4. damage from the reader reaches the authority; both see the hp -----------------------
	const victim = ea.entities[0].id;
	await ev(R, (id) => window.__stores.kitEntities.kitEntitiesApi().health.damage(id, 12), victim);
	await waitFor(
		async () =>
			(await ev(R, (id) => window.__stores.kitEntities.kitEntitiesApi().health.hp(id), victim)) ===
			18,
		5000
	);
	const hpW = await ev(
		W,
		(id) => window.__stores.kitEntities.kitEntitiesApi().health.hp(id),
		victim
	);
	const hpR = await ev(
		R,
		(id) => window.__stores.kitEntities.kitEntitiesApi().health.hp(id),
		victim
	);
	h.check(
		hpW === 18 && hpR === 18,
		`the reader's hit landed once, on both peers (${hpW} / ${hpR})`
	);

	// ---- 5. every death heard on both peers; the wave empties and the copies go --------------
	for (const p of [A, B])
		await ev(p, () => {
			window.__kitHeard = { died: 0, emptied: 0, auth: 0 };
			const api = window.__stores.kitEntities.kitEntitiesApi();
			api.health.onDied((e) => {
				window.__kitHeard.died++;
				if (e.authority) window.__kitHeard.auth++;
			});
			api.spawner.onEmptied(() => window.__kitHeard.emptied++);
		});
	await ev(R, () =>
		window.__stores.kitEntities.kitEntitiesApi().health.damageArea([-4, 0, 6], 30, 100, 'robot')
	);
	await waitFor(
		async () => (await dbg(R)).runtime.count === 0 && (await dbg(W)).runtime.count === 0,
		8000
	);
	const heard = await Promise.all([W, R].map((p) => ev(p, () => window.__kitHeard)));
	h.check(
		heard[0].died === 20 && heard[1].died === 20,
		`20 deaths heard on both peers (${heard[0].died} / ${heard[1].died})`
	);
	h.check(
		heard[0].auth === 20 && heard[1].auth === 0,
		`the authority flag is on ONE peer (${heard[0].auth} / ${heard[1].auth})`
	);
	h.check(
		heard[0].emptied === 1 && heard[1].emptied === 1,
		`"all dead" fired once on each (${heard[0].emptied} / ${heard[1].emptied})`
	);
	const gone = await Promise.all([W, R].map((p) => dbg(p)));
	h.check(
		gone[0].drawnIds.length === 0 && gone[1].drawnIds.length === 0,
		'and every drawn copy left both scenes'
	);

	// ---- 6. the node face: the generated groups are in the palette, with cards -----------------
	const nodes = await ev(A, () => {
		const cat = window.__stores.nodeCatalog?.nodeCatalog ?? null;
		return cat
			? cat
					.filter((g) => /^Kit: (Spawner|Health|Mover)$/.test(g.group))
					.map((g) => g.group + ':' + g.items.length)
			: null;
	});
	if (nodes)
		h.check(nodes.length === 3, `three kit node groups in the palette (${nodes.join(', ')})`);
	else console.log('(nodeCatalog not on the debug hook — node face covered by the unit suite)');

	await h.finish(browser);
});
