// 24-D: an invite link pasted INTO THE OPEN TAB. A hash-only navigation never reloads,
// and the hash was read only at startup, so `#75F41~srv=…` pasted over a running app did
// nothing (reported). D1 adds the live `hashchange` reader (lib/inviteLinks.js): dial,
// "own id" / "already connected" refusals, a two-button ask when already in a session,
// a confirmation naming the host when the link pins ANOTHER server. D2 adds
// `switchServer` so that confirmation can act without a reload, and Settings ▸
// Connection's "Apply" uses it.
//
// Three peers on the self-hosted signaling box; the D2 section seeds one context on a
// CUSTOM server config and one on the public cloud, and moves the first across.
const h = require('./helpers.cjs');

const openPeers = (peer) => peer.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return [...(p?.openedPeers ?? [])]; });
const pendingOut = (peer) => peer.page.evaluate(() => { let w; window.__stores.waitingForApproval.subscribe((x) => (w = x))(); return w.filter((e) => e[1] === 'pending').map((e) => e[0]); });
const lastToasts = (peer) => peer.page.evaluate(() => { let n; window.__stores.notifications.subscribe((x) => (n = x))(); return n.slice(-4).map((x) => x.text); });
const navCount = (peer) => peer.page.evaluate(() => performance.getEntriesByType('navigation').length);
const serverKind = (peer) => peer.page.evaluate(() => { let s; window.__stores.peerServer.peerServerStatus.subscribe((x) => (s = x))(); return s?.kind ?? null; });
// the toast STACK hides while the Connect drawer is open (toasts route into its Toasts
// tab) — a dial opens the drawer, so close it before each paste to press the buttons
const paste = (peer, hash) =>
	peer.page.evaluate((hash) => {
		window.__stores.connectDrawerOpen.set(false);
		location.hash = hash;
	}, hash);
const approveOn = async (peer) => {
	await peer.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 });
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');
	const urlBefore = B.page.url();

	// ---- 1. paste A's id into B's open tab: B dials, A approves, no navigation -----
	await paste(B, '#' + A.id.toUpperCase()); // links carry the id upper-case; the dial lower-cases
	await h.eventually(() => pendingOut(B), (p) => p.includes(A.id), 'B dials A on hashchange (pending request)', 10000);
	await approveOn(A);
	await h.eventually(() => openPeers(B), (p) => p.includes(A.id), 'B is connected to A after the approval', 30000);
	h.check((await navCount(B)) === 1 && B.page.url().split('#')[0] === urlBefore.split('#')[0], `no navigation happened on B (${await navCount(B)} navigation entry)`);
	h.check(!B.page.url().includes('#' + A.id), `the hash was consumed (${B.page.url()})`);
	await B.page.waitForTimeout(3000);

	// ---- 2. own id / current host: refusals, no dial ---------------------------------
	await paste(B, '#' + B.id);
	await B.page.waitForTimeout(400);
	let toasts = await lastToasts(B);
	h.check(toasts.some((t) => /your own invite link/i.test(t)), `own id → "your own invite link" (${JSON.stringify(toasts.at(-1))})`);
	await paste(B, '#' + A.id);
	await B.page.waitForTimeout(400);
	toasts = await lastToasts(B);
	h.check(toasts.some((t) => /Already connected to/.test(t)), `the current host's id → "Already connected" (${JSON.stringify(toasts.at(-1))})`);
	h.check((await pendingOut(B)).length === 0, 'neither refusal dialled anything');

	// ---- 3. in a session, pasting C's id asks; Stay keeps the session ----------------
	await paste(B, '#' + C.id);
	await B.page.waitForTimeout(400);
	toasts = await lastToasts(B);
	h.check(toasts.some((t) => /Leave it and join/.test(t)), `a third id while connected asks to leave first (${JSON.stringify(toasts.at(-1))})`);
	await B.page.getByRole('button', { name: 'Stay' }).click({ timeout: 10000 });
	await B.page.waitForTimeout(600);
	h.check((await openPeers(B)).includes(A.id) && (await pendingOut(B)).length === 0, 'Stay leaves the session with A intact and dials nobody');

	// ---- 4. ...and Leave & join leaves A and dials C ---------------------------------
	await paste(B, '#' + C.id);
	await B.page.waitForTimeout(400);
	await B.page.getByRole('button', { name: 'Leave & join' }).click({ timeout: 10000 });
	await h.eventually(() => openPeers(A), (p) => !p.includes(B.id), 'A sees B leave (goodbye delivered)', 20000);
	await h.eventually(() => pendingOut(B), (p) => p.includes(C.id), 'B dials C', 10000);
	await approveOn(C);
	await h.eventually(() => openPeers(B), (p) => p.includes(C.id) && !p.includes(A.id), 'B is connected to C and no longer to A', 30000);
	h.check((await navCount(B)) === 1, 'still no navigation on B');

	// ---- 5. the decision function's edge cases, directly -----------------------------
	const edge = await B.page.evaluate(async () => {
		const f = window.__stores.inviteLinks.handleInviteHash;
		return { empty: await f(''), hashOnly: await f('#'), badSrv: await f('#zzzzz~srv=%zz') };
	});
	h.check(edge.empty === 'none' && edge.hashOnly === 'none', `an empty hash (our own clears) is ignored (${edge.empty}, ${edge.hashOnly})`);
	h.check(edge.badSrv === 'none', `an unreadable ~srv is refused without a dial (${edge.badSrv})`);

	await h.finish(browser);
});
