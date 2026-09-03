// R22 ROUND 13 P3 — MOUNTED PROJECT VOLUMES: MOUNTING, AND WHAT A MOUNT MUST NOT MOVE.
//
//   "Load for session button should stay, it replace entire project, mount button is a
//    new button... it would likely be better to be able to mount/unmount multiple
//    projects and have them above 'Library' with save icon and x icon, so current open
//    project memory is not affected."
//
// A mount is a saved PROJECT session browsed as its own root. The whole design rests on
// one decision — a volume lives in its OWN namespace and never in `explorerItems` — so
// most of this suite measures things that are supposed to be true BY CONSTRUCTION. Which
// is exactly why they are measured: "by construction" is a claim about code that has not
// been read since, and three of these invariants (the shared index, `itemByHash`, the live
// library) are the ones a hash-addressed library cannot survive losing.
//
// §3 carries the batch's one replication rule and proves it BOTH ways: the published
// document is byte-identical with a volume mounted, AND the same check is run against an
// in-page COUNTERFACTUAL that puts the volume's rows into `explorerItems` — which changes
// the document, so the assertion cannot pass vacuously.
//
// THE SPLIT (round 13). This file is the MOUNTING half: the namespace parse, mounting
// through the Explorer's own picker, the invariants, navigating, the columns measurement,
// several volumes, reload survival, unmount, the Sessions manager's Mount button, and the
// mounts section's own chrome — the pinned entry point, the .tp import row and the picker's
// height ceiling. EDITING a mounted volume — P3b's buffered edits, save-back, copy in and
// out, and the dirty-unmount flow — is `explorer-mounts-edit`.
//
// The two were one file until it ran past the runner's 8-minute per-suite budget
// (tests/e2e/run.cjs) and was killed mid-run at 480s with every executed check green. The
// section NUMBERS are the undivided file's, kept so a reader can put the two halves back
// beside the original; §17-§19 sit after §20 here because they need the projects §20 saves.
//
// Premise traps paid for up front:
//  · ContextMenu rows are `[role=menuitem]` DIVs, not buttons.
//  · A portaled menu closes on POINTERDOWN, not on a plain click, and while open it
//    shields every later click.
//  · The Sessions manager is a NON-modal dialog — it must be closed again or it sits over
//    the Explorer.
//  · `#session-save-confirm` needs a name in `#session-save-name`; two projects with the
//    same name are indistinguishable in the picker.
//
// Run: APP_URL='https://localhost:5205/' npm run e2e -- explorer-mounts
const h = require('./helpers.cjs');

/** the mounted volumes, flattened to what the assertions read */
const vols = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((r) => ({
			id: r.id,
			sessionId: r.sessionId,
			name: r.name,
			folders: (r.folders ?? []).map((f) => f.name).sort(),
			items: (r.items ?? []).map((i) => i.name).sort(),
			itemIds: (r.items ?? []).map((i) => i.id),
			hashes: (r.items ?? []).map((i) => i.hash),
			sizes: (r.items ?? []).map((i) => i.size),
			buffered: (r.items ?? []).filter((i) => !!i.blob).length,
			dirty: !!r.dirty,
			missing: !!r.missing
		}));
	});

/** the LIVE library, as one comparable string — the thing a mount must never move */
const librarySnapshot = (p) =>
	p.page.evaluate(() => {
		const e = window.__stores.explorer;
		const read = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v ?? [];
		};
		return JSON.stringify({
			folders: read(e.explorerFolders),
			items: read(e.explorerItems),
			hidden: read(e.hiddenItems)
		});
	});

/** the shared index as the project document carries it */
const sharedIndex = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return JSON.stringify({ folders: m.folders ?? [], items: m.items ?? [] });
	});

const cards = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('.ex-cards .explorer-card, .ex-cards .explorer-folder-card')].map(
			(el) => ({
				id: el.getAttribute('data-card-id'),
				name: el.innerText.trim(),
				mount: !!el.querySelector('.explorer-mount-dot')
			})
		)
	);

const listRows = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('.ex-row')].map((r) => ({
			id: r.getAttribute('data-card-id'),
			cells: [...r.querySelectorAll('td[data-col]')].map((td) => td.innerText.trim()),
			mount: !!r.querySelector('.explorer-mount-dot')
		}))
	);

const menuRows = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => el.innerText.trim()).filter(Boolean)
	);

const crumbs = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('#explorer-tree')].length
			? [...document.querySelectorAll('.ex-topbar button, [class*="border-b"] button')].length
			: 0
	);

const activeFolderOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
		return v;
	});

const toasts = (p) =>
	p.page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.innerText.trim()));

const clearToasts = (p) => p.page.evaluate(() => window.__stores.toastStore.set([]));

/** close any open portaled menu with a REAL pointerdown */
async function closeMenu(page) {
	await page.mouse.move(6, 320);
	await page.mouse.down();
	await page.mouse.up();
	await page.waitForTimeout(200);
}

/** save the CURRENT scene+library as a project, through the real Sessions UI */
async function saveProject(p, name) {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(900);
	await p.page.locator('#session-save-project').click();
	await p.page.waitForTimeout(400);
	await p.page.locator('#session-save-name').fill(name);
	await p.page.locator('#session-save-confirm').click();
	await h.eventually(
		() =>
			p.page.evaluate(() => {
				let v;
				window.__stores.sessions.sessions.subscribe((x) => (v = x))();
				return (v ?? []).map((m) => m.name);
			}),
		(names) => names.includes(name),
		'the project "' + name + '" is saved',
		25000
	);
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await p.page.waitForTimeout(500);
}

