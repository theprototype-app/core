// R22 round 10: A HALF-CONFIGURED TURN SERVER MUST NOT KILL EVERY CONNECTION.
//
// Reported as "I get a peerID but no connect toasts" with the env host, while setting the
// same server by hand in Settings worked. The mechanism, measured: `.env` had
// VITE_TURN_USERNAME set and VITE_TURN_CREDENTIAL empty, `iceServers()` gated on the
// username only, and Chromium does not degrade for a credential-less TURN entry — it
// THROWS constructing the RTCPeerConnection:
//
//   InvalidAccessError: Failed to construct 'RTCPeerConnection':
//   ICE server parsing failed: TURN server with empty username or password
//
// Signaling is unaffected, so the app hands you a peer id and then silently cannot open a
// data channel to anybody. Round 9 made the env config apply on localhost, which exposed
// it; the same dead state is reachable by any user who fills a TURN url + username in
// Settings and leaves the password blank.
//
// THE GUARD IS THE BROWSER'S OWN VERDICT: build the options the app would use and hand
// them to a real RTCPeerConnection. With the old gate that constructor throws, so this
// cannot pass vacuously.
const h = require('./helpers.cjs');

/** the ICE servers the app would use for a given stored config */
const iceFor = (page, cfg) =>
	page.evaluate((c) => {
		window.__stores.peerServer.peerServerConfig.set(c);
		const { options } = window.__stores.peerServer.resolvePeerOptions({ isLocalDev: false });
		const servers = options?.config?.iceServers ?? [];
		let constructed = 'ok';
		try {
			// the exact object peerjs hands to WebRTC
			const pc = new RTCPeerConnection(options?.config ?? {});
			pc.close();
		} catch (e) {
			constructed = String(e && e.name ? e.name : e);
		}
		return { servers, constructed };
	}, cfg);

const custom = (extra) => ({
	mode: 'custom',
	custom: {
		host: 'peerjs.theprototype.app',
		port: 443,
		path: '/peerjs',
		secure: true,
		key: '',
		stunUrls: 'stun:peerjs.theprototype.app:3478',
		turnUrls: 'turn:peerjs.theprototype.app:3478?transport=udp',
		turnUsername: '',
		turnCredential: '',
		...extra
	}
});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.peerServer, null, { timeout: 30000 });

	// ---- 1. a username with NO credential: the shape that throws ---------------------
	const halfA = await iceFor(page, custom({ turnUsername: 'prototype', turnCredential: '' }));
	h.check(
		halfA.constructed === 'ok',
		`a TURN username with no credential still builds a usable RTCPeerConnection (${halfA.constructed})`
	);
	h.check(
		!halfA.servers.some((s) => JSON.stringify(s.urls).includes('turn:')),
		`and the half-configured TURN server is DROPPED (${JSON.stringify(halfA.servers)})`
	);
	h.check(
		halfA.servers.some((s) => JSON.stringify(s.urls).includes('stun:')),
		'while STUN survives — dropping TURN must not take the rest of the config with it'
	);

	// ---- 2. a credential with NO username: the same shape, the other way round -------
	const halfB = await iceFor(page, custom({ turnUsername: '', turnCredential: 'secret' }));
	h.check(
		halfB.constructed === 'ok' &&
			!halfB.servers.some((s) => JSON.stringify(s.urls).includes('turn:')),
		`a credential with no username is dropped too (${halfB.constructed})`
	);

	// ---- 3. WHITESPACE is not a credential ------------------------------------------
	const blank = await iceFor(page, custom({ turnUsername: 'prototype', turnCredential: '   ' }));
	h.check(
		blank.constructed === 'ok' &&
			!blank.servers.some((s) => JSON.stringify(s.urls).includes('turn:')),
		`a whitespace-only credential is not a credential (${blank.constructed})`
	);

	// ---- 4. a COMPLETE pair is kept, verbatim ---------------------------------------
	const full = await iceFor(page, custom({ turnUsername: 'prototype', turnCredential: 'pw' }));
	const turn = full.servers.find((s) => JSON.stringify(s.urls).includes('turn:'));
	h.check(!!turn, 'a fully configured TURN server is kept');
	h.check(
		turn?.username === 'prototype' && turn?.credential === 'pw',
		`with both halves carried through (${JSON.stringify(turn)})`
	);
	h.check(full.constructed === 'ok', 'and it constructs');

	// ---- 5. no TURN at all is a perfectly good config --------------------------------
	const none = await iceFor(page, custom({ turnUrls: '', turnUsername: '', turnCredential: '' }));
	h.check(
		none.constructed === 'ok' && none.servers.length === 1,
		`STUN only is valid (${JSON.stringify(none.servers)})`
	);

	h.check((h.pageErrors(A) || []).length === 0, `no page errors (${(h.pageErrors(A) || []).join(' | ')})`);
	await h.finish(browser);
});
