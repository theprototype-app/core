// 80a R1: roster changes are tied to the connection that made them. Three peers.
//
// X already has J in its roster, so J's dial to X opens and X's handshake arrives while J's request
// is still waiting (X never dials back: no approval). X's roster names Z, a peer nobody approved.
//   1. J takes Z provisionally, tied to X;
//   2. what J hands its own guest K leaves out X while J is still asking it;
//   3. J cancels: Z leaves J's roster; K never heard of Z;
//   4. an approval keeps the rows (J joins H, H's roster stays).
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__tp.test.v1.peers.subscribe((v) => (pc = v))();
			const read = (store) => {
				let v;
				window.__tp.test.v1[store].subscribe((x) => (v = x))();
				return v;
			};
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'read', 'arg', src)(window.__tp?.test.v1, pc, read, a);
		},
		[body, arg ?? null]
	);
const inRoster = (p, id) => inPage(p, `return read('userdata').some((u) => u[0] === arg);`, id);
const asking = (p, id) => inPage(p, `return read('waitingForApproval').some((w) => w[0] === arg && w[1] === 'pending');`, id);

h.run(async () => {
	const browser = await h.launch();
	const J = await h.setupPage(browser, 'J');
	const K = await h.setupPageQuiet(browser, 'K', [J]);
	await h.connect(K, J);
	const X = await h.setupPageQuiet(browser, 'X', [J, K]);
	const Z = 'zz' + Math.random().toString(36).slice(2, 10);

	// X has J in its roster already (and Z, whom nobody approved)
	await inPage(X, `s.userdata.update((u) => [...u, [arg.j, 'J', ''], [arg.z, 'Zed', '']]);`, { j: J.id, z: Z });
	await inPage(J, `await s.peerApproval.requestConnect(arg);`, X.id);
	await h.eventually(() => inRoster(J, Z), (v) => v, "premise: X's handshake reaches J while J is asking", 20000);
	h.check(await asking(J, X.id), 'premise: J is still waiting for X');
	h.check((await inPage(J, `return s.rosterOrigin.rosterOriginOf(arg);`, Z)) === X.id, 'J ties Z to the request to X');

	// what J hands K
	await inPage(J, `pc.send({ type: 'userdata', userdata: read('userdata') });`);
	await J.page.waitForTimeout(800);
	h.check(!(await inRoster(K, X.id)), 'K does not hear of X while J is still asking');
	h.check(!(await inRoster(K, Z)), 'nor of Z');

	// J cancels
	await inPage(J, `s.peerApproval.cancelOutboundRequest(arg);`, X.id);
	await h.eventually(() => inRoster(J, Z), (v) => !v, 'cancelling takes Z out of J\'s roster');
	h.check(await inRoster(J, K.id), "J's own guest stays");
	h.check(!(await inRoster(K, Z)), 'K never had Z');

	// an approval keeps them
	const H = await h.setupPageQuiet(browser, 'H', [J, K, X]);
	await h.connect(J, H);
	await h.eventually(() => inRoster(J, H.id), (v) => v, 'J joins H');
	h.check((await inPage(J, `return s.rosterOrigin.rosterOriginOf(arg);`, H.id)) === null, 'nothing from an approved host is tied');
	await J.page.waitForTimeout(1500);
	h.check(await inRoster(J, H.id), 'and the rows stay');

	await h.finish(browser);
});
