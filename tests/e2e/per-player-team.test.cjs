// 92-correct row 3 — PER-PLAYER OUTPUT: "show each player their team". A behaviour keeps
// `team: {<peer>: 'Red'|'Blue'}` (assigned in playerJoined, on the authority, so the teams stay even
// and everyone agrees) and the team scores; one HUD Text fed by a Game Value with `for: me` shows
// each person their OWN team from that one shared map; a click on the ball scores for the clicker's
// team on both screens. Then a reload: the reloaded peer comes back on the same team.
//
// Red on v1.74.0: there is no playerJoined event (the behaviour reports "on.playerJoined: no such
// event") and Game Value has no `for: me`, so a map shows as text or nothing (2.0-eval2 finding 3,
// team-score capped at 0.5).
//
// Run: APP_URL=https://localhost:5927/ npm run e2e -- per-player-team
const h = require('./helpers.cjs');

const TEAMS = `export default behaviour({
	name: 'Teams',
	state: { team: {}, red: 0, blue: 0 },
	inputs: ['scored'],
	outputs: ['team', 'red', 'blue'],
	on: {
		playerJoined({ by }) {
			if (this.state.team[by]) return;
			const n = (t) => Object.values(this.state.team).filter((x) => x === t).length;
			this.state.team[by] = n('Red') <= n('Blue') ? 'Red' : 'Blue';
		},
		scored({ by }) {
			const t = this.state.team[by];
			if (t === 'Red') this.state.red += 1;
			else if (t === 'Blue') this.state.blue += 1;
		}
	}
});`;

const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
/** the HUD runtime text of each element @param {any} p */
const hud = (p) =>
	E(p, () => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.hudDocs.hudRuntime.subscribe((/** @type {any} */ x) => (v = x))();
		return { mine: v?.myteam?.text ?? null, red: v?.redscore?.text ?? null, blue: v?.bluescore?.text ?? null };
	});
