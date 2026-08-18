// A2 — HUD replication: two peers plus a LATE JOINER through `gethuds`.
//
// Golden rule 8, made explicit: the authored DOCUMENT replicates (latest-wins on
// changedAt) and the RUNTIME half never does — screen visibility is deliberately per-peer,
// so one player can sit on the start menu while another plays. That distinction is what
// this suite has to prove, because it will otherwise be reported as a bug either way.
//
// Run: $env:APP_URL='https://localhost:5201/'; PEER_CONFIG=...; npm run e2e -- hud-sync
const h = require('./helpers.cjs');

const readDoc = (peer) =>
	peer.page.evaluate(() => {
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		return doc
			? {
					screens: doc.screens.length,
					active: doc.active,
					changedAt: doc.changedAt,
					labels: doc.screens.flatMap((s) => s.elements.map((e) => e.label)),
					kinds: doc.screens.flatMap((s) => s.elements.map((e) => e.kind))
				}
			: null;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(A, B);

	// ---- 1. an authored document reaches the peer ----------------------------
	await A.page.evaluate(() => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', { screens: [{ id: 'main', name: 'Main', elements: [] }], active: 'main' });
		H.addHudElement('scene', 'main', { kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 20, y: 20 });
		H.addHudElement('scene', 'main', { kind: 'button', label: 'Start', anchor: 'center' });
	});
	await A.page.waitForTimeout(1500);
	const onB = await readDoc(B);
	h.check(!!onB, 'the HUD document reached the peer');
	h.check(
		onB?.labels.includes('Gems: 0') && onB?.labels.includes('Start'),
		`with both elements (${JSON.stringify(onB?.labels)})`
	);
	h.check(
		JSON.stringify(onB?.kinds.sort()) === '["button","text"]',
		`and their kinds (${JSON.stringify(onB?.kinds)})`
	);
	const bRenders = await B.page.evaluate(
		() => document.querySelectorAll('#hud-layer .hud-slot').length
	);
	h.check(bRenders === 2, `and the peer actually RENDERS them (${bRenders})`);

	// ---- 2. a receiver must NOT re-broadcast (golden rule 1) ----------------
	// The counter lives on `window` so it can be read AFTER the inbound edit lands; a
	// closed-over array inside one evaluate() is gone by the time the next one runs.
	await B.page.evaluate(async () => {
		const s = window.__stores;
		window.__bSent = [];
		const peer = await new Promise((r) => s.peers.subscribe((p) => r(p))());
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			if (msg?.type === 'hud' || msg?.type === 'huddelete') window.__bSent.push(msg.type);
			return real(msg);
		};
		window.__restoreSend = () => (peer.send = real);
	});
	await A.page.evaluate(() =>
		window.__stores.hudDocs.updateHudElement(
			'scene',
			'main',
			window.__stores.hudDocs.hudDocOf('scene').screens[0].elements[0].id,
			{ label: 'Gems: 3' }
		)
	);
	await A.page.waitForTimeout(1200);
	const echoed = await B.page.evaluate(() => {
		const labels = window.__stores.hudDocs
			.hudDocOf('scene')
			.screens.flatMap((s) => s.elements.map((e) => e.label));
		return labels;
	});
	h.check(echoed.includes('Gems: 3'), `the edit arrived (${JSON.stringify(echoed)})`);
	const bSent = await B.page.evaluate(() => window.__bSent.slice());
	h.check(
		bSent.length === 0,
		`and the RECEIVER sent nothing back — an applier that re-broadcast would loop (${JSON.stringify(bSent)})`
	);
	await B.page.evaluate(() => window.__restoreSend?.());

	// ---- 3. LATEST-WINS, and an EQUAL stamp is ACCEPTED ---------------------
	// Refusing an equal stamp is the bug that killed every write of a fast gesture after
	// the first: a DataConnection is ordered, so an equal stamp arrived LATER.
	const latestWins = await B.page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const S = window.__stores.hudSync;
		const mine = H.hudDocOf('scene');
		// a STRICTLY older document must be refused
		S.applyRemoteHud({
			key: 'scene',
			doc: { ...mine, changedAt: mine.changedAt - 1000, screens: [{ id: 'main', name: 'stale', elements: [] }] }
		});
		const afterStale = H.hudDocOf('scene').screens[0].elements.length;
		// an EQUAL stamp must be accepted
		S.applyRemoteHud({
			key: 'scene',
			doc: {
				...mine,
				changedAt: mine.changedAt,
				screens: [{ id: 'main', name: 'Main', elements: [{ id: 'e-equal', kind: 'text', label: 'equal-stamp' }] }]
			}
		});
		const afterEqual = H.hudDocOf('scene').screens[0].elements.map((e) => e.label);
		return { afterStale, afterEqual };
	});
	h.check(latestWins.afterStale > 0, `a STRICTLY older document is refused (${latestWins.afterStale} elements kept)`);
	h.check(
		latestWins.afterEqual.includes('equal-stamp'),
		`an EQUAL stamp is ACCEPTED — an ordered channel means it arrived later (${JSON.stringify(latestWins.afterEqual)})`
	);

	// ---- 4. screen visibility is PER-PEER, on purpose -----------------------
	const perPeer = await A.page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', {
			screens: [
				{ id: 'main', name: 'Main', elements: [{ id: 'hud-play', kind: 'text', label: 'PLAYING', anchor: 'top-left' }] },
				{ id: 'menu', name: 'Menu', elements: [{ id: 'hud-menu', kind: 'text', label: 'MENU', anchor: 'center' }] }
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 400));
		H.showHudScreen('scene', 'menu');
		await new Promise((r) => setTimeout(r, 500));
		return [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent);
	});
	await A.page.waitForTimeout(1400);
	const bStillPlaying = await B.page.evaluate(() => ({
		shown: [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent),
		docActive: window.__stores.hudDocs.hudDocOf('scene').active
	}));
	h.check(perPeer.includes('MENU'), `A is looking at the menu (${JSON.stringify(perPeer)})`);
	h.check(
		bStillPlaying.shown.includes('PLAYING') && !bStillPlaying.shown.includes('MENU'),
		`and B is still PLAYING — visibility is per-peer by design (${JSON.stringify(bStillPlaying.shown)})`
	);
	h.check(
		bStillPlaying.docActive === 'main',
		'the document both peers hold is unchanged; only the local view moved'
	);

	// the AUTHORED default, by contrast, DOES replicate
	await A.page.evaluate(() => window.__stores.hudDocs.setActiveHudScreen('scene', 'menu'));
	await A.page.waitForTimeout(1300);
	const bActive = await B.page.evaluate(() => ({
		docActive: window.__stores.hudDocs.hudDocOf('scene').active,
		shown: [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent)
	}));
	h.check(bActive.docActive === 'menu', `the AUTHORED default replicates (${bActive.docActive})`);
	h.check(
		bActive.shown.includes('MENU'),
		`so a peer with no local override follows it (${JSON.stringify(bActive.shown)})`
	);

	// ---- 5. a LATE JOINER pulls the whole map through gethuds ---------------
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });
	await h.connect(C, A);
	await C.page.waitForTimeout(2500);
	const onC = await readDoc(C);
	h.check(!!onC, 'a LATE JOINER receives the HUD it never saw authored');
	h.check(onC?.screens === 2, `with every screen (${onC?.screens})`);
	h.check(
		onC?.labels.includes('PLAYING') && onC?.labels.includes('MENU'),
		`and every element (${JSON.stringify(onC?.labels)})`
	);
	h.check(onC?.active === 'menu', `and the authored active screen (${onC?.active})`);
	const cRenders = await C.page.evaluate(
		() => [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent)
	);
	h.check(
		cRenders.includes('MENU'),
		`and renders it immediately, with no local override of its own (${JSON.stringify(cRenders)})`
	);

	// ---- 6. delete replicates too ------------------------------------------
	await A.page.evaluate(() => window.__stores.hudDocs.setHudDocFor('scene', null));
	await A.page.waitForTimeout(1400);
	const gone = await Promise.all([B, C].map((p) => readDoc(p)));
	h.check(gone[0] === null && gone[1] === null, 'deleting the document reaches every peer');
	const layersGone = await Promise.all(
		[B, C].map((p) => p.page.evaluate(() => !!document.querySelector('#hud-layer')))
	);
	h.check(!layersGone[0] && !layersGone[1], 'and their layers render nothing');

	await h.finish(browser);
});
