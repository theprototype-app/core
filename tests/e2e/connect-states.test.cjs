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

	// --- Enter in the dial box IS the Connect button -----------------------------
	// REPORTED: "when I enter peer id and hit enter it should connect (as now I need to
	// hit tab and then enter)". One field, one obvious commit key.
	//
	// COUNTERFACTUAL, measured with the `onkeydown` removed from the Input: the pill
	// stayed idle and waitingForApproval stayed empty — the keypress went nowhere, which
	// is the bug as reported. The stub above is still installed, so this runs the real
	// dial state machine; the scene is EMPTY here, which also proves the round-31 ask
	// stands down when there is nothing unsaved to ask about.
	// the box still holds the id the Cancel section typed — clear it, or "empty" is a
	// premise this suite does not actually have (it dialled ffff1 again and read pending)
	const dialBox = A.page.locator('input[placeholder="Enter peer ID to connect"]').first();
	await dialBox.fill('');
	await dialBox.click();
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
		'CN: Enter on an EMPTY box does nothing — no dial to nowhere'
	);
	await dialBox.fill('eeee2');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(500);
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'pending',
		'CN: Enter in the dial box dials — no Tab to the button first'
	);
	const dialedByKey = await A.page.evaluate(() => {
		let v;
		window.__stores.waitingForApproval.subscribe((x) => (v = x))();
		return v.map((w) => w[0]);
	});
	h.check(
		dialedByKey.includes('eeee2'),
		`CN: …and it dialled the id that was typed (${JSON.stringify(dialedByKey)})`
	);
	h.check(
		(await A.page.evaluate(() => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return d;
		})) === null,
		'CN: an EMPTY scene raises no unnamed-scene question on the way out'
	);
	await A.page.locator('#cancel-request-button').click();
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
		'CN: cancel unwinds the Enter-dialled request too'
	);

	// --- round 33: THE DIAL ASKS NOTHING -----------------------------------------
	//
	// Round 31 put a question AT THE DIAL ("Save & connect / Connect anyway / Cancel")
	// whenever there was work in an unnamed scene, and held the dial until it was
	// answered. Round 33 DELIBERATELY REVERSED that: a dial is a request, and being made
	// to name a scene in order to ASK is a toll on a door that may not open. The question
	// moved to the HOST's APPROVAL, where the facts are known, as a blocking modal —
	// `connect-decision` owns all three of its endings.
	//
	// What is left to prove HERE is the reversal itself, on the pill: the same press that
	// round 31 held now goes straight out with no dialog of any kind. This block is the
	// exact inversion of the one it replaces, so it stays falsifiable — restore
	// `settleSceneIdentity()`'s early return in requestConnect and both checks go red.
	//
	// The approval-side modal is NOT asserted here and cannot be: the stub installed above
	// fakes an OPEN signaling link with a conn that never opens and no peer on the far
	// end, so nothing this page can do gets the request approved.
	const dialogNow = () =>
		A.page.evaluate(() => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return d ? { title: d.title, message: d.message, choices: (d.choices ?? []).map((c) => c.value) } : null;
		});
	const waitingNow = () =>
		A.page.evaluate(() => {
			let w;
			window.__stores.waitingForApproval.subscribe((x) => (w = x))();
			return w.map((/** @type {any} */ e) => e[0]);
		});
	const pressConnect = async (id) => {
		await dialBox.fill(id);
		await A.page.getByRole('button', { name: 'Connect', exact: true }).click();
	};

	// the scene is still empty here — that is the case the checks above already dialled
	// through, so give it work and nothing else
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});
	const sceneNow = await A.page.evaluate(() => {
		let g, at;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		window.__stores.levels.currentLevel.subscribe((x) => (at = x))();
		return { objects: g?.children.length ?? 0, name: at?.name ?? null };
	});
	h.check(
		sceneNow.objects === 1 && sceneNow.name === null,
		`premise: work in a scene with no identity at all (${JSON.stringify(sceneNow)})`
	);

	await pressConnect('dddd3');
	// bounded settle: long enough for the round-31 guard's on-demand `levels` import plus
	// its dialog to have appeared (it was given 8s and measured well inside 1.5s), so a
	// dialog that still exists would be seen here.
	await A.page.waitForTimeout(1500);
	h.check(
		(await dialogNow()) === null,
		`R33: dialing with work in an UNNAMED scene puts NO question at the dial (${JSON.stringify(await dialogNow())})`
	);
	h.check(
		(await waitingNow()).includes('dddd3') &&
			(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'pending',
		`R33: …the request goes straight out instead (${JSON.stringify(await waitingNow())})`
	);

	await A.page.locator('#cancel-request-button').click();
	await A.page.waitForTimeout(400);
	h.check(
		(await waitingNow()).length === 0 &&
			(await A.page.locator('.connect-pill').getAttribute('data-state')) === 'idle',
		'R33: and it cancels like any other outbound request'
	);

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
