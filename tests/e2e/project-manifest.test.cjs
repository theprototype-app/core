// 21-G2 — THE PROJECT MANIFEST, document mechanics: the one mutable thing in a
// project. Scene names point at HISTORIES of immutable hashes; last save wins the
// pointer, nothing is destroyed. This suite covers the document itself (writes,
// latest-wins, the viewer gate, persistence, the late joiner); the travel-away
// auto-save hook is covered in scene-levels once G1's rename lands.
//
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- project-manifest
const h = require('./helpers.cjs');

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.connect(A, B);

	// ---- 1. the write path: publish, pointer, history ------------------------------
	const w1 = await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		return [
			m.publishSceneVersion('Arena', 'hash-a1'),
			m.publishSceneVersion('Arena', 'hash-a2'),
			m.publishSceneVersion('Arena', 'hash-a2'), // pointer already there: refused
			m.publishSceneVersion('Pit', 'hash-p1')
		];
	});
	h.check(JSON.stringify(w1) === '[true,true,false,true]', `publish semantics (${JSON.stringify(w1)})`);
	const mA = await manifestOf(A);
	h.check(
		JSON.stringify(mA.scenes.Arena.history) === '["hash-a1","hash-a2"]',
		`history is append-only, pointer last (${JSON.stringify(mA.scenes.Arena.history)})`
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena'))) === 'hash-a2',
		'latestSceneHash reads the pointer'
	);
	// restore-previous is a RE-APPEND, never a dedupe — the pointer must move back
	await A.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Arena', 'hash-a1'));
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena'))) === 'hash-a1',
		'restoring an old version re-appends it — nothing is destroyed and the pointer moves'
	);

	// ---- 2. replication: latest-wins, both directions ------------------------------
	await h.eventually(
		() => manifestOf(B),
		(m) => m.scenes?.Arena?.history?.length === 3 && m.scenes?.Pit?.history?.length === 1,
		'the peer converges on the same document'
	);
	await B.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Pit', 'hash-p2'));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Pit')),
		(v) => v === 'hash-p2',
		"and A converges on B's write — symmetric, latest-wins"
	);

	// ---- 3. the badge read + the prune set ------------------------------------------
	const stale = await A.page.evaluate(() => window.__stores.projectManifest.staleSceneHash('hash-a2'));
	h.check(stale === 'Arena', `a hash behind the pointer names its scene (${stale})`);
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.staleSceneHash('hash-a1'))) === null,
		'the pointer itself is never stale'
	);
	const keep = await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		for (let i = 0; i < 14; i++) m.publishSceneVersion('Tower', 'hash-t' + i);
		m.pinSceneVersion('Tower', 'hash-t1', true);
		return [...m.keepableHashes('Tower')].sort();
	});
	h.check(
		keep.length === 11 && keep.includes('hash-t1') && keep.includes('hash-t13') && !keep.includes('hash-t2'),
		`prune keeps the newest 10 plus the pin (${keep.length} kept, pin ${keep.includes('hash-t1')})`
	);
	h.check(
		(await manifestOf(A)).scenes.Tower.history.length === 14,
		'the MANIFEST keeps the full list — pruning is about local bytes, never history'
	);

	// ---- 4. persistence: a reload comes back with the project ------------------------
	await A.page.waitForTimeout(400); // let the fire-and-forget idb write land
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena')),
		(v) => v === 'hash-a1',
		'a reload restores the local project from idb'
	);

	// ---- 5. the viewer gate (fork 3): inert without a plugin, enforced with one ------
	const gated = await B.page.evaluate(() => {
		const s = window.__stores;
		s.cloudHooks.rolesInfo.set({ myRole: 'viewer', amAdmin: false, roleOf: () => 'viewer' });
		const refused = s.projectManifest.publishSceneVersion('Arena', 'hash-viewer');
		s.cloudHooks.rolesInfo.set(null);
		const allowed = s.projectManifest.publishSceneVersion('Arena', 'hash-editor');
		return { refused, allowed };
	});
	h.check(gated.refused === false && gated.allowed === true, `viewers never publish; without a plugin the gate is inert (${JSON.stringify(gated)})`);

	// ---- 6. a LATE JOINER receives the project through the handshake -----------------
	const C = await h.setupPage(browser, 'C');
	// the joiner dials (the 21-F trap) — and dials B: A was freshReload-ed in section 4,
	// which minted it a NEW peer id, so the id captured at setup no longer answers
	await h.connect(C, B);
	await h.eventually(
		() => C.page.evaluate(() => window.__stores?.projectManifest ? window.__stores.projectManifest.latestSceneHash('Tower') : null),
		(v) => v === 'hash-t13',
		'the late joiner converges via getproject with nothing else sent',
		30000
	);

	// =====================================================================
	// 7. THE TRAVEL-AWAY AUTO-SAVE (fork 9) — the reported disappearing-object
	//    case, dead. Solo on C: alone = the session writer.
	// =====================================================================
	const historyOf = (peer, name) =>
		peer.page.evaluate((n) => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
			return m.scenes[n]?.history ?? [];
		}, name);
	const childCount = (peer) =>
		peer.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g?.children.length ?? 0;
		});
	// C is still connected to B — B is C's host, so C is NOT the writer. Disconnect
	// first: the auto-save is writer-only and this section needs C writing.
	await C.page.evaluate(() => {
		const s = window.__stores;
		let p; s.peers.subscribe((v) => (p = v))();
		p?.leaveSession?.();
		s.commandsHandler.clearSceneLocal();
	});
	await C.page.waitForTimeout(600);
	const writerC = await C.page.evaluate(() => {
		let host; window.__stores.connectionState.sessionHost.subscribe((v) => (host = v))();
		return host === null;
	});
	h.check(writerC, 'premise: C left the session and is its own writer');

	// scene Alpha: one box, saved (publishes v1)
	await C.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	const alpha1 = await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Alpha'));
	h.check(!!alpha1?.hash, 'Alpha v1 saved and published');
	const beta1 = await C.page.evaluate(() => window.__stores.levels.newLevel('Beta'));
	// newLevel makes the ASSET only — publish it so name-travel can find it
	await C.page.evaluate(({ hash }) => window.__stores.projectManifest.publishSceneVersion('Beta', hash), { hash: beta1.hash });

	// go to Beta, BUILD there (the reported case), hop to Alpha, come back BY NAME
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(() => childCount(C), (n) => n === 0, 'premise: Beta is empty');
	await C.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	const betaHistBefore = (await historyOf(C, 'Beta')).length;
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Alpha'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'arrived on Alpha (its one box)');
	h.check(
		(await historyOf(C, 'Beta')).length === betaHistBefore + 1,
		'leaving Beta AUTO-PUBLISHED the edit as a new version'
	);
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(
		() => childCount(C),
		(n) => n === 1,
		'THE REPORTED BUG IS DEAD: the object built in Beta is there when you come back'
	);

	// =====================================================================
	// 8. AN IDLE HOP MINTS NOTHING — the signature gate across a real
	//    load -> serialize round trip
	// =====================================================================
	const alphaHist = (await historyOf(C, 'Alpha')).length;
	const betaHist = (await historyOf(C, 'Beta')).length;
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Alpha'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'on Alpha');
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'back on Beta');
	h.check(
		(await historyOf(C, 'Alpha')).length === alphaHist && (await historyOf(C, 'Beta')).length === betaHist,
		`idle hops minted NOTHING (Alpha ${(await historyOf(C, 'Alpha')).length}/${alphaHist}, Beta ${(await historyOf(C, 'Beta')).length}/${betaHist})`
	);

	// =====================================================================
	// 9. the "update available" dot: the OLD Beta version is stale
	// =====================================================================
	const staleBeta = await C.page.evaluate(({ hash }) => window.__stores.projectManifest.staleSceneHash(hash), { hash: beta1.hash });
	h.check(staleBeta === 'Beta', `the first Beta file reads as an older version of "${staleBeta}"`);

	for (const p of [A, B, C]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
