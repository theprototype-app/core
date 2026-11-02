// A guest's yes, in a room where the host lets people in by itself, two real peers and a joiner.
//
// H hosts, G joined with H's approval. A guest cannot widen who joins (roster-sender), so somebody G lets in
// is asked about again by H. But H's own settings decide that question: where H admits by itself (a rooms
// plugin's "Allow guests to join automatically", stubbed here as a provider that admits), V gets in at H
// with NO card, so only a room that already asks the host sees the extra step. And the link G copies names
// H, so a joiner dials the host in the first place.
//
// Run: APP_URL='https://localhost:5980/' npm run e2e -- roster-guest-admit
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

const pill = async (from, to) => {
	await from.page.locator('input[placeholder="Enter peer ID to connect"]').fill(to.id);
	await from.page.getByRole('button', { name: 'Connect', exact: true }).click();
};

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPageQuiet(browser, 'G', [H]);
	await h.connect(G, H);

	// the link a guest copies names the host
	// connected, the pill is a chip: open the full bar first
	if (await G.page.locator('.connect-pill .cx-chip').isVisible()) await G.page.locator('.connect-pill .cx-chip').click();
	await G.page.locator('.connect-pill .cx-id').waitFor({ state: 'visible', timeout: 10000 });
	const copied = await G.page.evaluate(async () => {
		let captured = null;
		navigator.clipboard.writeText = (t) => {
			captured = t;
			return Promise.resolve();
		};
		document.querySelector('.connect-pill .cx-id')?.click();
		await new Promise((r) => setTimeout(r, 200));
		return captured;
	});
	h.check(!!copied && copied.includes('#' + H.id.toUpperCase()) && !copied.includes('#' + G.id.toUpperCase()), `the link a guest copies names the host (${copied})`);

	// H admits by itself
	await inPage(H, `window.__decided = []; s.cloudHooks.setAuthProvider({ decide(id) { window.__decided.push(id); return 'admit'; } });`);
	const V = await h.setupPageQuiet(browser, 'V', [H, G]);
	await pill(V, G);
	h.check(await until(G, () => card(G, V.id), 30000), 'a dial to the guest takes a card there');
	await inPage(G, `s.peerApproval.approvePeer(arg);`, V.id);
	h.check(await until(V, () => linked(V, G.id)), 'the guest lets it in');
	h.check(await until(H, async () => (await linked(H, V.id)) && (await linked(V, H.id)), 60000), 'it reaches the host too');
	h.check(await inPage(H, `return window.__decided.includes(arg);`, V.id), "the host's own rule decided it");
	h.check(!(await card(H, V.id)), 'with no card on the host (the host admits by itself)');
	h.check(await until(H, () => inRoster(H, V.id), 15000), "and it is in the host's roster");

	await h.finish(browser);
});
