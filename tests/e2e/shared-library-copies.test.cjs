// 24-C2 — ROW IDENTITY: `id` beside `hash` in the shared library.
//
// THE FINDING: a shared row WAS its content hash (`normalizeSharedIndex` keyed items by
// hash and deleted `id`), so C1's local Duplicate — a second RECORD holding the same
// bytes — could not exist on the wire at all: the second row collapsed into the first.
// Now a row is `{id, hash, ...}` where `id` is the publisher's record uuid (network
// identity, the folder precedent) and `hash` stays the content pointer the bytes travel
// by. "Send a command to make a copy for peers instead of resending the bytes" then needs
// NO new message: the index row IS the command — a peer holding the hash materialises the
// record from its own disk and moves nothing over the wire.
//
// Two peers throughout, a LATE joiner for the "pulls once" half, and a FRESH page for the
// .tp round trip. Fixtures are a few hundred bytes of text on purpose: every transfer here
// takes the single-shot `assetfile` path, so nothing depends on the chunk protocol.
//
// Run: APP_URL='https://theprototype.app:5176/' npm run e2e -- shared-library-copies
const h = require('./helpers.cjs');

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((i) => ({
			id: i.id,
			name: i.name,
			hash: i.hash,
			folderId: i.folderId ?? null,
			share: i.share ?? null,
			wasShared: !!i.wasShared
		}));
	});

const hiddenOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.hiddenItems.subscribe((x) => (v = x))();
		return v.map((i) => ({ id: i.id, name: i.name, hash: i.hash, share: i.share ?? null }));
	});

/** the ledger, incoming rows only — what "a transfer on B" means */
const inTransfers = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v
			.filter((t) => t.dir === 'in')
			.map((t) => ({ hash: t.hash, state: t.state, size: t.size, at: t.at, endedAt: t.endedAt ?? null, error: t.error ?? null }));
	});
/** the rows that MOVED BYTES for a hash — a request the 6s fuse gave up on ("nobody answered")
 *  before a slow peer's answer landed is a wait, not a transfer, and shows up as a failed row
 *  beside the done one on a loaded box; the property under test is that bytes moved ONCE */
const doneFor = (rows, hash) => rows.filter((t) => t.hash === hash && t.state === 'done');
const brief = (rows) => JSON.stringify(rows.map((t) => ({ hash: t.hash.slice(0, 8), state: t.state, size: t.size, ms: t.endedAt ? t.endedAt - t.at : null, error: t.error })));
const allTransfers = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v.map((t) => ({ hash: t.hash, state: t.state, dir: t.dir }));
	});
const clearLedger = (peer) => peer.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));

const blobText = (peer, id) =>
	peer.page.evaluate(async (id) => {
		const blob = await window.__stores.explorer.itemBlob(id);
		return blob ? await blob.text() : null;
	}, id);

const addFile = (peer, text, name, folderId = null) =>
	peer.page.evaluate(
		async ([text, name, folderId]) => {
			const buf = new TextEncoder().encode(text).buffer;
			const item = await window.__stores.explorer.addItemFromBytes(buf, name, folderId);
			return { id: item.id, hash: item.hash, name: item.name };
		},
		[text, name, folderId]
	);

const settle = async (peer) => {
	await peer.page.waitForFunction(() => !!window.__stores?.sharedLibrary && !!window.__stores?.explorer, { timeout: 30000 });
	await peer.page.evaluate(() => window.__stores.explorer.loadExplorer());
	// the share-new-files ASK is its own surface (shared-library covers it); `never` is
	// exactly "behave as before" and keeps the strip out of the way of every read below
	await peer.page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
};

