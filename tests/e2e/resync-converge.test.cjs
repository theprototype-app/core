// R22 round 32 item 2.1 — THE ARRIVAL RE-SYNC HEALS WHAT IT ALREADY HOLDS.
//
// REPORTED: a peer saves the scene as a file and keeps editing; the other side opens that
// file ("Open here" -> travelToLevel -> resyncRoomPeers). Both are demonstrably in the same
// room, both see each other, and their worlds never converge.
//
// The re-sync was answered all along — `deferUntilShareChoice`'s ARRIVING row replies with
// `sendObjects` — but every applier on the receiving end DEDUPES BY UUID:
//
//   · `createObject` skipped an object it already held, so a shared box kept the pose the
//     .tpscene was saved with FOREVER (the headline of this suite),
//   · `createGroup` did the opposite and had no dedupe at all: it minted a SECOND
//     THREE.Group carrying the same uuid on every re-sent `group` message,
//   · `applyObjectFile` returned early, so a rig's transform never converged either.
//
// So "double-application is safe by uuid dedupe" was also "existing objects never converge".
// The fix is one additive wire field: the reply to an ARRIVING request carries
// `override: true`, and the three appliers REPLACE (or update) instead of skipping. Every
// other reply is byte-identical to before, which is why the ordinary handshake keeps its
// classic dedupe semantics.
//
// Counterfactuals, both run: dropping `{ override: true }` from the arriving reply reds the
// pose convergence, and reverting createGroup's dedupe reds the one-group check.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- resync-converge
const h = require('./helpers.cjs');

// ---- reading the world -------------------------------------------------------------
/** top-level children as {uuid, name}, in scene order */
const topLevel = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => ({ uuid: c.uuid, name: c.name, type: c.type }));
	});

/** every occurrence of a uuid anywhere in the tree — the duplicate detector */
const occurrences = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		let n = 0;
		group?.traverse((o) => {
			if (o.uuid === id) n++;
		});
		return n;
	}, uuid);

/** local pose, rounded — the thing that has to converge */
const poseOf = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group?.getObjectByProperty('uuid', id);
		if (!o) return null;
		const r = (n) => Math.round(n * 1000) / 1000;
		return [r(o.position.x), r(o.position.y), r(o.position.z)];
	}, uuid);

const childCount = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group?.getObjectByProperty('uuid', id);
		return o ? o.children.length : -1;
	}, uuid);

const sceneName = (peer) =>
	peer.page.evaluate(() => {
		let c;
		window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
		return { name: c?.name ?? '', hash: c?.hash ?? '' };
	});

/** create one primitive and return its uuid (creation SELECTS — callers deselect) */
const create = (peer, command) =>
	peer.page.evaluate(async (cmd) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(cmd);
		await new Promise((r) => setTimeout(r, 1100));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		return group.children[group.children.length - 1].uuid;
	}, command);

