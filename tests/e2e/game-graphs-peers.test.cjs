// 36 (U10, 36-games-graphs) — a game whose rules are a behaviour on its Main graph, on TWO peers.
//
// Mini Golf (the staged .tpscene, MINIGOLF_TPSCENE to override): the rules behaviour loads on both
// peers and runs its handlers on ONE (the kit's authority); the OTHER peer presses Tee off in its
// own HUD and putts with a real mouse — the press reaches the rules through the replicated button
// stamp, the putt through the engine's broadcast; both peers read the same replicated state on
// their HUDs; a rules edit made on the non-authority (a knob) reloads the rules on the authority.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const TPSCENE = [
	process.env.MINIGOLF_TPSCENE,
	path.resolve(__dirname, '../../../cloud-lane-30-staging/36-games-graphs/games/mini-golf/scene.tpscene')
]
	.filter(Boolean)
	.find((p) => fs.existsSync(p));

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no staged games/mini-golf/scene.tpscene (set MINIGOLF_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const ctx = { context: { viewport: { width: 1280, height: 720 } } };
	const A = await h.setupPage(browser, 'A', ctx);
	const B = await h.setupPage(browser, 'B', ctx);
	await h.connect(B, A);
	await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(fs.readFileSync(TPSCENE)));

	const status = (peer) =>
		peer.page.evaluate(() => {
			const d = window.__stores.behaviours?.behavioursDebug?.();
			const id = window.__minigolf?.rulesNode?.();
			return d && id ? { status: d.status[id]?.status ?? null, authority: d.authority, me: d.me } : null;
		});
	await h.eventually(() => status(A), (v) => v?.status === 'running', 'A: the rules behaviour runs', 15000);
	await h.eventually(() => status(B), (v) => v?.status === 'running', 'B: the rules behaviour loaded on the joiner too', 20000);
	const sa = await status(A);
	const auth = sa.authority === sa.me ? A : B;
	const other = auth === A ? B : A;
	h.check(!!sa.authority, `one authority runs the handlers (${auth === A ? 'A' : 'B'})`);

	const rules = (peer) =>
		peer.page.evaluate(() => {
			const id = window.__minigolf?.rulesNode?.();
			const st = id ? window.__stores.behaviours.behaviourState(id) : null;
			return st ? JSON.parse(JSON.stringify(st)) : null;
		});
	const hud = (peer) => peer.page.locator('#hud-layer').textContent().then((t) => t ?? '');

	// both enter Play; the NON-authority presses Tee off in its own HUD
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => hud(other), (t) => /Tee off/.test(t), 'the non-authority sees the start menu', 10000);
	await other.page.locator('#hud-layer button', { hasText: 'Tee off' }).click();
	await h.eventually(() => rules(auth), (r) => r?.hole === 1 && r.phase === 'ready', "the other peer's press ran the rules on the authority (hole 1)", 10000);
	if (process.env.DEBUG_PEERS) {
		for (const [nm, p] of [['auth', auth], ['other', other]]) {
			const dbg = await p.page.evaluate(() => {
				const s = window.__stores;
				const d = s.behaviours.behavioursDebug();
				const id = window.__minigolf.rulesNode();
				let tr; s.flowTriggers.subscribe((v) => (tr = v))();
				let g; s.flowGraphs.subscribe((v) => (g = v))();
				const btn = g.scene.nodes.find((n) => n.type === 'hudbutton' && n.data.element === 'start-btn');
				const inst = s.behaviours.runtime.instances.get(id);
				return { inputs: s.flowRuntime?.behaviourInputStats ?? s.behaviourInputStats, fired: d.live(id)?.fired, stats: d.stats, synced: inst?.synced, btnStamp: tr[btn?.id], edges: g.scene.edges.filter((e) => e.target === id).map((e) => e.source + '>' + e.targetHandle), round: s.kit?.kit?.impls?.round?.phase?.(), game: (() => { let v; s.gameState.gameState.subscribe((x) => (v = x))(); return v?.state; })() };
			});
			console.log('DEBUG', nm, JSON.stringify(dbg));
		}
	}
	await h.eventually(() => rules(other), (r) => r?.hole === 1, 'the rules state replicated back (the other peer reads hole 1)', 8000);
	await h.eventually(() => hud(other), (t) => /Hole 1 of 6/.test(t) && /Par 2/.test(t), "the other peer's HUD shows the rules' words", 8000);
	await h.eventually(() => hud(auth), (t) => /Hole 1 of 6/.test(t), "the authority's HUD too", 8000);
	await other.page.waitForTimeout(1500);

	// the non-authority putts with a real mouse: press on the ball, drag back, let go
	const ballScreen = await other.page.evaluate(() => {
		const s = window.__stores;
		let cam; s.globalCamera.subscribe((v) => (cam = v))();
		let r; s.globalRenderer.subscribe((v) => (r = v))();
		const b = window.__minigolf.ball().pos;
		const v = new s.THREE.Vector3(...b).project(cam);
		const rect = r.domElement.getBoundingClientRect();
		return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
	});
	const under = await other.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, ballScreen);
	h.check(under === 'CANVAS', `premise: the ball is on the other peer's screen (${under})`);
	await other.page.mouse.move(ballScreen.x, ballScreen.y);
	await other.page.mouse.down();
	await other.page.mouse.move(ballScreen.x, ballScreen.y + 50, { steps: 4 });
	await other.page.mouse.move(ballScreen.x, ballScreen.y + 100, { steps: 4 });
	await other.page.mouse.up();
	await h.eventually(() => rules(auth), (r) => r?.strokes === 1, "the other peer's putt reached the rules: one stroke", 8000);
	await h.eventually(() => rules(other), (r) => r?.strokes === 1, 'and the stroke replicated back', 6000);
	await h.eventually(() => hud(other), (t) => /Strokes 1/.test(t), "the other peer's HUD says Strokes 1", 6000);

	// a knob turned on the non-authority reloads the rules everywhere
	await other.page.evaluate(() => {
		const s = window.__stores;
		let g; s.flowGraphs.subscribe((v) => (g = v))();
		const id = window.__minigolf.rulesNode();
		const node = g.scene.nodes.find((n) => n.id === id);
		const code = String(node.data.code).replace(/shotPower: \{ value: [\d.]+/, 'shotPower: { value: 4.5');
		s.nodesHandler.setNodeData(id, { code }, 'scene');
	});
	await h.eventually(
		() => auth.page.evaluate(() => window.__stores.behaviours.behavioursDebug().live(window.__minigolf.rulesNode())?.params?.shotPower),
		(v) => v === 4.5,
		'a rules edit on the other peer reloads the rules on the authority (shot power 4.5)',
		10000
	);
	h.check((await rules(auth))?.hole === 1, 'the hole in play carried on through the reload');

	await h.finish(browser);
});
