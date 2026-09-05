// ROADMAP 22 ROUND 36 — DELETED KEEPS ITS STRUCTURE: folders in the bin, restore-where-it-was.
//
// THE FINDING THE WHOLE BATCH RESTS ON, in one sentence: `explorer.deleteFolder` DESTROYED
// the folder locally and wrote NO tombstone and NO log row, so nothing anywhere was ever
// told a deletion had happened. The peer went on holding the folder as `peer` and the files
// as `peer`; the rows leaving the index stripped those marks to `wasShared`; the peer's
// "share new files: always" sweep then claimed everything unshared as `mine` and republished
// — and the DELETER adopted its own folder back and auto-downloaded its own files. The user
// reported it as "deleting a folder recreates it".
//
// So delete goes through ONE path now and it is the bin's (`deleteItemsToBin` /
// `deleteFolderToBin`): a log ROW per file AND per folder (carrying the `folderId` it lived
// under and a `path` of ancestor names), a TOMBSTONE so the removal beats the reconcile, and
// an APPLIED mark so we never re-apply our own deletion. The bin reads those rows back as a
// TREE, and Restore recreates the way there under the SAME uuids — which is the only answer
// that survives two peers, because a folder id is network identity.
//
// Section 5 measures the COUNTERFACTUAL directly: with `always` armed on the peer, seconds
// of its sweep must leave the deleter with no folder, no visible file, an empty index and
// nothing being pulled. Without that check every assertion above passes on a suite that
// simply never gave the sweep a chance to run.
//
// ONE process, two peers, and the single-page sections run on A BEFORE the connect: a
// two-peer connect costs 30-60s and the model, the restores and the whole UI need no peer.
//
// Run: APP_URL='https://localhost:5205/' PEER_CONFIG=... npm run e2e -- deleted-folders
const h = require('./helpers.cjs');

/** Installed in every page: the stores, and the four readings every section takes. */
const INSTALL = () => {
	const S = window.__stores;
	const val = (/** @type {any} */ s) => {
		let v;
		s.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	};
	window.__t = {
		S,
		val,
		log: () => val(S.projectManifest.projectManifest).deleted ?? [],
		doc: () => val(S.projectManifest.projectManifest),
		folders: () => val(S.explorer.explorerFolders),
		items: () => val(S.explorer.explorerItems),
		hidden: () => val(S.explorer.hiddenItems),
		held: () =>
			new Set([...val(S.explorer.explorerItems), ...val(S.explorer.hiddenItems)].map((i) => i.hash)),
		bytes: (/** @type {string} */ s) => new TextEncoder().encode(s).buffer,
		settle: (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms ?? 400)),
		reset: async () => {
			await S.explorer.clearLibrary();
			await S.sharedLibrary.emptyDeletedLog();
			// AND THE SHARED INDEX. `clearLibrary` takes the records, not the document: rows
			// this machine no longer holds read as FOREIGN and are carried forward verbatim (the
			// one-writer-per-row rule), and the very next sweep ADOPTS them back as `peer`
			// folders and cards. Measured: a section that expected 2 folders found 4, the two
			// extra being the previous section's shared folders re-adopted from the index.
			S.projectManifest.publishSharedIndex([], [], { items: {}, folders: {} }, []);
			await new Promise((r) => setTimeout(r, 300));
		}
	};
};

// ---- the three DOM readers, copied from explorer-views ---------------------------------
// ContextMenu rows are `[role=menuitem]` DIVs, not buttons (a `button` selector returns []
// while the menu is visibly open), a row's tooltip is its `title`, and `checked` renders as
// BOLD + a tinted pill rather than a tick — so state is read off the computed style.

const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => el.innerText.trim()).filter(Boolean)
	);

const menuDetail = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => ({
			label: el.innerText.trim(),
			title: el.getAttribute('title') ?? ''
		}))
	);

const menuChecked = (page, label) =>
	page.evaluate((want) => {
		const el = [...document.querySelectorAll('[role=menuitem]')].find(
			(x) => x.innerText.trim() === want
		);
		if (!el) return null;
		const cs = getComputedStyle(el);
		return Number(cs.fontWeight) >= 600 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
	}, label);

/** close any open portaled menu with a REAL pointerdown (it ignores a plain click) */
async function closeMenu(page) {
	await page.mouse.move(4, 300);
	await page.mouse.down();
	await page.mouse.up();
	await page.waitForTimeout(200);
}

/** every list row's cells, for the Location column */
const listRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.ex-row')].map((r) => ({
			id: r.getAttribute('data-card-id'),
			cells: [...r.querySelectorAll('td[data-col]')].map((td) => td.innerText.trim())
		}))
	);

/** the card ids the grid is drawing, whichever view mode is on */
const cardIds = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#explorer-grid [data-card-id]')].map((e) =>
			e.getAttribute('data-card-id')
		)
	);

/** the round-33 host modal, if it opened */
async function dismissDecision(peer) {
	try {
		const btn = peer.page.locator('#confirm-dialog-dismiss');
		if (await btn.isVisible({ timeout: 2000 })) await btn.click();
	} catch {}
}

