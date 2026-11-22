// 71 TR4 — HIDE MY IP, proved on the candidates themselves against a real TURN server (lib/miniTurn.cjs):
//   1 control: with the setting off the spy sees host candidates and nobody needs the relay
//   2 on for the dialler: only relay candidates leave it, its peer receives only relay candidates, the
//     selected pair is relayed, the relay really carried the bytes, and an edit still reaches the peer
//   3 on for the side being dialled: the answerer's candidates are relay-only too
//   4 Settings ▸ Privacy: the switch, the status line, the live Peer, and it survives a reload
//   5 fail closed: on with no relay server, the dial never connects, no candidate leaves and the toast
//     says why; the same pair with the setting off connects (the counterfactual)
// Run under a LOCAL slot: the browser has to reach the relay this process starts.
const os = require('os');
const h = require('./helpers.cjs');
const { startMiniTurn } = require('./lib/miniTurn.cjs');

const lanIp = () => {
	for (const list of Object.values(os.networkInterfaces())) {
		for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
	}
	return '127.0.0.1';
};

/** every RTCPeerConnection, what it was built with, and every candidate crossing it */
function spy() {
	const Real = window.RTCPeerConnection;
	window.__rtc = { pcs: [], local: [], remote: [] };
	const Wrapped = function (cfg) {
		const pc = new Real(cfg);
		window.__rtc.pcs.push({ pc, policy: cfg?.iceTransportPolicy ?? 'all' });
		pc.addEventListener('icecandidate', (e) => e.candidate?.candidate && window.__rtc.local.push(e.candidate.candidate));
		const add = pc.addIceCandidate.bind(pc);
		pc.addIceCandidate = (c, ...rest) => {
			if (c?.candidate) window.__rtc.remote.push(c.candidate);
			return add(c, ...rest);
		};
		return pc;
	};
	Wrapped.prototype = Real.prototype;
	window.RTCPeerConnection = Wrapped;
}

const typeOf = (c) => /\btyp (\w+)/.exec(c)?.[1] ?? '?';
const typesOf = (list) => [...new Set(list.map(typeOf))].sort();

/** what this page gathered, what it was told, how it was built, and the pair it picked */
const rtc = (peer, peerId) =>
	peer.page.evaluate(async (remoteId) => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		const pc = p?.connections?.[remoteId]?.peerConnection;
		let pair = null;
		if (pc) {
			const stats = await pc.getStats();
			stats.forEach((r) => {
				if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
					pair = { local: stats.get(r.localCandidateId)?.candidateType, remote: stats.get(r.remoteCandidateId)?.candidateType };
				}
			});
		}
		return {
			open: !!p?.connections?.[remoteId]?.open,
			local: window.__rtc.local,
			remote: window.__rtc.remote,
			// PeerJS's feature test builds one RTCPeerConnection at load and never gathers on it: only the ones used count
			policies: window.__rtc.pcs.filter((x) => x.pc.localDescription).map((x) => x.policy),
			sdp: pc?.localDescription?.sdp ?? '',
			pair
		};
	}, peerId);