const X_TEXT = 'row identity fixture: ' + 'the bytes of X, a few hundred of them. '.repeat(6);
const X2_TEXT = 'row identity fixture, EDITED: ' + 'the copy went its own way. '.repeat(7);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await settle(A);
	await settle(B);

	// ---- 1. the document: a row is `{id, hash}`, and only a LEGACY row is keyed by hash --
	//
	// The normalize is the one boundary. A row from a pre-24 peer (or an old .tp, or the
	// idb copy from before the upgrade) has no `id`: it takes a SYNTHETIC one derived from
	// the hash, stable on every machine, so two old peers still agree — and two real-id rows
	// sharing one hash both survive, which is the whole point.
	const norm = await A.page.evaluate(() =>
		window.__stores.projectManifest.normalizeManifest({
			scenes: {},
			assets: [],
			changedAt: 1,
			items: [
				{ hash: 'h1', name: 'legacy.txt', kind: 'text', folderId: null },
				{ hash: 'h1', name: 'legacy again.txt', kind: 'text', folderId: null },
				{ id: 'r2', hash: 'h1', name: 'copy one.txt', kind: 'text', folderId: null },
				{ id: 'r3', hash: 'h1', name: 'copy two.txt', kind: 'text', folderId: null },
				{ id: 'r3', hash: 'h1', name: 'copy two renamed.txt', kind: 'text', folderId: null }
			],
			deleted: [
				{ hash: 'h1', name: 'old row.txt', kind: 'text', at: 5 },
				{ id: 'r2', hash: 'h1', name: 'copy one.txt', kind: 'text', at: 6 },
				{ id: 'r3', hash: 'h1', name: 'copy two.txt', kind: 'text', at: 7 }
			]
		})
	);
	const ids = (norm.items ?? []).map((r) => r.id).sort();
	h.check(
		JSON.stringify(ids) === JSON.stringify(['hash:h1', 'r2', 'r3']),
		`a legacy row takes the synthetic id, two real-id rows with ONE hash both survive, a repeated id collapses last-wins (${JSON.stringify(ids)})`
	);
	h.check(
		norm.items.find((r) => r.id === 'r3')?.name === 'copy two renamed.txt',
		'the identity a duplicate collapses on is the id, not the hash'
	);
	h.check(
		norm.deleted.length === 3 && norm.deleted.every((r) => r.hash === 'h1'),
		`the deleted log keys on id when a row has one, hash otherwise — three rows, one hash (${norm.deleted.length})`
	);

	// the .tp remap seam: item ids are rewritten like folder ids; a legacy (id-less) row
	// and a row whose id the file did not carry are left alone rather than dropped
	const remapped = await A.page.evaluate(() => {
		const pf = window.__stores.projectFile;
		if (!pf.__remapSharedIndexForTest) return 'no seam';
		return pf.__remapSharedIndexForTest(
			{
				folders: [{ id: 'old-a', name: 'Kept', parentId: null }],
				items: [
					{ id: 'old-i', hash: 'h-keep', name: 'a.png', kind: 'image', folderId: 'old-a' },
					{ hash: 'h-legacy', name: 'b.png', kind: 'image', folderId: 'old-a' },
					{ id: 'unmapped', hash: 'h-remote', name: 'c.png', kind: 'image', folderId: null }
				]
			},
			new Map([['old-a', 'new-a']]),
			new Map([['old-i', 'new-i']])
		);
	});
	if (remapped === 'no seam') h.check(false, 'projectFile exposes the remap seam');
	else {
		const byName = Object.fromEntries(remapped.items.map((r) => [r.name, r]));
		h.check(
			byName['a.png']?.id === 'new-i' && byName['a.png']?.folderId === 'new-a',
			`a .tp open rewrites an item row onto the fresh record id AND folder id (${JSON.stringify(byName['a.png'])})`
		);
		h.check(
			byName['b.png']?.id === undefined && byName['c.png']?.id === 'unmapped',
			'a legacy row stays id-less and an id the file could not map is kept (its holder may still serve it)'
		);
	}

	await h.connect(A, B);

	// ---- 2. the premise: X shared, B auto-downloads it ONCE, under A's record id -------
	const assets = await A.page.evaluate(() => {
		const f = window.__stores.explorer.createFolder('Assets', null);
		window.__stores.sharedLibrary.shareFolder(f.id);
		return f.id;
	});
	const X = await addFile(A, X_TEXT, 'notes.txt', assets);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.id === X.id && r.hash === X.hash),
		`the row carries the record id beside the hash (${X.id.slice(0, 8)}… / ${X.hash.slice(0, 8)}…)`
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.id === X.id && i.hash === X.hash && i.share === 'peer'),
		'B auto-downloads X and holds it under the SAME record id — network identity, the folder rule',
		20000
	);
	h.check((await itemsOf(B)).find((i) => i.id === X.id)?.folderId === assets, 'placed in the adopted folder');
	await h.eventually(
		() => inTransfers(B),
		(rows) => doneFor(rows, X.hash).length === 1,
		'exactly one incoming transfer moved the bytes (the premise every zero-byte claim below rests on)',
		30000
	);
	console.log('  B ledger after X: ' + brief(await inTransfers(B)));

	// ---- 3. THE COPY COMMAND: a duplicate on A is a row on B and NO transfer ----------
	await clearLedger(A);
	await clearLedger(B);
	const copy = await A.page.evaluate(
		(id) => window.__stores.explorer.duplicateItem(id).then((i) => i && { id: i.id, name: i.name, hash: i.hash, folderId: i.folderId }),
		X.id
	);
	h.check(!!copy && copy.hash === X.hash && copy.id !== X.id && copy.folderId === assets, `A duplicates X: "${copy?.name}", same hash, its own id, same folder`);
	// the copy landed in a SHARED folder, so the inheritance sweep shares it with no gesture
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).filter((r) => r.hash === X.hash).length === 2 && (m.items ?? []).some((r) => r.id === copy.id),
		'the document carries TWO rows for one hash, distinct ids — the second one is the copy command'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.id === copy.id && i.hash === X.hash && i.share === 'peer' && i.name === copy.name),
		`B materialises "${copy.name}" under the copy's id, from its own disk`,
		20000
	);
	const bAfterCopy = await itemsOf(B);
	h.check(bAfterCopy.filter((i) => i.hash === X.hash).length === 2, `B holds two records for the hash (${bAfterCopy.filter((i) => i.hash === X.hash).map((i) => i.name).join(' / ')})`);
	h.check(bAfterCopy.find((i) => i.id === X.id)?.share === 'peer', "B's original X is untouched (still the same record, still 'peer')");
	h.check((await blobText(B, copy.id)) === X_TEXT, "the copy's blob on B holds the bytes — copied locally under its own id");
	// give any stray transfer time to appear before calling the ledger empty
	await B.page.waitForTimeout(1500);
	const ledgerB = await allTransfers(B);
	h.check(ledgerB.length === 0, `ZERO wire bytes for the copy — B's transfer ledger is empty (${JSON.stringify(ledgerB)})`);
	const ledgerA = await allTransfers(A);
	h.check(ledgerA.length === 0, `...and A sent nothing either (${JSON.stringify(ledgerA)})`);

	// ---- 4. DELETE IS PER COPY: A deletes "X copy", B keeps X -------------------------
	await A.page.evaluate((id) => window.__stores.sharedLibrary.deleteItemsToBin([id]), copy.id);
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.deleted ?? []).some((r) => r.id === copy.id && r.hash === X.hash),
		'the deleted log row carries the copy\'s id beside its hash'
	);
	const tombs = (await manifestOf(A)).removed?.items ?? {};
	h.check(!!tombs[copy.id] && !tombs[X.hash] && !tombs[X.id], `the tombstone is keyed by the copy's id — never by the hash both rows share (${JSON.stringify(Object.keys(tombs).map((k) => k.slice(0, 8)))})`);
	await h.eventually(
		() => itemsOf(B),
		(items) => !items.some((i) => i.id === copy.id) && items.some((i) => i.id === X.id && i.share === 'peer'),
		"B's copy leaves the visible shelf while B's X stays exactly where it was",
		15000
	);
	const hiddenB = await hiddenOf(B);
	h.check(hiddenB.some((i) => i.id === copy.id && i.hash === X.hash), 'the deleted copy sits on B\'s hidden shelf — bytes intact, the recycle bin rule');
	h.check(
		await B.page.evaluate((id) => window.__stores.sharedLibrary.canRestoreDeleted(id), copy.id),
		'and B can restore it by its row id'
	);
	const binB = await B.page.evaluate(() => {
		const sl = window.__stores.sharedLibrary;
		let m, items, hidden;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__stores.explorer.hiddenItems.subscribe((v) => (hidden = v))();
		const held = new Set([...items, ...hidden].flatMap((i) => [i.id, i.hash]));
		return sl.partitionDeleted(m.deleted ?? [], held, []).bin.map((r) => r.id ?? r.hash);
	});
	h.check(JSON.stringify(binB) === JSON.stringify([copy.id]), `B's bin lists the copy and only the copy (${JSON.stringify(binB.map((k) => k.slice(0, 8)))})`);
	// nothing moved for the delete either
	h.check((await allTransfers(B)).length === 0, 'a delete moves no bytes');

	// ---- 5. RESTORE by id puts the copy back everywhere, still with no transfer -------
	await A.page.evaluate((id) => window.__stores.sharedLibrary.restoreDeletedItem(id), copy.id);
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.id === copy.id) && !(m.deleted ?? []).some((r) => r.id === copy.id) && !m.removed?.items?.[copy.id],
		'restore re-publishes the row, clears the log row and lifts the tombstone'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.id === copy.id && i.share === 'peer') && items.filter((i) => i.hash === X.hash).length === 2,
		"B un-hides ITS copy (the hidden-and-deleted-and-applied restore rule, by id)",
		15000
	);
	h.check((await allTransfers(B)).length === 0, 'a restore moves no bytes either');

	// ---- 6. the .tp round trip keeps both rows with distinct ids -------------------------
	//
	// Done BEFORE the edit below, so the file carries two rows that still share one hash —
	// the case a hash-keyed reader would have folded into one.
	const exported = await A.page.evaluate(async () => {
		const r = await window.__stores.projectFile.exportProject();
		let s = '';
		for (let i = 0; i < r.bytes.length; i += 8192) s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192));
		return { b64: btoa(s), items: r.items };
	});
	const { unzipSync, strFromU8 } = require('fflate');
	const zip = unzipSync(Buffer.from(exported.b64, 'base64'));
	const projectJson = JSON.parse(strFromU8(zip['project.json']));
	const exportRows = (projectJson.items ?? []).filter((r) => r.hash === X.hash);
	h.check(
		exportRows.length === 2 && exportRows.every((r) => typeof r.id === 'string') && new Set(exportRows.map((r) => r.id)).size === 2,
		`project.json carries both records for one hash, each with its id (${exportRows.map((r) => r.name).join(' / ')})`
	);
	h.check(
		(projectJson.manifest?.items ?? []).filter((r) => r.hash === X.hash && r.id).length === 2,
		'and the embedded shared index carries both rows with their ids'
	);

	const D = await h.setupPage(browser, 'D');
	await settle(D);
	// import-as-folder on a FRESH library: two rows, one hash -> two records (the second is
	// written past the hash dedupe because the file itself says these are two records)
	const importedD = await D.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.importProjectAsFolder(bytes.buffer, { name: 'From A' });
	}, exported.b64);
	h.check(!!importedD, 'the .tp imports as a folder on a fresh page');
	const dItems = (await itemsOf(D)).filter((i) => i.hash === X.hash);
	h.check(
		dItems.length === 2 && new Set(dItems.map((i) => i.id)).size === 2 && dItems.some((i) => i.name === 'notes.txt') && dItems.some((i) => i.name === copy.name),
		`import keeps BOTH records, fresh ids, both names (${dItems.map((i) => i.name).join(' / ')})`
	);
	h.check(dItems.every((i) => i.id !== X.id && i.id !== copy.id), 'an import mints fresh record ids — a file must not collide with the library it lands in');
	// OPEN replaces the project and installs the manifest: the shared rows are REMAPPED
	// onto the fresh record ids, so every row still names a record this machine holds
	const openPromise = D.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.openProject(bytes.buffer);
	}, exported.b64);
	await h.eventually(
		() =>
			D.page.evaluate(() => {
				let d;
				window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
				return d?.title ?? null;
			}),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'the OPEN warning appeared'
	);
	await D.page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(true));
	await openPromise;
	await D.page.waitForTimeout(800);
	const dOpened = (await itemsOf(D)).filter((i) => i.hash === X.hash);
	const dRows = ((await manifestOf(D)).items ?? []).filter((r) => r.hash === X.hash);
	h.check(dOpened.length === 2 && dRows.length === 2, `after OPEN: two records and two rows for the hash (${dOpened.length}/${dRows.length})`);
	h.check(
		dRows.every((r) => dOpened.some((i) => i.id === r.id)) && new Set(dRows.map((r) => r.id)).size === 2,
		'each shared row was remapped onto the record this machine minted for it — no dead ids'
	);
	await D.ctx.close();

	// ---- 7. a LATE JOINER gets both rows and pulls ONCE --------------------------------
	const C = await h.setupPage(browser, 'C');
	await settle(C);
	await clearLedger(C);
	await h.connect(C, A);
	await h.eventually(
		() => itemsOf(C),
		(items) => items.some((i) => i.id === X.id && i.hash === X.hash) && items.some((i) => i.id === copy.id && i.hash === X.hash),
		'C receives both rows and holds both records under their network ids',
		25000
	);
	await h.eventually(
		() => inTransfers(C),
		(rows) => doneFor(rows, X.hash).length === 1 && !rows.some((t) => t.state === 'active' || t.state === 'queued'),
		'C pulled the bytes exactly ONCE for two records',
		30000
	);
	const cIn = await inTransfers(C);
	h.check(cIn.every((t) => t.hash === X.hash), `...and asked for nothing else (${brief(cIn)})`);
	h.check((await blobText(C, copy.id)) === X_TEXT && (await blobText(C, X.id)) === X_TEXT, 'both of C\'s records hold the bytes');

	// ---- 8. AN EDITED COPY IS NEW BYTES: one transfer per peer, same record --------------
	await clearLedger(B);
	await clearLedger(C);
	await A.page.evaluate(([id, text]) => window.__stores.explorer.updateItemBytes(id, text), [copy.id, X2_TEXT]);
	const edited = (await itemsOf(A)).find((i) => i.id === copy.id);
	h.check(!!edited && edited.hash !== X.hash, `the copy has a new hash after the edit (${edited?.hash?.slice(0, 8)}…)`);
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.id === copy.id && r.hash === edited.hash) && (m.items ?? []).some((r) => r.id === X.id && r.hash === X.hash),
		'the row keeps its id and points at the new hash; X\'s row is untouched'
	);
	for (const peer of [B, C]) {
		await h.eventually(
			() => itemsOf(peer),
			(items) => items.find((i) => i.id === copy.id)?.hash === edited.hash,
			`${peer === B ? 'B' : 'C'}'s copy record takes the new bytes IN PLACE — same id, new hash`,
			25000
		);
		const items = await itemsOf(peer);
		h.check(items.find((i) => i.id === X.id)?.hash === X.hash && items.filter((i) => i.id === X.id || i.id === copy.id).length === 2, `${peer === B ? 'B' : 'C'} still has two records and X is unchanged`);
		h.check((await blobText(peer, copy.id)) === X2_TEXT, `${peer === B ? 'B' : 'C'}'s copy blob holds the edited text`);
		await h.eventually(
			() => inTransfers(peer),
			(rows) => doneFor(rows, edited.hash).length === 1 && !rows.some((t) => t.state === 'active' || t.state === 'queued'),
			`exactly one transfer moved bytes on ${peer === B ? 'B' : 'C'}, for the new hash`,
			30000
		);
		const rows = await inTransfers(peer);
		h.check(rows.every((t) => t.hash === edited.hash), `...and nothing else was asked for on ${peer === B ? 'B' : 'C'} (${brief(rows)})`);
	}

	// ---- 9. invariants over the whole document ---------------------------------------
	const finalDoc = await manifestOf(A);
	const rowIds = (finalDoc.items ?? []).map((r) => r.id);
	h.check(new Set(rowIds).size === rowIds.length && rowIds.every((id) => typeof id === 'string' && !id.startsWith('hash:')), `every row has a real, unique id (${rowIds.length} rows)`);
	h.check(
		JSON.stringify(((await manifestOf(B)).items ?? []).map((r) => r.id).sort()) === JSON.stringify([...rowIds].sort()),
		'B and A agree on the row identities'
	);

	await h.finish(browser);
});
