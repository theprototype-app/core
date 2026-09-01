// 21-G3 — THE .tp PROJECT FILE. Fork 1: "OSS without cloud — a project exports/imports
// as ONE .tp file (manifest + hashes zipped), the .tpscene machinery one level up."
//
// ROUND-TRIP INTEGRITY IS THE WHOLE POINT, so the suite is built as a real hand-off: A
// builds a project (two scenes, an edit, a travel — so a history has more than one
// entry), exports it, and a FRESH page B that has never met A imports the bytes and
// must end up with the same project. B is a separate browser CONTEXT, so it has its own
// IndexedDB and localStorage — nothing but the file crosses between them, which is what
// makes the reproduction claim mean anything.
//
// The zip LAYOUT is asserted in node with fflate (a repo dependency), not through the
// app: reading the archive the app produced is the only way to know the file is a file
// and not a shape that happens to survive our own reader.
//
// No peers, no signaling: this feature is deliberately the offline half of the project
// story, and a two-peer dial would only add flakiness to a check about a file.
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- project-file
const h = require('./helpers.cjs');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

// ---- moving bytes across the CDP bridge -------------------------------------------
// base64 both ways, CHUNKED on the page side on purpose: `String.fromCharCode(...bytes)`
// over a whole zip overflows the argument stack, which reads as a mysteriously empty
// export rather than as the bridge problem it is.
// 21-G8: the whole-project restore is OPEN now (fork 12 — it replaces the project and
// warns first), so the page-side call is openProject and the caller answers the
// warning dialog with answerOpenConfirm below. importProjectAsFolder has its own
// suite (project-open-import).
const importOnPage = (peer, b64) =>
	peer.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.openProject(bytes.buffer);
	}, b64);

// the open warning BLOCKS openProject — watch for it and accept
const answerOpenConfirm = async (peer) => {
	await h.eventually(
		() =>
			peer.page.evaluate(() => {
				let d;
				window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
				return d?.title ?? null;
			}),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'the OPEN warning dialog appeared (fork 12: open replaces, warned)'
	);
	await peer.page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(true));
};

// ---- reading the world -------------------------------------------------------------
const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const libraryOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => ({ name: i.name, hash: i.hash, kind: i.kind, folderId: i.folderId }));
	});

const childUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid).sort();
	});

const currentLevelOf = (peer) =>
	peer.page.evaluate(() => {
		let at;
		window.__stores.levels.currentLevel.subscribe((v) => (at = v))();
		return at;
	});

