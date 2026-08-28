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
// A2 IS THE GATE and A3 IS THE ASK, and they cannot be judged apart: gating without the
// arrival re-sync is a staleness regression wearing isolation's clothes, and re-syncing
// without a scene-aware ask gives a person no way to say "leave me where I am".
//
//   §3  The three-option ask NAMES both scenes, the HOST is not asked at all, and Stay
//       really isolates — an edit and a scene singleton stop at the room boundary while
//       the chat, which belongs to the SESSION, does not.
//   §4  `clearscene`, the sharpest entry in the partition, with four counterfactuals:
//       the receive guard disarmed IN THE PAGE (the scene wipes), the send gate proven
//       independently by disarming the RECEIVER instead, and a real replicated clear
//       from a peer whose send gate is off.
//   §5  Travelling in: the traveller loads a SNAPSHOT and the re-sync converges it on
//       the live room, uuid for uuid, with `getgame` pulling what the handshake only
//       ever pushed.
//   §6  Leaving RE-ARMS the gate, and coming back re-runs the re-sync.
//   §7  A second empty joiner still adopts — no verdict anybody recorded strands it.
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
	await D.page.close();
	await C.page.close();

	// =====================================================================
	// 3. THE THREE-OPTION ASK, AND STAY
	// =====================================================================
	//
	// Two peers, two NAMED scenes, work on both sides. Before A2/A3 this was one world
	// wearing two labels: the joiner got "Share or stash?" with no third answer, and
	// whichever it picked, every edit either side made from then on landed in the other's
	// scene. The ask names both scenes now, and the third button is the one that was
	// missing — stay where you are, and mean it.
	//
	// NOTE the ORDER of the two saves: the project manifest is a whole-document
	// latest-wins singleton, so the peer that saves LAST owns the shared copy. Arena is
	// saved second on purpose, which is what lets §5 resolve it by NAME on the joiner.
	const F = await h.setupPage(browser, 'F');
	await F.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await wipe(F);
	await addBox(F);
	await F.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Beta'));
	await h.eventually(
		() => at(F),
		(v) => v?.name === 'Beta' && !!v?.hash,
		'premise: the joiner stands in a named scene of its OWN, with work in it'
	);
	const betaHash = (await at(F))?.hash;

	const E = await h.setupPage(browser, 'E');
	await E.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await wipe(E);
	await addBox(E);
	await E.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(
		() => at(E),
		(v) => v?.name === 'Arena' && !!v?.hash,
		'premise: the host stands in a DIFFERENT named scene, also with work in it'
	);

	await h.connect(F, E);

	// ---- the ask names both scenes and offers the way out -----------------
	const askOn = (peer) =>
		peer.page.evaluate(() => {
			let list;
			window.__stores.toastStore.subscribe((v) => (list = v))();
			const entry = list.find((e) => e && e.id === 'share-or-stash');
			if (!entry) return null;
			return { text: entry.text, labels: (entry.actions ?? []).map((a) => a.label), sticky: !!entry.sticky, noClose: !!entry.noClose };
		});
	await h.eventually(
		() => askOn(F),
		(v) => !!v && v.labels.length === 3,
		'the joiner is asked, and the ask has THREE answers'
	);
	const ask = (await askOn(F)) ?? { text: '', labels: [], sticky: false, noClose: false };
	h.check(
		ask.labels.some((l) => l.includes('Bring into') && l.includes('Arena')) &&
			ask.labels.some((l) => l.includes('Stash & join') && l.includes('Arena')) &&
			ask.labels.some((l) => l.includes('Stay in') && l.includes('Beta')),
		`each answer NAMES the scene it acts on (${JSON.stringify(ask.labels)})`
	);
	h.check(
		ask.text.includes('"Arena"') && ask.text.includes('"Beta"') && ask.text.includes('1 object'),
		`…and so does the question (${JSON.stringify(ask.text)})`
	);
	h.check(ask.sticky && ask.noClose, 'still a 15-P2 fork: sticky, and no ✕ — an answer must decide');

	// THE HOST-SIDE HALF: silence. Nothing of the host's is at stake — the joiner is the
	// one standing somewhere else — so asking here would be two prompts for one decision.
	await E.page.waitForTimeout(1200);
	h.check((await askOn(E)) === null, 'the HOST is not asked at all — row 2 withholds in silence');

	// ---- Stay ------------------------------------------------------------
	const clickToast = (peer, prefix) =>
		peer.page.evaluate((p) => {
			const btn = [...document.querySelectorAll('.tp-toast-action')].find((b) =>
				(b.textContent ?? '').startsWith(p)
			);
			if (!btn) return false;
			btn.click();
			return true;
		}, prefix);
	h.check(await clickToast(F, 'Stay in'), 'premise: the Stay button is really on screen and clickable');
	await F.page.waitForTimeout(2500);
	h.check((await askOn(F)) === null, 'answering it dismisses the fork');
	h.check(
		(await objectCount(E)) === 1 && (await objectCount(F)) === 1,
		`neither side gained the other's work (E ${await objectCount(E)}, F ${await objectCount(F)})`
	);
	h.check((await at(F))?.name === 'Beta', 'and the joiner is still standing in its own scene');

	// ---- an edit does not cross ------------------------------------------
	await addBox(E);
	await E.page.waitForTimeout(1800);
	h.check(
		(await objectCount(E)) === 2 && (await objectCount(F)) === 1,
		`an object created in Arena does not appear in Beta (E ${await objectCount(E)}, F ${await objectCount(F)})`
	);

	// ---- …but the SESSION is still one session ---------------------------
	// Chat is mesh-wide on purpose: splitting a conversation by room is how you make
	// people shout into an empty scene.
	await E.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.sendMessage('across the rooms');
	});
	await h.eventually(
		() =>
			F.page.evaluate(() => {
				let m;
				window.__stores.messages.subscribe((v) => (m = v))();
				// addMessage stores the body as `text` — `message` is the WIRE field
				return m.some((row) => (row?.text ?? '') === 'across the rooms');
			}),
		(v) => v === true,
		'CHAT still crosses — the mesh is one session even when it holds two rooms'
	);

	// ---- a scene SINGLETON does not ---------------------------------------
	const presetOf = (peer) =>
		peer.page.evaluate(() => {
			let e;
			window.__stores.environment.environment.subscribe((v) => (e = v))();
			return e?.preset ?? '';
		});
	const beforePreset = await presetOf(F);
	h.check(beforePreset !== 'sunset', `premise: the joiner is not already on the preset under test (${beforePreset})`);
	await E.page.evaluate(() => window.__stores.environment.setEnvironment('sunset'));
	await E.page.waitForTimeout(1800);
	h.check((await presetOf(E)) === 'sunset', 'premise: the host really changed its own sky');
	h.check(
		(await presetOf(F)) === beforePreset,
		`a scene singleton does not restyle another room (${await presetOf(F)})`
	);

	// =====================================================================
	// 4. CLEARSCENE — THE COUNTERFACTUALS, BOTH SIDES OF THE WIRE
	// =====================================================================
	//
	// `clearscene` is the sharpest case in the partition: destructive, one message, and
	// ungated it wipes a room its author is not standing in. Three legs, each proving a
	// different half of the gate by BREAKING it in the page.
	const roomScoped = (peer, op, type) =>
		peer.page.evaluate(([o, t]) => {
			const set = window.__stores.peerScenes.ROOM_SCOPED;
			if (o === 'delete') set.delete(t);
			else set.add(t);
			return set.has(t);
		}, [op, type]);

	// (a) a RAW clearscene, bypassing the sender's own gate entirely
	h.check(
		(await sendRaw(F, E.id, { type: 'clearscene', peerId: F.id })) === true,
		'premise: a raw clearscene really went down the wire'
	);
	await E.page.waitForTimeout(1500);
	h.check(
		(await objectCount(E)) === 2,
		`the RECEIVE guard drops it — a room we are not in cannot wipe ours (${await objectCount(E)})`
	);

	// (b) THE COUNTERFACTUAL: take `clearscene` out of the receiver's own partition and
	//     the very same message lands. Nothing else changes, so the guard is the thing
	//     doing the work — not luck, not a dropped connection.
	h.check((await roomScoped(E, 'delete', 'clearscene')) === false, 'premise: the guard is disarmed on the receiver');
	await sendRaw(F, E.id, { type: 'clearscene', peerId: F.id });
	await h.eventually(
		() => objectCount(E),
		(n) => n === 0,
		'…and with it disarmed the scene IS wiped — the guard was what stopped it'
	);
	h.check((await roomScoped(E, 'add', 'clearscene')) === true, 'the guard is armed again');

	// (c) the SEND side, proven the same way: disarm the RECEIVER so it would accept a
	//     create, and the object still never arrives — because it never left.
	h.check((await roomScoped(F, 'delete', 'create')) === false, 'premise: the joiner would now accept a create');
	await addBox(E);
	await E.page.waitForTimeout(1800);
	h.check(
		(await objectCount(F)) === 1,
		`the SEND gate withholds it independently — a willing receiver still gets nothing (${await objectCount(F)})`
	);
	h.check((await roomScoped(F, 'add', 'create')) === true, 'restored');

	// (d) and a REAL replicated clear, sent by a peer whose send gate is disarmed: the
	//     receive guard alone is enough. The two halves are not one mechanism twice.
	h.check((await roomScoped(F, 'delete', 'clearscene')) === false, 'premise: the sender will now broadcast it');
	await F.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await F.page.waitForTimeout(2000);
	h.check((await objectCount(F)) === 0, 'premise: the sender really cleared its own scene');
	h.check(
		(await objectCount(E)) === 1,
		`the other room survives on the RECEIVE guard alone (${await objectCount(E)})`
	);
	h.check((await roomScoped(F, 'add', 'clearscene')) === true, 'restored');

	// re-seed Arena and re-save it, so §5 has a file whose contents are a SUBSET of the
	// live room — which is the whole point of the arrival re-sync
	await addBox(E);
	await E.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(
		() => historyOf(E, 'Arena'),
		(hist) => hist.length >= 1,
		'premise: Arena is re-saved, and the project names it'
	);
	h.check((await objectCount(E)) === 2, `premise: the saved Arena holds 2 objects (${await objectCount(E)})`);

	// =====================================================================
	// 5. TRAVELLING IN — THE ARRIVAL RE-SYNC
	// =====================================================================
	//
	// THE HALF THAT MAKES THE GATE SHIPPABLE. Everything withheld while a peer stood
	// elsewhere is, by construction, missing from the world it walks into: the .tpscene
	// it loads is a SNAPSHOT and the live room has moved on. On arrival it asks for full
	// state, the same burst a fresh connection sends — and `createObject` already dedupes
	// by uuid, so what it already loaded is not added twice.
	await addBox(E); // LIVE-ONLY: created after the save, so only the re-sync can deliver it
	const gameOf = (peer) =>
		peer.page.evaluate(() => {
			let g;
			window.__stores.gameState.gameState.subscribe((v) => (g = v))();
			return g?.state ?? '';
		});
	await E.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await E.page.waitForTimeout(1800);
	h.check((await gameOf(E)) === 'playing', 'premise: a round is running in Arena');
	h.check(
		(await gameOf(F)) === 'menu',
		`…and Beta knows nothing about it — a round in one room does not flip another room's editors into play (${await gameOf(F)})`
	);
	h.check((await objectCount(E)) === 3, `premise: the live room is one object ahead of its file (${await objectCount(E)})`);

	await h.eventually(
		() => historyOf(F, 'Arena'),
		(hist) => hist.length >= 1,
		'premise: …and the replicated manifest names Arena, so travel can resolve it BY NAME',
		25000
	);

	const travelled = await F.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	h.check(travelled === true, 'the joiner travels to Arena — the bytes pulled from a peer in another room');
	await h.eventually(
		() => at(F),
		(v) => v?.name === 'Arena',
		'…and it is standing in Arena now'
	);

	const uuidsOf = (peer) =>
		peer.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return (g?.children ?? []).map((c) => c.uuid).sort();
		});
	await h.eventually(
		() => Promise.all([uuidsOf(E), uuidsOf(F)]),
		([e, f]) => e.length === 3 && f.length === 3 && e.join() === f.join(),
		'THE RE-SYNC: the traveller converges on the LIVE room, not on the file it loaded',
		25000
	);
	const fUuids = await uuidsOf(F);
	h.check(
		new Set(fUuids).size === fUuids.length,
		`…with no duplicates — the file and the re-sync agree on uuids (${fUuids.length})`
	);

	// THE GAME IS THE ONE DOMAIN THE ARRIVAL RE-SYNC DELIBERATELY DOES NOT PULL, and the
	// measurement is why: `travelToLevel` re-asserts the traveller's CARRIED state with a
	// fresh stamp (21-F4 fork 3 — your progress travels with you), so a `getgame` reply is
	// always strictly older and always refused. A pull was written, measured inert, and
	// removed; what makes the room converge is the NEXT transition, which the traveller is
	// now in the room to receive.
	h.check(
		(await gameOf(F)) === 'menu',
		`the traveller keeps the state it CARRIED — arriving does not adopt the room's round (${await gameOf(F)})`
	);
	await E.page.evaluate(() => window.__stores.gameState.setGameState('over'));
	await h.eventually(
		() => gameOf(F),
		(v) => v === 'over',
		'…but the next transition in that room reaches it — being in the room is what restores the flow'
	);

	await h.eventually(
		() => scenesOfPeers(E),
		(m) => m[F.id] === 'Arena',
		'the host sees the traveller arrive — one room again'
	);

	// =====================================================================
	// 6. TRAVELLING BACK, AND IN AGAIN
	// =====================================================================
	//
	// Isolation is not a one-way door: leaving re-arms the gate, and coming back re-runs
	// the re-sync. By hash rather than by name here, because Beta lives only in THIS
	// peer's library — the manifest is a latest-wins singleton and Arena's owner won it.
	const back = await F.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Beta'), betaHash);
	h.check(back === true, 'the traveller goes back to Beta');
	await h.eventually(
		() => at(F),
		(v) => v?.name === 'Beta',
		'…and is standing in its own scene again'
	);
	const backCount = await objectCount(F);
	await addBox(E);
	await E.page.waitForTimeout(1800);
	h.check(
		(await objectCount(E)) === 4 && (await objectCount(F)) === backCount,
		`leaving RE-ARMS the gate — the next Arena edit does not follow (E ${await objectCount(E)}, F ${await objectCount(F)})`
	);

	h.check(
		(await F.page.evaluate(() => window.__stores.levels.travelToScene('Arena'))) === true,
		'and back in again'
	);
	await h.eventually(
		() => Promise.all([uuidsOf(E), uuidsOf(F)]),
		([e, f]) => e.length === 4 && f.length === 4 && e.join() === f.join(),
		'the re-sync runs EVERY arrival, not just the first — exact convergence again',
		25000
	);

	// =====================================================================
	// 7. A SECOND JOINER STILL ADOPTS
	// =====================================================================
	//
	// The per-room verdict map is consulted AFTER "we hold nothing", which is the order
	// that matters: an empty joiner has nothing to decide about, so no verdict any peer
	// recorded earlier can strand it without a name.
	const G = await h.setupPage(browser, 'G');
	await G.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await wipe(G);
	h.check((await objectCount(G)) === 0, 'premise: a third peer, empty and nameless');
	await h.connect(G, E);
	await h.eventually(
		() => at(G),
		(v) => v?.name === 'Arena',
		'it adopts Arena — no verdict recorded by anybody latches adoption out'
	);
	await h.eventually(
		() => objectCount(G),
		(n) => n === 4,
		'…and receives the room it named',
		25000
	);

	for (const peer of [E, F, G]) {
		h.check(
			(await h.pageErrors(peer)).length === 0,
			`no page errors on ${peer.id.slice(0, 6)} through gating, travel and re-sync (${JSON.stringify(await h.pageErrors(peer))})`
		);
	}
	await h.finish(browser);
});
