// LOOSE SCENES + DUPLICATE IMPORTS — two reported bugs with one root cause: the app
// treated a scene FILE sitting in the library as if it were a member of the project.
//
//   §1  BUG 1, end to end. Two .tpscene files DRAGGED IN, open one, edit it, open the
//       other — and no third file may appear and no manifest entry may be created.
//       This is the reported repro verbatim (download all versions, unzip, drag both
//       into a fresh profile), driven through the real drop and the real card.
//   §2  BUG 1, second half. `hideOldVersions` folds same-NAMED scene files together as
//       versions, which is right for the legacy duplicates 21-I1 migrated and wrong for
//       files a user imported independently. WITH THE COUNTERFACTUAL COMPUTED IN-TEST:
//       clear the stamp on one item, re-run the sweep, and watch it fold — which is the
//       only thing that proves the scenario is adversarial rather than merely quiet.
//   §3  BUG 2a. Re-importing bytes the library already holds is VISIBLE now: the modal
//       in Ask, a counted toast in Skip, real files in Copy.
//   §4  BUG 2b. A copy is possible for a SCENE and for nothing else, because an item's
//       identity IS its content hash — and the modal says so per group instead of
//       offering a button that cannot work.
//   §5  THE INVARIANT the whole design stands on: no two items share a hash. This is
//       also a regression guard — `importFiles` used to write unconditionally, so
//       dropping one file twice minted two items with one hash and `itemByHash` (which
//       travel-by-hash, the .tp export and every assetShare pull go through) answered
//       with whichever came first.
//   §6  The setting, in Settings ▸ Files, driving the same key the modal's "don't ask
//       again" writes.
//   §7  A .tp import surfaces its duplicates too.
//
// SINGLE PEER on purpose: every writer here is gated on being the session writer
// (`sessionHost === null`), which a solo peer is, and nothing in this batch adds a
// message type. The one replicated thing it touches — the manifest — is asserted by
// its ABSENCE, which a second peer cannot make more true.
//
// Run: APP_URL='https://localhost:5202/' npm run e2e -- import-duplicates
const h = require('./helpers.cjs');

// ---- reading the world -------------------------------------------------------------

const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores.explorer;
		let vis, hid;
		s.explorerItems.subscribe((v) => (vis = v))();
		s.hiddenItems.subscribe((v) => (hid = v))();
		return {
			visible: vis.map((i) => ({ id: i.id, name: i.name, hash: i.hash, imported: !!i.imported })),
			hidden: hid.map((i) => ({ id: i.id, name: i.name, hash: i.hash, imported: !!i.imported }))
		};
	});

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const currentLevelOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const worldUuids = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return (g?.children ?? []).map((c) => c.uuid).sort();
	});

const toastsOf = (peer) =>
	peer.page.evaluate(() => {
		let t;
		window.__stores.toastStore.subscribe((x) => (t = x))();
		return (t ?? []).map((x) => (typeof x === 'string' ? x : (x.text ?? '')));
	});

const clearToasts = (peer) => peer.page.evaluate(() => window.__stores.toastStore.set([]));

const modeOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.importDuplicates.duplicateImportMode.subscribe((v) => (m = v))();
		return m;
	});

const setMode = (peer, mode) =>
	peer.page.evaluate((m) => window.__stores.importDuplicates.setDuplicateImportMode(m), mode);

// ---- driving ------------------------------------------------------------------------

/** Build a .tpscene the way a save does, and hand its BYTES back to node so the suite
 *  can drop it as a real OS file — which is the path the report describes. */
const sceneBytes = (peer, name, boxes) =>
	peer.page.evaluate(
		async ({ n, count }) => {
			const s = window.__stores;
			const payload = s.sessions.emptySessionPayload(n);
			// give each file DIFFERENT content, so the two are genuinely different files
			// rather than one file the hash dedupe would collapse
			payload.count = count;
			payload.annotations = Array.from({ length: count }, (_, i) => ({
				id: 'note-' + n + '-' + i,
				objectUuid: null,
				objectName: '',
				offset: [0, 0, 0],
				text: 'marker ' + i
			}));
			const bytes = await s.sessions.exportSessionZip(payload, {
				assets: false,
				packs: false,
				flow: true
			});
			return Array.from(bytes);
		},
		{ n: name, count: boxes }
	);

