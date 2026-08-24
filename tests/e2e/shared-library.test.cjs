// R22-R1/R2/R3 — THE SHARED EXPLORER LIBRARY: the index replicates, per-item opt-in.
//
// The finding the whole batch rests on: before R1 the Explorer library did not
// replicate AT ALL. No message carried folders and none carried item rows, so a session
// agreed on which SCENES exist (the manifest) and on nothing about where anything
// lives. This suite covers the document, the two identities (an item is its content
// hash, a shared folder's id is network identity), the adoption, the concurrent-share
// reconcile, and the one guarantee the plan is emphatic about: UNSHARE NEVER DELETES A
// PEER'S COPY.
//
// Run: APP_URL='https://localhost:5202/' PEER_CONFIG=... npm run e2e -- shared-library
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
			folderId: i.folderId,
			share: i.share ?? null,
			wasShared: !!i.wasShared,
			owner: i.owner ?? null
		}));
	});

const foldersOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerFolders.subscribe((x) => (v = x))();
		return v.map((f) => ({
			id: f.id,
			name: f.name,
			parentId: f.parentId,
			share: f.share ?? null,
			wasShared: !!f.wasShared
		}));
	});

/** Put bytes in the library. Returns the item record. */
const addFile = (peer, text, name, folderId = null) =>
	peer.page.evaluate(
		async ([text, name, folderId]) => {
			const buf = new TextEncoder().encode(text).buffer;
			const item = await window.__stores.explorer.addItemFromBytes(buf, name, folderId);
			return { id: item.id, hash: item.hash, name: item.name };
		},
		[text, name, folderId]
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) {
		await p.page.waitForFunction(() => !!window.__stores?.sharedLibrary && !!window.__stores?.explorer, {
			timeout: 30000
		});
		// the Explorer index is idb-backed and lazily loaded; every share read walks it
		await p.page.evaluate(() => window.__stores.explorer.loadExplorer());
	}

	// ---- 1. the document: absent = local, and empty means ABSENT --------------------
	//
	// THE MIGRATION RULE. Everything that already exists must read as local, and the two
	// sections must be OMITTED rather than written empty — otherwise a project that has
	// never shared a thing no longer serializes as it did before R1, which is the whole
	// claim that makes this batch a no-op until somebody presses Share.
	const f1 = await addFile(A, 'private bytes', 'secret.txt');
	await A.page.evaluate(() => window.__stores.projectManifest.setProjectName('R22'));
	const m0 = await manifestOf(A);
	h.check(!('items' in m0) && !('folders' in m0), 'a library nobody shared writes NO index keys');
	const local0 = (await itemsOf(A)).find((i) => i.hash === f1.hash);
	h.check(local0 && local0.share === null, 'an ordinary import is LOCAL — the flag is absent');

	// normalize is the one boundary: unknown per-row fields survive a round trip (the
	// normalizeAnnotation rule, applied per row), and a row with no identity is dropped
	const norm = await A.page.evaluate(() =>
		window.__stores.projectManifest.normalizeManifest({
			scenes: {},
			assets: [],
			changedAt: 1,
			folders: [
				{ id: 'f1', name: 'Textures', parentId: null, futureField: 7 },
				{ id: '', name: 'no id' },
				{ id: 'f2', name: '' }
			],
			items: [
				{ hash: 'h1', name: 'a.png', kind: 'image', folderId: 'f1', mystery: 'keep me' },
				{ name: 'no hash', kind: 'text' },
				{ hash: 'h1', name: 'later wins.png', kind: 'image', folderId: null }
			]
		})
	);
	h.check(norm.folders.length === 1 && norm.folders[0].futureField === 7,
		`a folder row keeps a newer peer's field and a row with no identity is dropped (${JSON.stringify(norm.folders)})`);
	h.check(norm.items.length === 1 && norm.items[0].name === 'later wins.png' && norm.items[0].mystery === undefined,
		`item rows are keyed by hash — a duplicate collapses, last wins (${JSON.stringify(norm.items)})`);

	await h.connect(A, B);

	// ---- 2. share one item: the row, the owner, the wire ---------------------------
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), f1.id);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	const mA = await manifestOf(A);
	h.check(mA.items?.length === 1 && mA.items[0].hash === f1.hash,
		`sharing publishes one row keyed by content hash (${JSON.stringify(mA.items)})`);
	h.check(mA.items[0].name === 'secret.txt' && mA.items[0].kind === 'text' && mA.items[0].folderId === null,
		'the row carries the name, kind and placement');
	h.check(!!mA.items[0].owner?.id && mA.items[0].owner.account === undefined,
		`the owner stamp carries a peer id and NO account without a cloud plugin (${JSON.stringify(mA.items[0].owner)})`);
	h.check((await itemsOf(A)).find((i) => i.hash === f1.hash)?.share === 'mine',
		"the local record says 'mine' — we are its writer");

	await h.eventually(
		() => manifestOf(B),
		(m) => m.items?.length === 1 && m.items[0].hash === f1.hash,
		'the peer receives the shared index'
	);

	// ---- 3. the peer does not hold the bytes: a DERIVED card, never a record --------
	//
	// An index row is not a library record. Writing one would leave a phantom card
	// behind the moment the owner unshared it, so the missing ones are derived.
	h.check((await itemsOf(B)).every((i) => i.hash !== f1.hash),
		'a shared row we do not hold writes NO local record');
	const remoteB = await B.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return window.__stores.sharedLibrary.remoteSharedRows(m).map((r) => r.name);
	});
	h.check(JSON.stringify(remoteB) === '["secret.txt"]',
		`it is offered as a remote row instead (${JSON.stringify(remoteB)})`);

	// ---- 4. the PULL: bytes ride assetfile/getasset, no new transport ---------------
	await B.page.evaluate((hash) => window.__stores.sharedLibrary.pullSharedItem(hash), f1.hash);
	const pending = await B.page.evaluate(() => {
		let s;
		window.__stores.sharedLibrary.pendingPulls.subscribe((v) => (s = v))();
		return [...s];
	});
	h.check(pending.includes(f1.hash), 'the pull is marked in flight so the card is not dead');
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.hash === f1.hash),
		'the bytes arrive over the EXISTING assetfile/getasset path'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.find((i) => i.hash === f1.hash)?.share === 'peer',
		"and the arrived item is adopted as 'peer' — shared, but not ours to publish"
	);
	const settled = await B.page.evaluate(() => {
		let s;
		window.__stores.sharedLibrary.pendingPulls.subscribe((v) => (s = v))();
		return [...s];
	});
	h.check(settled.length === 0, 'the in-flight mark clears when the bytes LAND, not on a timer');

	// ---- 5. a shared FOLDER: subtree, contents, and the clamp -----------------------
	//
	// PLACEMENT IS CLAMPED, NOT CASCADED: sharing a folder must not hand peers the names
	// of the folders above it. A shared row whose parent is not shared publishes with a
	// null parent and lands at the peer's root.
	const tree = await A.page.evaluate(() => {
		const e = window.__stores.explorer;
		const priv = e.createFolder('Private', null);
		const tex = e.createFolder('Textures', priv.id);
		const sub = e.createFolder('Wood', tex.id);
		return { priv: priv.id, tex: tex.id, sub: sub.id };
	});
	const f2 = await addFile(A, 'texture bytes', 'bark.png', tree.tex);
	const f3 = await addFile(A, 'deep bytes', 'grain.png', tree.sub);
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareFolder(id), tree.tex);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	const mA2 = await manifestOf(A);
	const texRow = mA2.folders.find((r) => r.id === tree.tex);
	const subRow = mA2.folders.find((r) => r.id === tree.sub);
	h.check(!!texRow && !!subRow, `the SUBTREE is shared, not just the folder (${mA2.folders.length} rows)`);
	h.check(texRow.parentId === null,
		`a shared folder inside a LOCAL one publishes with a null parent — the private name never leaves (${texRow.parentId})`);
	h.check(subRow.parentId === tree.tex, 'a subfolder keeps its parent, which is shared too');
	h.check(!mA2.folders.some((r) => r.id === tree.priv), 'the private ancestor is NOT published');
	h.check(mA2.items.some((r) => r.hash === f2.hash) && mA2.items.some((r) => r.hash === f3.hash),
		'the contents of a shared folder are shared, at every depth');

	// the LOCAL tree is untouched by the clamp — it happens at projection time only
	const aFolders = await foldersOf(A);
	h.check(aFolders.find((f) => f.id === tree.tex)?.parentId === tree.priv,
		'clamping is a projection, not an edit — the local tree still nests under Private');

	// the peer ADOPTS the folder under the SAME uuid, which is what makes every
	// folderId reference resolve everywhere with no remapping
	await h.eventually(
		() => foldersOf(B),
		(fs) => fs.some((f) => f.id === tree.tex) && fs.some((f) => f.id === tree.sub),
		'the peer adopts both folders under their NETWORK ids'
	);
	const bTree = await foldersOf(B);
	h.check(bTree.find((f) => f.id === tree.tex)?.parentId === null,
		'the adopted folder lands at the root, as its clamped row said');
	h.check(bTree.find((f) => f.id === tree.sub)?.parentId === tree.tex,
		'and the subfolder is adopted INSIDE it — the shared tree survives the trip');
	h.check(bTree.find((f) => f.id === tree.tex)?.share === 'peer',
		"an adopted folder is marked 'peer'");

	// ---- 6. the same bytes on both machines are ONE file ----------------------------
	//
	// An item's identity is its content hash, so a peer that independently holds the
	// bytes needs no transfer at all — the row is placement, and adoption is the
	// whole cost.
	const f4A = await addFile(A, 'shared identical bytes', 'both.txt', tree.tex);
	const f4B = await addFile(B, 'shared identical bytes', 'both.txt');
	h.check(f4A.hash === f4B.hash, 'identical bytes are one content hash on both machines');
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(
		() => itemsOf(B),
		(items) => items.find((i) => i.hash === f4A.hash)?.share === 'peer',
		'the peer adopts a file it already held — no bytes move'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.find((i) => i.hash === f4A.hash)?.folderId === tree.tex,
		'and it is PLACED where the row says, inside the adopted folder'
	);

	// ---- 7. inheritance: new contents of a shared folder are shared -----------------
	//
	// The folder is the unit of intent. A sweep rather than a hook per import path,
	// because there are many of those and a rule that holds only on the paths somebody
	// remembered to edit is not a rule.
	const f5 = await addFile(A, 'dropped later', 'later.png', tree.tex);
	await h.eventually(
		() => itemsOf(A),
		(items) => items.find((i) => i.hash === f5.hash)?.share === 'mine',
		'a file dropped into a shared folder AFTER the share is shared too'
	);
	await h.eventually(
		() => manifestOf(A),
		(m) => m.items.some((r) => r.hash === f5.hash),
		'and it reaches the document without a second gesture'
	);
	const f6 = await addFile(A, 'root drop', 'loose.png', null);
	await A.page.waitForTimeout(600);
	h.check((await itemsOf(A)).find((i) => i.hash === f6.hash)?.share === null,
		'a file dropped at the ROOT stays local — R3: a drop places local');

	// ---- 8. THE VETO ---------------------------------------------------------------
	//
	// Unsharing one file inside a shared folder must not be undone a moment later by
	// the folder it happens to sit in. `share: 'no'` is the difference between "never
	// decided" and "decided against", and only the second survives the sweep.
	const f5Id = (await itemsOf(A)).find((i) => i.hash === f5.hash).id;
	await A.page.evaluate((id) => window.__stores.sharedLibrary.unshareItem(id), f5Id);
	await A.page.waitForTimeout(700);
	const vetoed = (await itemsOf(A)).find((i) => i.hash === f5.hash);
	h.check(vetoed?.share === 'no', `an unshared file inside a shared folder holds a VETO (${vetoed?.share})`);
	h.check(!(await manifestOf(A)).items.some((r) => r.hash === f5.hash),
		'and it is gone from the document, the inheritance sweep notwithstanding');

	// ---- 9. UNSHARE NEVER DELETES A PEER'S COPY ------------------------------------
	//
	// THE GUARANTEE THE PLAN IS EMPHATIC ABOUT, and hash-addressing is what gives it for
	// free: the bytes a peer pulled are theirs. All that leaves the document is placement.
	const beforeB = (await itemsOf(B)).length;
	const secretId = (await itemsOf(A)).find((i) => i.hash === f1.hash).id;
	await A.page.evaluate((id) => window.__stores.sharedLibrary.unshareItem(id), secretId);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(
		() => manifestOf(B),
		(m) => !m.items.some((r) => r.hash === f1.hash),
		'unshare removes the row for every peer'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.find((i) => i.hash === f1.hash)?.wasShared === true,
		'the peer KEEPS the file and marks it "no longer shared"'
	);
	const afterB = await itemsOf(B);
	h.check(afterB.length === beforeB, `nothing was deleted on the peer (${beforeB} -> ${afterB.length})`);
	h.check(afterB.find((i) => i.hash === f1.hash)?.share === null,
		'and it is an ordinary local file again');
	const blobStillThere = await B.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		const blob = item ? await window.__stores.explorer.itemBlob(item.id) : null;
		return blob ? blob.size : -1;
	}, f1.hash);
	h.check(blobStillThere > 0, `the BYTES are still on the peer's disk (${blobStillThere} bytes)`);

	// ---- 10. THE RECONCILE: the concurrent-share race -----------------------------
	//
	// The manifest is whole-document latest-wins, so two peers sharing inside one
	// millisecond each build a document from a view that lacks the other's row and the
	// loser's file lands on the floor. Rule 3: on receiving a document that is missing a
	// row of OURS, we re-publish. GUARD PROVEN BY BREAKING THE CODE — with the
	// re-publish removed, A's row stays gone (measured below).
	const f7 = await addFile(A, 'A concurrent', 'fromA.txt');
	const f8 = await addFile(B, 'B concurrent', 'fromB.txt');
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), f7.id);
	await B.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), f8.id);
	// force the collision: both publish from a view that cannot contain the other
	await Promise.all([
		A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true)),
		B.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true))
	]);
	await h.eventually(
		() => manifestOf(A),
		(m) => m.items.some((r) => r.hash === f7.hash) && m.items.some((r) => r.hash === f8.hash),
		'both concurrently shared files survive on A — the reconcile unions them'
	);
	await h.eventually(
		() => manifestOf(B),
		(m) => m.items.some((r) => r.hash === f7.hash) && m.items.some((r) => r.hash === f8.hash),
		'...and on B, so the session converges rather than losing a file'
	);

	// TERMINATION: the publish is idempotent on CONTENT, so a converged document is not
	// a stamp ping-pong. If it were, changedAt would keep climbing with nobody touching
	// anything.
	const stamp1 = (await manifestOf(A)).changedAt;
	await A.page.waitForTimeout(1500);
	const stamp2 = (await manifestOf(A)).changedAt;
	h.check(stamp1 === stamp2,
		`a converged index writes NOTHING — no publish storm (${stamp1} === ${stamp2})`);

	// ---- 11. a publish of ours never drops a peer's row ----------------------------
	//
	// Rule 1. The projection carries every foreign row verbatim, so the only peer that
	// can remove a row is the one that published it.
	const f9 = await addFile(A, 'A again', 'more.txt');
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), f9.id);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	h.check((await manifestOf(A)).items.some((r) => r.hash === f8.hash),
		"A's own publish still carries B's row — one writer per row, and A is not it");

	// ---- 12. fork 3: a viewer publishes nothing ------------------------------------
	const viewerRefused = await A.page.evaluate(async () => {
		const ch = window.__stores.cloudHooks;
		const sl = window.__stores.sharedLibrary;
		let before;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (before = v))();
		const n = (before.items ?? []).length;
		ch.rolesInfo.set({ myRole: 'viewer' });
		const buf = new TextEncoder().encode('viewer bytes').buffer;
		const item = await window.__stores.explorer.addItemFromBytes(buf, 'viewer.txt', null);
		sl.shareItem(item.id);
		const wrote = sl.publishMine(true);
		let after;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (after = v))();
		ch.rolesInfo.set(null);
		return { wrote, before: n, after: (after.items ?? []).length };
	});
	h.check(viewerRefused.wrote === false && viewerRefused.after === viewerRefused.before,
		`a viewer's share is REFUSED, not queued (${JSON.stringify(viewerRefused)})`);

	// ---- 13. the .tp round trip: FORMAT 3 and the id remap -------------------------
	//
	// The shared index is keyed by FOLDER ID, and a .tp import mints fresh ids on
	// purpose (a file must never collide with the library it lands in). Carrying them
	// unremapped would adopt folders that exist nowhere and strand every item row.
	const fmt = await A.page.evaluate(() => window.__stores.projectFile.PROJECT_FORMAT);
	h.check(fmt === 3, `PROJECT_FORMAT is 3 (${fmt})`);
	const remapped = await A.page.evaluate(() => {
		const pf = window.__stores.projectFile;
		if (!pf.__remapSharedIndexForTest) return 'no seam';
		const remap = new Map([['old-a', 'new-a']]);
		return pf.__remapSharedIndexForTest(
			{
				folders: [
					{ id: 'old-a', name: 'Kept', parentId: null },
					{ id: 'gone', name: 'Dropped', parentId: 'old-a' }
				],
				items: [
					{ hash: 'h-keep', name: 'a.png', kind: 'image', folderId: 'old-a' },
					{ hash: 'h-root', name: 'b.png', kind: 'image', folderId: 'gone' }
				]
			},
			remap
		);
	});
	if (remapped === 'no seam') {
		h.check(false, 'projectFile exposes the remap seam for this check');
	} else {
		h.check(remapped.folders.length === 1 && remapped.folders[0].id === 'new-a',
			`a folder row is rewritten onto the fresh id, an unmapped one dropped (${JSON.stringify(remapped.folders)})`);
		h.check(remapped.items.length === 2 && remapped.items[0].folderId === 'new-a' && remapped.items[1].folderId === null,
			`item rows keep their HASH identity; an unresolvable placement falls to the root rather than losing the file (${JSON.stringify(remapped.items)})`);
	}

	// ---- 14. no render crash anywhere ---------------------------------------------
	for (const [label, p] of [
		['A', A],
		['B', B]
	]) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `${label}: no page errors (${errs.slice(0, 2).join(' | ')})`);
	}

	await h.finish(browser);
});
