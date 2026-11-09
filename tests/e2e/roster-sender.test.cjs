// Who may be let in without a card, three real peers.
//
// H hosts, G joined with H's approval. Each attack is a raw message from G, because the point is what H does
// with whatever a connected peer sends:
//   1. G names X in a roster: H does not add X, and X's dial takes the approval card;
//   2. G names Y in a mesh list: H does not dial Y, and H's scene does not reach Y;
//   3. a guest's own row still updates (a name change);
//   4. G approves W: W is in with G, and H gets its own card;
//   5. H removes Q while Q says it is reloading: Q takes the card when it dials back;
// (H joining a peer that has guests of its own: roster-merge.)
// First, on clean peers: H approves Z, G hears it from the host, Z and G link with no card on G.
//
// Run: APP_URL='https://localhost:5980/' npm run e2e -- roster-sender
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
const dialed = (p, id) => inPage(p, `return !!pc.connections[arg];`, id);
const raw = (p, to, msg) => inPage(p, `pc.connections[arg.to].send(arg.msg);`, { to, msg });
const meshes = (p) => inPage(p, `return read('objectsGroup').children.filter((c) => c.isMesh).length;`);
const pill = async (from, to) => {
	await (await h.openDial(from.page)).fill(to.id);
	await from.page.getByRole('button', { name: 'Connect', exact: true }).click();
};

const until = async (p, fn, ms = 40000) => {
	for (const t = Date.now() + ms; Date.now() < t; await p.page.waitForTimeout(1000)) if (await fn()) return true;
	return false;
};

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPageQuiet(browser, 'G', [H]);
	await h.connect(G, H);
	await inPage(H, `s.commandsHandler.sceneCommand('/create box');`);
	h.check(await until(H, async () => (await meshes(H)) > 0, 5000), 'H has a mesh to protect');

	// The host's word counts: an approved peer reaches the guest with no card there
	const Z = await h.setupPageQuiet(browser, 'Z', [H, G]);
	await pill(Z, H);
	await h.approveButton(H.page).click({ timeout: 30000 });
	h.check(await until(G, () => inRoster(G, Z.id)), 'the guest hears an approved id from the host');
	h.check(await until(G, async () => (await linked(G, Z.id)) && (await linked(Z, G.id))), 'the approved id links to the guest');
	h.check(!(await card(G, Z.id)), 'with no card on the guest');
	await h.closePeer(Z);

	// 1. A roster row from a guest
	const X = await h.setupPageQuiet(browser, 'X', [H, G]);
	await raw(G, H.id, { type: 'userdata', userdata: [[X.id, '', '']] });
	await H.page.waitForTimeout(1500);
	h.check(!(await inRoster(H, X.id)), 'a guest cannot add an id to the host roster');
	await pill(X, H);
	const carded = await until(H, () => card(H, X.id), 15000);
	h.check(carded, 'the id it named takes the approval card');
	const xLinked = await until(X, () => linked(X, H.id), 30000);
	h.check(!xLinked, 'the id it named is not linked to the host');
	h.check(!(await until(X, async () => (await meshes(X)) > 0, 15000)), 'and the scene does not reach it');
	await h.closePeer(X);

	// 2. A mesh list from a guest. Y holds H in its own roster, as anybody can on their own machine.
	const Y = await h.setupPageQuiet(browser, 'Y', [H, G]);
	await inPage(Y, `const u = read('userdata'); u.push([arg, '', '']); s.userdata.set(u);`, H.id);
	await raw(G, H.id, { type: 'hosts', hosts: [Y.id] });
	await H.page.waitForTimeout(3000);
	h.check(!(await dialed(H, Y.id)), 'a guest cannot make the host dial an id');
	const yLinked = await until(Y, () => linked(Y, H.id), 30000);
	h.check(!yLinked, 'so that id has no link to the host');
	if (yLinked) {
		await raw(Y, H.id, { type: 'getobjects' });
		h.check(!(await until(Y, async () => (await meshes(Y)) > 0, 15000)), 'and the scene does not reach it');
	}
	await h.closePeer(Y);

	// 3. The sender's own row still updates
	await raw(G, H.id, { type: 'userdata', userdata: [[G.id, 'Renamed', '']] });
	h.check(await until(H, () => inPage(H, `return read('userdata').find((u) => u[0] === arg)?.[1] === 'Renamed';`, G.id), 5000), 'a guest can still update its own row');

	// 4. A guest approves somebody: that peer is in with the guest, and the host still decides
	const W = await h.setupPageQuiet(browser, 'W', [H, G]);
	await pill(W, G);
	h.check(await until(G, () => card(G, W.id), 30000), 'a dial to the guest takes a card there');
	await inPage(G, `s.peerApproval.approvePeer(arg);`, W.id);
	h.check(await until(W, () => linked(W, G.id)), 'the guest can let it in');
	h.check(await until(H, () => card(H, W.id), 40000), 'and the host gets its own card for it');
	h.check(!(await inRoster(H, W.id)) && !(await linked(H, W.id)), 'and has not let it in');
	await h.closePeer(W);
	await inPage(H, `s.pendingApprovals.set([]);`);

	// 5. Somebody removed stays out, whatever goodbye they said
	const Q = await h.setupPageQuiet(browser, 'Q', [H, G]);
	await h.connect(Q, H, 3000);
	await Promise.all([inPage(H, `s.peerModeration.removePeer(arg);`, Q.id), raw(Q, H.id, { type: 'disconnected', peerId: Q.id, unload: true })]);
	await until(H, async () => !(await linked(H, Q.id)), 15000);
	// Q hears the removal and leaves on its own; a dial made before that lands would be cancelled by the leave
	await until(Q, async () => !(await linked(Q, H.id)), 15000);
	await Q.page.waitForTimeout(1000);
	await inPage(Q, `await s.peerApproval.requestConnect(arg);`, H.id);
	h.check(await until(H, () => card(H, Q.id), 30000), 'a removed peer that said it was reloading takes the card');
	h.check(!(await inRoster(H, Q.id)), 'and is not back in the roster');
	h.check(!(await linked(H, Q.id)), 'and has no link to the host');
	await h.closePeer(Q);
	await inPage(H, `s.pendingApprovals.set([]);`);

	await h.finish(browser);
});
