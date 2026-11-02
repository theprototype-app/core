// Two sessions meet, four real peers: H hosts G, N hosts P, and H joins N.
// G asks N (it hears N from its host and dials with a card), N decides, and once N says yes G and P mesh with
// no card between them. The new-ids-only-from-the-host rule (roster-sender) must not split a session that grows
// this way.
//
// Run: APP_URL='https://localhost:5980/' npm run e2e -- roster-merge
const h = require('./helpers.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			const read = (store) => {
				let v;
				window.__stores[store].subscribe((x) => (v = x))();
				return v;
			};
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'read', 'arg', src)(window.__stores, pc, read, a);
		},
		[body, arg ?? null]
	);
const inRoster = (p, id) => inPage(p, `return read('userdata').some((u) => u[0] === arg);`, id);
const card = (p, id) => inPage(p, `return read('pendingApprovals').some((a) => a.peerId === arg);`, id);
const linked = (p, id) => inPage(p, `return !!pc.connections[arg]?.open || pc.openedPeers.has(arg);`, id);

const until = async (p, fn, ms = 40000) => {
	for (const t = Date.now() + ms; Date.now() < t; await p.page.waitForTimeout(1000)) if (await fn()) return true;
	return false;
};

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPageQuiet(browser, 'G', [H]);
	await h.connect(G, H);
	const N = await h.setupPageQuiet(browser, 'N', [H, G]);
	const P = await h.setupPageQuiet(browser, 'P', [H, G, N]);
	await h.connect(P, N, 3000);
	await inPage(H, `await s.peerApproval.requestConnect(arg);`, N.id);
	await h.approveButton(N.page).click({ timeout: 30000 });
	h.check(await until(N, () => linked(N, H.id)), 'the host links to the peer it joined');
	h.check(await until(G, () => inRoster(G, N.id)), 'its guest hears that peer from the host');
	const asked = await until(N, () => card(N, G.id), 30000);
	h.check(asked, 'the peer joined is asked about the guest');
	// the store path: the page's input stalls under the load of this many browsers (the button has its own suites)
	if (asked) await inPage(N, `s.peerApproval.approvePeer(arg);`, G.id);
	h.check(await until(N, async () => (await linked(N, G.id)) && (await linked(G, N.id)), 60000), 'and once it says yes they link');
	h.check(await until(G, async () => (await linked(G, P.id)) && (await linked(P, G.id)), 60000), "the guests of both sides link");
	h.check(!(await card(P, G.id)) && !(await card(G, P.id)), 'with no card between them');

	await h.finish(browser);
});
