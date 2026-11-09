// 78 F26 — "WHY DID THIS NOT FIRE?". Each trigger node (On Enter / On Exit / On Hover / On Click /
// Collect pickup / Timer) keeps its last check (time, who / what, fired or the block) plus a STANDING
// reason; the node card shows one line, the Flow debugger the sentence. One check per reason:
//   §1 standing, Edit mode: On Click / On Hover "in Edit mode", On Enter "physics is not running",
//      a node with no object "no object to watch", Timer "nothing wired into it", Collect "touch off".
//   §2 Interact: On Click fires (card "fired …"); On Hover "enabled" off; cooldown; who: player on a
//      box that is not a sensor; the sensor edges refuse not-the-player / the player / the filter.
//   §3 the card DOM line and the Flow debugger's rows for the focused node.
//   §4 two peers: A runs the simulation, B's On Enter (objects) says it is checked on the physics peer.
//
//   APP_URL=https://theprototype.app:5800/ node tests/e2e/trigger-why-78.test.cjs
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const why = (page, id) => S(page, (id) => window.__stores.flowRuntime.triggerWhyOf(id), id);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	const ids = await S(p, async () => {
		const st = window.__stores;
		st.commandsHandler.sceneCommand('/create box');
		st.commandsHandler.sceneCommand('/create box');
		st.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => st.objectsGroup.subscribe(r)());
		const [bell, crate, gem] = g.children.slice(-3);
		bell.name = 'Bell';
		crate.name = 'Crate';
		gem.name = 'Gem';
		crate.position.x = 3;
		gem.position.x = -3;
		st.objectActions.applySelectionSet([]);
		return { bell: bell.uuid, crate: crate.uuid, gem: gem.uuid };
	});
	const N = (id, type, data, x, y) => ({ id, type, position: { x, y }, data: { type, label: id, ...data }, class: 'w-[150px]' });
	const sel = (id, uuid, y) => N(id, 'objectselector', { selected: uuid }, 320, y);
	const DOC = {
		scene: {
			nodes: [
				N('click', 'onclick', { pulse: 0.3 }, 0, 0),
				N('lonely', 'onclick', { pulse: 0.3 }, 0, 120),
				N('hoverOff', 'onhover', { on: 'enter', who: 'anyone', cooldown: 0, enabled: false }, 0, 240),
				N('hoverCool', 'onhover', { on: 'enter', who: 'anyone', cooldown: 30 }, 0, 360),
				N('enterAny', 'onenter', { pulse: 0.3 }, 0, 480),
				N('enterPlayer', 'onenter', { pulse: 0.3, who: 'player' }, 0, 600),
				N('enterObjects', 'onenter', { pulse: 0.3, who: 'objects' }, 0, 720),
				N('enterFilter', 'onenter', { pulse: 0.3, filter: ids.gem }, 0, 840),
				N('timer', 'timer', { delay: 1 }, 0, 960),
				sel('s1', ids.bell, 0),
				sel('s3', ids.bell, 240),
				sel('s4', ids.bell, 360),
				sel('s5', ids.bell, 480),
				sel('s6', ids.bell, 600),
				sel('s7', ids.bell, 720),
				sel('s8', ids.bell, 840)
			],
			edges: [
				{ id: 'e1', source: 'click', target: 's1' },
				{ id: 'e3', source: 'hoverOff', target: 's3' },
				{ id: 'e4', source: 'hoverCool', target: 's4' },
				{ id: 'e5', source: 'enterAny', target: 's5' },
				{ id: 'e6', source: 'enterPlayer', target: 's6' },
				{ id: 'e7', source: 'enterObjects', target: 's7' },
				{ id: 'e8', source: 'enterFilter', target: 's8' }
			]
		},
		// the gem's own graph: a Collect pickup with touch off and nothing wired
		[ids.gem]: { nodes: [N('collect', 'kit-pickups-collect', { score: 1, respawn: 0, touch: false }, 0, 0)], edges: [] }
	};
	await S(p, (doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await S(p, (id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await p.waitForTimeout(800);

	// --- §1 standing reasons in Edit mode ------------------------------------------------------
	console.log('\n=== §1 standing reasons (Edit mode) ===');
	const st = async (id, want, label) => {
		await h.eventually(() => why(p, id), (w) => w?.standing === want, `§1 ${label}: ${want}`);
	};
	await st('click', 'edit', 'On Click in Edit');
	await st('hoverCool', 'edit', 'On Hover in Edit');
	await st('lonely', 'no-target', 'On Click with no object');
	await st('enterAny', 'no-sim', 'On Enter with nothing simulating');
	await st('timer', 'nothing-wired', 'Timer with no input');
	await st('collect', 'touch-off', 'Collect with touch off and nothing wired');
	const w1 = await why(p, 'click');
	h.check(w1.card === "won't fire: in Edit mode (use Play)", `§1 the card line words it ("${w1.card}")`);

	// --- §2 checks in Interact -----------------------------------------------------------------
	console.log('\n=== §2 checks (Interact) ===');
	await S(p, () => window.__stores.editorMode.set('interact'));
	await h.eventually(() => why(p, 'click'), (w) => w?.standing === null, '§2 Interact clears On Click\'s standing reason');
	const fired = await S(p, (u) => window.__stores.flowRuntime.fireObjectClick(u), ids.bell);
	h.check(fired >= 1, `§2 a click on the bell fires (${fired})`);
	let w = await why(p, 'click');
	h.check(w.check?.fired === true && w.check.who === 'Bell' && /^fired /.test(w.card), `§2 On Click: fired, by the bell ("${w.card}", ${JSON.stringify(w.check)})`);

	await st('hoverOff', 'disabled', 'On Hover with "enabled" off');
	await S(p, (u) => window.__stores.flowRuntime.fireObjectHover(u, 'enter'), ids.bell);
	w = await why(p, 'hoverOff');
	h.check(w.check?.reason === 'disabled' && w.card === 'blocked: "enabled" is off', `§2 a hover on a disabled node is blocked ("${w.card}")`);
	w = await why(p, 'hoverCool');
	h.check(w.check?.fired === true, '§2 the first hover fires');
	await S(p, (u) => window.__stores.flowRuntime.fireObjectHover(u, 'leave'), ids.bell);
	await S(p, (u) => window.__stores.flowRuntime.fireObjectHover(u, 'enter'), ids.bell);
	w = await why(p, 'hoverCool');
	h.check(w.check?.reason === 'cooldown' && w.card === 'blocked: still in its cooldown', `§2 the second hover inside the cooldown is blocked ("${w.card}")`);

	await st('enterPlayer', 'no-sensor', 'On Enter (player) on a box that is not a sensor');
	await S(p, ([u, c]) => window.__stores.flowRuntime.fireObjectEnter(u, c), [ids.bell, ids.crate]);
	w = await why(p, 'enterPlayer');
	h.check(w.check?.reason === 'not-player' && w.check.who === 'Crate', `§2 a crate is not the player ("${w.card}", ${w.check?.who})`);
	w = await why(p, 'enterAny');
	h.check(w.check?.fired === true, '§2 the same crate fires On Enter (anything)');
	await S(p, (u) => window.__stores.flowRuntime.fireObjectEnter(u, 'player'), ids.bell);
	w = await why(p, 'enterObjects');
	h.check(w.check?.reason === 'not-objects' && w.check.who === 'the player', `§2 the player is refused by On Enter (objects) ("${w.card}")`);
	w = await why(p, 'enterFilter');
	h.check(w.check?.reason === 'filter', `§2 the filter refuses the player ("${w.card}")`);
	await S(p, ([u, g]) => window.__stores.flowRuntime.fireObjectEnter(u, g), [ids.bell, ids.gem]);
	w = await why(p, 'enterFilter');
	h.check(w.check?.fired === true && w.check.who === 'Gem', `§2 the filter's own object fires it ("${w.card}", ${JSON.stringify(w.check)})`);

	// --- §3 the card and the Flow debugger -----------------------------------------------------
	console.log('\n=== §3 card + debugger ===');
	// a restore offer can be up since boot (nothing before §3 clicks): answer it or it eats the press
	if (await p.locator('#restore-session-modal').isVisible().catch(() => false)) await p.locator('#restore-session-dismiss').click().catch(() => {});
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1200);
	const live = (id) => p.locator(`.flow-live-state[data-node-id="${id}"]`).textContent().catch(() => null);
	await S(p, (u) => window.__stores.flowRuntime.fireObjectEnter(u, 'player'), ids.bell);
	await h.eventually(() => live('enterObjects'), (t) => t === 'blocked: the player (wants objects)', '§3 the On Enter card says what blocked it');
	await h.eventually(() => live('lonely'), (t) => t === "won't fire: no object to watch", '§3 the lonely On Click card says why it cannot fire');
	// the debugger is live in Play (isLocked true; the flow-debugger suite's way in)
	await S(p, () => window.__stores.isLocked.set(true));
	await p.waitForTimeout(500);
	await S(p, () => {
		window.__stores.flowDebug.setDebugOpen(true);
		window.__stores.flowDebug.debugFocus.set('enterObjects');
	});
	const row = p.locator('#debug-why');
	await row.waitFor({ timeout: 8000 }).catch(() => {});
	const text = (await row.textContent().catch(() => '')) ?? '';
	h.check(/Last check .* ago · the player: blocked, the player \(wants objects\)\./.test(text), `§3 the debugger names time, who and the block ("${text.trim().slice(0, 120)}")`);
	await S(p, () => window.__stores.flowDebug.debugFocus.set('lonely'));
	await h.eventually(
		() => row.textContent().catch(() => ''),
		(t) => /Right now it cannot fire: no object to watch\./.test(t ?? '') && /No check yet/.test(t ?? ''),
		'§3 a node never reached says so, and its standing reason'
	);
	await S(p, () => window.__stores.flowDebug.setDebugOpen(false));
	await S(p, () => window.__stores.isLocked.set(null));
	await S(p, () => window.__stores.editorMode.set('edit'));

	// --- §4 two peers: the physics peer checks object edges -------------------------------------
	console.log('\n=== §4 two peers ===');
	await S(p, (u) => window.__stores.physics.setPhysicsFor(u, { mode: 'dynamic', mass: 1 }), ids.crate);
	await S(p, () => window.__stores.physics.toggleSimulation());
	await h.eventually(() => S(p, () => window.__stores.physics.isInitiator()), (v) => v === true, '§4 A runs the simulation');
	await h.eventually(() => why(B.page, 'enterObjects'), (w) => w?.standing === 'authority', '§4 on B, On Enter (objects) is checked on the physics peer');
	await h.eventually(() => why(p, 'enterObjects'), (w) => w?.standing === null, '§4 on A (the physics peer) nothing stands in the way');
	await S(p, () => window.__stores.physics.toggleSimulation());

	await browser.close();
});