/** mount a saved project through the Explorer's own picker */
async function mountThroughUi(p, name) {
	await p.page.locator('#explorer-mount-add').click();
	// the picker AWAITS loadSessions(), which reads every saved payload in full — with a
	// real project's blobs in there that is comfortably longer than any fixed sleep
	await p.page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await p.page.waitForTimeout(300);
	const rows = await menuRows(p);
	const row = rows.find((r) => r.startsWith(name));
	if (!row) throw new Error('the mount picker did not offer "' + name + '": ' + JSON.stringify(rows));
	await p.page.locator('[role=menuitem]', { hasText: name }).first().click();
	// mounting reads the whole saved payload out of idb (blobs included), so wait on the
	// STORE rather than on a sleep
	await h.eventually(
		() => vols(p),
		(list) => list.some((v) => v.name === name),
		'"' + name + '" is mounted',
		20000
	);
	await p.page.waitForTimeout(400);
	return rows;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(
		() => !!window.__stores?.mountedVolumes && !!window.__stores?.explorer && !!window.__stores?.sessions,
		null,
		{ timeout: 30000 }
	);
	h.check(true, 'premise: the mountedVolumes leaf is on the debug hook');

	// a clean library, a scene worth saving, and three files with DISTINCT bytes (the
	// library is content-hash addressed — two identical fixtures are ONE item)
	await page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.loadExplorer();
		await s.explorer.clearLibrary();
		for (const v of await new Promise((r) => {
			s.mountedVolumes.mountedVolumes.subscribe((x) => r(x ?? []))();
		}))
			await s.mountedVolumes.unmountVolume(v.id);
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(1400);
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		window.__stores.objectActions.deselectObject();
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const props = e.createFolder('Props', null);
		const nested = e.createFolder('Crates', props.id);
		await e.addItemFromBytes(enc('a'.repeat(400)), 'notes.txt', null);
		await e.addItemFromBytes(enc('b'.repeat(700)), 'crate.txt', nested.id);
		await e.addItemFromBytes(enc('c'.repeat(1100)), 'barrel.txt', props.id);
	});
	await page.waitForTimeout(700);

	// ---- 1. the pure namespace parse (no DOM at all) ---------------------------------
	const pure = await page.evaluate(() => {
		const m = window.__stores.mountedVolumes;
		const root = m.volumeOf('vol:abc');
		const inner = m.volumeOf('vol:abc:folder-1');
		return {
			libraryRoot: m.volumeOf(null),
			plainFolder: m.volumeOf('e7f6c1a2-0000-4000-8000-000000000001'),
			prefabs: m.volumeOf('prefabs'),
			pack: m.volumeOf('pack:default'),
			scene: m.volumeOf('scene:audio'),
			deleted: m.volumeOf('deleted'),
			rootVol: root && root.volumeId,
			rootFolder: root && root.folderId,
			innerVol: inner && inner.volumeId,
			innerFolder: inner && inner.folderId,
			roundTripRoot: m.volumeKey('abc'),
			roundTripInner: m.volumeKey('abc', 'folder-1'),
			// a folder id containing a colon must survive: the parse slices at the FIRST one
			odd: m.volumeOf('vol:abc:a:b')
		};
	});
	h.check(pure.libraryRoot === null, 'volumeOf(null) is the library, not a mount');
	h.check(pure.plainFolder === null, 'a plain library folder id is not a mount');
	h.check(
		pure.prefabs === null && pure.pack === null && pure.scene === null && pure.deleted === null,
		'none of the existing pseudo locations parse as a mount (prefabs/pack/scene/deleted)'
	);
	h.check(pure.rootVol === 'abc' && pure.rootFolder === null, 'vol:<id> is the volume ROOT');
	h.check(
		pure.innerVol === 'abc' && pure.innerFolder === 'folder-1',
		'vol:<id>:<folderId> is one folder inside it'
	);
	h.check(
		pure.roundTripRoot === 'vol:abc' && pure.roundTripInner === 'vol:abc:folder-1',
		'volumeKey is volumeOf inverted'
	);
	h.check(
		pure.odd && pure.odd.volumeId === 'abc' && pure.odd.folderId === 'a:b',
		`a folder id with a colon in it survives the parse (${pure.odd && pure.odd.folderId})`
	);

	// ---- 2. save a project, then mount it through the real UI ------------------------
	await saveProject(A, 'Depot');
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	h.check(await page.locator('#explorer-mounts').isVisible(), 'the mounts section is rendered');
	h.check(
		await page.locator('#explorer-mount-add').isVisible(),
		'…with the "＋ Mount project…" row as its entry point'
	);
	// the mounts block sits ABOVE the Library row, which is the ask
	const order = await page.evaluate(() => {
		const mounts = document.querySelector('#explorer-mounts');
		const lib = document.querySelector('#explorer-root-row');
		if (!mounts || !lib) return null;
		return {
			mountsTop: Math.round(mounts.getBoundingClientRect().top),
			libTop: Math.round(lib.getBoundingClientRect().top)
		};
	});
	h.check(
		!!order && order.mountsTop < order.libTop,
		`the mounts section is ABOVE the Library row (${order && order.mountsTop} < ${order && order.libTop})`
	);

	// THE LIBRARY, before anything is mounted. Every later comparison is against this.
	const libBefore = await librarySnapshot(A);
	const offered = await mountThroughUi(A, 'Depot');
	h.check(
		offered.some((r) => r.startsWith('Depot')),
		`the picker lists the saved PROJECT (${offered.join(' | ')})`
	);
	let list = await vols(A);
	h.check(list.length === 1, `one volume is mounted (${list.length})`);
	h.check(list[0].name === 'Depot', `it carries the project's name (${list[0].name})`);
	h.check(
		list[0].items.join(',') === 'barrel.txt,crate.txt,notes.txt',
		`with all three files (${list[0].items.join(',')})`
	);
	h.check(
		list[0].folders.join(',') === 'Crates,Props',
		`and both folders (${list[0].folders.join(',')})`
	);
	h.check(
		list[0].sizes.every((n) => n > 0),
		`every row has a real size, read off its Blob (${list[0].sizes.join(',')})`
	);
	h.check(
		list[0].itemIds.every((id) => id.startsWith('vitem:')) &&
			new Set(list[0].itemIds).size === 3,
		'ids are MINTED here (a session library row carries none) and unique'
	);
	h.check(list[0].buffered === 0, 'a read-only mount duplicates NO bytes — it resolves them by hash');
	h.check(
		await page.locator(`[data-mount="${list[0].id}"]`).isVisible(),
		'the volume has a row in the tree'
	);
	h.check(
		await page.locator(`#mount-save-${list[0].id}`).isDisabled(),
		'its Save button is DISABLED while nothing is dirty'
	);
	h.check(
		await page.locator(`#mount-unmount-${list[0].id}`).isVisible(),
		'…and its ✕ is there beside it'
	);

	// ---- 3. THE INVARIANTS a hash-addressed library cannot survive losing ------------
	h.check(
		(await librarySnapshot(A)) === libBefore,
		'MOUNTING MOVED NOTHING: explorerItems / explorerFolders / hiddenItems are byte-identical'
	);

	// a hash the VOLUME holds and the library does not. Clearing the library first is what
	// makes this a real test rather than a coincidence of the two holding the same files.
	await page.evaluate(() => window.__stores.explorer.clearLibrary());
	await page.waitForTimeout(500);
	const hashProbe = await page.evaluate(() => {
		const s = window.__stores;
		let v;
		s.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		const hashes = (v[0].items ?? []).map((i) => i.hash);
		return {
			hashes: hashes.length,
			byHash: hashes.map((x) => s.explorer.itemByHash(x)).filter(Boolean).length,
			libraryItems: (() => {
				let n;
				s.explorer.explorerItems.subscribe((x) => (n = x))();
				return n.length;
			})(),
			volumeStillThere: (v[0].items ?? []).length
		};
	});
	h.check(hashProbe.libraryItems === 0, 'premise: the library is now EMPTY');
	h.check(
		hashProbe.volumeStillThere === 3,
		`…while the mount still holds its three files (${hashProbe.volumeStillThere})`
	);
	h.check(
		hashProbe.byHash === 0,
		`itemByHash resolves NONE of the volume's ${hashProbe.hashes} hashes — the one-item-per-hash invariant is untouched`
	);

	// THE PUBLISH RULE. Share a real library file so the index is genuinely in use, then
	// prove the volume contributes nothing to it.
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const item = await e.addItemFromBytes(enc('shared'.repeat(30)), 'shared.txt', null);
		window.__stores.sharedLibrary.shareItem(item.id);
		window.__stores.sharedLibrary.publishMine(true);
	});
	await page.waitForTimeout(600);
	const indexWithMount = await sharedIndex(A);
	const counterfactual = await page.evaluate(() => {
		const s = window.__stores;
		let vol;
		s.mountedVolumes.mountedVolumes.subscribe((x) => (vol = x))();
		let before;
		s.projectManifest.projectManifest.subscribe((m) => (before = m))();
		const doc = (m) => JSON.stringify({ folders: m.folders ?? [], items: m.items ?? [] });
		const was = doc(before);
		// THE COUNTERFACTUAL: put the mount's rows into the library and share them, which is
		// what "the namespace is what keeps them out" claims cannot happen. If the check
		// above could not fail, this would leave the document unchanged too.
		const rows = (vol[0].items ?? []).map((i, n) => ({
			id: 'fake-' + n,
			name: i.name,
			kind: i.kind,
			folderId: null,
			size: i.size,
			hash: i.hash,
			thumbnail: null,
			createdAt: Date.now(),
			share: 'mine'
		}));
		let live;
		s.explorer.explorerItems.subscribe((x) => (live = x))();
		s.explorer.explorerItems.set([...live, ...rows]);
		s.sharedLibrary.publishMine(true);
		let after;
		s.projectManifest.projectManifest.subscribe((m) => (after = m))();
		const now = doc(after);
		// UNDO IT PROPERLY. Taking the rows back out of the library is not enough: the
		// publisher carries forward any row it holds no record for (that is what makes a
		// peer's file safe from our publish), so removing them locally would leave them in
		// the document for good. A tombstone is the only thing that removes a shared row,
		// which is what unshareHash is for.
		s.explorer.explorerItems.set(live);
		for (const r of rows) s.sharedLibrary.unshareHash(r.hash);
		s.sharedLibrary.publishMine(true);
		let restored;
		s.projectManifest.projectManifest.subscribe((m) => (restored = m))();
		return { was, now, restored: doc(restored), added: rows.length };
	});
	h.check(
		counterfactual.was === indexWithMount,
		'the shared index is byte-identical with a volume mounted'
	);
	h.check(
		counterfactual.now !== counterfactual.was,
		`COUNTERFACTUAL: the same ${counterfactual.added} rows placed in the LIBRARY do change the document — so the check above can fail`
	);
	h.check(
		counterfactual.restored === counterfactual.was,
		'…and unsharing them again brings the document back to exactly what it was'
	);

	// ---- 4. navigating a mount -------------------------------------------------------
	list = await vols(A);
	const volId = list[0].id;
	const volFolders = await page.evaluate(() => {
		let v;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		return (v[0].folders ?? []).map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }));
	});
	const props = volFolders.find((f) => f.name === 'Props');
	const crates = volFolders.find((f) => f.name === 'Crates');
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + volId);
	await page.waitForTimeout(700);
	let grid = await cards(A);
	h.check(
		grid.some((c) => c.name.includes('notes.txt')) && !grid.some((c) => c.name.includes('shared.txt')),
		`the volume ROOT shows its own files and none of the library's (${grid.map((c) => c.name).join(',')})`
	);
	h.check(
		grid.some((c) => c.name.includes('Props')),
		'…and its own folders as cards'
	);
	h.check(
		grid.filter((c) => c.id && c.id.startsWith('vitem:')).every((c) => c.mount),
		'every mounted FILE card carries the mount badge'
	);
	await page.evaluate(
		({ key }) => window.__stores.explorer.activeFolder.set(key),
		{ key: 'vol:' + volId + ':' + crates.id }
	);
	await page.waitForTimeout(600);
	grid = await cards(A);
	h.check(
		grid.length === 1 && grid[0].name.includes('crate.txt'),
		`a nested volume folder shows exactly its own file (${grid.map((c) => c.name).join(',')})`
	);
	const trail = await page.evaluate(() =>
		[...document.querySelectorAll('#explorer-crumbs button')]
			.map((b) => b.innerText.trim())
			.filter(Boolean)
	);
	h.check(
		trail.includes('Depot') && trail.includes('Crates') && !trail.includes('Library'),
		`the breadcrumb names the PROJECT, never "Library" (${trail.join(' / ')})`
	);
	// up walks the volume's own tree, then leaves for the library
	let where = await page.evaluate(() => {
		const el = document.querySelector('#explorer-grid');
		el?.focus();
		return true;
	}).then(async () => {
		await page.keyboard.press('Backspace');
		await page.waitForTimeout(500);
		return activeFolderOf(A);
	});
	h.check(
		where === 'vol:' + volId + ':' + props.id,
		`up from Crates lands in Props, inside the same mount (${where})`
	);

	// ---- 5. the columns decision, MEASURED ------------------------------------------
	await page.locator('#explorer-view-list').click();
	await page.waitForTimeout(600);
	const rows = await listRows(A);
	const cols = await page.evaluate(() =>
		[...document.querySelectorAll('.ex-table thead th[data-col], .ex-table th[data-col]')].map((th) =>
			th.getAttribute('data-col')
		)
	);
	h.check(
		cols.join(',') === 'name,kind,size,added,owner' || cols.length >= 4,
		`a mount reuses the LIBRARY column set (${cols.join(',')})`
	);
	const row = rows.find((r) => r.id && r.id.startsWith('vitem:'));
	h.check(!!row, 'a mounted file draws a list row');
	h.check(
		!!row && row.mount,
		'…carrying the mount dot (a row has no corners, so the status folds into one dot)'
	);
	h.check(
		!!row && row.cells[0].includes('barrel.txt') && /B|KB/.test(row.cells[2]),
		`name and SIZE read properly (${row && row.cells.join(' | ')})`
	);
	h.check(
		!!row && row.cells[3] === '—' && row.cells[4] === '—',
		`THE MEASUREMENT behind reusing the set: only "added" and "owner" have nothing to say, and they read as a gap rather than as something WRONG (${row && row.cells.slice(3).join(' | ')})`
	);
	await page.locator('#explorer-view-thumbnails').click().catch(() => {});
	await page.waitForTimeout(400);

	// ---- 6. a mount answers no library operation ------------------------------------
	await page.evaluate(
		({ key }) => window.__stores.explorer.activeFolder.set(key),
		{ key: 'vol:' + volId }
	);
	await page.waitForTimeout(500);
	const card = await page.locator('.ex-cards [data-card-id^="vitem:"]').first();
	const box = await card.boundingBox();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
	await page.waitForTimeout(600);
	const itemMenu = await menuRows(A);
	await closeMenu(page);
	h.check(
		itemMenu.includes('Open') &&
			itemMenu.includes('Properties') &&
			itemMenu.includes('Copy to Library'),
		`a mounted file's menu offers what works (${itemMenu.join(' | ')})`
	);
	h.check(
		itemMenu.includes('Rename') && itemMenu.includes('Remove'),
		'…including P3b\'s buffered edits'
	);
	h.check(
		!itemMenu.some((r) => /^Share/.test(r)) && !itemMenu.includes('Add to pack'),
		'…and NOT Share or Add to pack, which address a library record it has none of'
	);

	// THE GUARD PROVEN BY BREAKING IT (see the report): a folder made inside a mount is a
	// BUFFERED row in the volume, and must never be a LIBRARY folder parented to a 'vol:…'
	// key — that one is an orphan, drawn nowhere and reachable by nothing.
	const foldersBefore = await page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerFolders.subscribe((x) => (v = x))();
		return v.length;
	});
	await clearToasts(A);
	await page.locator('#new-folder').click();
	await page.waitForTimeout(500);
	// THE INLINE EDIT HAS TO BE COMMITTED for this to measure anything: `startCreate` only
	// opens an editor. With the conversion removed, the edit carries a 'vol:…' parentId, no
	// row in either tree matches it so nothing is even drawn, and the folder appears in the
	// LIBRARY the moment anything settles the edit — measured that way (1 orphan).
	await page.keyboard.press('Enter');
	await page.waitForTimeout(700);
	const afterNewFolder = await page.evaluate(() => {
		const s2 = window.__stores;
		let lib;
		s2.explorer.explorerFolders.subscribe((x) => (lib = x))();
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const vol = mv[0];
		return {
			n: lib.length,
			orphans: lib.filter((f) => String(f.parentId ?? '').startsWith('vol:')).length,
			volFolders: (vol?.folders ?? []).map((f) => f.name),
			dirty: !!vol?.dirty
		};
	});
	h.check(
		afterNewFolder.orphans === 0 && afterNewFolder.n === foldersBefore,
		`New folder inside a mount touches the LIBRARY not at all — no orphan parented to a 'vol:' key (${afterNewFolder.n} folders, ${afterNewFolder.orphans} orphans)`
	);
	h.check(
		afterNewFolder.volFolders.includes('New folder'),
		`…it lands in the VOLUME instead (${afterNewFolder.volFolders.join(', ')})`
	);
	h.check(afterNewFolder.dirty, '…and the mount is dirty, because nothing has reached disk yet');
	// put it back: later sections compare this volume against its saved record
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		await window.__stores.mountedVolumes.refreshVolume(mv[0].id);
	});
	await page.waitForTimeout(600);
	const afterRefresh = await page.evaluate(() => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		return { dirty: !!mv[0].dirty, folders: (mv[0].folders ?? []).map((f) => f.name).sort() };
	});
	h.check(
		!afterRefresh.dirty && !afterRefresh.folders.includes('New folder'),
		`Refresh discards the buffer and re-reads the saved project (${afterRefresh.folders.join(', ')})`
	);

	// ---- 7. several volumes coexist -------------------------------------------------
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		const enc = (t) => new TextEncoder().encode(t).buffer;
		await e.addItemFromBytes(enc('second'.repeat(50)), 'second-only.txt', null);
	});
	await page.waitForTimeout(400);
	await saveProject(A, 'Annex');
	await page.waitForTimeout(400);
	await mountThroughUi(A, 'Annex');
	list = await vols(A);
	h.check(list.length === 2, `two volumes are mounted at once (${list.map((v) => v.name).join(', ')})`);
	const annex = list.find((v) => v.name === 'Annex');
	const depot = list.find((v) => v.name === 'Depot');
	h.check(
		!!annex && annex.items.includes('second-only.txt') && !depot.items.includes('second-only.txt'),
		'each volume holds its OWN files — they do not pool'
	);
	h.check(
		annex.id !== depot.id && annex.sessionId !== depot.sessionId,
		'…with their own ids and their own source records'
	);
	// the same project twice is refused rather than mounted twice: two roots over one file
	// would each buffer edits and the second save would silently overwrite the first
	await clearToasts(A);
	const twice = await page.evaluate(
		async (sessionId) => {
			await window.__stores.mountedVolumes.mountVolume(sessionId);
			let v;
			window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
			return v.length;
		},
		depot.sessionId
	);
	h.check(twice === 2, `mounting the same project twice is refused (${twice} volumes)`);
	h.check(/already mounted/i.test((await toasts(A)).join(' ')), '…with the reason');

	// ---- 8. a mount survives a reload ----------------------------------------------
	const libBeforeReload = await librarySnapshot(A);
	// PREMISE, and it used to be a flake: what comes back after a reload is the idb RECORD,
	// so read it before reloading rather than inferring durability from the store
	// note: h.eventually RECORDS a check and returns its verdict, not the value — read the
	// record again for the assertion below
	await h.eventually(
		() =>
			page.evaluate(async () => {
				const rec = await window.__stores.idb.idbGet('explorer:mounts');
				return (rec ?? []).map((v) => v.name).sort();
			}),
		(names) => names.length === 2,
		'both mounts are PERSISTED, not just in the store',
		15000
	);
	const stored = await page.evaluate(async () => {
		const rec = await window.__stores.idb.idbGet('explorer:mounts');
		return (rec ?? []).map((v) => v.name).sort();
	});
	h.check(
		stored.join(',') === 'Annex,Depot',
		'the idb record holds both (' + stored.join(',') + ')'
	);
	await h.freshReload(A);
	await page.waitForFunction(() => !!window.__stores?.mountedVolumes, null, { timeout: 30000 });
	await page.evaluate(() => window.__stores.mountedVolumes.loadMountedVolumes());
	await page.waitForTimeout(1200);
	const afterReload = await vols(A);
	h.check(
		afterReload.length === 2,
		`both mounts come back after a reload (${afterReload.map((v) => v.name).join(', ')})`
	);
	// Depot was saved with three files; Annex was saved AFTER §3 cleared the library, so it
	// holds the two that existed then — the numbers are the fixtures', not a rule
	h.check(
		afterReload.every((v) => v.items.length === (v.name === 'Annex' ? 2 : 3)),
		`…with their file rows intact (${afterReload.map((v) => v.name + ':' + v.items.length).join(', ')})`
	);
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.waitForTimeout(600);
	h.check(
		(await librarySnapshot(A)) === libBeforeReload,
		'and the live library is still byte-identical across the reload'
	);

	// ---- 9. unmount, and a source that has gone ------------------------------------
	await page.locator('#explorer-slot').click().catch(() => {});
	await page.waitForTimeout(700);
	const reDepot = (await vols(A)).find((v) => v.name === 'Depot');
	await page.locator(`#mount-unmount-${reDepot.id}`).click();
	await page.waitForTimeout(700);
	list = await vols(A);
	h.check(
		list.length === 1 && list[0].name === 'Annex',
		`✕ unmounts exactly that volume and leaves the other (${list.map((v) => v.name).join(', ')})`
	);
	// the sessions list is populated by `loadSessions`, and this page has been reloaded
	// since the last one — an empty store here would say "the project is gone" about a
	// store nobody has filled
	const sessionsStillThere = await page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).map((m) => m.name);
	});
	h.check(
		sessionsStillThere.includes('Depot'),
		`unmounting DELETED NOTHING — the saved project is still there (${sessionsStillThere.join(', ')})`
	);

	// fork 3: the source record can be deleted from the Sessions manager. A mount whose
	// source has gone is marked UNAVAILABLE rather than dropped.
	const annexNow = (await vols(A))[0];
	await page.evaluate(
		async (id) => window.__stores.sessions.deleteSession(id),
		annexNow.sessionId
	);
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.mountedVolumes.revalidateVolumes());
	await page.waitForTimeout(600);
	const gone = await vols(A);
	h.check(
		gone.length === 1 && gone[0].missing,
		'a mount whose saved project is gone is marked unavailable, not silently dropped'
	);
	h.check(
		gone[0].items.length === 2,
		`…and its rows are still readable (${gone[0].items.length} files)`
	);


	// nothing may be mounted when section 20 starts: it asserts that clicking Mount in the
	// Sessions manager leaves exactly ONE volume, and section 9 deliberately leaves a
	// missing-source mount behind. In the undivided suite the editing sections between
	// these two did this cleanup on their way past.
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await window.__stores.mountedVolumes.unmountVolume(v.id);
		window.__stores.explorer.activeFolder.set(null);
	});
	await page.waitForTimeout(500);

	// ---- 20. MOUNT FROM THE SESSIONS MANAGER ----------------------------------------
	// The user asked for this button beside Load, and the pair IS the feature: Load
	// REPLACES the open project, Mount ADDS this one beside it. Goes after every section
	// that reasons about a saved record, and saves under its own names, because a section
	// that saves perturbs every premise above it — and because the picker sections below
	// it want exactly the projects it adds. Re-uses librarySnapshot rather than a second
	// reader, so "untouched" means here exactly what it means in section 1.
	// ---------------------------------------------------------------------------------
	const sBefore = await librarySnapshot(A);
	const savedNamesNow = () =>
		page.evaluate(() => {
			let v;
			window.__stores.sessions.sessions.subscribe((x) => (v = x))();
			return (v ?? []).map((m) => m.name);
		});

	await saveProject(A, 'Wharf');
	// a SCENE entry as well, so "who is offered a Mount" can be read off the two kinds.
	// Same shape as saveProject, waiting on the STORE rather than a fixed sleep - a save
	// that silently did not happen would otherwise show up later as a missing row.
	await page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await page.waitForTimeout(900);
	await page.locator('#session-save').click();
	await page.waitForTimeout(400);
	await page.locator('#session-save-name').fill('PlainScene');
	await page.locator('#session-save-confirm').click();
	await h.eventually(
		savedNamesNow,
		(names) => names.includes('PlainScene'),
		'premise: a plain SCENE entry is saved too',
		25000
	);

	// the view is a remembered pref and only LIST rows carry .session-row - a grid card
	// is .session-card alone, so pin the view rather than inherit whichever one a
	// previous section left behind
	await page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await page.waitForTimeout(700);
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);

	const wharfRow = page.locator('.session-row').filter({ hasText: 'Wharf' }).first();
	const sceneRow = page.locator('.session-row').filter({ hasText: 'PlainScene' }).first();
	await wharfRow.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	h.check(await wharfRow.isVisible(), 'premise: the saved project has a row in the manager');
	h.check(await sceneRow.isVisible(), 'premise: the saved scene has one too');

	const mountBtn = wharfRow.locator('.session-mount');
	h.check(await mountBtn.isVisible(), 'a PROJECT row offers Mount beside Load');

	// paired in ONE verdict on purpose: a count of 0 is also what a row that never
	// rendered returns, so the absence only means anything beside the Load that IS there
	const sceneMounts = await sceneRow.locator('.session-mount').count();
	const sceneLoads = await sceneRow.locator('.session-load').count();
	h.check(
		sceneMounts === 0 && sceneLoads === 1,
		'a SCENE row keeps Load and is offered NO Mount - it has no library, so the offer is ABSENT rather than refusing on click (load=' +
			sceneLoads +
			', mount=' +
			sceneMounts +
			')'
	);

	await mountBtn.click();
	// mountVolume awaits the idb load, the session read and the write - wait on the
	// THING, not on a guess at how long three awaits take on a loaded box
	await h.eventually(
		() => vols(A),
		(list) => list.length === 1 && list[0].name === 'Wharf',
		'clicking Mount mounts it',
		20000
	);

	h.check(
		await wharfRow.isVisible(),
		'...and the manager stays OPEN, because mounting is additive - Load closes it, Mount does not'
	);
	const mountLabel = (await mountBtn.textContent()) || '';
	h.check(
		mountLabel.includes('Mounted') && (await mountBtn.isDisabled()),
		'...the row reads Mounted and is disabled, rather than offering a click that would refuse (' +
			mountLabel.trim() +
			')'
	);

	const sAfter = await librarySnapshot(A);
	h.check(
		sAfter === sBefore,
		'...and the open library is untouched - a mount is not a load (' +
			(sAfter === sBefore ? 'identical' : 'CHANGED') +
			')'
	);
	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(400);

	// and nothing may be mounted when section 17 starts either: it counts the volume ROWS,
	// and section 20 leaves the project it mounted behind. The two it then mounts are the
	// two saved PROJECTS this file has made — Depot in section 2 and Wharf in section 20 —
	// where the undivided suite reached for Yard, which the editing half now owns.
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await window.__stores.mountedVolumes.unmountVolume(v.id);
	});
	await page.waitForTimeout(600);

	// ---- 17. the "＋ Mount project…" row is pinned to the TOP of the group -----------
	// User: "'mount project...' button should be always on top of mounted projects in
	// Explorer". It used to be the LAST child, so it moved on every mount and unmount and,
	// past a few volumes, sat below the fold of a scrolling section.
	// ---------------------------------------------------------------------------------
	for (const name of ['Wharf', 'Depot']) {
		const meta = await page.evaluate(async (n) => {
			await window.__stores.sessions.loadSessions();
			let v;
			window.__stores.sessions.sessions.subscribe((x) => (v = x))();
			return (v ?? []).find((m) => m.name === n && m.hasLibrary)?.id ?? null;
		}, name);
		if (meta) await page.evaluate((id) => window.__stores.mountedVolumes.mountVolume(id), meta);
	}
	await h.eventually(() => vols(A), (l) => l.length === 2, 'premise: two projects are mounted', 20000);
	await page.waitForTimeout(500);
	const pinned = await page.evaluate(() => {
		const section = document.querySelector('#explorer-mounts');
		const add = document.querySelector('#explorer-mount-add');
		const rows = [...document.querySelectorAll('[data-mount]')];
		return {
			first: section?.firstElementChild === add,
			addTop: Math.round(add.getBoundingClientRect().top),
			rowTops: rows.map((r) => Math.round(r.getBoundingClientRect().top)),
			rows: rows.length,
			listScrolls: getComputedStyle(document.querySelector('#explorer-mount-list')).overflowY
		};
	});
	h.check(pinned.rows === 2, `premise: both volume rows are drawn (${pinned.rows})`);
	h.check(pinned.first, 'the add row is the FIRST child of the mounts section');
	h.check(
		pinned.rowTops.every((t) => t > pinned.addTop),
		`…and sits above every mounted project (${pinned.addTop} < ${pinned.rowTops.join(', ')})`
	);
	// the SECTION no longer scrolls; the LIST does. That is what keeps the button in place
	// once the list is longer than its ceiling — `mountListMax`, which is 140 on a roomy
	// column and less on a short one so the Library below keeps its floor
	// (`explorer-tree-floor` owns that rule).
	h.check(
		pinned.listScrolls === 'auto',
		`the volume LIST owns the scroller, so a long list cannot carry the entry point away (${pinned.listScrolls})`
	);

	// ---- 18. the picker offers the .tp import ---------------------------------------
	// User: "'mount project...' context should also have import project option", and then:
	// "it should automatically also mount this session file, not just import (do not change
	// 'Import project (.tp)…' text in context menu)". So the row is no longer the
	// furnish-a-folder path: it reads the file into a saved PROJECT (importProjectAsSession)
	// and mounts that, which is the only thing a mount can read. THIS section still owns the
	// picker's SHAPE — the row exists, under its own heading, and opens a real .tp-only file
	// picker; the outcome (imported, mounted, walked into, Library untouched) is
	// `sessions-open` §6, where the bytes to feed it exist.
	// ---------------------------------------------------------------------------------
	await page.locator('#explorer-mount-add').click();
	await page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await page.waitForTimeout(300);
	const pickerRows = await menuRows(A);
	h.check(
		pickerRows.some((r) => r.startsWith('Depot')),
		`premise: the picker still lists the projects (${pickerRows.join(' | ')})`
	);
	h.check(
		pickerRows.some((r) => /Import project/i.test(r)),
		'…and offers Import project (.tp)…'
	);
	const sections = await page.evaluate(() =>
		[...document.querySelectorAll('[role=menu] *')]
			.map((el) => el.textContent.trim())
			.filter((t) => t === 'From a file').length
	);
	h.check(sections > 0, '…under its own heading, so it does not read as another project to mount');
	const [chooser] = await Promise.all([
		page.waitForEvent('filechooser', { timeout: 10000 }),
		page.locator('[role=menuitem]', { hasText: 'Import project' }).first().click()
	]);
	h.check(!!chooser, 'clicking it opens a real file picker');
	// read the input the ROW opened, not the first one in the document: the mount picker has
	// its own now (its intent differs from the Library's merge-as-folder), and a query that
	// finds either would answer the same for both
	const accepts = await chooser.element().getAttribute('accept');
	h.check(accepts === '.tp', `…which takes .tp files and nothing else (accept=${accepts})`);
	await chooser.setFiles([]).catch(() => {});
	await closeMenu(page);


	// ---- 19. the picker is BOUNDED, however many projects there are ------------------
	// User: "'mount project...' context when there are too many items, should not expand on
	// the entire browser window, make size reasonable and we already have scrollbar in case
	// there are many items".
	//
	// Real records, written straight into idb, because `loadSessions` re-reads every
	// `session:` key on every open — seeding the STORE would be overwritten by the picker's
	// own first await. They are removed again at the end of the section.
	//
	// SIXTEEN, and the number is measured rather than picked: 16 makes the list 533px
	// tall against a 360px ceiling, which is what the readings below need. It is not more
	// because `idb.js` opens a fresh connection per `idbGet` and `loadSessions` reads every
	// record one at a time — MEASURED at ~1.1s per saved project, so 40 of them cost 43
	// seconds of picker-opening for no extra information. (That cost is the picker's own,
	// pre-existing and shared with the Sessions manager; it is noted here because it is the
	// reason this section is bounded.)
	// ---------------------------------------------------------------------------------
	const fakeIds = await page.evaluate(async () => {
		const ids = [];
		for (let i = 0; i < 16; i++) {
			const id = 'ceiling-' + i;
			ids.push(id);
			await window.__stores.idb.idbPut('session:' + id, {
				id,
				name: 'Ceiling ' + i,
				createdAt: 1000 + i,
				count: 0,
				library: { folders: [], items: [] }
			});
		}
		return ids;
	});
	await page.locator('#explorer-mount-add').click();
	// the picker AWAITS a full `loadSessions`, one idb connection per record — see above
	await page.waitForSelector('[role=menuitem]', { timeout: 120000 });
	await page.waitForTimeout(600);
	const bounded = await page.evaluate(() => {
		const menu = document.querySelector('[role=menu]');
		const box = menu.getBoundingClientRect();
		return {
			rows: menu.querySelectorAll('[role=menuitem]').length,
			height: Math.round(box.height),
			bottom: Math.round(box.bottom),
			scrollH: menu.scrollHeight,
			clientH: menu.clientHeight,
			overflow: getComputedStyle(menu).overflowY,
			vh: window.innerHeight
		};
	});
	h.check(
		bounded.rows > 14,
		`premise: the picker really is long now (${bounded.rows} rows)`
	);
	h.check(
		bounded.height <= 360,
		`…and the menu stops at a readable height instead of filling the window (${bounded.height}px of ${bounded.vh})`
	);
	h.check(
		bounded.scrollH > bounded.clientH && bounded.overflow === 'auto',
		`…with the scrollbar it already had carrying the rest (${bounded.scrollH} > ${bounded.clientH}, overflow-y ${bounded.overflow})`
	);
	h.check(
		bounded.bottom <= bounded.vh,
		`…and it still ends inside the viewport (${bounded.bottom} <= ${bounded.vh})`
	);
	await closeMenu(page);
	// THE DIFFERENTIAL, so the reading above cannot be "every menu happens to be short":
	// the Explorer background menu takes no ceiling and is still allowed the full window.
	await page.evaluate(() => {
		const grid = document.querySelector('#explorer-grid');
		const box = grid.getBoundingClientRect();
		grid.dispatchEvent(new MouseEvent('contextmenu', {
			bubbles: true,
			clientX: Math.round(box.left + 40),
			clientY: Math.round(box.top + 40)
		}));
	});
	await page.waitForTimeout(500);
	const uncapped = await page.evaluate(() => {
		const menu = document.querySelector('[role=menu]');
		if (!menu) return null;
		return { max: getComputedStyle(menu).maxHeight, vh: window.innerHeight };
	});
	h.check(
		!!uncapped && Math.round(parseFloat(uncapped.max)) === uncapped.vh - 8,
		`a menu with no ceiling still gets the viewport one, so the cap is this menu's and not everyone's (${uncapped && uncapped.max})`
	);
	await closeMenu(page);
	await page.evaluate(async (ids) => {
		for (const id of ids) await window.__stores.idb.idbDelete('session:' + id);
		await window.__stores.sessions.loadSessions();
	}, fakeIds);
	await page.waitForTimeout(600);
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await window.__stores.mountedVolumes.unmountVolume(v.id);
	});
	await page.waitForTimeout(500);

	// =====================================================================
	// 21. R22 round 14 — A SCENE IN A MOUNT OPENS INTO THE VIEWPORT
	// =====================================================================
	//   "why cannot open a scene from mounted project? Receiving this toast 'Copy N into
	//    your Library to open it'... wouldn't it be simple to load this scene into
	//    viewport in same way as untitled scene opens... and its not stored in library,
	//    but can be saved. IF its simple to implement it also should ask to save current
	//    changes in viewport in case they are not saved"
	//
	// The whole of this section rests on ONE premise it establishes first and never lets
	// go of: the scene it opens is in the volume and NOT in the library. That is what
	// makes the reading meaningful — the library card's opener (`travelToLevel`) is
	// addressed by content hash and resolves through `explorerItems`, so if the file were
	// in there as well, every check below would pass with the feature ripped out.
	//
	// It runs LAST, and under its own project and scene names, because it replaces the
	// world several times over and moves `currentLevel`: the documented rule that a
	// section which saves or adds objects perturbs its neighbours.
	const worldNames = (p) =>
		p.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			return (g?.children ?? []).map((c) => c.name || c.type).sort();
		});
	const at = (p) =>
		p.page.evaluate(() => {
			let v;
			window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
			return v;
		});
	const dialogOf = (p) =>
		p.page.evaluate(() => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
			return d && { title: d.title, choices: (d.choices ?? []).map((c) => c.label) };
		});
	const answerDialog = (p, value) =>
		p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);
	const volCard = (p, name) =>
		p.page.locator('.ex-cards .explorer-card').filter({ hasText: name }).first();

	// a clean slate, then a real scene worth opening and one file of another kind beside it
	await page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await page.waitForTimeout(700);
	const vaultNames = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		const enc = (t) => new TextEncoder().encode(t).buffer;
		await s.explorer.addItemFromBytes(enc('ID3'.repeat(120)), 'chime.mp3', null);
		await s.levels.saveSceneAsLevel('Vault', null);
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).map((c) => c.name || c.type).sort();
	});
	await page.waitForTimeout(900);
	h.check(vaultNames.length === 2, `premise: "Vault" is a real scene of two objects (${vaultNames.join(', ')})`);
	// "Save into session" COPIES the library into the record and leaves it standing (a
	// measured correction to this section's first draft, which assumed the save emptied
	// it) — so the live copy is cleared here by hand. That is what leaves the mount
	// holding the only copy of the scene, which the premise below turns on.
	await saveProject(A, 'Cellar');
	await page.evaluate(() => window.__stores.explorer.clearLibrary());
	await page.waitForTimeout(700);
	await mountThroughUi(A, 'Cellar');
	const cellar = (await vols(A)).find((v) => v.name === 'Cellar');
	h.check(
		!!cellar && cellar.items.includes('Vault.tpscene') && cellar.items.includes('chime.mp3'),
		`premise: the mount holds the scene and a file of another kind (${cellar && cellar.items.join(', ')})`
	);
	const vaultRow = await page.evaluate((volId) => {
		const rows = window.__stores.mountedVolumes.volumeItems(volId);
		const row = rows.find((r) => r.name === 'Vault.tpscene');
		return row && { id: row.id, hash: row.hash, kind: row.kind };
	}, cellar.id);
	const audioKind = await page.evaluate((volId) => {
		const row = window.__stores.mountedVolumes.volumeItems(volId).find((r) => r.name === 'chime.mp3');
		return row && row.kind;
	}, cellar.id);
	h.check(vaultRow?.kind === 'scene', `premise: the row's kind really is 'scene' (${vaultRow?.kind})`);
	h.check(audioKind === 'audio', `premise: and the other file is not (${audioKind})`);
	// THE PREMISE THE WHOLE SECTION STANDS ON
	const inLibrary = (p, hash) =>
		p.page.evaluate((h2) => {
			let items;
			window.__stores.explorer.explorerItems.subscribe((x) => (items = x))();
			return (items ?? []).some((i) => i.hash === h2) || !!window.__stores.explorer.itemByHash(h2);
		}, hash);
	h.check(
		!(await inLibrary(A, vaultRow.hash)),
		'premise: the scene is in the MOUNT and not in the library — so nothing here can be travel-by-hash in disguise'
	);

	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + cellar.id);
	await page.waitForTimeout(700);

	// --- it opens ---------------------------------------------------------------------
	// nothing on screen and no identity, so `sceneAtRisk` is false and the guard steps
	// aside: this measures the OPEN on its own, before the guard gets its own checks.
	await page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		s.levels.currentLevel.set(null);
	});
	await page.waitForTimeout(700);
	h.check(
		(await worldNames(A)).length === 0 && (await at(A)) === null,
		'premise: an empty world with no identity — nothing for the guard to protect'
	);
	await clearToasts(A);
	const libBeforeOpen = await librarySnapshot(A);
	await volCard(A, 'Vault.tpscene').dblclick();
	await h.eventually(
		() => worldNames(A),
		(n) => n.length === vaultNames.length,
		'THE FIX: a scene in a mounted project opens into the viewport',
		25000
	);
	h.check(
		JSON.stringify(await worldNames(A)) === JSON.stringify(vaultNames),
		`…carrying the objects the file was saved with (${(await worldNames(A)).join(', ')})`
	);
	// the objects land while `applySession` is still running, so the identity is written a
	// beat AFTER the world is full — waited for rather than read at the first sight of a
	// box (which is what the first draft did, and it read `undefined` every time)
	await h.eventually(
		() => at(A),
		(v) => !!v,
		'…and the scene gets an identity once the apply finishes',
		20000
	);
	const opened = await at(A);
	h.check(
		opened?.name === 'Vault',
		`the identity names the SCENE, not the file — and with no "(from …)" decoration, because that name is the manifest key a later save files under (${opened?.name})`
	);
	h.check(
		opened?.hash === '' && opened?.unsaved === true,
		`…and it reads UNSAVED with no hash: on screen, not a member of the project (hash="${opened?.hash}", unsaved=${opened?.unsaved})`
	);
	h.check(
		!(await inLibrary(A, vaultRow.hash)) && (await librarySnapshot(A)) === libBeforeOpen,
		'…and opening copied NOTHING into the library to make it work'
	);
	h.check(
		!(await toasts(A)).some((t) => /Copy .* into your Library/.test(t)),
		'the read-only refusal is gone for a scene'
	);
	const cellarAfter = (await vols(A)).find((v) => v.id === cellar.id);
	h.check(
		!!cellarAfter && !cellarAfter.dirty && cellarAfter.items.length === cellar.items.length,
		'…and the mount itself is untouched — reading a file out of it is not an edit'
	);

	// --- the user's second ask: it asks about unsaved work first -----------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create cone'));
	await page.waitForTimeout(1400);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(300);
	const beforeGuard = await worldNames(A);
	const identBefore = JSON.stringify(await at(A));
	h.check(beforeGuard.length === vaultNames.length + 1, `premise: real unsaved work on screen (${beforeGuard.join(', ')})`);
	await volCard(A, 'Vault.tpscene').dblclick();
	await h.eventually(
		() => dialogOf(A),
		(d) => !!d && /Vault\.tpscene/.test(d.title ?? ''),
		'THE SECOND ASK: opening it asks about the unsaved scene on screen first',
		15000
	);
	const guardDialog = await dialogOf(A);
	h.check(
		JSON.stringify(guardDialog?.choices) === JSON.stringify(['Save and open', 'Open anyway']),
		`…with the same two-way every other scene open gives (${JSON.stringify(guardDialog?.choices)})`
	);
	await answerDialog(A, false);
	await page.waitForTimeout(1200);
	h.check(
		JSON.stringify(await worldNames(A)) === JSON.stringify(beforeGuard),
		'Cancel leaves the world exactly as it was'
	);
	h.check(JSON.stringify(await at(A)) === identBefore, '…and the scene identity with it');
	const cellarCancel = (await vols(A)).find((v) => v.id === cellar.id);
	h.check(
		!!cellarCancel && !cellarCancel.dirty && cellarCancel.items.length === cellar.items.length,
		'…and the mount, which a cancelled open must not have touched either'
	);

	await volCard(A, 'Vault.tpscene').dblclick();
	await h.eventually(() => dialogOf(A), (d) => !!d, 'premise: it asks again', 15000);
	await answerDialog(A, 'open');
	await h.eventually(
		() => worldNames(A),
		(n) => JSON.stringify(n) === JSON.stringify(vaultNames),
		'"Open anyway" opens it, and the work it warned about is gone',
		25000
	);

	// --- ...but it CAN be saved -------------------------------------------------------
	// the loose-scene treatment in full: the offer is armed 1.5s after the load and fires
	// on the FIRST real edit, which is how a user meets it.
	await page.waitForTimeout(2200);
	await clearToasts(A);
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create cylinder'));
	await h.eventually(
		() => toasts(A),
		(t) => t.some((x) => /not part of your project yet/.test(x)),
		'a first edit offers to save it into the project — the same treatment a .tpscene opened off disk gets',
		20000
	);
	const saved = await page.evaluate(async () => {
		const s = window.__stores;
		let now;
		s.levels.currentLevel.subscribe((x) => (now = x))();
		// exactly what the toast's own button calls
		await s.levels.saveSceneAsLevel(now.name, null);
		let items;
		s.explorer.explorerItems.subscribe((x) => (items = x))();
		let after;
		s.levels.currentLevel.subscribe((x) => (after = x))();
		let man;
		s.projectManifest.projectManifest.subscribe((x) => (man = x))();
		return {
			names: (items ?? []).map((i) => i.name),
			after,
			scenes: Object.keys(man?.scenes ?? {})
		};
	});
	h.check(
		saved.names.includes('Vault.tpscene'),
		`saving it afterwards writes a real library file (${saved.names.join(', ')})`
	);
	h.check(
		!saved.after?.unsaved && !!saved.after?.hash,
		`…and the identity stops being unsaved, with the bytes it was saved as (unsaved=${saved.after?.unsaved})`
	);
	h.check(
		saved.scenes.includes('Vault'),
		`…filed in the project under the scene's own name, undecorated (${saved.scenes.join(', ')})`
	);

	// --- and every OTHER kind keeps the toast ------------------------------------------
	// PAIRED WITH A PRESENCE CHECK: an absence check on its own passes against a row that
	// never rendered, which is the one way this could read green while the grid is empty.
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + cellar.id);
	await page.waitForTimeout(700);
	h.check(
		(await volCard(A, 'chime.mp3').count()) === 1,
		'premise: the audio row really is on screen in the mount'
	);
	await clearToasts(A);
	const worldBeforeAudio = await worldNames(A);
	const identBeforeAudio = JSON.stringify(await at(A));
	await volCard(A, 'chime.mp3').dblclick();
	// `openVolumeItem` resolves the bytes FIRST — `volumeBlob` reads the whole saved
	// project out of idb, blobs included — so the refusal arrives well after any fixed
	// sleep would have read an empty toast stack (measured: it did)
	await h.eventually(
		() => toasts(A),
		(t) => t.some((x) => /Copy chime\.mp3 into your Library to open it/.test(x)),
		'a NON-scene kind keeps the copy-into-library refusal, wording unchanged',
		20000
	);
	const audioToasts = await toasts(A);
	h.check(
		audioToasts.some((t) => /a audio viewer reads it from there/.test(t)),
		`…naming the viewer that does read from there (${audioToasts.join(' | ')})`
	);
	h.check(
		JSON.stringify(await worldNames(A)) === JSON.stringify(worldBeforeAudio) &&
			JSON.stringify(await at(A)) === identBeforeAudio,
		'…and it replaces nothing — only a scene opens a world'
	);
	// the menu says so too: the label a scene wears is the library card's own
	await volCard(A, 'Vault.tpscene').click({ button: 'right' });
	await page.waitForTimeout(600);
	const sceneMenu = await menuRows(A);
	await closeMenu(page);
	h.check(
		sceneMenu.some((r) => /Open here \(this screen\)/.test(r)),
		`a mounted scene's menu says what opening it does (${sceneMenu.join(' | ')})`
	);
	await volCard(A, 'chime.mp3').click({ button: 'right' });
	await page.waitForTimeout(600);
	const audioMenu = await menuRows(A);
	await closeMenu(page);
	h.check(
		audioMenu.includes('Open') && !audioMenu.some((r) => /Open here/.test(r)),
		`…and every other kind keeps the plain one (${audioMenu.join(' | ')})`
	);

	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await window.__stores.mountedVolumes.unmountVolume(v.id);
	});
	await page.waitForTimeout(400);

	await h.finish(browser);
});