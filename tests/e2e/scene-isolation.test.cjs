// R22 A1 — SCENE IDENTITY IN THE HANDSHAKE.
//
// The gap: a joiner who never travelled has `currentLevel === null`, so it publishes
// `atscene {scene:''}` and NOTHING in the app ever teaches it the host's scene name. It
// is permanently unnamed on both peer lists, and every scene-aware read — `elsewhereThan`
// and everything built on it — answers "no evidence" about the most ordinary peer there
// is. The content arrived over the handshake; only the NAME was missing.
//
// A1 sends `atscene` FIRST in `sendHandshake` (PeerJS conns are ordered and reliable, so
// the row is fresh before any handshake decision on the far side), hands
// `deferUntilShareChoice` the sender's context, and lets an EMPTY joiner ADOPT the
// identity of the peer it joined.
//
//   §1  An empty joiner takes the host's scene NAME, and nothing else: no hash and no
//       signature, because it loaded no file — it is standing in the live world.
//   §2  A joiner that brought its OWN work adopts nothing (this commit changes no merge
//       behaviour), and the roster crash guards hold.
//
// NO isolation or gating changes ride here — this commit only makes the evidence EXIST.
// The scene-aware decision table and the room gating that reads it land in the next
// phase, and this file grows the sections that cover them there.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- scene-isolation
const h = require('./helpers.cjs');

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const scenesOfPeers = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.peerScenes.peerScenes.subscribe((x) => (m = x))();
		return Object.fromEntries(Object.entries(m).map(([id, r]) => [id, r.scene]));
	});

const objectCount = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g?.children.length ?? 0;
	});

const historyOf = (p, name) =>
	p.page.evaluate((n) => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return m.scenes[n]?.history ?? [];
	}, name);

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});

/** Put a raw message on the wire, bypassing every sender — the only way to reach a
 * dispatch branch with an argument the app itself would never build. */
const sendRaw = (from, toId, msg) =>
	from.page.evaluate(([id, m]) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		const conn = p.connections?.[id];
		if (!conn?.open) return false;
		conn.send(m);
		return true;
	}, [toId, msg]);