/** an OS FILE drop onto the Explorer grid — `dt.items.add` is what populates dt.files */
const dropFile = (peer, name, type, arr) =>
	peer.page.evaluate(
		({ name, type, arr }) => {
			const file = new File([new Uint8Array(arr)], name, { type });
			const dt = new DataTransfer();
			dt.items.add(file);
			document
				.querySelector('#explorer-list')
				.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
		},
		{ name, type, arr }
	);

/** wipe library + manifest + where-we-are: the "fresh profile" the report starts from */
const freshProfile = async (peer) => {
	await peer.page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await peer.page.waitForTimeout(400);
};

/**
 * Wait for the LIBRARY to reach a count, never for a clock. Measured on a loaded
 * box: a .tpscene drop can take well over a second to land (hash + zip + idb), so a
 * fixed sleep here is a lottery — and when it loses, the NEXT drop reads an empty
 * library, both files import as fresh, and the section reports one file missing.
 */
const settleItems = (peer, count, label) =>
	h.eventually(
		() => itemsOf(peer),
		(i) => i.visible.length === count,
		label,
		20000
	);

const modalOpen = (peer) => peer.page.locator('#dup-skip').isVisible().catch(() => false);

/** what the modal is showing, per group */
const modalRows = (peer) =>
	peer.page.evaluate(() => {
		const rows = [...document.querySelectorAll('[data-dup-hash]')];
		return rows.map((r) => ({
			hash: r.getAttribute('data-dup-hash'),
			name: r.querySelector('.dup-name')?.textContent?.trim() ?? '',
			checkbox: !!r.querySelector('input[type="checkbox"]'),
			checked: !!r.querySelector('input[type="checkbox"]')?.checked
		}));
	});

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngArr = () => Array.from(Uint8Array.from(Buffer.from(TINY_PNG, 'base64')));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(300);

	// two versions of ONE scene, exactly as "Download all versions (.zip)" produces them:
	// same NAME, different CONTENT, and nothing anywhere that says they are related
	const v1 = await sceneBytes(A, 'Drifter', 1);
	const v2 = await sceneBytes(A, 'Drifter', 3);
	h.check(
		v1.length > 0 && v2.length > 0 && JSON.stringify(v1) !== JSON.stringify(v2),
		'premise: two DIFFERENT .tpscene files of one scene name'
	);

	// =====================================================================
	// 1. BUG 1 — travel-away must not invent a project scene from a loose file
	// =====================================================================
	await freshProfile(A);
	await setMode(A, 'ask');
	await dropFile(A, 'Drifter.tpscene', 'application/zip', v1);
	await settleItems(A, 1, 'premise: the first dragged-in file landed');
	await dropFile(A, 'Drifter.tpscene', 'application/zip', v2);
	await settleItems(A, 2, 'premise: the second dragged-in file landed');

	let items = await itemsOf(A);
	h.check(
		items.visible.filter((i) => i.name === 'Drifter.tpscene').length === 2,
		`BOTH dragged-in files are in the library — neither was folded away (${items.visible.length} visible, ${items.hidden.length} hidden)`
	);
	h.check(
		items.visible.filter((i) => i.name === 'Drifter.tpscene').every((i) => i.imported),
		'…and both carry the IMPORTED stamp, which is what tells the fold they are strangers'
	);
	h.check(
		Object.keys((await manifestOf(A)).scenes).length === 0,
		'premise: dragging files in creates no project scene at all'
	);

	const [fileOne, fileTwo] = items.visible.filter((i) => i.name === 'Drifter.tpscene');

	// open the FIRST one, the way the report does
	await clearToasts(A);
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash), fileOne.hash);
	await h.eventually(
		() => currentLevelOf(A),
		(c) => c?.hash === fileOne.hash,
		'opening a dragged-in scene file loads it'
	);
	let at = await currentLevelOf(A);
	h.check(
		at?.unsaved === true,
		`THE FIX: a scene the project has never heard of is LOOSE, not a project member (unsaved=${at?.unsaved})`
	);
	h.check(
		Object.keys((await manifestOf(A)).scenes).length === 0,
		'…and opening it still wrote nothing into the manifest'
	);

	// edit it — the thing that used to make travel-away publish
	const beforeEdit = (await worldUuids(A)).length;
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});
	h.check((await worldUuids(A)).length === beforeEdit + 1, 'premise: the loose scene was edited');

	// …then open the OTHER one. This is the exact moment the phantom file appeared.
	const beforeTravel = (await itemsOf(A)).visible.length;
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash), fileTwo.hash);
	await h.eventually(
		() => currentLevelOf(A),
		(c) => c?.hash === fileTwo.hash,
		'the second dragged-in scene opens'
	);
	await A.page.waitForTimeout(800);

	items = await itemsOf(A);
	h.check(
		items.visible.length === beforeTravel && items.hidden.length === 0,
		`THE REPORTED BUG IS DEAD: leaving a loose scene minted no file (${beforeTravel} -> ${items.visible.length} visible, ${items.hidden.length} hidden)`
	);
	h.check(
		Object.keys((await manifestOf(A)).scenes).length === 0,
		'…and no project scene was invented for a name the user never chose'
	);
	h.check(
		(await currentLevelOf(A))?.unsaved === true,
		'the second one is loose as well — the rule is about the FILE, not about the first hop'
	);

	// the offer the user does get instead: the first edit prompts to save it in. It is
	// armed on a 1.5s delay (the load storms markDirty), so this waits for the arming.
	await clearToasts(A);
	await A.page.waitForTimeout(1800);
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
	});
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /not part of your project yet/i.test(x)),
		'instead of publishing behind your back, the first edit OFFERS to save it in',
		12000
	);

	// =====================================================================
	// 2. BUG 1, second half — the by-name fold must skip imported files
	// =====================================================================
	// Now give the project a real scene called Drifter, so `hideOldVersions('Drifter')`
	// has an entry to run against. The two dragged-in files must survive it.
	await clearToasts(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Drifter'));
	await A.page.waitForTimeout(1200);

	let entry = (await manifestOf(A)).scenes['Drifter'];
	h.check(
		!!entry && entry.history.length >= 1,
		`premise: the project now has a scene called Drifter (${entry?.history.length} version(s))`
	);
	items = await itemsOf(A);
	// THE DISTINCTION, sharpened by the loose-scene adoption: §1 left us standing in
	// fileTwo, so saving adopts THAT one as version 1 — it is not a stranger, it is
	// literally the scene we saved. fileOne is a file the user merely dragged in, shares
	// a name by coincidence, and must survive untouched. Two imported files, two
	// different answers, decided by `currentLevel.hash` rather than by the name.
	h.check(
		entry.history.includes(fileTwo.hash),
		'the file we were STANDING IN is adopted as a version of the scene we saved'
	);
	h.check(
		items.hidden.some((i) => i.hash === fileTwo.hash),
		'…and folded, so the scene keeps ONE card'
	);
	h.check(
		items.visible.some((i) => i.hash === fileOne.hash && i.imported),
		'…while the file we merely dragged in is still a card'
	);
	h.check(
		!entry.history.includes(fileOne.hash),
		'…and was NOT adopted into a project scene it only shares a name with'
	);

	// THE COUNTERFACTUAL, computed in-test: strip the stamp from ONE of them and re-run
	// the same sweep. Without it the sweep folds — which is what makes the check above
	// evidence rather than a quiet pass, AND proves the 21-I1 migration still works for
	// every item stored before the stamp existed.
	const folded = await A.page.evaluate((id) => {
		const s = window.__stores;
		s.explorer.explorerItems.update((list) =>
			list.map((i) => (i.id === id ? { ...i, imported: false } : i))
		);
		return s.levels.hideOldVersions('Drifter');
	}, fileOne.id);
	await A.page.waitForTimeout(400);
	items = await itemsOf(A);
	h.check(
		folded >= 1 && items.hidden.some((i) => i.hash === fileOne.hash),
		`COUNTERFACTUAL: with the stamp removed the very same sweep folds it (${folded} moved) — the guard is load-bearing, and the 21-I1 migration is untouched`
	);
	h.check(
		items.visible.filter((i) => i.name === 'Drifter.tpscene').length === 1,
		`…leaving exactly the pointer visible, which is what the stamp had been preventing (${items.visible.filter((i) => i.name === 'Drifter.tpscene').length} card)`
	);

	// =====================================================================
	// 3. BUG 2a — the dedupe is VISIBLE
	// =====================================================================
	await freshProfile(A);
	await setMode(A, 'ask');
	await clearToasts(A);
	await dropFile(A, 'Twin.tpscene', 'application/zip', v1);
	await settleItems(A, 1, 'premise: one file in the library');

	await dropFile(A, 'Twin.tpscene', 'application/zip', v1);
	await h.eventually(() => modalOpen(A), (v) => v === true, 'ASK: re-importing the same bytes opens the modal instead of doing nothing at all');
	let rows = await modalRows(A);
	h.check(
		rows.length === 1 && rows[0].name === 'Twin.tpscene',
		`the modal names the file (${JSON.stringify(rows.map((r) => r.name))})`
	);
	h.check(rows[0].checkbox && rows[0].checked, 'a SCENE row is tickable and starts ticked — the copy action is the one you have to opt into');

	await A.page.locator('#dup-skip').click();
	await A.page.waitForTimeout(700);
	h.check(
		(await itemsOf(A)).visible.length === 1,
		'Skip leaves the library exactly as it was — and it took a decision, not silence'
	);
	h.check(!(await modalOpen(A)), 'the modal closed');

	// --- Import as copies ---
	await clearToasts(A);
	await dropFile(A, 'Twin.tpscene', 'application/zip', v1);
	await h.eventually(() => modalOpen(A), (v) => v === true, 'the modal opens again');
	await A.page.locator('#dup-import-copies').click();
	await h.eventually(
		() => itemsOf(A),
		(i) => i.visible.length === 2,
		'"Import as copies" adds a real second file'
	);
	items = await itemsOf(A);
	const copy = items.visible.find((i) => i.name !== 'Twin.tpscene');
	h.check(
		!!copy && /\(copy\)/.test(copy.name),
		`…named as a copy rather than as a second file with the same name (${copy?.name})`
	);
	h.check(
		!!copy && copy.hash !== items.visible.find((i) => i.name === 'Twin.tpscene')?.hash,
		'…and with a DIFFERENT content hash, which is the only way two items may coexist'
	);
	// the copy is a real, readable scene with an identity of its own
	const copyPayload = await A.page.evaluate(async (id) => {
		const blob = await window.__stores.explorer.itemBlob(id);
		const p = await window.__stores.sessions.readSessionZip(await blob.arrayBuffer());
		return { id: p?.id, name: p?.name, notes: (p?.annotations ?? []).length };
	}, copy.id);
	const srcPayload = await A.page.evaluate(async (id) => {
		const blob = await window.__stores.explorer.itemBlob(id);
		const p = await window.__stores.sessions.readSessionZip(await blob.arrayBuffer());
		return { id: p?.id, name: p?.name, notes: (p?.annotations ?? []).length };
	}, items.visible.find((i) => i.name === 'Twin.tpscene').id);
	h.check(
		copyPayload.notes === srcPayload.notes && copyPayload.notes > 0,
		`the copy holds the same CONTENT (${copyPayload.notes} annotations either side)`
	);
	h.check(
		copyPayload.id !== srcPayload.id,
		'…with a fresh uuid, which is what makes the bytes — and therefore the hash — genuinely new'
	);
	h.check(
		copyPayload.name !== srcPayload.name && /\(copy\)/.test(String(copyPayload.name)),
		`…and its own SCENE name (${srcPayload.name} -> ${copyPayload.name}), so it cannot share the original's version history`
	);

	// --- Skip them, as a setting ---
	await setMode(A, 'skip');
	await clearToasts(A);
	const beforeSkip = (await itemsOf(A)).visible.length;
	await dropFile(A, 'Twin.tpscene', 'application/zip', v1);
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /Skipped 1 file already in your library/i.test(x)),
		'SKIP: no modal, and it SAYS how many it left out'
	);
	h.check((await itemsOf(A)).visible.length === beforeSkip, '…having added nothing');
	h.check(!(await modalOpen(A)), '…and without asking');

	// --- Import as copies, as a setting ---
	await setMode(A, 'copy');
	await clearToasts(A);
	await dropFile(A, 'Twin.tpscene', 'application/zip', v1);
	await h.eventually(
		() => itemsOf(A),
		(i) => i.visible.length === beforeSkip + 1,
		'COPY: no modal, a second copy lands straight away'
	);
	h.check(!(await modalOpen(A)), '…and without asking');
	items = await itemsOf(A);
	h.check(
		items.visible.filter((i) => /\(copy/.test(i.name)).length === 2 &&
			new Set(items.visible.map((i) => i.name)).size === items.visible.length,
		`the second copy took its own name rather than colliding (${JSON.stringify(items.visible.map((i) => i.name))})`
	);

	// =====================================================================
	// 4. BUG 2b — a copy is possible for a SCENE and for nothing else
	// =====================================================================
	await freshProfile(A);
	await setMode(A, 'copy');
	await clearToasts(A);
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	await h.eventually(
		() => itemsOf(A),
		(i) => i.visible.length === 1,
		'premise: one image in the library'
	);
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /identical files of that kind are the same file/i.test(x)),
		'a non-scene duplicate is REFUSED with the reason, not silently copied'
	);
	h.check(
		(await itemsOf(A)).visible.length === 1,
		'…and the library still holds exactly one of it, because two items may not share a hash'
	);

	// the modal says the same thing, per group
	await setMode(A, 'ask');
	await clearToasts(A);
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	await h.eventually(() => modalOpen(A), (v) => v === true, 'the modal opens for a non-scene duplicate too');
	rows = await modalRows(A);
	h.check(
		rows.length === 1 && rows[0].checkbox === false,
		'…with NO checkbox on the row, because there is no copy to opt into'
	);
	h.check(
		await A.page.locator('#dup-import-copies').isDisabled(),
		'…and "Import as copies" is disabled rather than present and inert'
	);
	const groupText = await A.page.evaluate(() => document.body.innerText);
	h.check(
		// `.ui-section-label` is `text-transform: uppercase`, and innerText reflects that
		/other files/i.test(groupText) && /the same file, not a copy/i.test(groupText),
		'…and the group heading explains why, once, instead of per row'
	);
	await A.page.locator('#dup-skip').click();
	await A.page.waitForTimeout(500);

	// --- REVEAL: "show me the one I already have" ---
	// The modal lives at the App root and the answer — switch folder, select the card,
	// scroll it into view — belongs to the Explorer, which may not even be mounted. The
	// seam is a request STORE, so this asserts the request is consumed end to end.
	const shelf = await A.page.evaluate(() => {
		const s = window.__stores.explorer;
		const folder = s.createFolder('Shelf', null);
		let items;
		s.explorerItems.subscribe((v) => (items = v))();
		s.moveItem(items[0].id, folder.id);
		s.activeFolder.set(null);
		return { folderId: folder.id, itemId: items[0].id };
	});
	await A.page.waitForTimeout(500);
	h.check(
		(await A.page.evaluate(() => {
			let f;
			window.__stores.explorer.activeFolder.subscribe((v) => (f = v))();
			return f;
		})) === null,
		'premise: the file we already hold is in a folder we are NOT looking at'
	);
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	await h.eventually(() => modalOpen(A), (v) => v === true, 'premise: the modal is open for it');
	await A.page.locator('.dup-reveal').first().click();
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				const s = window.__stores.explorer;
				let f, insp;
				s.activeFolder.subscribe((v) => (f = v))();
				s.inspectedFile.subscribe((v) => (insp = v))();
				return { folder: f, inspected: insp };
			}),
		(v) => v.folder === shelf.folderId && v.inspected === shelf.itemId,
		'Reveal takes you to the file you already have — the right folder, the card selected'
	);
	h.check(!(await modalOpen(A)), '…and closes the modal, because you asked to go somewhere');
	h.check(
		(await itemsOf(A)).visible.length === 1,
		'…having imported nothing — Reveal is a way OUT of the decision, not a third answer'
	);

	// =====================================================================
	// 5. THE INVARIANT — no two items share a hash
	// =====================================================================
	// This is the regression guard for the half of bug 2a that was a silent data bug:
	// `importFiles` wrote unconditionally, so a second drop of one file left two items
	// with one hash and `itemByHash` — travel-by-hash, the .tp export, every assetShare
	// pull — answered with whichever happened to come first.
	await freshProfile(A);
	await setMode(A, 'skip');
	for (let i = 0; i < 3; i++) {
		await dropFile(A, 'pic.png', 'image/png', pngArr());
		await A.page.waitForTimeout(500);
	}
	items = await itemsOf(A);
	h.check(
		items.visible.length === 1,
		`dropping one file three times leaves ONE item (${items.visible.length})`
	);
	const all = [...items.visible, ...items.hidden].map((i) => i.hash);
	h.check(
		new Set(all).size === all.length,
		`no two items share a content hash (${all.length} items, ${new Set(all).size} hashes)`
	);
	// and the picker contract: a caller handing over bytes we already hold gets the item
	// we already hold, never an empty answer (ShaderTexturePicker / HudImagePicker both
	// index created[0], so a silent skip would break the picker rather than the import)
	const reused = await A.page.evaluate(async (arr) => {
		const file = new File([new Uint8Array(arr)], 'pic.png', { type: 'image/png' });
		const created = await window.__stores.explorer.importFiles([file], null, {
			duplicates: 'reuse'
		});
		return { count: created.length, hash: created[0]?.hash };
	}, pngArr());
	h.check(
		reused.count === 1 && reused.hash === items.visible[0].hash,
		'a programmatic import of held bytes answers with the item already held, not with nothing'
	);
	h.check(
		(await itemsOf(A)).visible.length === 1,
		'…without minting a second item for it'
	);

	// =====================================================================
	// 6. THE SETTING — Settings ▸ Files, and the modal's "don't ask again"
	// =====================================================================
	await setMode(A, 'ask');
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('scene');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForTimeout(900);
	const rowText = await A.page.evaluate(() => {
		const el = document.querySelector('#import-duplicate-mode');
		const row = el?.closest('.setting-row');
		const desc = row?.querySelector('.sr-desc');
		return {
			present: !!el,
			text: (desc?.textContent ?? '').replace(/\s+/g, ' ').trim(),
			// THE FLEX TRAP this row had to avoid: `.sr-desc` is a flex COLUMN, so every
			// ELEMENT child becomes its own flex item on its own line — a description
			// mixing <strong>s as siblings renders one fragment per line (reported twice
			// as "too many carriage returns"). The invariant is ONE block child, which is
			// deterministic; a rendered LINE count is just the panel's current width.
			descChildren: desc ? desc.children.length : -1
		};
	});
	h.check(rowText.present, 'the rule has a row in Settings ▸ Files, not in the Explorer view cog');
	h.check(
		/Ask lets you decide file by file/.test(rowText.text) &&
			/Skip keeps what you have/.test(rowText.text) &&
			/Import as copies brings them in/.test(rowText.text),
		'…and the description explains all three answers'
	);
	// the flex-cell trap: `.sr-desc` is a flex COLUMN, so sibling <strong>s render one
	// fragment per line. One block child keeps it as prose.
	h.check(
		rowText.descChildren === 1,
		`…as ONE block of prose rather than a fragment per <strong> (${rowText.descChildren} flex children)`
	);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(400);

	// "don't ask again" writes the same key
	await freshProfile(A);
	await setMode(A, 'ask');
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	// wait for the ITEM, never a sleep: an image import awaits a decode, and a second
	// drop inside that window is collapsed by the in-flight guard rather than reported as
	// a duplicate — which is correct, and would make this premise vacuous
	await h.eventually(
		() => itemsOf(A),
		(i) => i.visible.length === 1,
		'premise: the first drop landed'
	);
	await dropFile(A, 'pic.png', 'image/png', pngArr());
	await h.eventually(() => modalOpen(A), (v) => v === true, 'premise: the modal is open in Ask mode');
	await A.page.locator('#dup-remember').click();
	await A.page.locator('#dup-skip').click();
	await A.page.waitForTimeout(500);
	h.check(
		(await modeOf(A)) === 'skip',
		`the modal's "don't ask again" writes the SAME setting the Files row shows (${await modeOf(A)})`
	);
	const stored = await A.page.evaluate(() => localStorage.getItem('importDuplicateMode'));
	h.check(stored === 'skip', `…and it persists like every other Files rule (${stored})`);

	// =====================================================================
	// 7. A .tp IMPORT SURFACES ITS DUPLICATES
	// =====================================================================
	await freshProfile(A);
	await setMode(A, 'ask');
	// a project file holding one scene, exported from this very app
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Packed'));
	await A.page.waitForTimeout(1200);
	const tpBytes = await A.page.evaluate(async () => {
		const result = await window.__stores.projectFile.exportProject({});
		return result?.bytes ? Array.from(result.bytes) : null;
	});
	if (!tpBytes) {
		h.check(false, 'premise: a .tp could be built (exportProject)');
	} else {
		h.check(tpBytes.length > 0, `premise: a .tp holding the project (${tpBytes.length} bytes)`);
		const beforeTp = (await itemsOf(A)).visible.length;
		// NOT awaited on the page side: `page.evaluate` awaits whatever the page function
		// RETURNS, and this import blocks on the modal — returning its promise deadlocks
		// the suite against the very dialog it is here to answer.
		await A.page.evaluate((arr) => {
			void window.__stores.projectFile.importProjectAsFolder(new Uint8Array(arr).buffer, {
				fileName: 'Packed project.tp'
			});
		}, tpBytes);
		await h.eventually(
			() => modalOpen(A),
			(v) => v === true,
			'importing a .tp whose contents we already hold ASKS, instead of reporting "Imported N items" having added nothing'
		);
		rows = await modalRows(A);
		h.check(
			rows.length >= 1 && rows.some((r) => /\.tpscene$/.test(r.name)),
			`…naming the files it already has (${JSON.stringify(rows.map((r) => r.name))})`
		);
		await A.page.locator('#dup-skip').click();
		await A.page.waitForTimeout(900);
		items = await itemsOf(A);
		const dupNames = items.visible.filter((i) => /Packed\.tpscene$/.test(i.name));
		h.check(
			dupNames.length === 1,
			`Skip means the .tp furnished its folder without duplicating the scene (${dupNames.length} Packed.tpscene)`
		);
		const hashes = [...items.visible, ...items.hidden].map((i) => i.hash);
		h.check(
			new Set(hashes).size === hashes.length,
			'…and the one-item-per-hash invariant survived the merge'
		);
		h.check(
			items.visible.length >= beforeTp,
			'…while the import itself still happened (the folder is there)'
		);
	}

	h.check((await h.pageErrors(A)).length === 0, `no page errors (${JSON.stringify(await h.pageErrors(A))})`);
	await h.finish(browser);
});