const play = (/** @type {any} */ p) => E(p, () => /** @type {any} */ (window).__tp.test.v1.playMode.requestPlay({ flat: true }));
const playing = (/** @type {any} */ p) =>
	E(p, () => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.isLocked.subscribe((/** @type {any} */ x) => (v = x))();
		return v === true;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	const ball = await E(A, async () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		/** @type {any} */
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const b = g.children[g.children.length - 1];
		b.name = 'Ball';
		return b.uuid;
	});
	await E(
		A,
		({ code, ball, b }) => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			s.hudDocs.setHudDocFor('scene', {
				screens: [
					{
						id: 'main',
						name: 'Main',
						elements: [
							{ id: 'myteam', kind: 'text', label: '', anchor: 'top-left', x: 20, y: 20, w: 200, h: 26 },
							{ id: 'redscore', kind: 'text', label: '', anchor: 'top-center', x: -60, y: 20, w: 120, h: 26 },
							{ id: 'bluescore', kind: 'text', label: '', anchor: 'top-center', x: 60, y: 20, w: 120, h: 26 }
						]
					}
				],
				active: 'main'
			});
			const node = (/** @type {string} */ id, /** @type {string} */ type, /** @type {any} */ data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
			s.updateGraph(s.SCENE_GRAPH, () => ({
				nodes: [
					node('bhv', 'behaviour', { name: 'Teams', code }),
					node('click', 'onclick', { pulse: 0.3 }),
					node('sel', 'objectselector', { selected: ball }),
					node('mine', 'gamevalue', { read: 'wired', format: 'text', prefix: 'Team: ', who: 'me' }),
					node('t1', 'hudtext', { element: 'myteam', format: '{v}' }),
					node('t2', 'hudtext', { element: 'redscore', format: 'Red {v}' }),
					node('t3', 'hudtext', { element: 'bluescore', format: 'Blue {v}' })
				],
				edges: [
					{ id: 'e1', source: 'click', target: 'sel' },
					{ id: 'e2', source: 'click', target: 'bhv', targetHandle: 'scored' },
					{ id: 'e3', source: 'bhv', sourceHandle: 'team', target: 'mine', targetHandle: 'value' },
					{ id: 'e4', source: 'mine', target: 't1', targetHandle: 'value' },
					{ id: 'e5', source: 'bhv', sourceHandle: 'red', target: 't2', targetHandle: 'value' },
					{ id: 'e6', source: 'bhv', sourceHandle: 'blue', target: 't3', targetHandle: 'value' }
				]
			}));
			s.nodesHandler.sendNodes(b);
		},
		{ code: TEAMS, ball, b: B.id }
	);
	// the first behaviour also loads the sandbox engine (up to 40 s headless)
	await h.eventually(
		() => E(A, () => /** @type {any} */ (window).__tp.test.v1.behaviours.behavioursDebug().status.bhv?.status ?? null),
		(v) => v === 'running',
		'the Teams behaviour runs',
		60000
	);
	const problems = await E(A, () => /** @type {any} */ (window).__tp.test.v1.behaviours.behavioursDebug().live('bhv')?.problems ?? []);
	h.check(!problems.some((/** @type {string} */ p) => /playerJoined/.test(p)), `playerJoined is a known event (${JSON.stringify(problems)}; red on v1.74.0: "no such event")`);

	// both players enter Play: each is put on a team, evenly, and sees their own
	await play(A);
	await play(B);
	await h.eventually(async () => (await playing(A)) && (await playing(B)), (v) => v === true, 'both players are in Play', 20000);
	await h.eventually(
		async () => [await hud(A), await hud(B)],
		([a, b]) => /^Team: (Red|Blue)$/.test(a.mine ?? '') && /^Team: (Red|Blue)$/.test(b.mine ?? '') && a.mine !== b.mine,
		'each player sees their OWN team, and the two are on different teams',
		30000
	);
	const [a0, b0] = [await hud(A), await hud(B)];
	console.log(`  A ${a0.mine}, B ${b0.mine}`);
	h.check(a0.red === b0.red && a0.blue === b0.blue, `both screens show the same scores (${a0.red} ${a0.blue} / ${b0.red} ${b0.blue})`);

	// B clicks the ball twice: two points for B's team on both screens
	const teamB = String(b0.mine).replace('Team: ', '');
	for (let i = 0; i < 2; i++) {
		await E(B, (u) => /** @type {any} */ (window).__tp.test.v1.flowRuntime.fireObjectClick(u), ball);
		await B.page.waitForTimeout(700);
	}
	const want = teamB === 'Red' ? { red: 'Red 2', blue: 'Blue 0' } : { red: 'Red 0', blue: 'Blue 2' };
	await h.eventually(
		async () => [await hud(A), await hud(B)],
		([a, b]) => a.red === want.red && a.blue === want.blue && b.red === want.red && b.blue === want.blue,
		`the clicker's team (${teamB}) scored 2 on both screens`,
		20000
	);

	// a reload: B comes back on the SAME team (the map is the authority's, the reloaded peer is announced again)
	await h.freshReload(B);
	await h.answerRestore(B);
	B.id = await B.page.evaluate(
		() =>
			new Promise((r) => {
				const t = setInterval(() => {
					/** @type {any} */
					let p;
					/** @type {any} */ (window).__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (p = v))();
					if (p?.peer?.open && p.peer.id) (clearInterval(t), r(p.peer.id));
				}, 250);
			})
	);
	// the host is in Play, where the join card is not answerable (92-menus' GC8): approve through the store it calls
	await E(B, (id) => /** @type {any} */ (window).__tp.test.v1.peerApproval.requestConnect(id), A.id);
	await h.eventually(
		() =>
			E(A, (id) => {
				/** @type {any} */
				let w;
				/** @type {any} */ (window).__tp.test.v1.pendingApprovals.subscribe((/** @type {any} */ x) => (w = x))();
				return (w ?? []).some((/** @type {any} */ c) => (c?.peerId ?? c?.[0]) === id);
			}, B.id),
		(v) => v === true,
		'the rejoin knocks on the host',
		30000
	);
	await E(A, (id) => /** @type {any} */ (window).__tp.test.v1.peerApproval.approvePeer(id), B.id);
	await play(B);
	await h.eventually(
		async () => [await hud(A), await hud(B)],
		([a, b]) => /^Team: (Red|Blue)$/.test(b.mine ?? '') && b.red === want.red && b.blue === want.blue && a.red === want.red,
		'after a reload the peer sees its team and the kept scores',
		60000
	);
	console.log(`  after reload: B ${(await hud(B)).mine}`);

	await browser.close();
});