const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.objectActions.deselectObject();
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });

	// =====================================================================
	// 1. BUILD A PROJECT ON A — two scenes, an edit, a travel
	// =====================================================================
	await makeBox(A);
	const arenaWorld = await childUuids(A);
	// 21-H1 (locked answer 6): the app no longer invents a folder for a save, so the one
	// these scenes live in is a folder the USER made. That also makes the v2 folder-tree
	// round trip below a real test rather than a test of our own former default.
	const sceneFolder = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Scenes', null)?.id ?? null
	);
	h.check(!!sceneFolder, 'premise: a user-made folder to save the scenes into');
	const arenaHash = await A.page.evaluate(async (folderId) => {
		const item = await window.__stores.levels.saveSceneAsLevel('Arena', folderId);
		return item?.hash ?? null;
	}, sceneFolder);
	h.check(!!arenaHash, `Arena saved as a scene asset (${String(arenaHash).slice(0, 8)})`);

	await makeBox(A); // the scene is now different from what Arena holds
	const pitV1 = await A.page.evaluate(async (folderId) => {
		const item = await window.__stores.levels.saveSceneAsLevel('Pit', folderId);
		return item?.hash ?? null;
	}, sceneFolder);
	h.check(!!pitV1 && pitV1 !== arenaHash, 'Pit saved as a second scene, its own content hash');

	// the EDIT, then a travel away — G2b's auto-save publishes the departing scene, so
	// Pit ends with a real two-entry history rather than a fabricated one
	await makeBox(A);
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	await h.eventually(
		() => manifestOf(A),
		(m) => m.scenes?.Pit?.history?.length === 2,
		'travelling away from an EDITED scene published a second Pit version'
	);
	const mA = await manifestOf(A);
	const pitV2 = mA.scenes.Pit.history[1];
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify(arenaWorld),
		'…and the travel landed on Arena (the premise every later content check rests on)'
	);
	h.check(
		mA.scenes.Arena.history.length === 1 && mA.scenes.Arena.history[0] === arenaHash,
		'Arena keeps its single version'
	);

	// an ASSET the project tracks (fork 8: the manifest carries the discovery list)
	const assetHash = await A.page.evaluate(async () => {
		const bytes = new TextEncoder().encode('21-G3 project asset payload').buffer;
		const item = await window.__stores.explorer.addItemFromBytes(bytes, 'project-note.txt', null);
		window.__stores.projectManifest.recordProjectAssets([item.hash]);
		return item.hash;
	});
	h.check(
		(await manifestOf(A)).assets.includes(assetHash),
		'the manifest tracks an asset hash'
	);

	// =====================================================================
	// 2. A LOCALLY PRUNED VERSION — the half that must NOT vanish
	// =====================================================================
	// fork 4: pruning drops local BYTES, never history. Deleting the item is exactly
	// what pruneSceneVersions does, so this is the real state, not a simulation of it.
	await A.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		if (item) await window.__stores.explorer.deleteItem(item.id);
	}, pitV1);
	h.check(
		(await A.page.evaluate((hash) => !window.__stores.explorer.itemByHash(hash), pitV1)) === true,
		'Pit v1 bytes are gone from the local library (a real prune)'
	);
	h.check(
		(await manifestOf(A)).scenes.Pit.history.length === 2,
		'…and its hash is STILL in the manifest history'
	);

	// an unknown top-level field: the normalizeAnnotation preserve rule has to survive
	// a whole file round trip, not just a wire hop
	await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		let doc;
		m.projectManifest.subscribe((v) => (doc = v))();
		m.manifestRestore({ ...doc, futureField: 'from a newer build' });
	});

	// =====================================================================
	// 3. EXPORT — the counts, and the archive itself
	// =====================================================================
	const exported = await A.page.evaluate(async () => {
		const r = await window.__stores.projectFile.exportProject();
		let s = '';
		for (let i = 0; i < r.bytes.length; i += 8192)
			s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192));
		return {
			b64: btoa(s),
			scenes: r.scenes,
			assets: r.assets,
			skippedScenes: r.skippedScenes,
			skippedAssets: r.skippedAssets,
			size: r.bytes.length
		};
	});
	h.check(
		exported.scenes === 2 && exported.skippedScenes === 1,
		`export carries the 2 kept scene versions and REPORTS the 1 it cannot (${exported.scenes}/${exported.skippedScenes})`
	);
	h.check(
		exported.assets === 1 && exported.skippedAssets === 0,
		`and the tracked asset (${exported.assets} asset, ${exported.skippedAssets} skipped)`
	);

	const zip = unzipSync(new Uint8Array(Buffer.from(exported.b64, 'base64')));
	const names = Object.keys(zip).sort();
	h.check(!!zip['project.json'], `project.json is at the archive root (${names.length} entries)`);
	const doc = JSON.parse(strFromU8(zip['project.json']));
	h.check(doc.format === 3, `format is an int and gates loading (${doc.format} — 3 since R22-R1)`);
	// 21-G8 fork 11: a .tp is the WHOLE Explorer — folder rows and one row per library
	// item (A holds 3: two visible scene versions + the tracked asset), each row naming
	// a file the archive really carries
	h.check(
		Array.isArray(doc.folders) && doc.folders.some((f) => f.name === 'Scenes'),
		`v2 carries the folder tree (${(doc.folders ?? []).length} folders incl. Scenes)`
	);
	h.check(
		Array.isArray(doc.items) &&
			doc.items.length === 3 &&
			doc.items.every((row) => !!zip[row.file]),
		`v2 carries one row per library item, each pointing at real bytes (${(doc.items ?? []).length})`
	);
	h.check(typeof doc.name === 'string', 'v2 carries the project name field (G9 owns its editor)');
	h.check(
		typeof doc.appVersion === 'string' && doc.appVersion.length > 0,
		`appVersion provenance rides beside it (${doc.appVersion})`
	);
	h.check(
		names.filter((n) => n.startsWith('scenes/')).length === 2 &&
			!!zip['scenes/' + arenaHash + '.tpscene'] &&
			!!zip['scenes/' + pitV2 + '.tpscene'],
		'scenes/<hash>.tpscene for every kept version whose bytes are here'
	);
	h.check(
		names.some((n) => n.startsWith('assets/' + assetHash)),
		'assets/<hash><ext> for the tracked asset'
	);
	h.check(
		!zip['scenes/' + pitV1 + '.tpscene'] &&
			doc.manifest.scenes.Pit.history.length === 2 &&
			doc.manifest.scenes.Pit.history[0] === pitV1,
		'THE PRUNED HASH: no bytes in the archive, and still in the exported history'
	);
	h.check(doc.skipped?.scenes === 1, 'the archive says out loud what it could not carry');
	h.check(
		doc.manifest.futureField === 'from a newer build',
		"a newer build's unknown manifest field survives the export"
	);
	// the scene entries are real .tpscene bundles, not renamed rubbish
	const inner = unzipSync(zip['scenes/' + arenaHash + '.tpscene']);
	h.check(
		!!inner['session.json'] && JSON.parse(strFromU8(inner['session.json'])).name === 'Arena',
		'a scenes/ entry is an ordinary .tpscene (session.json inside, named)'
	);

	// =====================================================================
	// 4. IMPORT ON A FRESH PAGE — its own IndexedDB, nothing but the file
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	const beforeM = await manifestOf(B);
	h.check(
		Object.keys(beforeM.scenes).length === 0 && (await libraryOf(B)).length === 0,
		'PREMISE: B is a genuinely fresh machine — no project, no library'
	);

	const pendingOpen = importOnPage(B, exported.b64);
	await answerOpenConfirm(B);
	const imported = await pendingOpen;
	h.check(
		!!imported && imported.scenes === 2 && imported.assets === 1,
		`open restored 2 scene versions + 1 asset (${JSON.stringify(imported)})`
	);

	const mB = await manifestOf(B);
	h.check(
		JSON.stringify(mB.scenes) === JSON.stringify(mA.scenes),
		'THE MANIFEST IS IDENTICAL — names, histories and pointers, entry for entry'
	);
	h.check(
		mB.scenes.Pit.history[mB.scenes.Pit.history.length - 1] === pitV2 &&
			mB.scenes.Arena.history[0] === arenaHash,
		'the pointers point at the same hashes A pointed at'
	);
	h.check(mB.futureField === 'from a newer build', 'and the unknown field came through the file');

	const libB = await libraryOf(B);
	const hasHash = (hash) => libB.some((i) => i.hash === hash);
	h.check(
		hasHash(arenaHash) && hasHash(pitV2),
		'every kept scene hash RESOLVES in B\'s library — byte identity by construction (the item hash IS the content hash)'
	);
	h.check(hasHash(assetHash), 'the tracked asset resolves too');
	// both halves of the prune, on the receiving side
	h.check(
		!hasHash(pitV1) && mB.scenes.Pit.history.includes(pitV1),
		'the pruned version has no bytes on B either — and is still in its history, restorable from any peer who kept it'
	);
	const scenesFolder = await B.page.evaluate(() => {
		let folders;
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		return folders.find((f) => f.name === 'Scenes' && !f.parentId)?.id ?? null;
	});
	// 21-H1: the folder is one A's user MADE, so this is the folder tree round-tripping
	// — the placement travelled with the items, not a default either end reinvented
	h.check(
		!!scenesFolder && libB.filter((i) => i.folderId === scenesFolder).length === 2,
		"the scenes landed back in the folder A had them in, rebuilt from the file's own tree"
	);
	h.check(
		JSON.stringify(await childUuids(B)) === '[]',
		'IMPORTING A PROJECT LOADS NOTHING — the library and the manifest are furnished, the world is untouched'
	);

	// =====================================================================
	// 5. THE REPRODUCTION: travel on B lands on A's content
	// =====================================================================
	const travelled = await B.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	h.check(travelled === true, 'travelToScene resolves the imported name through the imported manifest');
	h.check(
		JSON.stringify(await childUuids(B)) === JSON.stringify(arenaWorld),
		'…and B is standing in the SAME Arena, object for object (uuids survive toJSON/ObjectLoader)'
	);
	h.check((await currentLevelOf(B))?.name === 'Arena', 'B knows where it is');

	// Pit's POINTER (v2) is the edited scene — the version the auto-save minted
	await B.page.evaluate(() => window.__stores.levels.travelToScene('Pit'));
	await h.eventually(
		() => childUuids(B),
		(u) => u.length === 3,
		'travelling to Pit lands on the POINTER (v2, the edited 3-object scene), not the pruned v1'
	);

	// =====================================================================
	// 6. FORMAT GATING + refusals (nothing is mutated by a rejected file)
	// =====================================================================
	const beforeGate = JSON.stringify((await manifestOf(B)).scenes);
	const newer = Buffer.from(
		zipSync({
			'project.json': strToU8(
				JSON.stringify({
					format: 99,
					appVersion: '99.0.0',
					manifest: { scenes: { Ghost: { history: ['ghost-1'], pinned: [] } }, assets: [], changedAt: 1 },
					scenes: [],
					assets: []
				})
			)
		})
	).toString('base64');

	// the dialog BLOCKS the import, so kick it off without awaiting and answer it
	const pending = importOnPage(B, newer);
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let d;
				window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
				return d?.title ?? null;
			}),
		(t) => t === 'Newer project format',
		'a NEWER format asks first (an import is one person at a file dialog — unlike travel, it can be asked)'
	);
	await B.page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(false));
	h.check((await pending) === null, 'declining resolves null — a silent no-op for the caller');
	h.check(
		JSON.stringify((await manifestOf(B)).scenes) === beforeGate &&
			!(await manifestOf(B)).scenes.Ghost,
		'…and a DECLINED import mutated nothing (the confirm sits above every restore loop)'
	);

	const garbage = Buffer.from('not a zip at all, just text').toString('base64');
	h.check(
		(await importOnPage(B, garbage)) === null,
		'a file that is not an archive is refused rather than thrown'
	);
	const emptyZip = Buffer.from(zipSync({ 'readme.txt': strToU8('hello') })).toString('base64');
	h.check(
		(await importOnPage(B, emptyZip)) === null,
		'a zip with no project.json is refused too'
	);
	h.check(
		JSON.stringify((await manifestOf(B)).scenes) === beforeGate,
		'neither refusal touched the project'
	);

	// =====================================================================
	// 7. RE-IMPORT IS IDEMPOTENT — content hashes dedupe, pointers do not drift
	// =====================================================================
	const libCount = (await libraryOf(B)).length;
	const pendingReopen = importOnPage(B, exported.b64);
	await answerOpenConfirm(B);
	await pendingReopen;
	h.check(
		(await libraryOf(B)).length === libCount,
		're-opening the same project lands on the same library (wipe + restore of identical content)'
	);
	h.check(
		JSON.stringify((await manifestOf(B)).scenes) === JSON.stringify(mA.scenes),
		'…and the manifest is the same document, not a doubled history'
	);

	// =====================================================================
	// 8. THE ENTRY POINTS — the menu gate, and the extension switch
	// =====================================================================
	// the export entry exists only once there IS a project; C has none
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	// the grid menu, opened the way a user opens it. The right-click goes near the
	// BOTTOM of the grid: B's library is populated, and a press landing on a card
	// opens the ITEM menu instead — which is why every read below asserts the
	// 'New folder' premise rather than trusting the coordinates.
	const gridRows = async (peer) => {
		await peer.page.locator('#explorer-slot').click();
		await peer.page.waitForTimeout(600);
		const region = peer.page.locator('#explorer-list [role="region"]').first();
		const box = await region.boundingBox();
		await region.click({
			button: 'right',
			position: { x: Math.max(20, (box?.width ?? 400) - 40), y: Math.max(20, (box?.height ?? 200) - 24) }
		});
		await peer.page.waitForTimeout(300);
		const rows = await peer.page.evaluate(() =>
			[...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map((el) =>
				el.textContent?.trim()
			)
		);
		await peer.page.keyboard.press('Escape');
		await peer.page.waitForTimeout(200);
		return rows;
	};
	const rowsC = await gridRows(C);
	h.check(
		rowsC.includes('New folder'),
		`PREMISE: the GRID menu opened on the empty library (${JSON.stringify(rowsC)})`
	);
	h.check(
		rowsC.some((r) => r?.startsWith('Save scene')) && !rowsC.some((r) => r?.includes('Export project')),
		'no project yet: the EXPORT entry is not offered (it could only produce an empty zip)'
	);
	h.check(
		rowsC.some((r) => r?.startsWith('Import project as folder')),
		'…but the IMPORT entry is (21-G8: furnishing an empty library is the classic case)'
	);
	const rowsB = await gridRows(B);
	h.check(rowsB.includes('New folder'), `PREMISE: the GRID menu opened on B (${JSON.stringify(rowsB)})`);
	h.check(
		rowsB.some((r) => r?.includes('Export project (.tp)')),
		'with a project in use the Explorer grid menu offers the export'
	);

	// the Open affordance accepts .tp, and fileHandler's switch routes it
	await C.page.evaluate(() => window.__stores.closeMenu.set(false));
	await C.page.waitForTimeout(300);
	h.check(
		((await C.page.getAttribute('#load-file', 'accept')) ?? '').includes('.tp'),
		'the Open file input accepts .tp'
	);
	await C.page.evaluate(() => window.__stores.closeMenu.set(true));
	await C.page.waitForTimeout(200);
	// load() blocks on the open warning — answer it from node while the page awaits
	const viaLoadPending = C.page.evaluate(
		async ({ b64 }) => {
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const file = new File([bytes], 'MyGame.tp', { type: 'application/zip' });
			await window.__stores.fileHandler.load(file);
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
			return Object.keys(m.scenes).sort();
		},
		{ b64: exported.b64 }
	);
	await answerOpenConfirm(C);
	const viaLoad = await viaLoadPending;
	h.check(
		JSON.stringify(viaLoad) === '["Arena","Pit"]',
		`a .tp handed to the real open path OPENS the project (${JSON.stringify(viaLoad)})`
	);
	h.check(
		JSON.stringify(await childUuids(C)) === '[]',
		'…and still loads no scene — the Open path is not a "load this project\'s world" button'
	);

	await h.finish(browser);
});
