// 21-G7 — VERSION HISTORY, DCC-standard. Fork 10 + fork 13.
//
// The G2 behaviour minted one VISIBLE .tpscene per save, so a scene edited five times
// showed five identical-looking cards and nothing said which one the project meant.
// G7 keeps exactly one card per scene name — the POINTER — and folds the rest onto a
// hidden shelf (`explorer.hiddenItems`) that is still fully addressable by hash, so
// travel, the .tp export and a peer's assetShare pull are unaffected. What this suite
// has to prove, in order:
//
//   the invariant     three saves of one scene leave ONE card, two hidden records, and
//                     itemByHash resolving all three (§1)
//   the migration     a crafted pre-G7 library (a card per save) folds on demand (§2)
//   the panel         rows through the REAL UI: right-click ▸ Version history ▸ the
//                     properties panel, newest first, the pointer badged (§3)
//   naming            "Save version…" with a custom label, replicated on the manifest (§4)
//   restore           checkpoint FIRST, then RE-APPEND, then the world really reverts —
//                     asserted on object UUIDS, not on a count (§5)
//   delete honesty    the bytes go, the manifest keeps the hash, and the row stays and
//                     SAYS it is not held rather than disappearing (§6)
//   the setting       keep-0 stops the travel-away auto-version and nothing else (§7),
//                     and the prune obeys the count (§8)
//   the round trip    a .tp carries hidden versions out and folds them back in (§9)
//   21-I1, the bug   an item the history NEVER named folds by NAME and is ADOPTED, so
//                     the bytes get a door and the pointer does not move (§10)
//   21-I1 badges      Previous sits beside Current, and after a restore it is the
//                     checkpoint the restore just took (§11)
//   21-I1 gating      "Save version…" only on the scene you are IN, both directions (§12)
//   21-I1 no history  a scene the manifest has no entry for still gets a panel (§13)
//
// SINGLE PEER for §1-§9 on purpose: every writer here is gated on being the session
// writer (`sessionHost === null`), which a solo peer is. A second peer joins in §10,
// where the only claim is that a version LABEL replicates like the rest of the document.
//
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- scene-versions
const h = require('./helpers.cjs');

// ---- reading the world -------------------------------------------------------------
const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const historyOf = (peer, name) =>
	peer.page.evaluate((n) => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m.scenes[n]?.history ?? [];
	}, name);

/** the two shelves, as {visible, hidden} name lists for one scene name */
const shelves = (peer, fileName) =>
	peer.page.evaluate((n) => {
		const s = window.__stores.explorer;
		let vis, hid;
		s.explorerItems.subscribe((v) => (vis = v))();
		s.hiddenItems.subscribe((v) => (hid = v))();
		return {
			visible: vis.filter((i) => i.name === n).map((i) => i.hash),
			hidden: hid.filter((i) => i.name === n).map((i) => i.hash)
		};
	}, fileName);

/** does this peer still hold BYTES for each hash — through the ordinary hash lookup */
const heldByHash = (peer, hashes) =>
	peer.page.evaluate(
		(list) => list.map((hash) => !!window.__stores.explorer.itemByHash(hash)),
		hashes
	);

const childUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid).sort();
	});

const addBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.objectActions.deselectObject();
	});

const saveScene = (peer, name) =>
	peer.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), name);

/** the scene we are IN (21-I1: what gates the save row) */
const currentLevelName = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v?.name ?? null;
	});

/**
 * 21-I1 — craft the thing the reported bug is made of: a real .tpscene of a scene,
 * stored in the library, that NOTHING ever published. That is a save from before the
 * manifest existed, a viewer's save (publishSceneVersion refuses those) or any publish
 * that returned false. `createdAt` is stamped explicitly because it is the ONLY ordering
 * signal such an item carries, and the adoption order is what this suite asserts.
 */
const craftOrphan = (peer, sceneName, createdAt) =>
	peer.page.evaluate(
		async ({ n, at }) => {
			const s = window.__stores;
			const payload = s.sessions.emptySessionPayload(n);
			const bytes = await s.sessions.exportSessionZip(payload, {
				assets: false,
				packs: false,
				flow: true
			});
			const item = await s.explorer.addItemFromBytes(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
				n + '.tpscene',
				null
			);
			s.explorer.explorerItems.update((list) =>
				list.map((i) => (i.id === item.id ? { ...i, createdAt: at } : i))
			);
			return item.hash;
		},
		{ n: sceneName, at: createdAt }
	);

/** open the Version history panel for one card THROUGH THE REAL UI — right-click ▸
 * Version history, which is the only route a user has to it */
const openPanel = async (peer, fileName) => {
	if (await peer.page.locator('[role="menu"]').first().isVisible().catch(() => false))
		await peer.page.keyboard.press('Escape');
	await peer.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await peer.page.waitForTimeout(400);
	const card = peer.page.locator(`.explorer-card[title="${fileName}"]`).first();
	await card.waitFor({ state: 'visible', timeout: 15000 });
	await card.click({ button: 'right' });
	await peer.page.waitForTimeout(350);
	await peer.page
		.locator('[role="menu"]')
		.getByText('Version history', { exact: false })
		.first()
		.click();
	await peer.page.waitForTimeout(500);
};