const wipe = async (p) => {
	await p.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await p.page.waitForTimeout(700);
};

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================
	// 1. AN EMPTY JOINER ADOPTS THE HOST'S SCENE
	// =====================================================================
	//
	// COUNTERFACTUAL, measured on this branch with the adoption call commented out of
	// sessions.js: `currentLevel` on the joiner stayed NULL for the whole session and its
	// `peerScenes` row on the host read '' — so the host saw itself alone in Arena and the
	// joiner in no room at all — while the objects arrived perfectly. The name was the only
	// thing missing, which is exactly why nobody files this as a sync bug.
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await wipe(A);
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(
		() => historyOf(A, 'Arena'),
		(x) => x.length === 1,
		'premise: the host stands in a NAMED project scene with content in it'
	);
	const hostAt = await at(A);
	h.check(
		hostAt?.name === 'Arena' && !!hostAt?.hash,
		`premise: the host's own identity is Arena + a hash (${JSON.stringify(hostAt?.name)})`
	);

	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	h.check((await at(B)) === null, 'premise: the joiner has never travelled — no identity at all');
	h.check((await objectCount(B)) === 0, 'premise: …and an empty world, so it brought nothing');
	await h.connect(B, A);

	await h.eventually(
		() => at(B),
		(v) => v?.name === 'Arena',
		"THE FIX: the empty joiner adopts the host's scene name instead of staying nameless"
	);
	const adopted = await at(B);
	h.check(
		adopted?.hash === '' && adopted?.unsaved === true && adopted?.signature === undefined,
		`THE NAME AND NOTHING ELSE — no hash, no signature, unsaved (${JSON.stringify(adopted)})`
	);
	await h.eventually(
		() => objectCount(B),
		(n) => n >= 1,
		'…while the handshake still delivers the content it always did'
	);
	// …and it STAYS unsaved even after the manifest arrives naming that scene. The
	// project knowing about Arena says nothing about whether THIS machine holds its
	// bytes, and it does not — which is also what keeps the Explorer offering to
	// download it (scene-rooms covers that end).
	await h.eventually(
		() => historyOf(B, 'Arena'),
		(hist) => hist.includes(hostAt?.hash),
		"premise: the replicated manifest reaches the joiner and names the host's version",
		20000
	);
	h.check(
		(await at(B))?.unsaved === true,
		'…and the adopted identity stays UNSAVED — this machine holds no file for it'
	);

	await h.eventually(
		() => scenesOfPeers(A),
		(m) => m[B.id] === 'Arena',
		'…and the host now sees the joiner IN Arena — one room, not two peers in nowhere'
	);
	h.check(
		(await A.page.evaluate((id) => {
			let ps, cl;
			window.__stores.peerScenes.peerScenes.subscribe((v) => (ps = v))();
			window.__stores.levels.currentLevel.subscribe((v) => (cl = v))();
			// the row has to be POPULATED for this to mean anything — an empty scene on
			// either side is a no-evidence pass, not agreement
			return (ps[id]?.scene ?? '') + '|' + window.__stores.peerScenes.elsewhereThan(ps, cl?.name ?? '', id);
		}, B.id)) === 'Arena|',
		'…and is NOT read as elsewhere — evidence that agrees is not evidence of a split'
	);

	h.check(
		(await h.pageErrors(A)).length === 0 && (await h.pageErrors(B)).length === 0,
		'no page errors through the adoption handshake'
	);
	await B.page.close();
	await A.page.close();

	// =====================================================================
	// 2. A JOINER THAT BROUGHT ITS OWN WORK ADOPTS NOTHING
	// =====================================================================
	//
	// Adoption is only ever a statement about an EMPTY world: the content arriving is the
	// only content there is, so it can be named without asking. A joiner holding objects of
	// its own is the share-or-stash case, and this commit deliberately leaves that decision
	// exactly where it was — taking the host's name there would label a merge after one of
	// its two halves.
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await wipe(C);
	await addBox(C);
	await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Depot'));
	await h.eventually(
		() => historyOf(C, 'Depot'),
		(x) => x.length === 1,
		'premise: a second host, standing in a named scene of its own'
	);

	const D = await h.setupPage(browser, 'D');
	await D.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await addBox(D); // the joiner's OWN work — note /create box stamps dynamic physics
	h.check((await objectCount(D)) >= 1, 'premise: the joiner brought an object of its own');
	await h.connect(D, C);

	h.check(
		(await at(D)) === null,
		`a joiner with work of its own adopts NOTHING (${JSON.stringify(await at(D))})`
	);
	await D.page.waitForTimeout(2500);
	h.check(
		(await at(D)) === null,
		'…still nothing a beat later — no late write sneaks a name onto a merge'
	);

	// ---- the crash guards -------------------------------------------------
	//
	// COUNTERFACTUAL, measured with the guards removed: each of these three raw messages
	// threw out of `conn.on('data')` — which has no try/catch — and landed as a page error.
	// `specator` with an unknown peer id read `users[-1][3]` and, on the watching branch,
	// dereferenced an avatar mesh that is not in the scene; `cameraSettings` read
	// `users[-1][4]`. Harmless today only because nothing sends those; load-bearing the
	// moment room gating hides a peer standing somewhere else.
	const errorsBefore = (await h.pageErrors(D)).length;
	h.check(
		(await sendRaw(C, D.id, { type: 'specator', peerId: 'ghost-123', watching: 'x' })) === true,
		'premise: a raw message really went down the wire'
	);
	await sendRaw(C, D.id, { type: 'specator', peerId: 'ghost-123', watching: 'false' });
	await sendRaw(C, D.id, { type: 'cameraSettings', peerId: 'ghost-123', fov: 55 });
	await D.page.waitForTimeout(1500);
	const after = await h.pageErrors(D);
	h.check(
		after.length === errorsBefore,
		`a message about a peer we hold no roster row for is inert, not fatal (${JSON.stringify(after.slice(errorsBefore))})`
	);
	h.check(
		(await objectCount(D)) >= 1,
		'…and the connection is still alive afterwards — the dispatcher survived'
	);

	h.check(
		(await h.pageErrors(C)).length === 0,
		`no page errors on the sender either (${JSON.stringify(await h.pageErrors(C))})`
	);
	await h.finish(browser);
});
