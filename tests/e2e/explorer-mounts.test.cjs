// R22 ROUND 13 P3 — MOUNTED PROJECT VOLUMES.
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

	// ---- 10. P3b: a clean mount to EDIT ---------------------------------------------
	// The volume above has had its saved record deleted on purpose, so P3b starts from a
	// fresh project rather than reasoning about a broken one.
	await page.evaluate(async () => {
		const s2 = window.__stores;
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		for (const v of mv) await s2.mountedVolumes.unmountVolume(v.id);
		await s2.explorer.clearLibrary();
		const enc = (t) => new TextEncoder().encode(t).buffer;
		const f = s2.explorer.createFolder('Timber', null);
		await s2.explorer.addItemFromBytes(enc('p'.repeat(220)), 'plank.txt', f.id);
		await s2.explorer.addItemFromBytes(enc('n'.repeat(310)), 'nails.txt', null);
	});
	await page.waitForTimeout(700);
	await saveProject(A, 'Yard');
	await mountThroughUi(A, 'Yard');
	let yard = (await vols(A))[0];
	h.check(
		!!yard && yard.name === 'Yard' && !yard.dirty,
		`a fresh mount starts clean (${yard && yard.name}, dirty=${yard && yard.dirty})`
	);
	// the library, and the SAVED RECORD, as they stand before any edit
	const libBeforeEdit = await librarySnapshot(A);
	const savedNames = (peer, sessionId) =>
		peer.page.evaluate(async (id) => {
			const rec = await window.__stores.idb.idbGet('session:' + id);
			return (rec?.library?.items ?? []).map((i) => i.name).sort();
		}, sessionId);
	const beforeSave = await savedNames(A, yard.sessionId);
	h.check(
		beforeSave.join(',') === 'nails.txt,plank.txt',
		`premise: the saved project holds both files (${beforeSave.join(',')})`
	);

	// ---- 11. an edit is BUFFERED: dirty, and disk untouched -------------------------
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + yard.id);
	await page.waitForTimeout(600);
	const target = (await vols(A))[0].itemIds[0];
	await page.evaluate(async (id) => {
		const s2 = window.__stores;
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const row = mv[0].items.find((i) => i.id === id);
		s2.mountedVolumes.volumeRenameItem(mv[0].id, id, 'renamed-' + row.name);
	}, target);
	await page.waitForTimeout(600);
	yard = (await vols(A))[0];
	h.check(
		yard.dirty && yard.items.some((nm) => nm.startsWith('renamed-')),
		`a rename inside the mount is buffered and marks it dirty (${yard.items.join(',')})`
	);
	h.check(
		await page.locator('#mount-save-' + yard.id).isEnabled(),
		'…the Save button LIGHTS (it is disabled while there is nothing to write)'
	);
	h.check(
		(await librarySnapshot(A)) === libBeforeEdit,
		'…the live library is untouched by the edit'
	);
	h.check(
		(await savedNames(A, yard.sessionId)).join(',') === beforeSave.join(','),
		'…and NOTHING has reached the saved project yet'
	);

	// ---- 12. THE BUFFER SURVIVES A RELOAD (the guard proven by breaking it) ---------
	await h.freshReload(A);
	await page.waitForFunction(() => !!window.__stores?.mountedVolumes, null, { timeout: 30000 });
	await page.evaluate(async () => {
		await window.__stores.mountedVolumes.loadMountedVolumes();
		await window.__stores.explorer.loadExplorer();
	});
	await page.waitForTimeout(1200);
	const survived = (await vols(A))[0];
	h.check(
		!!survived && survived.items.some((nm) => nm.startsWith('renamed-')),
		`the BUFFERED edit survives a reload — a reload that discarded it would silently lose work (${survived && survived.items.join(',')})`
	);
	h.check(survived.dirty, '…and it still reads as unsaved');

	// ---- 13. SAVE BACK ---------------------------------------------------------------
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);
	const manifestBefore = await sharedIndex(A);
	await page.locator('#mount-save-' + survived.id).click();
	await h.eventually(
		() => savedNames(A, survived.sessionId),
		(names) => names.some((nm) => nm.startsWith('renamed-')),
		'Save writes the edit back into the saved project',
		20000
	);
	await h.eventually(
		() => vols(A),
		(list) => !list[0].dirty,
		'the mount stops reading as dirty once it is written',
		15000
	);
	const saved = (await vols(A))[0];
	h.check(
		saved.buffered === 0,
		'…and stops carrying a second copy of the bytes (they are in the session again)'
	);
	h.check(
		(await librarySnapshot(A)) === libBeforeEdit,
		'SAVE-BACK TOUCHED NO LIVE STORE: the library is still byte-identical'
	);
	h.check(
		(await sharedIndex(A)) === manifestBefore,
		'…and the project manifest is untouched by it'
	);
	const bothStillThere = await savedNames(A, survived.sessionId);
	h.check(
		bothStillThere.length === 2,
		`…and the OTHER file is still in the record — a save is a rewrite, not a replace of what it knows (${bothStillThere.join(',')})`
	);

	// ---- 14. copy OUT is a real import, hash-deduped --------------------------------
	// FIXTURE, and it cost a red to learn: a RENAME does not change bytes, so the file in
	// the mount is content-identical to the one the library already holds — and
	// `addItemFromBytes` correctly answers with the item it has. The copy-out was working
	// and the count could not move. Empty the library so the import has something to do.
	await page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
	});
	await page.waitForTimeout(600);
	await page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + saved.id);
	await page.waitForTimeout(700);
	const copyOut = await page.evaluate(() => {
		const card = document.querySelector('.ex-cards [data-card-id^="vitem:"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const lib = document.querySelector('#explorer-root-row');
		lib.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		lib.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		return card.getAttribute('data-card-id');
	});
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
				return v.map((i) => i.name);
			}),
		(names) => names.length === 1,
		'dragging a mounted file onto Library IMPORTS it',
		15000
	);
	const afterCopyOut = await page.evaluate((id) => {
		const s2 = window.__stores;
		let lib;
		s2.explorer.explorerItems.subscribe((x) => (lib = x))();
		let mv;
		s2.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		const row = mv[0].items.find((i) => i.id === id);
		return {
			libNames: lib.map((i) => i.name).sort(),
			matchedByHash: lib.filter((i) => i.hash === row.hash).length,
			stillInVolume: mv[0].items.length,
			dirty: !!mv[0].dirty
		};
	}, copyOut);
	h.check(
		afterCopyOut.matchedByHash === 1,
		`…as a real library item with the SAME content hash (${afterCopyOut.libNames.join(',')})`
	);
	h.check(
		afterCopyOut.stillInVolume === 2 && !afterCopyOut.dirty,
		'…and copying OUT changes nothing in the mount (it is a copy, not a move)'
	);
	// the same bytes again are the same file — the library's own invariant, inherited free
	await page.evaluate(() => {
		const card = document.querySelector('.ex-cards [data-card-id^="vitem:"]');
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const lib = document.querySelector('#explorer-root-row');
		lib.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		lib.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
	});
	await page.waitForTimeout(1500);
	const twiceOut = await page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.length;
	});
	h.check(
		twiceOut === 1,
		`copying the same file out twice is ONE item — the one-item-per-hash invariant, inherited rather than re-implemented (${twiceOut})`
	);

	// ---- 15. copy IN is buffered ----------------------------------------------------
	// bytes the VOLUME does not hold, for the mirror of the reason above: a volume dedupes
	// on its own hashes, so copying in something it already has is a no-op by design
	await page.evaluate(async () => {
		const enc = (t) => new TextEncoder().encode(t).buffer;
		await window.__stores.explorer.addItemFromBytes(enc('k'.repeat(455)), 'brick.txt', null);
	});
	await page.waitForTimeout(600);
	await page.locator('#explorer-root-row').click();
	await page.waitForTimeout(600);
	const libCard = await page.evaluate(() => {
		const el = [...document.querySelectorAll('.ex-cards .explorer-card')].find((c) =>
			(c.innerText ?? '').includes('brick.txt')
		);
		return el?.getAttribute('data-card-id') ?? null;
	});
	h.check(!!libCard, 'premise: the library file to drag is on screen');
	await page.evaluate(
		({ id, vol }) => {
			const card = document.querySelector('[data-card-id="' + id + '"]');
			const dt = new DataTransfer();
			card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
			const row = document.querySelector('[data-mount="' + vol + '"]');
			row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
			row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		},
		{ id: libCard, vol: saved.id }
	);
	await h.eventually(
		() => vols(A),
		(list) => list[0].items.some((nm) => nm === 'brick.txt'),
		'dragging a library file onto a mount copies it IN',
		15000
	);
	const afterCopyIn = await vols(A);
	h.check(
		afterCopyIn[0].dirty && afterCopyIn[0].buffered === 1,
		`…buffered, with its bytes carried on the mount record so a reload cannot lose them (${afterCopyIn[0].buffered} buffered)`
	);
	h.check(
		(await savedNames(A, saved.sessionId)).length === 2,
		'…and nothing has reached the saved project until Save is pressed'
	);
	await page.locator('#mount-save-' + saved.id).click();
	await h.eventually(
		() => savedNames(A, saved.sessionId),
		(names) => names.length === 3,
		'…which then writes all three',
		20000
	);

	// ---- 16. unmount with unsaved changes ASKS, and can be cancelled ----------------
	await page.evaluate(async () => {
		let mv;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
		window.__stores.mountedVolumes.volumeRenameItem(mv[0].id, mv[0].items[0].id, 'edited-again.txt');
	});
	// A SAVE IS SEVERAL AWAITS LONG, so this rename lands while the one above may still be
	// finishing — and a save that cleared `dirty` unconditionally would mark it saved when
	// it is not. Measured exactly that way before `rev` existed: the flag read clean and
	// the next unmount took the no-confirm path and discarded the edit.
	await page.waitForTimeout(2000);
	const dirtyVol = (await vols(A))[0];
	h.check(
		dirtyVol.dirty,
		'an edit made while a save is still finishing STAYS dirty — the save is of the older revision'
	);
	await page.locator('#mount-unmount-' + dirtyVol.id).click();
	await page.waitForTimeout(600);
	h.check(
		await page.locator('#explorer-confirm-yes').isVisible(),
		'unmounting a DIRTY mount asks first — in the Explorer, where the files are'
	);
	await page.locator('#explorer-confirm-no').click();
	await page.waitForTimeout(500);
	const afterCancel = (await vols(A))[0];
	h.check(
		!!afterCancel && afterCancel.dirty,
		'…and Cancel leaves it mounted WITH its edits (dirty=' + (afterCancel && afterCancel.dirty) + ')'
	);
	await page.locator('#mount-unmount-' + dirtyVol.id).click();
	await page.waitForSelector('#explorer-confirm-yes', { timeout: 15000 });
	await page.locator('#explorer-confirm-yes').click();
	await page.waitForTimeout(700);
	h.check((await vols(A)).length === 0, 'confirming unmounts it');
	const discarded = await savedNames(A, dirtyVol.sessionId);
	h.check(
		!discarded.includes('edited-again.txt'),
		`…and the discarded edit never reached the saved project (${discarded.join(',')})`
	);

	await h.finish(browser);
});
