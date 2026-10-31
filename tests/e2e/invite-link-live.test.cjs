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
// 41 G16: the two QUESTIONS (leave this session? / join on another server?) are confirmDialog
// modals now, not toasts — so they are read from the dialog record, never from the toast log
const question = (peer) => peer.page.evaluate(() => { let d; window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))(); return d ? (d.title ?? '') + ' | ' + (d.message ?? '') : ''; });
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
	await h.approveButton(peer.page).click({ timeout: 30000 });
};
/** press a toast action button. The button is asserted RENDERED and laid out, then
 * clicked through the DOM: Playwright's actionability probe on the animated toast
 * card timed out intermittently while the button was plainly there (its hit-test
 * lands on the fly-in transition), and what this suite proves is the DECISION each
 * button makes — asserted on the session state right after. */
const clickToast = async (peer, name) => {
	const found = await peer.page.evaluate((name) => {
		// 41 G16: the leave/join questions are kit modals now (dialog buttons), other prompts stay toasts
		const all = [...document.querySelectorAll('.tp-toast-action, dialog[open] button')];
		const button = all.find((b) => b.textContent.trim() === name);
		if (!button) return { found: false, buttons: all.map((b) => b.textContent.trim()) };
		const laidOut = button.offsetParent !== null && button.getBoundingClientRect().width > 0;
		if (laidOut) button.click();
		return { found: true, laidOut };
	}, name);
	h.check(found.found && found.laidOut, `the "${name}" toast button is rendered (${JSON.stringify(found)})`);
	await peer.page.waitForTimeout(300);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
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
	await h.eventually(() => question(B), (q) => /Leave it and join/.test(q), 'a third id while connected asks to leave first', 10000);
	await clickToast(B, 'Stay');
	await B.page.waitForTimeout(600);
	h.check((await openPeers(B)).includes(A.id) && (await pendingOut(B)).length === 0, 'Stay leaves the session with A intact and dials nobody');

	// ---- 4. ...and Leave & join leaves A and dials C ---------------------------------
	await paste(B, '#' + C.id);
	await B.page.waitForTimeout(400);
	await clickToast(B, 'Leave & join');
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

	// ---- 6. D2: a link pinning ANOTHER server switches at runtime, then dials ---------
	// A, B and C are done with (section 7 needs A's id STRING only — it dials an unreachable server):
	// close them, so D and E boot on a browser that is not already rendering three software-GL
	// pages. A fourth page there took more than 90 s to boot (43-tests e2e/r2-invite-link-live.1.log).
	for (const peer of [A, B, C]) await h.closePeer(peer);
	// D on a CUSTOM config (the self-hosted box spelled out), E on the public cloud
	const custom = { mode: 'custom', custom: { host: 'peerjs.theprototype.app', port: 443, path: '/peerjs', secure: true } };
	const D = await h.setupPage(browser, 'D', { storage: { peerServerConfig: JSON.stringify(custom) } });
	const E = await h.setupPageQuiet(browser, 'E', [D], { storage: { peerServerConfig: JSON.stringify({ mode: 'public' }) } });
	h.check((await serverKind(D)) === 'custom' && (await serverKind(E)) === 'public', `premise: D on a custom server, E on the public cloud (${await serverKind(D)}, ${await serverKind(E)})`);
	await paste(D, '#' + E.id + '~srv=public');
	await D.page.waitForTimeout(400);
	await h.eventually(() => question(D), (q) => /\| Join .* on the public PeerJS cloud\?/.test(q), 'a link pinning another server asks, naming it', 10000);
	await clickToast(D, 'Join');
	await h.eventually(() => serverKind(D), (k) => k === 'public', 'D switched to the public cloud without a reload', 20000);
	await h.eventually(() => pendingOut(D), (p) => p.includes(E.id), 'D dials E on the new server', 15000);
	await approveOn(E);
	await h.eventually(() => openPeers(D), (p) => p.includes(E.id), 'D is connected to E across the switch', 40000);
	h.check((await navCount(D)) === 1, 'no navigation on D');
	const idKept = await D.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return p.peer.id; });
	h.check(idKept === D.id, `D kept its session id across the switch (${idKept} = ${D.id})`);

	// ---- 7. D2: a pinned server that never opens: back where you were, said so -------
	await D.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); p.leaveSession(); });
	await D.page.waitForTimeout(1500);
	await paste(D, '#' + A.id + '~srv=' + encodeURIComponent('nonexistent.invalid:4443'));
	await D.page.waitForTimeout(400);
	await clickToast(D, 'Join');
	await h.eventually(() => lastToasts(D), (t) => t.some((x) => /Could not reach nonexistent\.invalid:4443/.test(x)), 'an unreachable pinned server is reported by name', 30000);
	await h.eventually(() => serverKind(D), (k) => k === 'public', 'D is back on the server it had (public)', 20000);
	h.check((await pendingOut(D)).length === 0, 'and nothing was dialled');
	// the state is read whole so a red says where it stopped (45 s: well past the 8 s switch
	// timeout plus one capped backoff)
	await h.eventually(
		() => D.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return { open: !!p.peer?.open, id: p.peer?.id ?? null, disconnected: !!p.peer?.disconnected, destroyed: !!p.peer?.destroyed, idRetries: p.idRetries ?? null }; }),
		(o) => o.open,
		'the rebuilt link on the previous server opened',
		45000
	);
	// RED BY AN APP BUG, not by the test (43-tests STATUS "Real bugs" #2, ~half the runs on either server):
	// the rebuild collides with this peer's own still-held registration ("ID … is taken"), the
	// collision retry mints a new id, and the link then never opens and never errors. The net log
	// printed here is the evidence.
	if (!(await D.page.evaluate(() => { let p; window.__stores.peers.subscribe((x) => (p = x))(); return !!p.peer?.open; })))
		console.log('  net log: ' + JSON.stringify(await D.page.evaluate(() => window.__stores.diagnostics.lines().filter((l) => /net|peer|signal/i.test(JSON.stringify(l))).slice(-15))));

	// ---- 8. D2: Settings ▸ Connection "Apply" switches without a reload -------------
	await D.page.evaluate((cfg) => {
		window.__stores.peerServer.peerServerConfig.set(cfg);
		window.__stores.settingsSection.set('connection');
		window.__stores.settingsOpen.set(true);
	}, custom);
	await D.page.waitForSelector('#peer-server-apply', { timeout: 15000 });
	await D.page.locator('#peer-server-apply').click();
	await h.eventually(() => serverKind(D), (k) => k === 'custom', 'Apply moved D to the configured custom server, no reload', 20000);
	h.check((await navCount(D)) === 1, 'still one navigation entry on D');
	await D.page.evaluate(() => window.__stores.settingsOpen.set(false));

	// ---- 9. 69 T8: a link that names a server, opened in a NEW tab, asks too ---------
	// It used to switch at load with no word: the server in a link sees everyone's address.
	const srvHost = 'nonexistent.invalid:4443';
	const F = await h.setupPageQuiet(browser, 'F', [D], { hash: '#' + D.id + '~srv=' + encodeURIComponent(srvHost) });
	await h.eventually(() => question(F), (q) => /\| Join .* on nonexistent\.invalid:4443\?/.test(q) && /IP address/.test(q), 'a new tab on a link naming a server asks first, naming it', 20000);
	const fHost = await F.page.evaluate(() => { let s; window.__stores.peerServer.peerServerStatus.subscribe((x) => (s = x))(); return s?.host ?? s?.kind ?? null; });
	h.check(fHost !== 'nonexistent.invalid', `nothing switched before the answer (${fHost})`);
	await clickToast(F, 'Stay on mine');
	await F.page.waitForTimeout(1500);
	h.check((await pendingOut(F)).length === 0, 'Stay on mine: nothing was dialled');
	const fHostAfter = await F.page.evaluate(() => { let s; window.__stores.peerServer.peerServerStatus.subscribe((x) => (s = x))(); return s?.host ?? s?.kind ?? null; });
	h.check(fHostAfter !== 'nonexistent.invalid', `and the server stayed ours (${fHostAfter})`);

	await h.finish(browser);
});
