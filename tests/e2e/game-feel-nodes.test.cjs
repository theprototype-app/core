// 30b (core-games) P0 — GAME FEEL AS FLOW NODES. The three core games are FLOW graphs, and
// 30b-vr-play's game-feel kit (banner, sounds, bursts, haptics, music) was reachable from a
// MODULE only. The user on Towers: "When I reach some of the rings and go to the top, it
// should dynamically tell me and give effects such as sparkles ... there should be some
// sounds." These five nodes are how a graph does that.
//
// 1 a pulse through Announce / Game Sound / Effect Burst / Controller Buzz does its thing,
// with {v} filled, the sound and burst AT the wired object · 2 nothing of their own goes on
// the wire · 3 a node adopting an OLD stamp stays quiet (actionSeenAt) · 4 the buzz is
// silent in Edit and asks in Interact · 5 Game Music is a declaration: silent in Edit,
// plays in Interact, 'round' waits for the round, an `on` wired false stops it, leaving
// Interact stops it · 6 a replicated pulse makes the second peer announce too.
const h = require('./helpers.cjs');

const NOW = () => (Date.now() % 86400000) / 1000;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	// a box to aim the sound and the burst at, then the graph
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(600);
	const box = await page.evaluate(async () => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		let target = group.children.find((c) => c.isMesh);
		if (!target) {
			const THREE = s.THREE ?? (await import('/node_modules/.vite/deps/three.js').catch(() => null));
			return { missing: true, have: group.children.length, hasTHREE: !!THREE };
		}
		// hold it still and somewhere known (a /create box is dynamic and would fall)
		target.userData.physics = { mode: 'static' };
		target.position.set(2, 3, -4);
		target.updateMatrixWorld(true);
		return { uuid: target.uuid };
	});
	h.check(!!box.uuid, 'a box to aim at (' + JSON.stringify(box) + ')');

	const build = (extra = {}) =>
		page.evaluate(
			async ({ uuid, extra }) => {
				const s = window.__stores;
				const x = extra.suffix ?? '';
				const N = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data }, class: 'w-[150px]' });
				const nodes = [
					N('fKey', 'keypress', { code: 'KeyJ', edge: 'down', pulse: 0.3 }),
					N('fCount', 'counter', { op: 'up', step: 1 }),
					N('fSel', 'objectselector', { selected: uuid }),
					N('fAnn' + x, 'announce', { text: 'Ring {v} reached', sub: 'keep going', seconds: 2, color: '#7fd4ff' }),
					N('fSnd' + x, 'gamesound', { sound: 'ring' }),
					N('fFx' + x, 'effectburst', { kind: 'confetti', count: 30, lift: 0.5 }),
					N('fBuzz' + x, 'hapticpulse', { pattern: 'success', hand: 'both' }),
					...(extra.music ? [N('fMus', 'gamemusic', { preset: 'space', volume: 0.4, while: extra.music })] : [])
				];
				const E = (s0, t, th) => ({ id: 'e-' + s0 + '-' + t + (th ? '.' + th : ''), source: s0, target: t, ...(th ? { targetHandle: th } : {}) });
				const edges = [
					E('fKey', 'fCount', 'pulse'),
					E('fKey', 'fAnn' + x, 'trigger'),
					E('fCount', 'fAnn' + x, 'value'),
					E('fKey', 'fSnd' + x, 'trigger'),
					E('fSel', 'fSnd' + x, 'at'),
					E('fKey', 'fFx' + x, 'trigger'),
					E('fSel', 'fFx' + x, 'at'),
					E('fKey', 'fBuzz' + x, 'trigger')
				];
				s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
				s.flowNodes.set(nodes);
				s.flowEdges.set(edges);
				s.gameKit.gameFeelActions.resetGameFeelActionsDebug();
				await new Promise((r) => setTimeout(r, 800)); // past the nodes' first-seen (actionSeenAt)
				return true;
			},
			{ uuid: box.uuid, extra }
		);
	await build();
	await page.evaluate(() => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		window.__sent = [];
		const send = peer.send.bind(peer);
		peer.send = (msg) => {
			window.__sent.push(msg?.type);
			return send(msg);
		};
	});

	console.log('\n=== 1. a pulse: banner, sound, burst, buzz ===');
	const pulse = async (replicate = false) => {
		await page.evaluate(({ t, replicate }) => window.__stores.flowRuntime.applyNodeTrigger('fKey', t, replicate), { t: NOW(), replicate });
		await page.waitForTimeout(500);
	};
	await pulse();
	await pulse();
	const one = await page.evaluate(() => {
		const k = window.__stores.gameKit;
		let ann;
		k.gameAnnounce.gameAnnouncement.subscribe((v) => (ann = v))();
		const dbg = k.gameFeelActions.gameFeelActionsDebug();
		const banner = document.querySelector('#game-announce');
		return {
			ann,
			fired: dbg.fired,
			last: dbg.last,
			sfx: k.gameSfx.gameSfxDebug(),
			live: k.effectsBurst.burstDebug().live,
			bannerText: banner?.textContent ?? null
		};
	});
	h.check(one.ann?.text === 'Ring 2 reached' && one.ann?.sub === 'keep going', '1.1 Announce shows the text with {v} = the wired counter (' + JSON.stringify(one.ann) + ')');
	h.check(one.ann?.color === '#7fd4ff' && one.ann?.ms === 2000, '1.2 in its colour, for its seconds');
	h.check(/Ring 2 reached/.test(one.bannerText ?? ''), '1.3 the desktop banner draws it (' + JSON.stringify(one.bannerText) + ')');
	const snd = one.last.filter((e) => e.type === 'gamesound');
	h.check(snd.length === 2 && snd.every((e) => e.sound === 'ring' && e.spatial), '1.4 Game Sound played `ring` twice, placed at the wired box (' + JSON.stringify(snd) + ')');
	h.check(one.sfx.last === 'ring', '1.5 through the procedural set (' + JSON.stringify(one.sfx) + ')');
	const fx = one.last.filter((e) => e.type === 'effectburst');
	h.check(fx.length === 2 && fx.every((e) => e.fired && e.kind === 'confetti'), '1.6 Effect Burst fired a confetti burst per pulse');
	const where = fx[0]?.where ?? [];
	h.check(Math.abs(where[0] - 2) < 1e-3 && Math.abs(where[1] - 3.5) < 1e-3 && Math.abs(where[2] + 4) < 1e-3, '1.7 at the wired box, lifted 0.5 m (' + JSON.stringify(where) + ')');
	h.check(one.live.some((b) => b.kind === 'confetti'), '1.8 a live burst is in the pool');
	h.check((one.fired.hapticpulse ?? 0) === 2, '1.9 Controller Buzz asked twice');

	console.log('\n=== 2. nothing of their own on the wire ===');
	const sent = await page.evaluate(() => window.__sent);
	h.check(!sent.some((t) => /announce|sound|burst|haptic|music/i.test(String(t))), '2.1 no game-feel message was sent (' + JSON.stringify([...new Set(sent)]) + ')');

	console.log('\n=== 3. an OLD stamp does not announce ===');
	// the key's newest stamp is section 1's; NEW action nodes wired to it now would adopt it
	await page.waitForTimeout(600);
	await build({ suffix: 'New' });
	await page.waitForTimeout(700);
	const stale = await page.evaluate(() => window.__stores.gameKit.gameFeelActions.gameFeelActionsDebug().fired);
	h.check(!stale.announce && !stale.gamesound && !stale.effectburst && !stale.hapticpulse, '3.1 fresh nodes adopting a stamp older than them stay quiet (' + JSON.stringify(stale) + ')');
	await pulse();
	const fresh = await page.evaluate(() => window.__stores.gameKit.gameFeelActions.gameFeelActionsDebug().fired);
	h.check(fresh.announce === 1 && fresh.gamesound === 1, '3.2 and act on the next real pulse (' + JSON.stringify(fresh) + ')');

	console.log('\n=== 4. the buzz: silent in Edit, asked in Interact ===');
	const buzz = await page.evaluate(async () => {
		const s = window.__stores;
		const k = s.gameKit;
		const t = () => (Date.now() % 86400000) / 1000;
		s.objectActions.setEditorMode('edit');
		k.gameFeelActions.resetGameFeelActionsDebug();
		const sup0 = s.vrControls.hapticDebug().suppressed;
		s.flowRuntime.applyNodeTrigger('fKey', t(), false);
		await new Promise((r) => setTimeout(r, 400));
		const edit = k.gameFeelActions.gameFeelActionsDebug().last.find((e) => e.type === 'hapticpulse');
		const sup1 = s.vrControls.hapticDebug().suppressed;
		s.objectActions.setEditorMode('interact');
		s.flowRuntime.applyNodeTrigger('fKey', t(), false);
		await new Promise((r) => setTimeout(r, 400));
		const inter = k.gameFeelActions.gameFeelActionsDebug().last.filter((e) => e.type === 'hapticpulse').pop();
		s.objectActions.setEditorMode('edit');
		return { edit, inter, sup0, sup1 };
	});
	h.check(buzz.edit && buzz.edit.felt === false, '4.1 in Edit the buzz is refused by the core gate (' + JSON.stringify(buzz.edit) + ')');
	h.check(buzz.inter && buzz.inter.felt === true && buzz.inter.pattern === 'success', '4.2 in Interact the success pattern is played (' + JSON.stringify(buzz.inter) + ')');

	console.log('\n=== 5. Game Music is a declaration ===');
	await build({ music: 'always' });
	const music = await page.evaluate(async () => {
		const s = window.__stores;
		const k = s.gameKit;
		const state = () => {
			let v;
			k.gameMusic.gameMusicState.subscribe((x) => (v = x))();
			return v?.preset ?? null;
		};
		const wait = () => new Promise((r) => setTimeout(r, 400));
		s.objectActions.setEditorMode('edit');
		await wait();
		const inEdit = state();
		s.objectActions.setEditorMode('interact');
		await wait();
		const inInteract = state();
		s.objectActions.setEditorMode('edit');
		await wait();
		const backInEdit = state();
		return { inEdit, inInteract, backInEdit, dbg: k.gameFeelActions.gameFeelActionsDebug() };
	});
	h.check(music.inEdit === null, '5.1 the editor stays silent (' + music.inEdit + ')');
	h.check(music.inInteract === 'space', '5.2 Interact plays the preset (' + music.inInteract + ')');
	h.check(music.backInEdit === null, '5.3 back in Edit it stops (' + music.backInEdit + ')');
	await build({ music: 'round' });
	const round = await page.evaluate(async () => {
		const s = window.__stores;
		const k = s.gameKit;
		const state = () => {
			let v;
			k.gameMusic.gameMusicState.subscribe((x) => (v = x))();
			return v?.preset ?? null;
		};
		const wait = () => new Promise((r) => setTimeout(r, 400));
		s.gameState.resetGame?.();
		s.objectActions.setEditorMode('interact');
		await wait();
		const menu = state();
		s.gameState.setGameState('playing');
		await wait();
		const playing = state();
		s.gameState.setGameState('over');
		await wait();
		const over = state();
		// `on` wired to a false boolean: a Compare that can never hold
		s.gameState.setGameState('playing');
		const cmp = { id: 'fNo', type: 'compare', position: { x: 0, y: 0 }, data: { label: 'never', op: 'gt', a: 0, b: 1 }, class: 'w-[150px]' };
		const edge = { id: 'e-fNo-fMus.on', source: 'fNo', target: 'fMus', targetHandle: 'on' };
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes: [...g.scene.nodes, cmp], edges: [...g.scene.edges, edge] } }));
		await wait();
		const off = state();
		s.objectActions.setEditorMode('edit');
		s.gameState.resetGame?.();
		return { menu, playing, over, off };
	});
	h.check(round.menu === null && round.playing === 'space' && round.over === null, "5.4 while 'round' it waits for the round and stops at its end (" + JSON.stringify(round) + ')');
	h.check(round.off === null, '5.5 an `on` wired false switches it off');

	console.log('\n=== 7. On Grab: a player lifting a body pulses it ===');
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(800);
	const grabbed = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const crate = group.children.filter((c) => c.isMesh).pop();
		crate.name = 'Grab crate';
		crate.position.set(0, 1.2, -3);
		crate.userData.physics = { mode: 'dynamic', mass: 1 };
		s.objectsGroup.update((v) => v);
		s.scenePhysics.setScenePhysics({ play: { interaction: 'grab' }, ground: { enabled: true, height: 0 } });
		const N = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data }, class: 'w-[150px]' });
		const nodes = [N('gGrab', 'ongrab', { pulse: 0.3 }), N('gSel', 'objectselector', { selected: crate.uuid }), N('gPop', 'gamesound', { sound: 'pop' })];
		const edges = [
			{ id: 'e-gGrab-gSel', source: 'gGrab', target: 'gSel' },
			{ id: 'e-gGrab-gPop.trigger', source: 'gGrab', target: 'gPop', targetHandle: 'trigger' },
			{ id: 'e-gSel-gPop.at', source: 'gSel', target: 'gPop', targetHandle: 'at' }
		];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		await new Promise((r) => setTimeout(r, 800));
		s.gameKit.gameFeelActions.resetGameFeelActionsDebug();
		s.objectActions.setEditorMode('interact');
		await s.physics.toggleSimulation();
		await new Promise((r) => setTimeout(r, 600));
		let camera;
		s.globalCamera.subscribe((v) => (camera = v))();
		camera.updateMatrixWorld(true);
		const from = camera.getWorldPosition(new THREE.Vector3());
		const to = crate.getWorldPosition(new THREE.Vector3());
		const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize());
		const started = s.playInteract.cursorGrabStart(ray, { x: 0, y: 0 }, camera);
		await new Promise((r) => setTimeout(r, 600));
		const dbg = s.gameKit.gameFeelActions.gameFeelActionsDebug();
		s.playInteract.cursorGrabEnd();
		await s.physics.toggleSimulation();
		s.objectActions.setEditorMode('edit');
		return { started, pops: dbg.last.filter((e) => e.type === 'gamesound' && e.sound === 'pop') };
	});
	h.check(grabbed.started === true, '7.1 (premise) the Interact cursor carry picked the crate up');
	h.check(grabbed.pops.length === 1 && grabbed.pops[0].spatial, '7.2 On Grab fired: the pop played once, at the crate (' + JSON.stringify(grabbed.pops) + ')');

	console.log('\n=== 6. two peers: a replicated pulse announces on both ===');
	// the graph is A's before B dials, so the handshake's full-state nodes reply carries it
	await build();
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await B.page.waitForFunction(() => window.__stores.allNodes().some((n) => n.id === 'fAnn'), null, { timeout: 30000 });
	await B.page.waitForTimeout(900); // B's first tick sees the nodes (actionSeenAt)
	await pulse(true);
	await B.page.waitForTimeout(800);
	const onB = await B.page.evaluate(() => {
		let v;
		window.__stores.gameKit.gameAnnounce.gameAnnouncement.subscribe((x) => (v = x))();
		return { ann: v, fired: window.__stores.gameKit.gameFeelActions.gameFeelActionsDebug().fired };
	});
	h.check(/^Ring \d+ reached$/.test(onB.ann?.text ?? ''), '6.1 the second peer shows the banner from the same pulse (' + JSON.stringify(onB.ann) + ')');
	h.check((onB.fired.gamesound ?? 0) >= 1, '6.2 and plays the sound itself (' + JSON.stringify(onB.fired) + ')');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page error');
	await h.finish(browser);
});
