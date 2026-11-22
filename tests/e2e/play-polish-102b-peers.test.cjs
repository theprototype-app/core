// 102b-play — TWO PEERS + A RELOAD (the int's rule for a lane that touches sync).
//
// The author's touch layout rides scenePhysics (`scenephysics`, latest-wins) and an info point is
// an ordinary note (`annotation`, `getannotations`). Both must reach a joiner live, survive the
// joiner's reload (it rejoins and gets them again from the handshake), and a Reset of the layout
// (play.touch: null) must clear it on the other side too.
//
// Counterfactual (base v1.70.0): normalizeScenePhysics drops nothing it does not know (withUnknown),
// so the raw key would travel — but the base has no `scenePlay.touch` reader, no visitor flag
// normalizer and no clearing path through setScenePhysics; checks 1, 3 and 4 read lane-only state.
const h = require('./helpers.cjs');

const { check } = h;
// bounded: a lost page or a stuck browser close must not hold the e2e slot (SIGKILL skips exit hooks)
const SUITE_LIMIT_MS = Number(process.env.SUITE_LIMIT_MS || 240000);
setTimeout(() => {
	console.error(`SUITE TIMEOUT after ${SUITE_LIMIT_MS / 1000} s`);
	process.kill(process.pid, 'SIGKILL');
}, SUITE_LIMIT_MS).unref();
process.on('exit', (c) => c && process.kill(process.pid, 'SIGKILL'));
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const AUTHOR = { v: 1, items: { stick: { x: 0.25, y: 0.7, size: 140, opacity: 0.6 } } };

const touchOf = (peer) => peer.page.evaluate((r) => eval(r)(window.__tp.test.v1.scenePhysics.scenePlay).touch ?? null, read);
const visitorOf = (peer, id) =>
	peer.page.evaluate(
		({ r, id }) => {
			const n = eval(r)(window.__tp.test.v1.annotationsHandler.annotations).find((a) => a.id === id);
			return n ? { visitors: n.visitors === true, picture: n.picture ?? null, name: n.name } : null;
		},
		{ r: read, id }
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	const id = await A.page.evaluate(
		({ AUTHOR, PNG }) => {
			const s = window.__tp.test.v1;
			s.commandsHandler.sceneCommand('/create box');
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const box = g.children[g.children.length - 1];
			const ah = s.annotationsHandler;
			ah.addAnnotation(box.uuid, [0, 1, 0]);
			let cur = null;
			ah.activeAnnotation.subscribe((a) => (cur = a))();
			ah.setAnnotation({ ...cur.draft, name: 'Info', text: 'for visitors', visitors: true, picture: PNG });
			ah.activeAnnotation.set(null);
			s.scenePhysics.setScenePhysics({ play: { touch: AUTHOR } });
			return cur.draft.id;
		},
		{ AUTHOR, PNG }
	);

	await h.connect(B, A);

	// 1 + 2: a joiner receives both from the handshake
	await h.eventually(() => touchOf(B), (t) => JSON.stringify(t) === JSON.stringify(AUTHOR), '1: the joiner has the author touch layout', 30000);
	await h.eventually(() => visitorOf(B, id), (n) => n?.visitors === true && n.picture === PNG, '2: the joiner has the info point with its picture', 30000);

	// 3: live change — a new layout from the author arrives
	const NEXT = { v: 1, items: { stick: { x: 0.4, y: 0.5, size: 100, opacity: 0.9 } } };
	await A.page.evaluate((NEXT) => window.__tp.test.v1.scenePhysics.setScenePhysics({ play: { touch: NEXT } }), NEXT);
	await h.eventually(() => touchOf(B), (t) => t?.items?.stick?.x === 0.4, '3: a changed author layout replicates live');

	// reload the joiner: it rejoins and gets the state again
	await h.freshReload(B);
	await h.eventually(
		() =>
			B.page.evaluate((r) => {
				const p = eval(r)(window.__tp.test.v1.peers);
				return Object.keys(p?.openedPeers ?? {}).length || (p?.openedPeers?.size ?? 0);
			}, read),
		(n) => n > 0,
		'reload: the joiner rejoins',
		60000
	);
	await h.eventually(() => touchOf(B), (t) => t?.items?.stick?.x === 0.4, 'reload: the touch layout is back on the joiner', 30000);
	await h.eventually(() => visitorOf(B, id), (n) => n?.visitors === true && n.picture === PNG, 'reload: the info point is back with its flag and picture', 30000);

	// 4: the author's Reset (play.touch: null) clears it for everyone
	await A.page.evaluate(() => window.__tp.test.v1.scenePhysics.setScenePhysics({ play: { touch: null } }));
	await h.eventually(() => touchOf(B), (t) => t === null, '4: Reset clears the layout on the joiner');

	await h.finish(browser);
});