/** a REPLICATED move, exactly the message the app sends (physics-joints' idiom) */
const moveTo = (peer, uuid, pos) =>
	peer.page.evaluate(
		([id, p]) => {
			const s = window.__stores;
			let group, peers;
			s.objectsGroup.subscribe((v) => (group = v))();
			s.peers.subscribe((v) => (peers = v))();
			const o = group?.getObjectByProperty('uuid', id);
			if (!o) return false;
			o.position.set(p[0], p[1], p[2]);
			s.objectsGroup.update((v) => v); // THREE trees are not reactive
			peers?.send({ type: 'move', uuid: id, pos: p, rot: o.rotation.toArray(), scale: o.scale.toArray() });
			return true;
		},
		[uuid, pos]
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	// =====================================================================
	// 1. A BUILDS A SCENE AND SAVES IT AS A FILE
	// =====================================================================
	// A box (a leaf mesh — the GLTF wire shape) and a GROUP with two children (the
	// `group` message plus the recursion), because the two appliers failed differently.
	const boxU = await create(A, '/create box');
	const s1 = await create(A, '/create sphere 1');
	const s2 = await create(A, '/create sphere 1');
	const groupU = await A.page.evaluate(
		(ids) => {
			const s = window.__stores;
			s.objectActions.applySelectionSet(ids);
			const uuid = s.objectActions.groupSelection();
			s.objectActions.deselectObject();
			return uuid;
		},
		[s1, s2]
	);
	h.check(!!groupU, 'premise: the two spheres are grouped');
	const built = await topLevel(A);
	h.check(
		built.length === 2 && built.some((o) => o.uuid === boxU) && built.some((o) => o.uuid === groupU),
		`premise: A holds a box and a group at the top level (${JSON.stringify(built.map((o) => o.name))})`
	);
	h.check((await childCount(A, groupU)) === 2, 'premise: the group holds both spheres');

	const saved = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('ConvergeDepot'));
	h.check(!!saved?.hash, `premise: the scene is saved as a file (${saved?.hash?.slice(0, 8)})`);
	h.check((await sceneName(A)).name === 'ConvergeDepot', 'premise: A is standing in ConvergeDepot');

	// =====================================================================
	// 2. B JOINS — empty, so it adopts the room and receives everything
	// =====================================================================
	await h.connect(B, A);
	await h.eventually(
		() => topLevel(B),
		(list) => list.length === 2 && list.some((o) => o.uuid === boxU) && list.some((o) => o.uuid === groupU),
		'premise: B received the scene through the ordinary handshake'
	);
	h.check(
		(await sceneName(B)).name === 'ConvergeDepot',
		'premise: B adopted the room name, so both peers are demonstrably in ONE room'
	);
	// B does NOT hold the file: `shareNewFiles` defaults to ASK, so a scene saved a moment
	// ago is not published to the library until somebody answers. That is the reported
	// shape exactly — the traveller reaches the bytes through travel's own pull (the LUT
	// watch: ask once, then watch until they land), which section 4 exercises.
	h.check(
		(await B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), saved.hash)) === false,
		"premise: B does not hold the scene file's bytes yet"
	);

	// =====================================================================
	// 3. A KEEPS EDITING AFTER THE SAVE — the file is now stale
	// =====================================================================
	const BOX_AT = [4, 2, -3];
	const GROUP_AT = [-2, 0, 5];
	h.check(await moveTo(A, boxU, BOX_AT), 'A moves the box to a distinctive pose');
	h.check(await moveTo(A, groupU, GROUP_AT), 'A moves the group too');
	const sphereU = await create(A, '/create sphere 1');
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	h.check((await topLevel(A)).length === 3, 'premise: A now holds three top-level objects');
	// the ordinary wire still works — B has all of this BEFORE it travels, which is what
	// makes the next section about the FILE overwriting B and nothing else
	await h.eventually(
		() => Promise.all([topLevel(B), poseOf(B, boxU)]),
		([list, pose]) => list.length === 3 && JSON.stringify(pose) === JSON.stringify(BOX_AT),
		'premise: the live edits reached B over the ordinary wire'
	);

	// =====================================================================
	// 4. B OPENS THE FILE — and lands in the world as it was SAVED
	// =====================================================================
	// Read inside the SAME evaluate, right after travelToLevel resolves: the heal needs a
	// network round trip (sendObjects waits 500ms before it writes a byte), so this is a
	// race-free look at the stale world rather than a timer betting against it.
	const landed = await B.page.evaluate(
		async ([hash, box]) => {
			const s = window.__stores;
			const ok = await s.levels.travelToLevel(hash, 'ConvergeDepot');
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			const o = group?.getObjectByProperty('uuid', box);
			return {
				ok,
				count: group?.children.length ?? -1,
				box: o ? [o.position.x, o.position.y, o.position.z] : null
			};
		},
		[saved.hash, boxU]
	);
	h.check(landed.ok === true, 'B travelled into the file');
	h.check(
		(await B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), saved.hash)) === true,
		'the bytes were pulled from A on the way in'
	);
	h.check(
		landed.count === 2 && JSON.stringify(landed.box) === JSON.stringify([0, 0, 0]),
		`premise: the file really is STALE — B lands on 2 objects with the box at the origin (${JSON.stringify(landed)})`
	);

	// =====================================================================
	// 5. THE HEAL — what B already holds converges on the live room
	// =====================================================================
	await h.eventually(
		() => poseOf(B, boxU),
		(pose) => JSON.stringify(pose) === JSON.stringify(BOX_AT),
		'THE HEADLINE: the box B already held converges on the live pose, not the saved one',
		25000
	);
	h.check(
		JSON.stringify(await poseOf(B, groupU)) === JSON.stringify(GROUP_AT),
		`the GROUP converges too (${JSON.stringify(await poseOf(B, groupU))})`
	);
	await h.eventually(
		() => topLevel(B),
		(list) => list.some((o) => o.uuid === sphereU),
		'the object B was missing arrives — the add-only half still works'
	);
	h.check(
		(await occurrences(B, groupU)) === 1,
		`the group is not duplicated: exactly one object carries its uuid (${await occurrences(B, groupU)})`
	);
	h.check((await childCount(B, groupU)) === 2, 'and it still holds both spheres');
	h.check((await occurrences(B, boxU)) === 1, 'the healed box is a replacement, not a second copy');
	const bTop = await topLevel(B);
	h.check(
		bTop.length === 3,
		`B's scene is A's scene: three top-level objects, no extras (${JSON.stringify(bTop.map((o) => o.name))})`
	);

	// A is the one being asked for state, and answering must not move A's own world
	const aTop = await topLevel(A);
	h.check(
		aTop.length === 3 &&
			JSON.stringify(await poseOf(A, boxU)) === JSON.stringify(BOX_AT) &&
			JSON.stringify(await poseOf(A, groupU)) === JSON.stringify(GROUP_AT),
		"A's own scene is untouched by the heal it sent"
	);

	// =====================================================================
	// 6. IDEMPOTENCE — a heal may be asked for again, and again
	// =====================================================================
	// A walk-in is not a one-off: a peer can travel back and forth, and `resyncRoomPeers`
	// is fired every time. A replace that is not stable under repetition would show up as
	// a scene that grows a copy per hop.
	const asked = await B.page.evaluate(() => window.__stores.peerScenes.resyncRoomPeers());
	h.check(asked >= 1, `premise: B asked its room again (${asked} peer(s))`);
	await B.page.waitForTimeout(8000);
	h.check((await occurrences(B, groupU)) === 1, 'a second heal still leaves ONE group');
	h.check((await occurrences(B, boxU)) === 1, '…and ONE box');
	h.check((await childCount(B, groupU)) === 2, '…with both spheres still inside it');
	h.check(
		JSON.stringify(await poseOf(B, boxU)) === JSON.stringify(BOX_AT) &&
			JSON.stringify(await poseOf(B, groupU)) === JSON.stringify(GROUP_AT),
		'…and the poses unchanged'
	);
	h.check((await topLevel(B)).length === 3, "…and B's scene is still exactly A's three objects");

	await h.finish(browser);
});
