// Roadmap #14 CN — the Connect pill state machine + invite ~srv param. Single-page
// checks (idle → pending → Cancel roundtrip; param encode/decode). The two-peer
// connected/Disconnect flow is covered in the block at the bottom, env-gated on the
// theprototype.app hosts mapping (currently commented out locally): set
// TWO_PEER=1 with the mapping enabled to run it.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- idle ------------------------------------------------------------------
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
		'CN: pill starts in idle state'
	);
	h.check(
		await A.page.locator('input[placeholder="Enter peer ID to connect"]').first().isVisible(),
		'CN: idle shows the dial input'
	);

	// --- idle -> pending (dial a bogus id) --------------------------------------
	// no signaling server in the headless env (peer.open stays false and a real
	// peer.connect would return undefined) — simulate an OPEN link with a stub conn
	// so the dial flows through the real state machine.
	await A.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		Object.defineProperty(p.peer, 'open', { value: true, configurable: true });
		p.peer.connect = (id) => ({ peer: id, open: false, on() {}, close() {}, send() {} });
	});
	await A.page.fill('input[placeholder="Enter peer ID to connect"]', 'ffff1');
	await A.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await A.page.waitForTimeout(400);
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'pending',
		'CN: dialing flips the pill to pending'
	);
	h.check(
		await A.page.locator('#cancel-request-button').first().isVisible(),
		'CN: pending shows the amber Cancel button'
	);
	// The pending STATUS is the gray disabled input that keeps the pill a stable
	// width ("Requesting <ID>", title "Waiting for approval"). This used to look for
	// a `data-testid="connect-pending"` that the CN drawer redesign never carried
	// over — the element never existed in src, so the check could only ever fail.
	const pendingInput = A.page.locator('.cx-connect input[disabled]').first();
	const pendingValue = await pendingInput.inputValue();
	h.check(
		(await pendingInput.isVisible()) && /^Requesting FFFF1$/i.test(pendingValue),
		`CN: pending shows the waiting-for-approval status ("${pendingValue}")`
	);

	// --- Cancel -> back to idle, stores fully unwound ----------------------------
	await A.page.locator('#cancel-request-button').click();
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
		'CN: Cancel returns the pill to idle'
	);
	const unwound = await A.page.evaluate(() => {
		const read = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v;
		};
		return {
			waiting: read(window.__stores.waitingForApproval).length,
			roster: read(window.__stores.userdata).length,
			conn: !!read(window.__stores.peers)?.connections?.['ffff1'],
			host: read(window.__stores.connectionState.sessionHost)
		};
	});
	h.check(unwound.waiting === 0, 'CN: cancel cleared waitingForApproval');
	h.check(unwound.roster === 1, 'CN: cancel un-whitelisted the dialed peer (roster = self only)');
	h.check(unwound.conn === false, 'CN: cancel dropped the pending connection');
	h.check(unwound.host === null, 'CN: sessionHost stays null');

	// the restoreConnection retry loop must NOT resurrect the cancelled conn
	await A.page.waitForTimeout(4500);
	const resurrect = await A.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		return !!p?.connections?.['ffff1'];
	});
	h.check(resurrect === false, 'CN: the 4s restore retry does not resurrect a cancelled conn');

	// --- invite ~srv param: encode + parse round-trips ---------------------------
	const param = await A.page.evaluate(() => {
		const ps = window.__stores.peerServer;
		return {
			selfHosted: ps.inviteServerParam({ kind: 'self-hosted', label: 'self-hosted', host: 'x', port: 443, path: '/peerjs', didFallback: false }),
			local: ps.inviteServerParam({ kind: 'local', label: 'local dev', host: 'localhost', port: 9001, path: '/peerjs', didFallback: false }),
			fallback: ps.inviteServerParam({ kind: 'public', label: 'public cloud', host: 'PeerJS public cloud', port: 443, path: '/', didFallback: true }),
			custom: ps.inviteServerParam({ kind: 'custom', label: 'custom', host: 'my.host', port: 9443, path: '/peerjs', didFallback: false }),
			parse: ps.parseInviteHash('#a1b2c~srv=public'),
			parsePlain: ps.parseInviteHash('#a1b2c'),
			decodePublic: ps.decodeInviteServer('public'),
			decodeCustom: ps.decodeInviteServer(encodeURIComponent('my.host:9443'))
		};
	});
	h.check(param.selfHosted === '' && param.local === '', 'CN-3: default-resolution servers add NO param');
	h.check(param.fallback === '~srv=public', 'CN-3: fallback encodes ~srv=public');
	h.check(param.custom === '~srv=' + encodeURIComponent('my.host:9443'), 'CN-3: custom encodes host:port');
	h.check(param.parse.peerId === 'a1b2c' && param.parse.srv === 'public', 'CN-3: parseInviteHash splits id + srv');
	h.check(param.parsePlain.peerId === 'a1b2c' && param.parsePlain.srv === null, 'CN-3: plain hash parses with no srv');
	h.check(param.decodePublic.forcePublic === true, 'CN-3: decode public -> forcePublic');
	h.check(param.decodeCustom.custom.host === 'my.host' && param.decodeCustom.custom.port === 9443, 'CN-3: decode custom -> host+port');

	// the copied invite link picks up the param when the status is non-default
	await A.page.evaluate(() => {
		window.__stores.peerServer.peerServerStatus.set({
			kind: 'public', label: 'public cloud', host: 'PeerJS public cloud', port: 443, path: '/', didFallback: true
		});
	});
	await A.page.waitForTimeout(150);
	const copied = await A.page.evaluate(async () => {
		// no signaling server in the headless env — simulate the id arriving so the
		// copy guard ("Generating...") passes, then stub the clipboard and click copy
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		p?.updateIdFn?.('abc12');
		await new Promise((r) => setTimeout(r, 50));
		let captured = null;
		navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
		document.querySelector('.connect-pill button')?.click(); // first button = copy
		await new Promise((r) => setTimeout(r, 100));
		return captured;
	});
	h.check(!!copied && copied.includes('#ABC12~srv=public'), 'CN-3: copied invite link carries ~srv on fallback (' + copied + ')');

	// --- two-peer connected + Disconnect (env-gated) ----------------------------
	if (process.env.TWO_PEER) {
		const B = await h.setupPage(browser, 'B');
		await h.connect(A, B);
		h.check(
			(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'connected',
			'CN: dialer pill shows connected'
		);
		h.check(
			(await B.page.locator('.connect-pill').getAttribute('data-state')) === 'connected',
			'CN: approver pill shows connected'
		);
		const hosts = await Promise.all([A, B].map((P) =>
			P.page.evaluate(() => {
				let v;
				window.__stores.connectionState.sessionHost.subscribe((x) => (v = x))();
				return v;
			})
		));
		h.check(hosts[0] === B.id, 'CN: dialer sessionHost = approver id');
		h.check(hosts[1] === null, 'CN: approver sessionHost = null (hosting)');
		h.check(await A.page.locator('#disconnect-button').first().isVisible(), 'CN: red Disconnect visible');
		await A.page.locator('#disconnect-button').click();
		await A.page.waitForTimeout(1500);
		h.check(
			(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
			'CN: Disconnect returns the dialer to idle'
		);
		await h.eventually(
			() => B.page.locator('.connect-pill').getAttribute('data-state'),
			(s) => s === 'idle',
			'CN: the approver self-heals back to idle'
		);
	} else {
		console.log('  (two-peer connected/Disconnect block skipped — set TWO_PEER=1 with the hosts mapping enabled)');
	}

	await h.finish(browser);
});