const countOf = (peer, sel) => peer.page.locator(sel).count();

const menuRows = (peer) =>
	peer.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => el.textContent?.trim())
			.filter(Boolean)
	);

/** exactly what the Version history panel is showing, in its rendered order */
const panelRows = (peer) =>
	peer.page.evaluate(() =>
		[...document.querySelectorAll('#version-history .vh-row')].map((row) => ({
			hash: row.getAttribute('data-hash'),
			pointer: row.getAttribute('data-pointer') === '1',
			label: row.querySelector('.vh-label')?.textContent?.trim() ?? '',
			when: row.querySelector('.vh-when')?.textContent?.trim() ?? '',
			badges: [...row.querySelectorAll('.vh-badge')].map((b) => b.textContent?.trim()),
			restore: !!row.querySelector('.vh-restore'),
			del: !!row.querySelector('.vh-delete')
		}))
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.levels && !!window.__stores?.projectManifest, {
		timeout: 30000
	});

	h.check(
		await A.page.evaluate(() => {
			let host;
			window.__stores.connectionState.sessionHost.subscribe((v) => (host = v))();
			return host === null;
		}),
		'premise: A is alone, so A is the session writer (every version write is gated on it)'
	);
	h.check(
		(await A.page.evaluate(() => {
			let n;
			window.__stores.projectManifest.keepVersionsSetting.subscribe((v) => (n = v))();
			return n;
		})) === 10,
		'premise: "Keep versions per scene" starts at the documented default of 10'
	);

	// =====================================================================
	// 1. THE INVARIANT — three saves, ONE card
	// =====================================================================
	/** @type {string[]} */
	const v = [];
	/** @type {string[][]} */
	const worldAt = [];
	for (let i = 0; i < 3; i++) {
		await addBox(A);
		worldAt.push(await childUuids(A));
		const saved = await saveScene(A, 'Arena');
		v.push(saved?.hash);
	}
	h.check(
		v.every(Boolean) && new Set(v).size === 3,
		`premise: three saves minted three distinct hashes (${v.map((x) => x?.slice(0, 8)).join(', ')})`
	);
	h.check(
		JSON.stringify(await historyOf(A, 'Arena')) === JSON.stringify(v),
		'the manifest history is all three, append-only, pointer last'
	);
	let shelf = await shelves(A, 'Arena.tpscene');
	h.check(
		shelf.visible.length === 1 && shelf.visible[0] === v[2],
		`ONE visible card, and it is the pointer (${shelf.visible.length} visible: ${JSON.stringify(shelf.visible.map((x) => x.slice(0, 8)))})`
	);
	h.check(
		shelf.hidden.length === 2 && shelf.hidden.includes(v[0]) && shelf.hidden.includes(v[1]),
		`the two older versions moved to the hidden shelf (${shelf.hidden.length})`
	);
	h.check(
		JSON.stringify(await heldByHash(A, v)) === '[true,true,true]',
		'itemByHash still resolves ALL THREE — hiding is not deleting, so travel/export/pull are untouched'
	);
	h.check(
		await A.page.evaluate(async (hash) => {
			const item = window.__stores.explorer.itemByHash(hash);
			const blob = await window.__stores.explorer.itemBlob(item.id);
			return !!blob && blob.size > 0;
		}, v[0]),
		'a hidden version still has its bytes on disk (the blob is id-addressed, so the move cost nothing)'
	);
	// the travel picker lists scenes to GO to, and there is one Arena to go to
	h.check(
		(await A.page.evaluate(() => window.__stores.levels.levelItems().map((i) => i.name))).filter(
			(n) => n === 'Arena.tpscene'
		).length === 1,
		'the travel picker offers Arena exactly once (it reads the visible library)'
	);

	// =====================================================================
	// 2. THE MIGRATION — a crafted pre-G7 library folds on demand
	// =====================================================================
	const unfolded = await A.page.evaluate(() => {
		const s = window.__stores.explorer;
		let hid;
		s.hiddenItems.subscribe((x) => (hid = x))();
		for (const item of [...hid]) s.setItemHidden(item.id, false);
		let vis;
		s.explorerItems.subscribe((x) => (vis = x))();
		return vis.filter((i) => i.name === 'Arena.tpscene').length;
	});
	h.check(unfolded === 3, `premise: the pre-G7 state really is three cards for one scene (${unfolded})`);
	const folded = await A.page.evaluate(() => window.__stores.levels.foldSceneVersions());
	shelf = await shelves(A, 'Arena.tpscene');
	h.check(
		folded === 2 && shelf.visible.length === 1 && shelf.visible[0] === v[2],
		`the migration folded both stale cards and left the pointer (folded ${folded}, visible ${shelf.visible.length})`
	);
	h.check(
		JSON.stringify(await heldByHash(A, v)) === '[true,true,true]',
		'and it moved records, never bytes — all three hashes still resolve'
	);

	// =====================================================================
	// 3. THE PANEL — through the real UI, no test-only door
	// =====================================================================
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);
	// 21-H1 (locked answer 6): a save invents no folder any more, so these landed at the
	// library ROOT — nothing was being browsed when they were made. That is where the
	// card is; `scene-folders` owns the landing rule itself.
	h.check(
		(await A.page.evaluate(() => {
			let f;
			window.__stores.explorer.explorerFolders.subscribe((x) => (f = x))();
			return f.length;
		})) === 0,
		'premise: the saves created no folders at all — every card is at the root'
	);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(500);
	const card = A.page.locator('.explorer-card[title="Arena.tpscene"]');
	h.check((await card.count()) === 1, `premise: exactly one Arena card is in the grid (${await card.count()})`);
	await card.click({ button: 'right' });
	await A.page.waitForTimeout(350);
	const rows = await menuRows(A);
	h.check(
		rows.some((r) => r.startsWith('Version history')),
		`a scene item offers Version history (${JSON.stringify(rows)})`
	);
	await A.page.locator('[role="menu"]').getByText('Version history', { exact: false }).first().click();
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#version-history').isVisible(), 'the panel opened where a file keeps its facts');
	let shown = await panelRows(A);
	h.check(shown.length === 3, `three rows, one per version (${shown.length})`);
	h.check(
		shown[0].hash === v[2] && shown[1].hash === v[1] && shown[2].hash === v[0],
		'NEWEST FIRST — the pointer at the top'
	);
	h.check(
		shown[0].pointer && shown[0].badges.includes('Current') && !shown[1].pointer,
		'the pointer row is badged Current, and only it'
	);
	h.check(
		!shown[0].restore && !shown[0].del,
		'the current version offers neither Restore nor Delete — it is the one you are on'
	);
	h.check(
		shown[1].restore && shown[1].del,
		'an older version we hold offers both Restore and Delete'
	);
	h.check(
		shown.every((r) => r.label === 'Auto'),
		`an unnamed version reads "Auto" (${JSON.stringify(shown.map((r) => r.label))})`
	);
	h.check(
		shown.every((r) => r.when !== '—' && r.when.length > 4),
		`every held version shows the date its bytes were written (${JSON.stringify(shown.map((r) => r.when))})`
	);

	// =====================================================================
	// 4. "SAVE VERSION…" WITH A NAME — driven through the panel
	// =====================================================================
	await A.page.locator('#version-label').fill('Client review');
	await A.page.locator('#version-save').click();
	await h.eventually(
		() => historyOf(A, 'Arena'),
		(hist) => hist.length === 4,
		'the manual save published a fourth version'
	);
	const hist4 = await historyOf(A, 'Arena');
	const named = hist4[3];
	h.check(
		(await manifestOf(A)).scenes.Arena.labels?.[named] === 'Client review',
		'the label rides the MANIFEST entry, so it replicates, persists and exports for free'
	);
	shown = await panelRows(A);
	h.check(
		shown[0].hash === named && shown[0].label === 'Client review' && shown[0].pointer,
		`the named version is the new pointer and shows its name (${shown[0].label})`
	);
	shelf = await shelves(A, 'Arena.tpscene');
	h.check(
		shelf.visible.length === 1 && shelf.visible[0] === named,
		`still ONE visible card after a manual save (${shelf.visible.length})`
	);

	// =====================================================================
	// 5. RESTORE — checkpoint, RE-APPEND, and the world really goes back
	// =====================================================================
	await addBox(A); // unsaved work: the checkpoint has to catch this
	const beforeRestore = await childUuids(A);
	h.check(beforeRestore.length === 4, `premise: four objects are open, one of them unsaved (${beforeRestore.length})`);
	const histBefore = (await historyOf(A, 'Arena')).length;
	// restore the FIRST version (a one-object world) from its own row
	await A.page.locator(`#version-history .vh-row[data-hash="${v[0]}"] .vh-restore`).click();
	await h.eventually(
		() => childUuids(A),
		(uuids) => uuids.length === 1,
		'the world reverted to the first version'
	);
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify(worldAt[0]),
		`and it is THAT world, by uuid — not merely one object (${JSON.stringify(await childUuids(A))} vs ${JSON.stringify(worldAt[0])})`
	);
	const histAfter = await historyOf(A, 'Arena');
	h.check(
		histAfter.length === histBefore + 2,
		`two entries: a CHECKPOINT of the open scene, then the RE-APPEND (${histBefore} → ${histAfter.length})`
	);
	h.check(
		histAfter[histAfter.length - 1] === v[0],
		'the pointer is the restored version (a re-append, never a dedupe — going back is an event)'
	);
	h.check(
		histAfter[histAfter.length - 2] !== named &&
			(await heldByHash(A, [histAfter[histAfter.length - 2]]))[0],
		'the checkpoint is a NEW hash we hold — the unsaved work was not thrown away'
	);
	h.check(
		(await A.page.evaluate(async () => {
			const s = window.__stores;
			let m;
			s.projectManifest.projectManifest.subscribe((x) => (m = x))();
			const check = m.scenes.Arena.history[m.scenes.Arena.history.length - 2];
			const item = s.explorer.itemByHash(check);
			const blob = await s.explorer.itemBlob(item.id);
			const payload = await s.sessions.readSessionZip(await blob.arrayBuffer());
			return payload.count;
		})) === 4,
		'the checkpoint really holds the FOUR objects that were open (read back out of the .tpscene)'
	);
	shown = await panelRows(A);
	h.check(
		shown.filter((r) => r.hash === v[0]).length === 1,
		'a re-appended hash is ONE row, not two — the history may repeat it, the list may not'
	);
	shelf = await shelves(A, 'Arena.tpscene');
	h.check(
		shelf.visible.length === 1 && shelf.visible[0] === v[0],
		`and the one visible card followed the pointer back (${shelf.visible.map((x) => x.slice(0, 8))})`
	);

	// =====================================================================
	// 6. DELETE HONESTY — bytes only. The project keeps the version.
	// =====================================================================
	const doomed = v[1];
	const histLen = (await historyOf(A, 'Arena')).length;
	await A.page.locator(`#version-history .vh-row[data-hash="${doomed}"] .vh-delete`).click();
	await h.eventually(
		() => heldByHash(A, [doomed]),
		(held) => held[0] === false,
		'the local bytes are gone'
	);
	h.check(
		(await historyOf(A, 'Arena')).length === histLen &&
			(await historyOf(A, 'Arena')).includes(doomed),
		'the MANIFEST still names it — pruning was always about disk, never about history'
	);
	shown = await panelRows(A);
	const orphan = shown.find((r) => r.hash === doomed);
	h.check(!!orphan, 'the row STAYS — a version you no longer hold is still a version');
	h.check(
		orphan?.when === '—' && orphan?.badges.includes('Not held'),
		`and it says so honestly rather than inventing a date (when="${orphan?.when}", badges ${JSON.stringify(orphan?.badges)})`
	);
	h.check(
		orphan?.restore === true && orphan?.del === false,
		'nothing left to delete, but Restore is still offered — travel pulls it back by hash from a peer'
	);

	// =====================================================================
	// 7. THE SETTING AT ZERO — no versions cut behind your back, everything
	//    you ASK for still works
	// =====================================================================
	await A.page.evaluate(() => window.__stores.levels.newLevel('Sandbox'));
	const sandbox = await A.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v2) => (items = v2))();
		const item = items.find((i) => i.name === 'Sandbox.tpscene');
		window.__stores.projectManifest.publishSceneVersion('Sandbox', item.hash);
		return item.hash;
	});
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Sandbox'));
	await h.eventually(() => childUuids(A), (u) => u.length === 0, 'premise: on the empty Sandbox scene');
	await A.page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(0));
	await addBox(A); // a real edit, so only the SETTING can be what stops the publish
	const sandboxBefore = (await historyOf(A, 'Sandbox')).length;
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	await h.eventually(() => childUuids(A), (u) => u.length === 1, 'travelled away from Sandbox');
	h.check(
		(await historyOf(A, 'Sandbox')).length === sandboxBefore,
		`at keep-0 the travel-away auto-save publishes NOTHING (${sandboxBefore} → ${(await historyOf(A, 'Sandbox')).length})`
	);
	// the counterfactual, in-test: the SAME departure with the setting back on does publish
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Sandbox'));
	await h.eventually(() => childUuids(A), (u) => u.length === 0, 'back on Sandbox (its saved, empty content)');
	await addBox(A);
	await A.page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(10));
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	await h.eventually(() => childUuids(A), (u) => u.length === 1, 'left Sandbox again, setting restored');
	h.check(
		(await historyOf(A, 'Sandbox')).length === sandboxBefore + 1,
		`COUNTERFACTUAL: the identical departure with the setting on DOES publish (${(await historyOf(A, 'Sandbox')).length})`
	);
	// and an explicit save is never gated by it — it is the user asking
	await A.page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(0));
	const manualAtZero = await saveScene(A, 'Arena');
	h.check(
		!!manualAtZero?.hash && (await historyOf(A, 'Arena')).includes(manualAtZero.hash),
		'an explicit Save scene still publishes at keep-0 — off means "stop cutting versions unasked"'
	);
	const keep0 = await A.page.evaluate(() => [
		...window.__stores.projectManifest.keepableHashes('Arena')
	]);
	const pointerNow = (await historyOf(A, 'Arena')).slice(-1)[0];
	h.check(
		keep0.length === 1 && keep0[0] === pointerNow,
		`at keep-0 the prune set is the pointer alone (${keep0.length} kept)`
	);
	// that save ran the prune with the count at zero, so it really did free everything
	// but the pointer — the setting is not advisory
	const arenaHeld = await heldByHash(A, await historyOf(A, 'Arena'));
	h.check(
		arenaHeld.filter(Boolean).length === 1,
		`and the save's own prune freed every other version's bytes (${arenaHeld.filter(Boolean).length} still held)`
	);
	h.check(
		(await shelves(A, 'Arena.tpscene')).visible.length === 1,
		'the one visible card is still there — pruning frees bytes, it never removes the scene'
	);

	// =====================================================================
	// 8. THE PRUNE OBEYS THE COUNT — and a PIN always survives it.
	//    A FRESH scene, because §7 deliberately left Arena with one held version
	//    and a prune with nothing to drop would prove nothing.
	// =====================================================================
	await A.page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(10));
	/** @type {string[]} */
	const t = [];
	for (let i = 0; i < 4; i++) {
		await addBox(A);
		t.push((await saveScene(A, 'Tower'))?.hash);
	}
	h.check(
		new Set(t).size === 4 && (await heldByHash(A, t)).every(Boolean),
		`premise: four Tower versions, all held (${new Set(t).size} distinct)`
	);
	// t[0] is deliberately OUTSIDE the newest two — a pin already inside the window
	// would prove nothing about pinning
	await A.page.evaluate((hash) => {
		const s = window.__stores.projectManifest;
		s.keepVersionsSetting.set(2);
		s.pinSceneVersion('Tower', hash, true);
	}, t[0]);
	const pinnedKeep = await A.page.evaluate(() => [
		...window.__stores.projectManifest.keepableHashes('Tower')
	]);
	h.check(
		pinnedKeep.length === 3 && pinnedKeep.includes(t[0]) && pinnedKeep.includes(t[3]),
		`keep-2 plus one pin OUTSIDE the window = three keepable hashes (${pinnedKeep.length})`
	);
	const towerHist = await historyOf(A, 'Tower');
	const dropped = await A.page.evaluate(() => window.__stores.levels.pruneSceneVersions('Tower'));
	h.check(dropped === 1, `the prune dropped exactly the one unkeepable version (${dropped})`);
	h.check(
		JSON.stringify(await historyOf(A, 'Tower')) === JSON.stringify(towerHist),
		'the manifest history is byte-identical afterwards — bytes went, history did not'
	);
	h.check(
		(await heldByHash(A, [t[0]]))[0] === true,
		'the PINNED version kept its bytes through a prune whose window excluded it'
	);
	const survivors = await heldByHash(A, towerHist);
	h.check(
		towerHist.every((hash, i) => survivors[i] === pinnedKeep.includes(hash)),
		`exactly the keepable set survived — nothing more, nothing less (${JSON.stringify(survivors)})`
	);
	await A.page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(10));

	// =====================================================================
	// 9. THE .tp ROUND TRIP — hidden versions ride out and fold back in
	// =====================================================================
	const exported = await A.page.evaluate(async () => {
		const r = await window.__stores.projectFile.exportProject();
		return { scenes: r.scenes, skipped: r.skippedScenes, bytes: [...r.bytes] };
	});
	h.check(
		exported.scenes >= 3,
		`the .tp carried the kept versions, HIDDEN ones included (${exported.scenes} scene files, ${exported.skipped} skipped)`
	);
	h.check(
		(await shelves(A, 'Tower.tpscene')).hidden.length >= 2,
		'premise: most of what that export carried was on the hidden shelf, reachable only through itemByHash'
	);
	// a clean library, then import: the versions land VISIBLE and the migration folds them
	await A.page.evaluate(async () => {
		const s = window.__stores.explorer;
		let vis, hid;
		s.explorerItems.subscribe((x) => (vis = x))();
		s.hiddenItems.subscribe((x) => (hid = x))();
		for (const item of [...vis, ...hid]) await s.deleteItem(item.id);
		window.__stores.projectManifest.manifestRestore(null);
	});
	h.check(
		(await shelves(A, 'Tower.tpscene')).visible.length === 0,
		'premise: the library is empty before the import'
	);
	// 21-G8 renames the whole-project restore to openProject (fork 12: it replaces and
	// WARNS) — take whichever this build has, answering the warning when it exists, so
	// this suite is green on the G7 branch alone AND after G8 lands under it
	const importPending = A.page.evaluate((bytes) => {
		const pf = window.__stores.projectFile;
		const buffer = new Uint8Array(bytes).buffer;
		return pf.openProject ? pf.openProject(buffer) : pf.importProject(buffer);
	}, exported.bytes);
	await A.page.evaluate(async () => {
		if (!window.__stores.projectFile.openProject) return; // pre-G8: no warning to answer
		const cd = window.__stores.confirmDialog;
		for (let i = 0; i < 100; i++) {
			let d;
			cd.confirmDialog.subscribe((v) => (d = v))();
			if (d?.title?.startsWith('Open project')) return cd.resolveConfirm(true);
			await new Promise((r) => setTimeout(r, 100));
		}
	});
	const imported = await importPending;
	h.check(!!imported, 'the project imported');
	await h.eventually(
		() => shelves(A, 'Tower.tpscene'),
		(s) => s.visible.length === 1 && s.hidden.length >= 1,
		'ONE visible card again — the versions arrive VISIBLE and the migration folds them'
	);
	const afterImport = await shelves(A, 'Tower.tpscene');
	h.check(
		afterImport.visible[0] === (await historyOf(A, 'Tower')).slice(-1)[0],
		'and the card that stayed is the pointer'
	);
	h.check(
		(await shelves(A, 'Arena.tpscene')).visible.length === 1,
		'a scene the export could only carry ONE version of still comes back as exactly one card'
	);
	h.check(
		(await manifestOf(A)).scenes.Arena.labels?.[named] === 'Client review',
		'the version NAME survived the round trip (it is manifest data, so it just rides along)'
	);

	// =====================================================================
	// 10. THE NAME FOLD — 21-I1, THE REPORTED BUG.
	//     §2 folds cards whose hashes the HISTORY names. This is the other
	//     case, and it is the one users hit: an item the manifest NEVER
	//     recorded stayed a visible card forever, so a long-lived profile grew
	//     a shelf of twins while a clean one looked perfect. Folding it alone
	//     would be worse than the bug — hidden bytes with no door — so it is
	//     ADOPTED into the history first, and the POINTER may not move.
	// =====================================================================
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	const depotPointer = (await saveScene(A, 'Depot'))?.hash;
	h.check(!!depotPointer, 'premise: Depot saved once, so its history is exactly one hash');
	// three files nothing ever published: two BACKDATED (the pre-manifest case) and one
	// stamped AFTER the pointer (a viewer's save). The future one is the interesting one:
	// it proves the rule is about ORDER, not about time.
	const orphanOld = await craftOrphan(A, 'Depot', 1000000);
	const orphanMid = await craftOrphan(A, 'Depot', 2000000);
	const orphanNew = await craftOrphan(A, 'Depot', Date.now() + 10000000);
	h.check(
		new Set([depotPointer, orphanOld, orphanMid, orphanNew]).size === 4,
		'premise: four distinct .tpscene files of one scene exist'
	);
	let depotShelf = await shelves(A, 'Depot.tpscene');
	h.check(
		depotShelf.visible.length === 4,
		`premise: THE BUG STATE reproduced — four cards for one scene (${depotShelf.visible.length})`
	);
	h.check(
		JSON.stringify(await historyOf(A, 'Depot')) === JSON.stringify([depotPointer]),
		'premise: and the manifest has never heard of three of them — which is exactly why the' +
			' hash-only fold could never touch them'
	);
	const foldedByName = await A.page.evaluate(() => window.__stores.levels.foldSceneVersions());
	h.check(
		foldedByName >= 3,
		`the sweep folded the three orphans (${foldedByName} items moved shelf)`
	);
	const depotHist = await historyOf(A, 'Depot');
	h.check(
		JSON.stringify(depotHist) === JSON.stringify([orphanOld, orphanMid, orphanNew, depotPointer]),
		`ADOPTED oldest-first by createdAt, every one of them BEFORE the pointer (${JSON.stringify(depotHist.map((x) => x.slice(0, 6)))})`
	);
	h.check(
		depotHist[depotHist.length - 1] === depotPointer,
		'THE POINTER DID NOT MOVE — including for the orphan minted AFTER it, because a' +
			' migration may not change which version the project means'
	);
	depotShelf = await shelves(A, 'Depot.tpscene');
	h.check(
		depotShelf.visible.length === 1 && depotShelf.visible[0] === depotPointer,
		`ONE card again, and it is the pointer (${depotShelf.visible.length} visible)`
	);
	h.check(
		depotShelf.hidden.length === 3,
		`the three orphans went to the hidden shelf, not to the bin (${depotShelf.hidden.length})`
	);
	h.check(
		(await heldByHash(A, [orphanOld, orphanMid, orphanNew, depotPointer])).every(Boolean),
		'and every one of the four still resolves by hash — folding moved records, never bytes'
	);
	// IDEMPOTENT: adoption writes the manifest, and a manifest write re-runs this sweep.
	// A second pass must find nothing, or the two would feed each other forever.
	const stampBefore = (await manifestOf(A)).changedAt;
	await A.page.evaluate(() => window.__stores.levels.foldSceneVersions());
	await A.page.waitForTimeout(400);
	h.check(
		(await manifestOf(A)).changedAt === stampBefore &&
			JSON.stringify(await historyOf(A, 'Depot')) === JSON.stringify(depotHist),
		'a second sweep writes NOTHING — the adoption terminates instead of re-appending forever'
	);
	// the whole point of adopting rather than merely hiding: the panel can offer them
	await openPanel(A, 'Depot.tpscene');
	shown = await panelRows(A);
	h.check(
		shown.length === 4 &&
			shown.map((r) => r.hash).join() === [depotPointer, orphanNew, orphanMid, orphanOld].join(),
		`the panel lists all four, newest first — the folded bytes now have a DOOR (${shown.length} rows)`
	);
	h.check(
		shown.slice(1).every((r) => r.restore),
		'and every adopted version can be restored, which is the only thing that makes hiding it honest'
	);

	// =====================================================================
	// 11. THE `Previous` BADGE — history[length - 2]
	// =====================================================================
	h.check(
		shown[1].badges.includes('Previous') &&
			!shown[0].badges.includes('Previous') &&
			!shown[2].badges.includes('Previous'),
		`exactly ONE row carries Previous, and it is the one behind the pointer (${JSON.stringify(shown.map((r) => r.badges))})`
	);
	h.check(
		shown[0].badges.includes('Current') && !shown[0].badges.includes('Previous'),
		'the pointer is Current and never both'
	);
	// after a RESTORE the previous row is the checkpoint the restore just took — the row a
	// user goes looking for, and until now indistinguishable from every other "Auto"
	await addBox(A); // unsaved work, so there is something for the checkpoint to catch
	const depotLenBefore = (await historyOf(A, 'Depot')).length;
	await A.page.locator(`#version-history .vh-row[data-hash="${orphanOld}"] .vh-restore`).click();
	await h.eventually(
		() => historyOf(A, 'Depot'),
		(hist) => hist.length === depotLenBefore + 2,
		'the restore checkpointed the open scene and re-appended the old version'
	);
	const depotAfter = await historyOf(A, 'Depot');
	await openPanel(A, 'Depot.tpscene');
	shown = await panelRows(A);
	h.check(
		shown[0].hash === orphanOld && shown[0].badges.includes('Current'),
		'the restored version is Current'
	);
	h.check(
		shown[1].hash === depotAfter[depotAfter.length - 2] && shown[1].badges.includes('Previous'),
		'and Previous is the CHECKPOINT the restore just took — the row the badge exists for'
	);

	// =====================================================================
	// 12. "Save version…" ONLY FOR THE OPEN SCENE — both directions, real UI.
	//     It versions the CURRENT scene, so on a card you have merely selected
	//     it would file this scene's contents under that one's name.
	// =====================================================================
	h.check(
		(await currentLevelName(A)) === 'Depot',
		`premise: the restore left us IN Depot (${await currentLevelName(A)})`
	);
	h.check(
		(await countOf(A, '#version-save')) === 1 && (await countOf(A, '#version-save-hint')) === 0,
		'the save row is offered on the scene you are in'
	);
	await saveScene(A, 'Foyer'); // a SECOND scene — saving it is also how we leave Depot
	h.check(
		(await currentLevelName(A)) === 'Foyer',
		`premise: we are now in Foyer, and Depot is merely a card (${await currentLevelName(A)})`
	);
	await openPanel(A, 'Depot.tpscene');
	h.check(
		(await countOf(A, '#version-save')) === 0,
		'on a scene you have only SELECTED the button is gone — it would have saved Foyer under the name Depot'
	);
	h.check(
		(((await A.page.locator('#version-save-hint').first().textContent()) ?? '')
			.toLowerCase()
			.includes('open this scene')),
		'and it SAYS why, rather than leaving a gap where a button was'
	);
	h.check(
		(await panelRows(A)).length > 1,
		'the history itself is still fully readable there — only the WRITE is gated'
	);
	await openPanel(A, 'Foyer.tpscene');
	h.check(
		(await countOf(A, '#version-save')) === 1 && (await countOf(A, '#version-save-hint')) === 0,
		'COUNTERFACTUAL: the same panel on the OPEN scene still offers it'
	);

	// =====================================================================
	// 13. A SCENE WITH NO HISTORY still gets a panel. A New scene… publishes
	//     nothing, so the manifest has no entry — which used to render the
	//     whole component away, leaving no way to take a first version of it.
	// =====================================================================
	await A.page.evaluate(() => window.__stores.levels.newLevel('Draft'));
	const draftHash = await A.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v2) => (items = v2))();
		return items.find((i) => i.name === 'Draft.tpscene')?.hash ?? null;
	});
	h.check(
		!!draftHash && (await historyOf(A, 'Draft')).length === 0,
		'premise: the draft exists as a file and the manifest has no entry for it at all'
	);
	await openPanel(A, 'Draft.tpscene');
	h.check(
		await A.page.locator('#version-history').isVisible(),
		'the panel renders anyway — a .tpscene card is a scene whether or not the document knows it'
	);
	h.check(
		(await countOf(A, '#version-empty')) === 1 && (await panelRows(A)).length === 0,
		'with an honest empty state instead of a bare header'
	);
	h.check(
		(await countOf(A, '#version-save')) === 0,
		'and no save row, because the draft is not the scene we are in'
	);
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Draft'), draftHash);
	await h.eventually(() => currentLevelName(A), (n) => n === 'Draft', 'opened the draft');
	await openPanel(A, 'Draft.tpscene');
	h.check(
		(await countOf(A, '#version-save')) === 1 && (await countOf(A, '#version-empty')) === 1,
		'now it IS the open scene: "Save version…" over a history of nothing — the point of the gap'
	);
	await A.page.locator('#version-save').click();
	await h.eventually(
		() => historyOf(A, 'Draft'),
		(hist) => hist.length === 2,
		'the first version published — and the original file landed BESIDE it, not under it'
	);
	const draftHist = await historyOf(A, 'Draft');
	h.check(
		draftHist[0] === draftHash,
		'the New-scene file is history[0]: adopted by NAME in the same breath as the save that' +
			' would otherwise have made it a permanent twin'
	);
	h.check(
		(await shelves(A, 'Draft.tpscene')).visible.length === 1,
		`ONE card for the draft, though two .tpscene files of it exist (${(await shelves(A, 'Draft.tpscene')).visible.length})`
	);
	shown = await panelRows(A);
	h.check(
		shown.length === 2 && shown[0].badges.includes('Current') && shown[1].badges.includes('Previous'),
		`two rows, Current over Previous (${JSON.stringify(shown.map((r) => r.badges))})`
	);

	// =====================================================================
	// 13b. A VERSION LANDS BESIDE THE VERSION IT SUPERSEDES  (21-I, reported)
	// =====================================================================
	// A manual "Save version…" of a scene living in a SUBFOLDER wrote the new file at the
	// library ROOT — and because the new version becomes the pointer, and the pointer is
	// the one visible card, the scene appeared to MOVE there. `saveSceneVersion` passed
	// `null`, which since 21-H1 means the root (locked answer 6 retired the invented
	// `Scenes` folder). Every other scene in this suite lives at the root, so only one in
	// a real folder can tell the fix from the bug.
	//
	// LAST, and with a scene name of its own, on purpose: it saves — which moves
	// `currentLevel` — and every earlier section reasons about Arena being the open scene.
	const chapters = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Chapters', null)?.id ?? null
	);
	h.check(!!chapters, 'premise: a real library folder to keep a scene in');
	const folderOfHash = (hash) =>
		A.page.evaluate((h2) => window.__stores.explorer.itemByHash(h2)?.folderId ?? null, hash);
	const archiveV1 = await A.page.evaluate(async (folderId) => {
		const item = await window.__stores.levels.saveSceneAsLevel('Archive', folderId);
		return item?.hash ?? null;
	}, chapters);
	h.check((await folderOfHash(archiveV1)) === chapters, 'premise: Archive was saved INTO that folder');
	// no edit needed to make the next version differ: a .tpscene embeds a fresh uuid,
	// createdAt and thumbnail per save, which is the very reason `sceneSignature` exists
	const archiveV2 = await A.page.evaluate(async () => {
		const item = await window.__stores.levels.saveSceneVersion('Archive', 'Chapter two');
		return item?.hash ?? null;
	});
	const archiveFolder2 = await folderOfHash(archiveV2);
	h.check(
		!!archiveV2 && archiveV2 !== archiveV1 && archiveFolder2 === chapters,
		`THE FIX: the new version landed in the scene's own folder, not the root (${
			archiveFolder2 === chapters ? 'Chapters' : String(archiveFolder2)
		})`
	);
	const archiveShelf = await shelves(A, 'Archive.tpscene');
	h.check(
		archiveShelf.visible.length === 1 && archiveShelf.visible[0] === archiveV2,
		'…so the scene did not appear to MOVE — its one visible card is still in that folder'
	);

	// =====================================================================
	// 14. A PEER — a label is ordinary manifest data
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.connect(B, A); // B dials A, so A stays the writer
	await h.eventually(
		() => B.page.evaluate(() => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v2) => (m = v2))();
			return m.scenes?.Arena?.labels ?? null;
		}),
		(labels) => !!labels && Object.values(labels).includes('Client review'),
		'the peer receives the version labels with the rest of the document — no new message type',
		30000
	);

	// ---- ADOPTION IS WRITER-ONLY -----------------------------------------------------
	// The fold is a local display truth and runs everywhere; ADOPTION writes the SHARED
	// document, so a joiner must not file its own unrelated files into somebody else's
	// project. B holds an `Arena.tpscene` of its OWN — same name, different bytes, a
	// different project entirely — which is precisely the case a name-match cannot tell
	// apart from a real older version. B must fold it to one card and adopt NOTHING.
	const historyBefore = await B.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v2) => (m = v2))();
		return [...(m.scenes?.Arena?.history ?? [])];
	});
	const strayHash = await B.page.evaluate(async () => {
		const bytes = new TextEncoder().encode('B’s own unrelated Arena, from another project');
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'Arena.tpscene', null);
		await window.__stores.levels.foldSceneVersions();
		await new Promise((r) => setTimeout(r, 400));
		return item.hash;
	});
	const historyAfter = await B.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v2) => (m = v2))();
		return [...(m.scenes?.Arena?.history ?? [])];
	});
	h.check(
		!historyAfter.includes(strayHash) &&
			JSON.stringify(historyAfter) === JSON.stringify(historyBefore),
		`a JOINER adopts nothing — its stray Arena stayed out of the shared history (${historyBefore.length} -> ${historyAfter.length})`
	);
	// …and it does not FOLD it either. B never pulled the host's Arena bytes, so its own
	// file is the only Arena copy it holds — a name-fold against somebody else's document
	// would hide it and leave B with NO Arena card at all (measured, before the gate
	// covered both halves). Local data may not vanish because a remote document reuses a
	// name, so the whole by-name sweep is writer-only and B's file stays exactly where it is.
	h.check(
		(await shelves(B, 'Arena.tpscene')).visible.includes(strayHash),
		"…and its own file is untouched — a joiner does not fold by name against a document it did not write"
	);
	await h.eventually(
		() => historyOf(A, 'Arena'),
		(hist) => !hist.includes(strayHash),
		"…and the HOST's history never heard of it (nothing was broadcast)"
	);

	for (const p of [A, B]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