h.run(async () => {
	const turn = await startMiniTurn({ host: lanIp() });
	console.log(`relay at ${turn.url}`);
	// the browser's mDNS masking would hide the peer's address from the relay's permission check on one machine
	const browser = await h.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
	const server = { host: process.env.VITE_PEER_HOST || 'peerjs.theprototype.app', port: 443, path: '/peerjs', secure: true, key: '', stunUrls: '' };
	const withRelay = JSON.stringify({ mode: 'custom', custom: { ...server, turnUrls: turn.url, turnUsername: turn.username, turnCredential: turn.credential } });
	// STUN only: a config with no ICE servers at all would mean PeerJS's own defaults, and those include a TURN server
	const noRelay = JSON.stringify({ mode: 'custom', custom: { ...server, stunUrls: `stun:${turn.host}:${turn.port}`, turnUrls: '', turnUsername: '', turnCredential: '' } });
	const page = (name, config, hide) => h.setupPageQuiet(browser, name, [], { init: spy, storage: { peerServerConfig: config, hideMyIp: String(hide) } });

	// ---- 1 control -------------------------------------------------------------------------------
	{
		const A = await page('A', withRelay, false);
		const B = await page('B', withRelay, false);
		await h.connect(A, B, 2000);
		const a = await rtc(A, B.id);
		h.check(a.open, '1.1 control: the pair connects');
		h.check(a.local.some((c) => typeOf(c) === 'host'), `1.2 the spy sees host candidates with the setting off (${typesOf(a.local)})`);
		h.check(a.policies.every((p) => p === 'all'), `1.3 no relay policy is set (${[...new Set(a.policies)]})`);
		h.check(a.pair?.local === 'host', `1.4 the pair is direct (${JSON.stringify(a.pair)})`);
		await h.closePeer(A);
		await h.closePeer(B);
	}

	// ---- 2 on for the dialler --------------------------------------------------------------------
	{
		const before = turn.stats.relayedOut;
		const A = await page('A', withRelay, true);
		const B = await page('B', withRelay, false);
		await h.connect(A, B, 2000);
		const a = await rtc(A, B.id);
		const b = await rtc(B, A.id);
		h.check(a.open, '2.1 the pair connects through the relay');
		h.check(a.local.length > 0 && typesOf(a.local).join() === 'relay', `2.2 only relay candidates leave the dialler (${typesOf(a.local)} x${a.local.length})`);
		h.check(a.policies.length > 0 && a.policies.every((p) => p === 'relay'), `2.3 every RTCPeerConnection it built is relay-only (${a.policies})`);
		h.check(!/typ (host|srflx|prflx)/.test(a.sdp), '2.4 its SDP carries no other candidate type');
		const fromA = b.remote.filter((c) => c.includes(turn.host));
		h.check(b.remote.length > 0 && typesOf(b.remote).join() === 'relay', `2.5 the peer is told relay candidates and nothing else (${typesOf(b.remote)})`);
		h.check(fromA.length === b.remote.length, '2.6 and they name the relay, not the dialler');
		h.check(a.pair?.local === 'relay', `2.7 the dialler's selected pair is relayed (${JSON.stringify(a.pair)})`);
		h.check(turn.stats.relayedOut > before, `2.8 the relay really carried the traffic (+${turn.stats.relayedOut - before} bytes)`);
		// an edit still gets through
		const scene = (peer) => peer.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.children.map((c) => c.uuid);
		});
		const before2 = (await scene(B)).length;
		await A.page.evaluate(() => {
			window.__stores.commandsHandler.sceneCommand('/create box');
		});
		await A.page.keyboard.press('Escape');
		await h.eventually(() => scene(B), (u) => u.length > before2, '2.9 an edit made behind the relay reaches the peer', 15000);
		await h.closePeer(A);
		await h.closePeer(B);
	}

	// ---- 3 on for the side being dialled ---------------------------------------------------------
	{
		const C = await page('C', withRelay, false);
		const D = await page('D', withRelay, true);
		await h.connect(C, D, 2000);
		const d = await rtc(D, C.id);
		const c = await rtc(C, D.id);
		h.check(d.open && c.open, '3.1 the pair connects');
		h.check(d.local.length > 0 && typesOf(d.local).join() === 'relay', `3.2 only relay candidates leave the side that was dialled (${typesOf(d.local)})`);
		h.check(c.remote.every((x) => typeOf(x) === 'relay'), `3.3 the dialler hears nothing else from it (${typesOf(c.remote)})`);
		await h.closePeer(C);
		await h.closePeer(D);
	}

	// ---- 4 Settings ------------------------------------------------------------------------------
	{
		const E = await page('E', withRelay, false);
		const policy = () =>
			E.page.evaluate(() => {
				let p;
				window.__stores.peers.subscribe((v) => (p = v))();
				return p.peer.options.config?.iceTransportPolicy ?? 'all';
			});
		await E.page.evaluate(() => {
			window.__stores.settingsSection.set('privacy');
			window.__stores.settingsOpen.set(true);
		});
		const row = E.page.locator('#row-hide-my-ip');
		await row.waitFor({ state: 'visible', timeout: 15000 });
		h.check((await row.innerText()).includes('never see your IP address'), '4.1 the row explains what it does');
		h.check((await policy()) === 'all', '4.2 off by default');
		await E.page.locator('#hide-my-ip').click({ force: true });
		await h.eventually(policy, (p) => p === 'relay', '4.3 the switch reaches the live Peer');
		await h.eventually(
			() => E.page.locator('#hide-my-ip-status').getAttribute('data-relay').catch(() => null),
			(v) => v === 'relay',
			'4.4 the status line says the relay is in use'
		);
		h.check((await E.page.evaluate(() => localStorage.getItem('hideMyIp'))) === 'true', '4.5 it is saved on this device');
		await E.page.locator('#hide-my-ip').click({ force: true });
		await h.eventually(policy, (p) => p === 'all', '4.6 off again reaches the live Peer');
		h.check((await E.page.locator('#hide-my-ip-status').count()) === 0, '4.7 and the status line goes');
		await h.closePeer(E);
	}

	// ---- 5 fail closed ---------------------------------------------------------------------------
	{
		const F = await page('F', noRelay, true);
		const G = await page('G', noRelay, false);
		await F.page.evaluate(() => {
			window.__stores.settingsSection.set('privacy');
			window.__stores.settingsOpen.set(true);
		});
		await h.eventually(
			() => F.page.locator('#hide-my-ip-status').getAttribute('data-relay').catch(() => null),
			(v) => v === 'no-relay',
			'5.1 the row says there is no relay'
		);
		await F.page.evaluate(() => window.__stores.settingsOpen.set(false));
		await F.page.locator('input[placeholder="Enter peer ID to connect"]').fill(G.id);
		await F.page.getByRole('button', { name: 'Connect', exact: true }).click();
		await h.eventually(
			() => F.page.getByText('Could not connect through a relay server').first().isVisible().catch(() => false),
			(v) => v === true,
			'5.2 the toast says why, instead of an endless Requesting',
			15000
		);
		const f = await rtc(F, G.id);
		h.check(!f.open, '5.3 no connection opened');
		h.check(f.local.length === 0, `5.4 no candidate left the page (${f.local.length})`);
		await h.closePeer(F);
		await h.closePeer(G);

		const F2 = await page('F2', noRelay, false);
		const G2 = await page('G2', noRelay, false);
		await h.connect(F2, G2, 2000);
		const f2 = await rtc(F2, G2.id);
		h.check(f2.open, '5.5 counterfactual: the same pair with the setting off connects');
		await h.closePeer(F2);
		await h.closePeer(G2);
	}

	turn.close();
	await h.finish(browser);
});