h.run(async () => {
	const browser = await h.launch();
	// `keepRecycleBin` because the bin is EMPTIED ON LOAD by default — without it every row
	// this suite writes is gone before it can be read. `deleteNoConfirm` because section 4
	// drives the real menus and a modal in front of them is a different test.
	const storage = {
		'shared:shareNewFiles': 'never',
		'shared:keepRecycleBin': 'true',
		'shared:deleteNoConfirm': 'true'
	};
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1440, height: 900 } },
		storage
	});
	const page = A.page;
	await page.waitForFunction(
		() => !!window.__stores?.sharedLibrary && !!window.__stores?.explorer && !!window.__stores?.explorerView,
		null,
		{ timeout: 30000 }
	);
	await page.evaluate(INSTALL);
	// the standing ask, silenced for the body of the suite: the shipped default is `ask`, and
	// an armed share strip is a sticky row that swallows clicks over every card below.
	await page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
	const ev = (fn, arg) => page.evaluate(fn, arg);

	// ---- 1. THE LOG ROWS a folder delete writes ------------------------------------------
	//
	// Three files in a two-deep shared tree. One act, and what comes out of it is the whole
	// of what the peer half later depends on: a row per file KEEPING its `folderId`, a row
	// per FOLDER whose own `folderId` is its PARENT, tombstones for both kinds, and the
	// folder RECORDS gone locally while every byte stays on the hidden shelf.
	const s1 = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await E.loadExplorer();
		await window.__t.reset();
		const fa = E.createFolder('Alpha', null);
		const fb = E.createFolder('Beta', fa.id);
		const a1 = await E.addItemFromBytes(bytes('alpha-one'), 'a1.txt', fa.id);
		const b1 = await E.addItemFromBytes(bytes('beta-one'), 'b1.txt', fb.id);
		const b2 = await E.addItemFromBytes(bytes('beta-two'), 'b2.txt', fb.id);
		L.shareFolder(fa.id);
		await settle(400);
		const counts = L.deleteFolderToBin(fa.id);
		await settle(400);
		const log = window.__t.log();
		const tree = L.buildDeletedTree(log, window.__t.folders());
		const part = L.partitionDeleted(log, window.__t.held(), window.__t.folders());
		const rootKids = tree.children.get(null);
		const aKids = tree.children.get(fa.id);
		const bKids = tree.children.get(fb.id);
		return {
			ids: { fa: fa.id, fb: fb.id, a1: a1.hash, b1: b1.hash, b2: b2.hash },
			counts,
			rows: log.map((r) => ({
				hash: r.hash,
				kind: r.kind,
				folderId: r.folderId,
				path: r.path,
				localOnly: !!r.localOnly
			})),
			foldersLeft: window.__t.folders().length,
			visibleLeft: window.__t.items().length,
			hiddenCount: window.__t.hidden().length,
			rootFolders: rootKids.folders.map((n) => n.id),
			rootItems: rootKids.items.length,
			aFolders: aKids.folders.map((n) => n.id),
			aItems: aKids.items.map((r) => r.hash),
			bItems: bKids.items.map((r) => r.hash),
			descA: tree.descendants(fa.id).items.length,
			descAFolders: tree.descendants(fa.id).folders.map((n) => n.name),
			locB1: tree.locationOf(log.find((r) => r.hash === b1.hash)),
			locA1: tree.locationOf(log.find((r) => r.hash === a1.hash)),
			locFolderB: tree.locationOf(log.find((r) => r.hash === L.folderRowKey(fb.id))),
			bin: part.bin.length,
			spent: part.spent.length,
			tombFolders: Object.keys((window.__t.doc().removed ?? {}).folders ?? {}),
			tombItems: Object.keys((window.__t.doc().removed ?? {}).items ?? {}),
			isFolderRow: L.isFolderRow(log.find((r) => r.hash === L.folderRowKey(fa.id))),
			folderRowId: L.folderRowId({ hash: L.folderRowKey(fa.id), kind: 'folder' })
		};
	});
	h.check(
		s1.counts.folders === 2 && s1.counts.files === 3,
		`deleteFolderToBin reports the whole subtree (${JSON.stringify(s1.counts)})`
	);
	h.check(s1.foldersLeft === 0, `the folder RECORDS are gone locally (${s1.foldersLeft} left)`);
	h.check(
		s1.visibleLeft === 0 && s1.hiddenCount === 3,
		`every file moved to the hidden shelf, bytes intact (${s1.visibleLeft} visible / ${s1.hiddenCount} hidden)`
	);
	h.check(
		s1.rows.length === 5,
		`the log holds 3 item rows + 2 folder rows (${s1.rows.length}: ${s1.rows.map((r) => r.kind).join(',')})`
	);
	h.check(
		s1.isFolderRow === true && s1.folderRowId === s1.ids.fa,
		`isFolderRow / folderRowId round-trip on one key (${s1.folderRowId})`
	);
	const rowB1 = s1.rows.find((r) => r.hash === s1.ids.b1);
	h.check(
		!!rowB1 && rowB1.folderId === s1.ids.fb,
		`an item row records the folder it was IN (${rowB1 && rowB1.folderId})`
	);
	h.check(
		!!rowB1 && JSON.stringify(rowB1.path) === JSON.stringify(['Alpha', 'Beta']),
		`...and the ancestor NAMES beside it, for when the folder is gone too (${JSON.stringify(rowB1 && rowB1.path)})`
	);
	const rowFB = s1.rows.find((r) => r.kind === 'folder' && r.hash.endsWith(s1.ids.fb));
	h.check(
		!!rowFB && rowFB.folderId === s1.ids.fa,
		`a folder row's own folderId is its PARENT — the row IS the folder (${rowFB && rowFB.folderId})`
	);
	h.check(
		!!rowFB && JSON.stringify(rowFB.path) === JSON.stringify(['Alpha']),
		`...so its path is the parent's path (${JSON.stringify(rowFB && rowFB.path)})`
	);
	h.check(
		s1.rows.every((r) => !r.localOnly),
		`a shared subtree writes no localOnly anywhere (${s1.rows.filter((r) => r.localOnly).length} marked)`
	);
	h.check(
		s1.tombFolders.includes(s1.ids.fa) && s1.tombFolders.includes(s1.ids.fb),
		`both shared FOLDERS are tombstoned, which is what the old destroyer never wrote (${s1.tombFolders.length})`
	);
	h.check(
		s1.tombItems.length === 3,
		`and every shared file with them (${s1.tombItems.length} item tombstones)`
	);

	// ---- 2. buildDeletedTree / locationOf / descendants / partitionDeleted ----------------
	//
	// PURE — they take the rows and the live folders as arguments rather than reaching for
	// the stores (a helper that reads a store with get() registers no dependency, which is
	// round 9's bug verbatim), so they are called here through the same module the component
	// imports rather than a copy of it.
	h.check(
		JSON.stringify(s1.rootFolders) === JSON.stringify([s1.ids.fa]) && s1.rootItems === 0,
		`the bin root holds Alpha and nothing loose (${s1.rootFolders.length} folders / ${s1.rootItems} items)`
	);
	h.check(
		JSON.stringify(s1.aFolders) === JSON.stringify([s1.ids.fb]),
		`Beta hangs under Alpha, not beside it (${s1.aFolders.length} under Alpha)`
	);
	h.check(
		JSON.stringify(s1.aItems) === JSON.stringify([s1.ids.a1]),
		`a1.txt is Alpha's own row (${s1.aItems.length})`
	);
	h.check(s1.bItems.length === 2, `b1 and b2 are Beta's (${s1.bItems.length})`);
	h.check(
		s1.descA === 3 && JSON.stringify(s1.descAFolders) === JSON.stringify(['Beta']),
		`descendants(Alpha) walks the WHOLE subtree (${s1.descA} files / ${JSON.stringify(s1.descAFolders)})`
	);
	h.check(
		s1.locB1 === 'Alpha / Beta' && s1.locA1 === 'Alpha',
		`locationOf walks the chain, one deep and two (${s1.locA1} / ${s1.locB1})`
	);
	h.check(
		s1.locFolderB === 'Alpha',
		`...and a FOLDER row answers where IT was (${s1.locFolderB})`
	);
	h.check(
		s1.bin === 5 && s1.spent === 0,
		`partitionDeleted: the bytes are all here, so every row is restorable (${s1.bin} bin / ${s1.spent} spent)`
	);
	// the two clauses that only a fabricated log can isolate: a folder with NO item rows at
	// all is in the bin (without it the default empty-on-load would leave a bin made entirely
	// of empty folders nobody can put back), and a folder whose every item is spent is spent.
	// Plus the display fallback: an item whose folderId resolves to NOTHING shows at the root
	// with its recorded `path` as the location text — the one thing that cannot be re-derived.
	const pure = await ev(() => {
		const L = window.__t.S.sharedLibrary;
		const rows = [
			{ hash: 'folder:E', kind: 'folder', name: 'Empty', folderId: null, at: 1, by: {} },
			{ hash: 'folder:S', kind: 'folder', name: 'Spent', folderId: null, at: 1, by: {} },
			{ hash: 'x1', kind: 'text', name: 'x1.txt', folderId: 'S', path: ['Spent'], at: 1, by: {} },
			{ hash: 'orph', kind: 'text', name: 'o.txt', folderId: 'GONE', path: ['Old', 'Place'], at: 1, by: {} }
		];
		const tree = L.buildDeletedTree(rows, []);
		const none = L.partitionDeleted(rows, new Set(), []);
		const one = L.partitionDeleted(rows, new Set(['x1']), []);
		return {
			rootFolders: (tree.children.get(null) ?? { folders: [] }).folders.map((n) => n.id),
			rootItems: (tree.children.get(null) ?? { items: [] }).items.map((r) => r.hash),
			locOrphan: tree.locationOf(rows[3]),
			binNone: none.bin.map((r) => r.hash),
			spentNone: none.spent.map((r) => r.hash),
			binOne: one.bin.map((r) => r.hash)
		};
	});
	h.check(
		JSON.stringify(pure.rootFolders) === JSON.stringify(['E', 'S']),
		`both folder rows are ROOT nodes (${JSON.stringify(pure.rootFolders)})`
	);
	h.check(
		JSON.stringify(pure.rootItems) === JSON.stringify(['orph']) && pure.locOrphan === 'Old / Place',
		`an item whose folder resolves to nothing shows at the bin ROOT with its recorded path as the location — nothing else can name it (${JSON.stringify(pure.rootItems)} / ${pure.locOrphan})`
	);
	h.check(
		pure.binNone.includes('folder:E'),
		`a folder deleted EMPTY stays in the bin with nothing held (${JSON.stringify(pure.binNone)})`
	);
	h.check(
		pure.spentNone.includes('folder:S') && pure.spentNone.includes('x1'),
		`a folder whose every file is spent is spent with them (${JSON.stringify(pure.spentNone)})`
	);
	h.check(
		pure.binOne.includes('folder:S') && pure.binOne.includes('x1'),
		`...and holding ONE file under it puts the folder back in the bin (${JSON.stringify(pure.binOne)})`
	);

	// ---- 3a. RESTORE ONE ITEM recreates the way there ------------------------------------
	//
	// The folder is GONE from the library — that is the state a peer is in after applying a
	// delete-for-everyone, and the reason restore cannot simply `moveItem` to a folderId.
	const s3a = await ev(async (ids) => {
		const L = window.__t.S.sharedLibrary;
		const before = window.__t.folders().length;
		const ok = L.restoreDeletedItem(ids.b1);
		await window.__t.settle(400);
		const folders = window.__t.folders();
		const item = window.__t.items().find((i) => i.hash === ids.b1);
		const log = window.__t.log();
		const tree = L.buildDeletedTree(log, folders);
		return {
			ok,
			before,
			folderIds: folders.map((f) => f.id),
			beta: folders.find((f) => f.id === ids.fb),
			itemFolder: item && item.folderId,
			itemShare: item && item.share,
			logHashes: log.map((r) => r.hash),
			ghostA: !!(tree.nodes.get(ids.fa) ?? {}).ghost,
			ghostB: !!(tree.nodes.get(ids.fb) ?? {}).ghost,
			locA1: tree.locationOf(log.find((r) => r.hash === ids.a1))
		};
	}, s1.ids);
	h.check(
		s3a.before === 0 && s3a.ok === true,
		`the folder was gone from the library and restore still succeeded (${s3a.before} folders before)`
	);
	h.check(
		s3a.folderIds.includes(s1.ids.fa) && s3a.folderIds.includes(s1.ids.fb),
		`the chain came back under the SAME uuids — the identity every peer's folderId points at (${s3a.folderIds.length} folders)`
	);
	h.check(
		!!s3a.beta && s3a.beta.parentId === s1.ids.fa,
		`Beta was recreated UNDER Alpha, not at the root (${s3a.beta && s3a.beta.parentId})`
	);
	h.check(
		s3a.itemFolder === s1.ids.fb && s3a.itemShare === 'mine',
		`and b1.txt landed in Beta, shared again (${s3a.itemFolder === s1.ids.fb} / ${s3a.itemShare})`
	);
	h.check(
		s3a.logHashes.length === 2 && !s3a.logHashes.some((x) => x.startsWith('folder:')),
		`both folder rows and the item row left the log (${JSON.stringify(s3a.logHashes.length)} left, folder rows: ${s3a.logHashes.filter((x) => x.startsWith('folder:')).length})`
	);
	h.check(
		s3a.ghostA === true && s3a.ghostB === true,
		`the rows still in the bin now hang under GHOST nodes — places, not things to restore (${s3a.ghostA}/${s3a.ghostB})`
	);
	h.check(s3a.locA1 === 'Alpha', `a ghost still names the location (${s3a.locA1})`);

	// ---- 3b. RESTORE THE FOLDER puts the rest back ---------------------------------------
	const s3b = await ev(async (ids) => {
		const L = window.__t.S.sharedLibrary;
		const out = L.restoreDeletedFolder(ids.fa);
		await window.__t.settle(400);
		const folders = window.__t.folders();
		const items = window.__t.items();
		const at = (hash) => items.find((i) => i.hash === hash);
		return {
			out,
			a1: at(ids.a1) && at(ids.a1).folderId,
			b2: at(ids.b2) && at(ids.b2).folderId,
			shares: folders.map((f) => f.share),
			itemShares: [at(ids.a1), at(ids.b1), at(ids.b2)].map((i) => i && i.share),
			logLeft: window.__t.log().length,
			tombF: Object.keys((window.__t.doc().removed ?? {}).folders ?? {}).length,
			tombI: Object.keys((window.__t.doc().removed ?? {}).items ?? {}).length
		};
	}, s1.ids);
	h.check(
		s3b.out.files === 2,
		`restoreDeletedFolder put back what was still under it (${JSON.stringify(s3b.out)})`
	);
	h.check(
		s3b.a1 === s1.ids.fa && s3b.b2 === s1.ids.fb,
		`every file landed in its OWN folder, one deep and two (${s3b.a1 === s1.ids.fa}/${s3b.b2 === s1.ids.fb})`
	);
	h.check(
		s3b.itemShares.every((s) => s === 'mine'),
		`all three are shared again (${JSON.stringify(s3b.itemShares)})`
	);
	h.check(
		s3b.shares.every((s) => s === 'mine'),
		`and so are the folders they live in — a place no peer may see is not a restore (${JSON.stringify(s3b.shares)})`
	);
	h.check(
		s3b.logLeft === 0 && s3b.tombF === 0 && s3b.tombI === 0,
		`the log is empty and every tombstone was lifted, or the rows just published are filtered straight out (${s3b.logLeft} rows / ${s3b.tombF} folder / ${s3b.tombI} item tombstones)`
	);

	// ---- 3c. a LOCAL deletion restores LOCAL ---------------------------------------------
	//
	// The reported "restoring a local deletion shares it": `restoreDeletedItem` always marked
	// `share: 'mine'`. Restore puts a file back AS IT WAS, and a file nobody ever shared was
	// not shared — so the mark has to stay ABSENT, and nothing may be published for it.
	const s3c = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await window.__t.reset();
		const f = E.createFolder('Private', null);
		const it = await E.addItemFromBytes(bytes('local-only-bytes'), 'p1.txt', f.id);
		await settle(400);
		const n = L.deleteItemsToBin([it.id]);
		await settle(300);
		const row = window.__t.log().find((r) => r.hash === it.hash);
		const ok = L.restoreDeletedItem(it.hash);
		await settle(400);
		const back = window.__t.items().find((i) => i.hash === it.hash);
		return {
			n,
			ok,
			localOnly: !!(row && row.localOnly),
			rowFolder: row && row.folderId,
			rowPath: row && row.path,
			folderId: back && back.folderId,
			share: back ? ('share' in back ? back.share : 'absent') : 'gone',
			docItems: (window.__t.doc().items ?? []).length,
			logLeft: window.__t.log().length
		};
	});
	h.check(
		s3c.n === 1 && s3c.localOnly === true,
		`deleteItemsToBin writes a localOnly row for a local file (${s3c.n} moved, localOnly ${s3c.localOnly})`
	);
	h.check(
		!!s3c.rowFolder && JSON.stringify(s3c.rowPath) === JSON.stringify(['Private']),
		`...with the same folderId + path a shared row gets (${JSON.stringify(s3c.rowPath)})`
	);
	h.check(
		s3c.ok === true && s3c.folderId === s3c.rowFolder,
		`it restored back into Private (${s3c.folderId === s3c.rowFolder})`
	);
	h.check(s3c.share === 'absent', `and came back LOCAL — the flag stays absent (${s3c.share})`);
	h.check(
		s3c.docItems === 0 && s3c.logLeft === 0,
		`nothing was published for it, and the row left the log (${s3c.docItems} index rows / ${s3c.logLeft} log rows)`
	);

	// ---- 3d. delete from INSIDE a live folder -> a GHOST node -----------------------------
	const s3d = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await window.__t.reset();
		const outer = E.createFolder('Outer', null);
		const inner = E.createFolder('Inner', outer.id);
		await E.addItemFromBytes(bytes('keep-me-here'), 'keep.txt', inner.id);
		const drop = await E.addItemFromBytes(bytes('drop-me-here'), 'drop.txt', inner.id);
		L.shareFolder(outer.id);
		await settle(400);
		L.deleteItemsToBin([drop.id]);
		await settle(400);
		const log = window.__t.log();
		const tree = L.buildDeletedTree(log, window.__t.folders());
		const nodeI = tree.nodes.get(inner.id);
		const nodeO = tree.nodes.get(outer.id);
		const before = window.__t.items().length;
		L.restoreDeletedItem(drop.hash);
		await settle(400);
		const back = window.__t.items().find((i) => i.hash === drop.hash);
		return {
			ids: { outer: outer.id, inner: inner.id },
			keptVisible: before,
			ghostI: !!(nodeI && nodeI.ghost),
			ghostO: !!(nodeO && nodeO.ghost),
			nameI: nodeI && nodeI.name,
			loc: tree.locationOf(log.find((r) => r.hash === drop.hash)),
			rootFolders: tree.children.get(null).folders.map((n) => n.id),
			folderId: back && back.folderId,
			share: back && back.share,
			folderCount: window.__t.folders().length,
			logLeft: window.__t.log().length
		};
	});
	h.check(s3d.keptVisible === 1, `only the deleted file left the shelf (${s3d.keptVisible} still visible)`);
	h.check(
		s3d.ghostI && s3d.ghostO,
		`the still-live folders draw as GHOST nodes (${s3d.ghostO}/${s3d.ghostI})`
	);
	h.check(s3d.nameI === 'Inner', `a ghost is named from the LIVE record (${s3d.nameI})`);
	h.check(s3d.loc === 'Outer / Inner', `nested ghosts give the full location (${s3d.loc})`);
	h.check(
		JSON.stringify(s3d.rootFolders) === JSON.stringify([s3d.ids.outer]),
		`the ghost chain hangs off the bin root once (${JSON.stringify(s3d.rootFolders.length)})`
	);
	h.check(
		s3d.folderId === s3d.ids.inner && s3d.share === 'mine',
		`restore landed back INSIDE the live folder, shared (${s3d.folderId === s3d.ids.inner} / ${s3d.share})`
	);
	h.check(
		s3d.folderCount === 2 && s3d.logLeft === 0,
		`no duplicate folder was minted on the way (${s3d.folderCount} folders / ${s3d.logLeft} rows)`
	);

	// ---- 3e. purgeDeletedFolder reclaims bytes and prunes only the EMPTY row --------------
	//
	// Round 13's ruling, applied to a node: emptying reclaims BYTES, never the record. The one
	// row it may drop is a folder that held no item rows at all, because a name is the only
	// thing there was to free.
	const s3e = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await window.__t.reset();
		const fa = E.createFolder('Alpha', null);
		const fb = E.createFolder('Beta', fa.id);
		const empty = E.createFolder('Empty', fa.id);
		const a1 = await E.addItemFromBytes(bytes('purge-alpha'), 'a1.txt', fa.id);
		const b1 = await E.addItemFromBytes(bytes('purge-beta-1'), 'b1.txt', fb.id);
		const b2 = await E.addItemFromBytes(bytes('purge-beta-2'), 'b2.txt', fb.id);
		L.shareFolder(fa.id);
		await settle(400);
		L.deleteFolderToBin(fa.id);
		await settle(400);
		const before = window.__t.log().length;
		const reclaimed = await L.purgeDeletedFolder(fa.id);
		await settle(400);
		const log = window.__t.log();
		const part = L.partitionDeleted(log, window.__t.held(), window.__t.folders());
		return {
			ids: { fa: fa.id, fb: fb.id, empty: empty.id, a1: a1.hash, b1: b1.hash, b2: b2.hash },
			before,
			reclaimed,
			after: log.map((r) => r.hash),
			held: window.__t.held().size,
			bin: part.bin.length,
			spent: part.spent.length
		};
	});
	h.check(
		s3e.before === 6,
		`the log held 3 files + 3 folders, Empty included (${s3e.before} rows)`
	);
	h.check(
		s3e.reclaimed === 3 && s3e.held === 0,
		`purgeDeletedFolder freed every held file under the node, however deep (${s3e.reclaimed} reclaimed / ${s3e.held} still held)`
	);
	h.check(
		!s3e.after.includes('folder:' + s3e.ids.empty),
		`the EMPTY folder's row was pruned — a name is all it had (${s3e.after.length} rows left)`
	);
	h.check(
		s3e.after.includes('folder:' + s3e.ids.fa) && s3e.after.includes('folder:' + s3e.ids.fb),
		`the folders that HELD something keep their rows, so their files have somewhere to be listed (${s3e.after.filter((x) => x.startsWith('folder:')).length} folder rows)`
	);
	h.check(
		s3e.after.length === 5 && [s3e.ids.a1, s3e.ids.b1, s3e.ids.b2].every((x) => s3e.after.includes(x)),
		`and every purged item row stays: emptying takes bytes, never the record (${s3e.after.length})`
	);
	h.check(
		s3e.spent === 5 && s3e.bin === 0,
		`partitionDeleted now reads the whole log as spent (${s3e.bin} bin / ${s3e.spent} spent)`
	);

	// ---- 3f. "Clear the log" forgets the cleaned-up records and NOTHING ELSE ---------------
	//
	// Reported: clearing the log removed every deleted file. It ran `emptyDeletedLog`, the
	// bin's own destructive act. Staged on the five spent rows above plus ONE fresh deletion
	// whose bytes are still here: the five go, the one stays, and it can still be put back.
	const s3f = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		const keep = await E.addItemFromBytes(bytes('still-restorable'), 'keep-me.txt', null);
		await settle(300);
		L.deleteItemsToBin([keep.id]);
		await settle(300);
		const before = window.__t.log().length;
		const gone = L.clearDeletedRecords();
		await settle(300);
		const after = window.__t.log();
		return {
			before,
			gone,
			after: after.map((r) => r.hash),
			keepHash: keep.hash,
			restorable: L.canRestoreDeleted(keep.hash),
			bytesKept: window.__t.held().has(keep.hash)
		};
	});
	h.check(s3f.before === 6 && s3f.gone === 5, `five spent rows forgotten out of six (${s3f.gone} of ${s3f.before})`);
	h.check(
		s3f.after.length === 1 && s3f.after[0] === s3f.keepHash,
		`the one row whose bytes are still here SURVIVES (${s3f.after.length} left)`
	);
	h.check(
		s3f.restorable && s3f.bytesKept,
		`...and it is still restorable — clearing the log took no bytes (restorable ${s3f.restorable}, held ${s3f.bytesKept})`
	);

	// ---- 4. THE BIN VIEW, driven through the real UI --------------------------------------
	//
	// Single page, no peer needed: the tree, the walk-in, the menus and the toggle are all
	// readings of ONE local array. Everything here is reached the way a user reaches it —
	// a view with no way in is invisible to a suite that supplies its own entry point.
	const ui = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await window.__t.reset();
		S.explorer.activeFolder.set(null);
		S.explorerView.explorerBinLayout.set('tree');
		S.explorerView.explorerBinShowSpent.set(false);
		S.explorerView.explorerViewMode.set('thumbnails');
		const docs = E.createFolder('Docs', null);
		const inner = E.createFolder('Inner', docs.id);
		const top = await E.addItemFromBytes(bytes('ui-top-file'), 'top.txt', docs.id);
		const keep = await E.addItemFromBytes(bytes('ui-inner-file'), 'keep.txt', inner.id);
		await settle(400);
		L.deleteFolderToBin(docs.id);
		await settle(500);
		return { docs: docs.id, inner: inner.id, top: top.hash, keep: keep.hash };
	});

	// the Explorer WINDOW has to be open before its tree can be read — every section above
	// drove the stores, and a store has no `#deleted-folder` (explorer-views opens it the
	// same way). Idempotent: the slot toggles, so a second click would close it again.
	if ((await page.locator('#explorer-tree').count()) === 0) {
		await page.locator('#explorer-slot').click();
		await page.waitForTimeout(800);
	}

	// a) the way in, and what the root of the bin draws
	h.check(
		(await page.locator('#deleted-folder').count()) === 1,
		'the Deleted row is in the tree once something is in the bin'
	);
	await page.locator('#deleted-folder').click();
	await page.waitForTimeout(600);
	let where = await ev(() => window.__t.val(window.__t.S.explorer.activeFolder));
	h.check(where === 'deleted', `clicking it stands you in the bin (${JSON.stringify(where)})`);
	let ids = await cardIds(page);
	h.check(
		ids.filter((i) => i === 'deletedfolder:' + ui.docs).length === 1,
		`the deleted FOLDER draws as a card of its own (${JSON.stringify(ids)})`
	);
	h.check(
		ids.every((i) => !i.startsWith('deleted:')),
		`and nothing is loose at the root — the files are inside it (${ids.filter((i) => i.startsWith('deleted:')).length} loose)`
	);

	// b) the node's OWN menu: no rename, no share, no delete — it is the record of a place
	await page.locator('[data-card-id="deletedfolder:' + ui.docs + '"]').click({ button: 'right' });
	await page.waitForTimeout(400);
	let rows = await menuRows(page);
	h.check(
		rows.some((t) => t.startsWith('Restore folder')),
		`a bin node offers Restore folder, with its counts (${JSON.stringify(rows)})`
	);
	h.check(
		rows.includes('Open') && rows.some((t) => t.startsWith('Deleted by')),
		`...Open, and who threw it away (${rows.length} rows)`
	);
	h.check(
		!rows.includes('Rename') && !rows.some((t) => t.startsWith('Share')),
		`...and none of Rename/Share, which would address a folder the library does not have (${JSON.stringify(rows)})`
	);
	await closeMenu(page);

	// c) walking IN — a double-click, the same gesture a library folder takes
	await page.locator('[data-card-id="deletedfolder:' + ui.docs + '"]').dblclick();
	await page.waitForTimeout(600);
	where = await ev(() => window.__t.val(window.__t.S.explorer.activeFolder));
	h.check(where === 'deleted:' + ui.docs, `a double-click walks into the node (${JSON.stringify(where)})`);
	let crumbs = await page.evaluate(() =>
		[...document.querySelectorAll('#explorer-crumbs button')]
			.map((b) => b.textContent.trim())
			.filter(Boolean)
			.join(' / ')
	);
	h.check(crumbs === 'Deleted / Docs', `the trail walks the bin's tree the way the library's does (${crumbs})`);
	ids = await cardIds(page);
	h.check(
		ids.includes('deletedfolder:' + ui.inner) && ids.includes('deleted:' + ui.top),
		`inside the node: the subfolder and this folder's own file (${JSON.stringify(ids)})`
	);

	// d) the item menu — and the tooltip that says WHERE, which is the whole round
	await page.locator('[data-card-id="deleted:' + ui.top + '"]').click({ button: 'right' });
	await page.waitForTimeout(400);
	const itemMenu = await menuDetail(page);
	const restoreRow = itemMenu.find((r) => r.label === 'Restore');
	h.check(!!restoreRow, `a held row offers Restore (${itemMenu.map((r) => r.label).join(' / ')})`);
	h.check(
		!!restoreRow && restoreRow.title === 'Put it back in Docs',
		`...and the tooltip NAMES the folder it goes back to (${restoreRow && restoreRow.title})`
	);
	h.check(
		itemMenu.some((r) => r.label === 'Location: Docs'),
		`...with a Location line beside it (${itemMenu.map((r) => r.label).join(' / ')})`
	);
	await page.locator('[role=menu]').getByText('Restore', { exact: true }).first().click();
	await page.waitForTimeout(900);
	const restored = await ev((u) => {
		const t = window.__t;
		const item = t.items().find((i) => i.hash === u.top);
		return {
			folderLive: t.folders().some((f) => f.id === u.docs),
			folderId: item && item.folderId,
			rows: t.log().map((r) => r.hash)
		};
	}, ui);
	h.check(
		restored.folderLive && restored.folderId === ui.docs,
		`Restore from the menu recreated Docs and put the file back IN it (${restored.folderId === ui.docs})`
	);
	h.check(
		!restored.rows.includes(ui.top) && !restored.rows.includes('folder:' + ui.docs),
		`...consuming both rows it used (${restored.rows.length} left)`
	);

	// e) the background menu's Layout section, and what PLAIN means
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deleted'));
	await page.waitForTimeout(500);
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 170 } });
	await page.waitForTimeout(450);
	rows = await menuRows(page);
	// R22 round 36 (user): ONE section, TWO TOGGLES. The layout used to be a checked PAIR
	// (Folder structure / Plain list) on the round-9 group-by reasoning — but "off" is not a
	// choice for a bin that IS a tree, so the departure is what gets the switch, and it sits
	// beside the other switch on how this view is drawn rather than in a section of its own.
	h.check(
		rows.includes('Plain list without folders') && rows.includes('Show cleaned-up files'),
		`the bin's background menu carries both view flags (${JSON.stringify(rows.slice(0, 3))})`
	);
	h.check(
		!rows.includes('Folder structure') && !rows.includes('Plain list'),
		`...and the old checked PAIR is gone (${JSON.stringify(rows)})`
	);
	h.check(
		(await menuChecked(page, 'Plain list without folders')) === false,
		'unchecked, because the tree is the default and the flag is the departure from it'
	);
	await page.getByRole('menuitem', { name: 'Plain list without folders' }).click();
	await page.waitForTimeout(700);
	const plain = await ev(() => ({
		layout: window.__t.val(window.__t.S.explorerView.explorerBinLayout),
		ids: [...document.querySelectorAll('#explorer-grid [data-card-id]')].map((e) =>
			e.getAttribute('data-card-id')
		)
	}));
	h.check(plain.layout === 'plain', `the menu entry flips the pref (${plain.layout})`);
	h.check(
		!plain.ids.some((i) => i.startsWith('deletedfolder:')),
		`plain layout offers NO folder cards — that is the whole of what plain means (${JSON.stringify(plain.ids)})`
	);
	h.check(
		plain.ids.includes('deleted:' + ui.keep),
		`...and the file two folders deep is listed at the root instead (${JSON.stringify(plain.ids)})`
	);
	// the column is what carries the place once the folders are gone from the view
	await page.evaluate(() => window.__stores.explorerView.explorerViewMode.set('list'));
	await page.waitForTimeout(600);
	const listed = await listRows(page);
	const keepRow = listed.find((r) => r.id === 'deleted:' + ui.keep);
	h.check(
		!!keepRow && keepRow.cells[2] === 'Docs / Inner',
		`the Location column says where it was, ghost and all (${keepRow && keepRow.cells[2]})`
	);
	// ...and it is a TOGGLE, so the same row reads checked and takes you back
	await page.locator('#explorer-grid').click({ button: 'right', position: { x: 1000, y: 220 } });
	await page.waitForTimeout(450);
	h.check(
		(await menuChecked(page, 'Plain list without folders')) === true,
		'with the flat list on, the row reads CHECKED — one control, two states'
	);
	await page.getByRole('menuitem', { name: 'Plain list without folders' }).click();
	await page.waitForTimeout(700);
	const backToTree = await ev(() => ({
		layout: window.__t.val(window.__t.S.explorerView.explorerBinLayout),
		ids: [...document.querySelectorAll('#explorer-grid [data-card-id]')].map((e) =>
			e.getAttribute('data-card-id')
		)
	}));
	h.check(
		backToTree.layout === 'tree' && backToTree.ids.some((i) => i.startsWith('deletedfolder:')),
		`pressing it again restores the folder structure (${backToTree.layout} / ${JSON.stringify(backToTree.ids)})`
	);
	// put the flat list back the way the rest of this section found it — the UI half of the
	// switch is proven above, and the sections below read the flat root
	await page.evaluate(() => window.__stores.explorerView.explorerBinLayout.set('plain'));
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.explorerView.explorerViewMode.set('thumbnails'));
	await page.waitForTimeout(400);

	// f) the breadcrumb toggle — a VIEW FLAG, not a place
	const toggle = await page.evaluate(() => {
		const b = document.querySelector('#deleted-log-toggle');
		return {
			present: !!b,
			inCrumbs: !!(b && b.closest('#explorer-crumbs')),
			strip: !!document.querySelector('#explorer-bin-tabs'),
			on: b && b.getAttribute('aria-pressed')
		};
	});
	h.check(
		toggle.present && toggle.inCrumbs && !toggle.strip && toggle.on === 'false',
		`the toggle lives INSIDE the breadcrumb row, off by default, and the Bin|Log strip that cost a row of height is gone (crumbs ${toggle.inCrumbs} / strip ${toggle.strip} / pressed ${toggle.on})`
	);
	await page.locator('#deleted-log-toggle').click();
	await page.waitForTimeout(600);
	const flipped = await ev(() => ({
		on: document.querySelector('#deleted-log-toggle').getAttribute('aria-pressed'),
		spent: window.__t.val(window.__t.S.explorerView.explorerBinShowSpent),
		where: window.__t.val(window.__t.S.explorer.activeFolder)
	}));
	h.check(
		flipped.on === 'true' && flipped.spent === true,
		`pressing it flips the flag and the paint together (${flipped.on} / ${flipped.spent})`
	);
	h.check(
		flipped.where === 'deleted',
		`...and navigates nowhere: one place, read two ways (${JSON.stringify(flipped.where)})`
	);

	// g) a PURGED row: in the record, never in the bin
	await page.evaluate(() => window.__stores.explorerView.explorerBinShowSpent.set(false));
	await page.waitForTimeout(300);
	await ev(async (u) => {
		await window.__t.S.sharedLibrary.purgeDeletedItem(u.keep);
		await window.__t.settle(500);
	}, ui);
	await page.waitForTimeout(600);
	ids = await cardIds(page);
	h.check(
		!ids.includes('deleted:' + ui.keep),
		`once the bytes are freed the row LEAVES the bin — a bin lists what it can put back (${JSON.stringify(ids)})`
	);
	await page.locator('#deleted-log-toggle').click();
	await page.waitForTimeout(600);
	ids = await cardIds(page);
	h.check(
		ids.includes('deleted:' + ui.keep),
		`with the toggle on the record is still there (${JSON.stringify(ids)})`
	);
	await page.locator('[data-card-id="deleted:' + ui.keep + '"]').click({ button: 'right' });
	await page.waitForTimeout(400);
	rows = await menuRows(page);
	h.check(
		rows.some((t) => t.startsWith('Cleaned up on this device')) && !rows.includes('Restore'),
		`and its menu says what THIS machine did rather than offering a Restore that cannot work (${JSON.stringify(rows)})`
	);
	await closeMenu(page);

	// h) `deletedlog` survives as an ALIAS. `openFolder` is component-private, so what is
	// driven here is the state a caller of it leaves behind: the view standing on the old id
	// draws THE BIN — one trail, one toggle, one set of rows — rather than a second place.
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('deletedlog'));
	await page.waitForTimeout(700);
	const alias = await page.evaluate(() => ({
		crumbs: [...document.querySelectorAll('#explorer-crumbs button')]
			.map((b) => b.textContent.trim())
			.filter(Boolean)
			.join(' / '),
		toggle: !!document.querySelector('#deleted-log-toggle'),
		logRoot: !!document.querySelector('#deleted-log-folder')
	}));
	h.check(
		alias.crumbs === 'Deleted' && alias.toggle,
		`the old id is answered by the bin itself, toggle and all (${alias.crumbs})`
	);
	h.check(
		!alias.logRoot,
		'and the log has no tree root of its own — one subject, one place in the tree'
	);

	// ---- 4i. DRAG IT OUT OF DELETED --------------------------------------------------
	//
	// R22 round 36 (user). Restore decides WHERE for you, from the location the row
	// recorded; this gesture is the answer to that question stated by hand. It reuses the
	// library's own DnD end to end — the same `dragstart` handlers, the same payload
	// strings, the same `dropInto` on every target — so what is measured here is that the
	// bin's two id namespaces survive the round trip and that `{ into }` beats the recorded
	// location, not that a second drag system works.
	const dnd = await ev(async () => {
		const { S, bytes, settle } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		await window.__t.reset();
		S.explorer.activeFolder.set(null);
		S.explorerView.explorerBinLayout.set('tree');
		S.explorerView.explorerBinShowSpent.set(false);
		S.explorerView.explorerViewMode.set('thumbnails');
		const vault = E.createFolder('Vault', null);
		const elsewhere = E.createFolder('Elsewhere', null);
		const gone = E.createFolder('Gone', null);
		const loose = await E.addItemFromBytes(bytes('dnd-loose'), 'loose.txt', null);
		const inside = await E.addItemFromBytes(bytes('dnd-inside'), 'inside.txt', gone.id);
		const ghosted = await E.addItemFromBytes(bytes('dnd-ghosted'), 'ghosted.txt', vault.id);
		await settle(400);
		L.deleteItemsToBin([loose.id]);
		L.deleteFolderToBin(gone.id);
		// deleting from INSIDE a folder that stays leaves a GHOST node — a place, not a
		// thing, which is exactly the node this gesture must refuse to pick up
		L.deleteItemsToBin([ghosted.id]);
		await settle(600);
		return {
			vault: vault.id,
			elsewhere: elsewhere.id,
			gone: gone.id,
			loose: loose.hash,
			inside: inside.hash,
			ghosted: ghosted.hash
		};
	});
	await page.locator('#deleted-folder').click();
	await page.waitForTimeout(700);
	ids = await cardIds(page);
	h.check(
		ids.includes('deleted:' + dnd.loose) &&
			ids.includes('deletedfolder:' + dnd.gone) &&
			ids.includes('deletedfolder:' + dnd.vault),
		`premise: a loose row, a deleted folder and a ghost all at the bin root (${JSON.stringify(ids)})`
	);

	// WHAT MAY BE PICKED UP. A ghost is the one node here that is not itself deleted, so
	// there is nothing to put back and no id a drop could write.
	const grabbable = await ev((d) => {
		const at = (/** @type {string} */ id) =>
			document.querySelector('[data-card-id="' + id + '"]')?.getAttribute('draggable') ?? null;
		return {
			item: at('deleted:' + d.loose),
			node: at('deletedfolder:' + d.gone),
			ghost: at('deletedfolder:' + d.vault)
		};
	}, dnd);
	h.check(
		grabbable.item !== 'false' && grabbable.node !== 'false',
		`a bin ROW and a real deleted FOLDER can both be picked up (${JSON.stringify(grabbable)})`
	);
	h.check(grabbable.ghost === 'false', `...and a GHOST cannot (${grabbable.ghost})`);
	// belt to that brace: even forced, its drag start writes NOTHING, so no drop anywhere
	// can act on it
	const ghostPayload = await ev((d) => {
		const dt = new DataTransfer();
		document
			.querySelector('[data-card-id="deletedfolder:' + d.vault + '"]')
			.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
		return {
			folder: dt.getData('application/x-explorer-folder'),
			item: dt.getData('application/x-explorer-item')
		};
	}, dnd);
	h.check(
		!ghostPayload.folder && !ghostPayload.item,
		`a forced drag start on a ghost carries no payload at all (${JSON.stringify(ghostPayload)})`
	);

	/** the real gesture: dragstart on the card, dragover + drop on the target, one
	 *  DataTransfer carrying whatever the app's own handlers wrote into it */
	const dragCardTo = (cardId, targetSel) =>
		ev(
			(a) => {
				const dt = new DataTransfer();
				const from = document.querySelector('[data-card-id="' + a.card + '"]');
				const to = a.target.kind === 'root'
					? document.querySelector('#explorer-root-row')
					: [...document.querySelectorAll('#explorer-folder-list [role=treeitem]')].find(
							(r) => r.innerText.trim() === a.target.name
						);
				if (!from || !to) return { ok: false, from: !!from, to: !!to };
				from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
				to.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
				to.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
				return { ok: true };
			},
			{ card: cardId, target: targetSel }
		);

	// a) a bin ROW onto a Library folder ROW in the tree
	const droppedRow = await dragCardTo('deleted:' + dnd.loose, { kind: 'row', name: 'Vault' });
	h.check(droppedRow.ok, `premise: the drop reached the Vault tree row (${JSON.stringify(droppedRow)})`);
	await page.waitForTimeout(900);
	let after = await ev((d) => ({
		row: window.__t.items().find((i) => i.hash === d.loose)?.folderId ?? 'MISSING',
		log: window.__t.log().map((r) => r.hash)
	}), dnd);
	h.check(
		after.row === dnd.vault,
		`a row dragged onto a folder is restored INTO it, not into the root it came from (${after.row})`
	);
	h.check(
		!after.log.includes(dnd.loose),
		`...and its record leaves the log, exactly as the menu's Restore does (${after.log.length} rows left)`
	);

	// b) a deleted FOLDER node onto the Library ROOT row — `into` beats the recorded parent
	const droppedFolder = await dragCardTo('deletedfolder:' + dnd.gone, { kind: 'root' });
	h.check(droppedFolder.ok, 'premise: the drop reached the Library root row');
	await page.waitForTimeout(1000);
	after = await ev((d) => {
		const folders = window.__t.folders();
		const back = folders.find((f) => f.id === d.gone);
		return {
			folder: back ? { name: back.name, parentId: back.parentId ?? null } : null,
			inside: window.__t.items().find((i) => i.hash === d.inside)?.folderId ?? 'MISSING',
			log: window.__t.log().map((r) => r.hash)
		};
	}, dnd);
	h.check(
		!!after.folder && after.folder.name === 'Gone' && after.folder.parentId === null,
		`a deleted FOLDER dropped on the root comes back there, under its own uuid (${JSON.stringify(after.folder)})`
	);
	h.check(
		after.inside === dnd.gone,
		`...carrying what was inside it, still inside it (${after.inside})`
	);
	h.check(
		!after.log.includes('folder:' + dnd.gone) && !after.log.includes(dnd.inside),
		`...and consuming both rows it used (${JSON.stringify(after.log)})`
	);

	// c) THE ONE THAT MATTERS: a drop names a destination the row never had. `ghosted.txt`
	// recorded `Vault`; dropped on Elsewhere it lands in Elsewhere. The FOLDER CARD is the
	// third drop target and it cannot be staged from the bin's own grid (one view at a
	// time), so the payload the bin card really writes is captured and handed to the card's
	// own handler — which is the point: it is an ordinary Explorer item payload.
	// ghosted.txt was deleted from INSIDE Vault, which is still live, so in the tree layout
	// this section runs in it sits UNDER the Vault ghost node, not at the bin root: walk in,
	// and WAIT for the card rather than reading it in the same tick as the re-render (both
	// measured: null at the root, then a timeout waiting there)
	await page.evaluate((id) => window.__stores.explorer.activeFolder.set('deleted:' + id), dnd.vault);
	await page.locator('[data-card-id="deleted:' + dnd.ghosted + '"]').first().waitFor({ timeout: 8000 });
	const carried = await ev((d) => {
		const dt = new DataTransfer();
		document
			.querySelector('[data-card-id="deleted:' + d.ghosted + '"]')
			.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
		return dt.getData('application/x-explorer-item');
	}, dnd);
	h.check(
		!!carried && JSON.parse(carried).id === 'deleted:' + dnd.ghosted,
		`a bin card writes the ORDINARY item payload, keyed by its own id (${carried})`
	);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(600);
	const ontoCard = await ev((a) => {
		const dt = new DataTransfer();
		dt.setData('application/x-explorer-item', a.payload);
		const card = document.querySelector('[data-card-id="' + a.folder + '"]');
		if (!card) return { ok: false };
		card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
		card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
		return { ok: true };
	}, { payload: carried, folder: dnd.elsewhere });
	h.check(ontoCard.ok, 'premise: the Elsewhere folder card took the drop');
	await page.waitForTimeout(900);
	const moved = await ev((d) => ({
		folderId: window.__t.items().find((i) => i.hash === d.ghosted)?.folderId ?? 'MISSING',
		log: window.__t.log().map((r) => r.hash)
	}), dnd);
	h.check(
		moved.folderId === dnd.elsewhere,
		`the DROP decides where, beating the location the row recorded (${moved.folderId} vs recorded ${dnd.vault})`
	);
	h.check(
		!moved.log.includes(dnd.ghosted),
		'...and it is a real restore: the record is consumed either way'
	);

	// ---- 5. TWO PEERS: the report, and the counterfactual that proves it fixed ------------
	await ev(async () => {
		await window.__t.reset();
		window.__t.S.explorer.activeFolder.set(null);
		window.__t.S.explorerView.explorerBinLayout.set('tree');
		window.__t.S.explorerView.explorerBinShowSpent.set(false);
		await window.__t.settle(400);
	});

	const B = await h.setupPage(browser, 'B', { storage });
	await B.page.waitForFunction(
		() => !!window.__stores?.sharedLibrary && !!window.__stores?.explorer,
		null,
		{ timeout: 30000 }
	);
	await B.page.evaluate(INSTALL);
	await B.page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
	await B.page.evaluate(() => window.__stores.explorer.loadExplorer());

	try {
		await h.connect(A, B);
	} catch (error) {
		console.log('connect failed once, retrying: ' + error.message);
		await h.connect(A, B);
	}
	await dismissDecision(B);
	await dismissDecision(A);
	await A.page.waitForTimeout(3000);

	const seed = await A.page.evaluate(async () => {
		const { S, bytes } = window.__t;
		const E = S.explorer, L = S.sharedLibrary;
		const f = E.createFolder('Shared Set', null);
		const one = await E.addItemFromBytes(bytes('peer-file-one-' + Date.now()), 'one.txt', f.id);
		const two = await E.addItemFromBytes(bytes('peer-file-two-' + Date.now()), 'two.txt', f.id);
		L.shareFolder(f.id);
		L.publishMine(true);
		return { folder: f.id, one: one.hash, two: two.hash };
	});
	await h.eventually(
		() =>
			B.page.evaluate((s) => {
				const t = window.__t;
				return {
					folder: t.folders().some((f) => f.id === s.folder),
					items: t
						.items()
						.filter((i) => i.hash === s.one || i.hash === s.two)
						.map((i) => i.folderId)
				};
			}, seed),
		(v) => v.folder && v.items.length === 2 && v.items.every((f) => f === seed.folder),
		'B holds the shared folder and both files, placed inside it',
		60000
	);

	// the engine of the reported bug: with `always` armed, B's sweep claims everything
	// unshared as `mine` and republishes it
	await B.page.evaluate(() => window.__t.S.sharedLibrary.shareNewFiles.set('always'));
	await B.page.waitForTimeout(1500);

	const counts = await A.page.evaluate(
		(s) => window.__t.S.sharedLibrary.deleteFolderToBin(s.folder),
		seed
	);
	h.check(
		counts.folders === 1 && counts.files === 2,
		`A deleted the folder and both files in one act (${JSON.stringify(counts)})`
	);

	await h.eventually(
		() =>
			B.page.evaluate((s) => {
				const t = window.__t;
				return {
					folder: t.folders().some((f) => f.id === s.folder),
					visible: t.items().filter((i) => i.hash === s.one || i.hash === s.two).length,
					hidden: t.hidden().filter((i) => i.hash === s.one || i.hash === s.two).length,
					rows: t.log().length
				};
			}, seed),
		(v) => !v.folder && v.visible === 0 && v.hidden === 2 && v.rows === 3,
		"B's folder RECORD is gone, both files are hidden, and its log holds three rows",
		45000
	);
	const bAfter = await B.page.evaluate((s) => {
		const t = window.__t;
		const L = t.S.sharedLibrary;
		const log = t.log();
		const tree = L.buildDeletedTree(log, t.folders());
		const part = L.partitionDeleted(log, t.held(), t.folders());
		const kids = tree.children.get(s.folder) ?? { folders: [], items: [] };
		return {
			hidden: t
				.hidden()
				.filter((i) => i.hash === s.one || i.hash === s.two)
				.map((i) => ({ f: i.folderId, s: i.share })),
			folderRow: log.find((r) => r.hash === 'folder:' + s.folder) ?? null,
			itemRows: log.filter((r) => r.hash === s.one || r.hash === s.two).length,
			under: kids.items.map((r) => r.hash),
			rootItems: (tree.children.get(null) ?? { items: [] }).items.length,
			bin: part.bin.length
		};
	}, seed);
	h.check(
		bAfter.hidden.every((i) => i.f === seed.folder),
		`B's hidden copies KEEP their folderId, which is what lets its bin draw the tree (${JSON.stringify(bAfter.hidden.map((i) => i.f === seed.folder))})`
	);
	h.check(
		bAfter.hidden.every((i) => i.s === 'no'),
		`...and are marked share:'no', the state a delete-for-everyone produces (${JSON.stringify(bAfter.hidden.map((i) => i.s))})`
	);
	h.check(
		!!bAfter.folderRow && bAfter.folderRow.kind === 'folder' && bAfter.itemRows === 2,
		`B's manifest carries the FOLDER row and both item rows (${bAfter.itemRows} item rows)`
	);
	h.check(
		bAfter.under.length === 2 && bAfter.rootItems === 0 && bAfter.bin === 3,
		`and B's bin places both files UNDER the folder node rather than loose at its root, all three restorable from B alone (${bAfter.under.length} under / ${bAfter.rootItems} loose / ${bAfter.bin} in the bin)`
	);

	// THE COUNTERFACTUAL, measured: seconds of B's `always` sweep must change NOTHING on A.
	// This is the report itself — without this wait the whole section passes on a suite that
	// simply never let the sweep run.
	await A.page.waitForTimeout(3500);
	const cf = await A.page.evaluate((s) => {
		const t = window.__t;
		return {
			folder: t.folders().some((f) => f.id === s.folder),
			visible: t.items().length,
			hidden: t.hidden().filter((i) => i.hash === s.one || i.hash === s.two).length,
			docFolders: (t.doc().folders ?? []).length,
			docItems: (t.doc().items ?? []).length,
			pulling: t.val(t.S.sharedLibrary.pendingPulls).size
		};
	}, seed);
	console.log('  counterfactual: ' + JSON.stringify(cf));
	h.check(cf.folder === false, `MEASURED: the folder did NOT come back on A (${cf.folder})`);
	h.check(cf.visible === 0, `MEASURED: no file was re-downloaded onto A (${cf.visible} visible)`);
	h.check(
		cf.hidden === 2,
		`A's own copies are still on the hidden shelf, bytes intact (${cf.hidden})`
	);
	h.check(
		cf.docFolders === 0 && cf.docItems === 0,
		`the shared index stayed empty (${cf.docFolders} folders / ${cf.docItems} items)`
	);
	h.check(cf.pulling === 0, `and nothing is being pulled (${cf.pulling})`);

	// ---- B restores ONE file: the folder comes back under the SAME uuid on BOTH -----------
	await B.page.evaluate((s) => window.__t.S.sharedLibrary.restoreDeletedItem(s.one), seed);
	await h.eventually(
		() =>
			B.page.evaluate((s) => {
				const t = window.__t;
				const it = t.items().find((i) => i.hash === s.one);
				const f = t.folders().find((x) => x.id === s.folder);
				return {
					share: f && f.share,
					item: it && it.folderId,
					itemShare: it && it.share,
					rows: t.log().map((r) => r.hash)
				};
			}, seed),
		(v) =>
			v.share === 'mine' && v.item === seed.folder && v.itemShare === 'mine' && v.rows.length === 1,
		'B recreated the folder under the SAME uuid, as its publisher, with one.txt back inside it',
		30000
	);
	await h.eventually(
		() =>
			A.page.evaluate((s) => {
				const t = window.__t;
				const it = t.items().find((i) => i.hash === s.one);
				const f = t.folders().find((x) => x.id === s.folder);
				return {
					share: f && f.share,
					item: it && it.folderId,
					otherHidden: t.hidden().some((i) => i.hash === s.two),
					rows: t.log().map((r) => r.hash)
				};
			}, seed),
		(v) =>
			v.share === 'peer' &&
			v.item === seed.folder &&
			v.otherHidden &&
			v.rows.length === 1 &&
			v.rows[0] === seed.two,
		"A adopted the folder as a PEER's and un-hid its own copy back into it — the reported \"restored files do not appear for peers\"",
		45000
	);
	const bins = await Promise.all([
		A.page.evaluate(() => window.__t.log().map((r) => r.hash)),
		B.page.evaluate(() => window.__t.log().map((r) => r.hash))
	]);
	h.check(
		bins[0].length === 1 && bins[1].length === 1 && bins[0][0] === seed.two && bins[1][0] === seed.two,
		`two.txt is the sole row in BOTH bins, and the folder row is spent on both (${JSON.stringify(bins)})`
	);

	// ---- B restores the FOLDER: what is left under it comes back too ----------------------
	await B.page.evaluate((s) => window.__t.S.sharedLibrary.restoreDeletedFolder(s.folder), seed);
	await h.eventually(
		() =>
			B.page.evaluate((s) => {
				const t = window.__t;
				const it = t.items().find((i) => i.hash === s.two);
				return { item: it && it.folderId, rows: t.log().length };
			}, seed),
		(v) => v.item === seed.folder && v.rows === 0,
		"restoreDeletedFolder on the ghost put two.txt back in the folder and emptied B's bin",
		30000
	);
	await h.eventually(
		() =>
			A.page.evaluate((s) => {
				const t = window.__t;
				const it = t.items().find((i) => i.hash === s.two);
				return {
					item: it && it.folderId,
					rows: t.log().length,
					visible: t.items().length,
					hidden: t.hidden().filter((i) => i.hash === s.one || i.hash === s.two).length
				};
			}, seed),
		(v) => v.item === seed.folder && v.rows === 0 && v.visible === 2 && v.hidden === 0,
		'...and A followed: both files visible in the folder again, both bins empty, nothing left on the hidden shelf',
		45000
	);

	// ---- A deletes the folder AGAIN: the peer must apply it afresh -------------------------
	//
	// The cloud review of PR #190: a peer's `appliedDeletes` kept `folder:<id>` across the
	// restore (only the ITEM half of the un-apply rule existed), so the second deletion of the
	// same folder short-circuited in the applier and the reconcile left a `wasShared` ghost of
	// a folder the deleter had destroyed — surviving reloads, since the set is persisted. The
	// mark comes off with the live row now. This is the whole delete -> restore -> delete
	// cycle the batch advertises, measured on the peer.
	await A.page.evaluate((s) => window.__t.S.sharedLibrary.deleteFolderToBin(s.folder), seed);
	await h.eventually(
		() =>
			B.page.evaluate((s) => {
				const t = window.__t;
				const f = t.folders().find((x) => x.id === s.folder);
				return {
					folder: f ? { share: f.share ?? null, wasShared: !!f.wasShared } : null,
					visible: t.items().filter((i) => i.hash === s.one || i.hash === s.two).length,
					rows: t.log().length
				};
			}, seed),
		(v) => v.folder === null && v.visible === 0 && v.rows === 3,
		'a SECOND deletion of the same folder applies on the peer too: the record is gone again (no wasShared ghost), both files hidden, three rows',
		30000
	);

	// ---- 6. A SHARED SCENE FILE IS NOT A PRIVATE ONE -------------------------------------
	//
	// R22 round 36 (user), a separate fix in the same batch: "files were shared to peers and
	// appeared in their Library, but opening still shows Edit privately". `sceneNameShared`
	// asked only the manifest's own scene rows and the names this session had saved or
	// opened — and a .tpscene that rode the SHARED INDEX is on every peer's disk, under its
	// name, without ever touching either. The privacy ask then offered to withhold a name
	// that had already left the machine, which is a promise it could not keep.
	//
	// Single page, on A, and the index is read where our OWN `mine` rows land, so no peer is
	// needed for the reading even though one is connected by now.
	const scenes = await A.page.evaluate(async () => {
		const { S, bytes, settle } = window.__t;
		const shared = await S.explorer.addItemFromBytes(bytes('{"scene":"arena"}'), 'Arena.tpscene', null);
		const kept = await S.explorer.addItemFromBytes(bytes('{"scene":"other"}'), 'Other.tpscene', null);
		await settle(400);
		S.sharedLibrary.shareItem(shared.id);
		return { shared: shared.id, kept: kept.id };
	});
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				const rows = window.__t.doc().items ?? [];
				return rows.filter((r) => r && r.kind === 'scene').map((r) => r.name);
			}),
		(v) => v.includes('Arena.tpscene'),
		'premise: the shared .tpscene reached the index as an ordinary kind-scene row',
		20000
	);
	const verdicts = await A.page.evaluate(() => ({
		shared: window.__stores.projectManifest.sceneNameShared('Arena'),
		kept: window.__stores.projectManifest.sceneNameShared('Other'),
		// the name is matched with the extension stripped, because that is the form
		// `currentLevel` holds and the form the ask is asked about
		withExt: window.__stores.projectManifest.sceneNameShared('Arena.tpscene')
	}));
	h.check(
		verdicts.shared === true,
		`a scene whose FILE is already on every peer answers "shared" — no privacy left to offer (${verdicts.shared})`
	);
	h.check(
		verdicts.kept === false,
		`...and one that never left this device still answers "private" (${verdicts.kept})`
	);
	h.check(
		verdicts.withExt === false,
		`the row is matched on the bare scene NAME, which is what currentLevel holds (${verdicts.withExt})`
	);

	await h.finish(browser);
});
