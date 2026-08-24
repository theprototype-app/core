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
	// PLACEMENT CASCADES (locked answer, round 2). Sharing a folder publishes its
	// ANCESTORS as well, so every peer rebuilds the same tree — "all peers have project
	// folder consistency" was the deciding requirement. The first version CLAMPED (a
	// shared folder whose parent was private landed at the peer's root), which is what
	// made a shared folder look as though its contents had not arrived: they had, one
	// level up from where the author was looking.
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
	h.check(texRow.parentId === tree.priv,
		`a shared folder keeps its real parent — the chain is published, not flattened (${texRow.parentId})`);
	h.check(subRow.parentId === tree.tex, 'a subfolder keeps its parent, which is shared too');
	const privRow = mA2.folders.find((r) => r.id === tree.priv);
	h.check(!!privRow && privRow.parentId === null,
		'and the private ANCESTOR rides along as placement, so no folderId can dangle');
	// NOTE the trade the locked answer accepts: an ancestor's NAME does travel. It is
	// published as placement only — it is not marked shared here and holds no files of
	// its own on the wire — but a peer can read it.
	h.check(mA2.folders.length >= 3, `three rows: the shared folder, its child and its parent (${mA2.folders.length})`);
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
	h.check(bTree.find((f) => f.id === tree.tex)?.parentId === tree.priv,
		'the adopted folder sits under the same parent it does here — one tree, every peer');
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

	// ================================================================================
	// R2 / R3 / R7 — THE UI. Driven through the REAL context menus and the REAL filter
	// control, never through the store functions the sections above already cover: a
	// feature with no entry point is invisible to a suite that supplies its own (the
	// documented Shader-tab lesson, which shipped 20 green checks over a tab no user
	// could open).

	// a clean slate for the UI half — the sections above left a tangle of shares
	// deliberately, and a menu check wants to know exactly what it is right-clicking
	await A.page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
		window.__stores.sharedLibrary.publishMine(true);
	});
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#explorer-list').isVisible(), 'the Explorer opens from the hud button');

	const uiFile = await addFile(A, 'ui share bytes', 'ui-share.txt');
	const card = () => A.page.locator('[data-card-id="' + uiFile.id + '"]');
	await h.eventually(() => card().count(), (n) => n === 1, 'the imported file has a card');

	// ---- 15. Share from the item context menu -------------------------------------
	await card().click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const shareRow = A.page.locator('[role=menu]').getByText('Share', { exact: true }).first();
	h.check((await shareRow.count()) > 0, 'a local file offers Share in its context menu');
	await shareRow.click();
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === uiFile.hash),
		'pressing Share publishes the row — through the real menu'
	);

	// the DOT, asserted as a COMPUTED COLOUR rather than a class string: in the
	// documented tbx-btn case the class was right the whole time while the fill was wrong
	const dotInfo = await A.page.evaluate((id) => {
		const el = document.querySelector('[data-card-id="' + id + '"] .explorer-share-dot');
		return el ? { color: getComputedStyle(el).backgroundColor, title: el.getAttribute('title') } : null;
	}, uiFile.id);
	// NOT /^rgb/: tailwind 4 emits oklch(), so the honest claim is "a real, opaque
	// colour was computed" rather than a guess at the notation the toolchain uses
	const painted =
		!!dotInfo &&
		!!dotInfo.color &&
		!/transparent/.test(dotInfo.color) &&
		!/rgba(0, 0, 0, 0)/.test(dotInfo.color);
	h.check(painted,
		'a shared card draws a share dot with a real fill (' + JSON.stringify(dotInfo) + ')');
	h.check(/Shared by you/.test(dotInfo?.title ?? ''), 'and it says what it means');

	// ---- 16. Unshare from the same menu -------------------------------------------
	await card().click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const unshareRow = A.page.locator('[role=menu]').getByText('Unshare', { exact: true }).first();
	h.check((await unshareRow.count()) > 0, 'a shared file offers Unshare instead');
	await unshareRow.click();
	await h.eventually(
		() => manifestOf(A),
		(m) => !(m.items ?? []).some((r) => r.hash === uiFile.hash),
		'and pressing it removes the row'
	);

	// ---- 17. a PEER's file: ANYONE may unshare it (locked answer, round 2) --------
	//
	// The first version offered the owner's name and no button, on the reasoning that a
	// gesture which cannot work should not be offered. The locked answer is that a
	// project's library belongs to the project: anyone may take a file out, the removal
	// sticks (a tombstone, see section 24), and the owner-only rule survives as a setting.
	const peerFile = await addFile(B, 'peer owned bytes', 'from-peer.txt');
	await B.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), peerFile.id);
	await B.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === peerFile.hash),
		"A receives the peer's row"
	);

	// ---- 18. R1's card for a shared file whose bytes are NOT here -----------------
	const remoteSel = '[data-card-id="shared:' + peerFile.hash + '"]';
	const remoteCard = A.page.locator(remoteSel);
	await h.eventually(() => remoteCard.count(), (n) => n === 1,
		'a shared file we do not hold gets a DERIVED card in the grid');
	const dimmed = await A.page.evaluate((sel) => {
		const el = document.querySelector(sel);
		return el ? Number(getComputedStyle(el).opacity) : -1;
	}, remoteSel);
	h.check(dimmed > 0 && dimmed < 1, 'and it is DIMMED rather than hidden (opacity ' + dimmed + ')');

	await remoteCard.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const dl = A.page.locator('[role=menu]').getByText('Download from peers', { exact: true }).first();
	h.check((await dl.count()) > 0, 'its menu offers the one thing that makes sense: Download from peers');
	await dl.click();
	// the bytes ride the EXISTING assetfile/getasset path, and the derived card is
	// replaced by the real item the moment they land
	await h.eventually(
		() => itemsOf(A),
		(items) => items.some((i) => i.hash === peerFile.hash),
		'clicking it fetches the bytes'
	);
	await h.eventually(() => remoteCard.count(), (n) => n === 0,
		'and the derived card gives way to the real item — no phantom left behind');

	// ...and now that A HOLDS the peer's file, its menu must offer Unshare — the default
	const adopted = (await itemsOf(A)).find((i) => i.hash === peerFile.hash);
	h.check(adopted?.share === 'peer', 'A holds it, marked as a peer’s');
	await A.page.locator('[data-card-id="' + adopted.id + '"]').click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const menuText = await A.page.locator('[role=menu]').first().innerText();
	h.check(/^Unshare$/m.test(menuText),
		'a peer’s file offers Unshare too — anyone may take a file out of the project');
	// ...and with the owner-only setting on, the row NAMES the owner instead of offering
	// a button that would be refused (section 25 covers the predicate itself)
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// ---- 19. Share FOLDER from the folder card menu -------------------------------
	const uiFolder = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('UI Textures', null).id
	);
	await A.page.waitForTimeout(400);
	const folderCard = A.page.locator('[data-card-id="' + uiFolder + '"]');
	await h.eventually(() => folderCard.count(), (n) => n === 1, 'the new folder has a card');
	await folderCard.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const shareFolderRow = A.page.locator('[role=menu]').getByText('Share folder', { exact: true }).first();
	h.check((await shareFolderRow.count()) > 0, 'a folder offers Share folder');
	await shareFolderRow.click();
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.folders ?? []).some((r) => r.id === uiFolder),
		'and pressing it publishes the folder row'
	);

	// R3 + the user's rule, through the real import path: a file that lands in a SHARED
	// folder is shared, with no second gesture
	const inherited = await addFile(A, 'inherited by the folder', 'inherit.txt', uiFolder);
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === inherited.hash),
		'a file imported into a shared folder is shared automatically'
	);

	// ---- 20. R7: the filter --------------------------------------------------------
	const filterBtn = A.page.locator('#explorer-filter');
	h.check((await filterBtn.count()) > 0, 'the filter control exists beside the search box');
	const gridCount = () => A.page.locator('.explorer-card').count();
	const before = await gridCount();
	await filterBtn.click();
	await A.page.waitForTimeout(300);
	const localOnly = A.page.locator('[role=menu]').getByText('Local only', { exact: true }).first();
	h.check((await localOnly.count()) > 0, 'it offers a share-state axis');
	await localOnly.click();
	await A.page.waitForTimeout(400);
	const afterLocal = await gridCount();
	h.check(afterLocal < before,
		'"Local only" hides the shared cards (' + before + ' -> ' + afterLocal + ')');
	// and it is REVERSIBLE from the same control, which is the half a filter gets wrong
	await filterBtn.click();
	await A.page.waitForTimeout(300);
	await A.page.locator('[role=menu]').getByText('Clear filters', { exact: true }).first().click();
	await A.page.waitForTimeout(400);
	h.check((await gridCount()) === before, 'Clear filters puts them all back');

	// ---- 21. the batch menu acts on the SET ---------------------------------------
	const two = await A.page.evaluate(async () => {
		const e = window.__stores.explorer;
		const a = await e.addItemFromBytes(new TextEncoder().encode('batch one').buffer, 'b1.txt', null);
		const b = await e.addItemFromBytes(new TextEncoder().encode('batch two').buffer, 'b2.txt', null);
		return [a.id, b.id, a.hash, b.hash];
	});
	await A.page.waitForTimeout(500);
	await A.page.locator('[data-card-id="' + two[0] + '"]').click();
	await A.page.locator('[data-card-id="' + two[1] + '"]').click({ modifiers: ['Control'] });
	await A.page.locator('[data-card-id="' + two[1] + '"]').click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const batchShare = A.page.locator('[role=menu]').getByText('Share 2 items', { exact: true }).first();
	h.check((await batchShare.count()) > 0, 'a multi-selection offers Share with the COUNT it will honour');
	await batchShare.click();
	await h.eventually(
		() => manifestOf(A),
		(m) => [two[2], two[3]].every((hash) => (m.items ?? []).some((r) => r.hash === hash)),
		'and shares them both in one gesture'
	);

	// ================================================================================
	// ROUND 2 — the locked answers and the reported bugs.

	// ---- 22. THE REPORTED BUG: a MOVE must reach peers -----------------------------
	//
	// Reported as two things — "cannot drag files into folders" and "a shared folder's
	// contents do not appear" — and it was one fault: the sweep published only when it had
	// MARKED something, so moving an already-shared file changed the local record and
	// nothing on the wire. Measured before the fix: the row still read folderId null after
	// the file had visibly moved.
	const mv = await A.page.evaluate(async () => {
		const e = window.__stores.explorer;
		const f = e.createFolder('Moved Into', null);
		const i = await e.addItemFromBytes(new TextEncoder().encode('move me').buffer, 'move.txt', null);
		window.__stores.sharedLibrary.shareItem(i.id);
		window.__stores.sharedLibrary.publishMine(true);
		return { folderId: f.id, itemId: i.id, hash: i.hash };
	});
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === mv.hash),
		'the file is shared at the root'
	);
	await A.page.evaluate((x) => window.__stores.explorer.moveItem(x.itemId, x.folderId), mv);
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).find((r) => r.hash === mv.hash)?.folderId === mv.folderId,
		'MOVING a shared file republishes its placement — with no share gesture at all'
	);
	await h.eventually(
		() => manifestOf(B),
		(m) => (m.items ?? []).find((r) => r.hash === mv.hash)?.folderId === mv.folderId,
		'...and the peer agrees about the tree'
	);

	// ---- 23. CASCADE replaces the clamp (locked answer) ----------------------------
	//
	// Sharing a folder inside a private one now publishes the ANCESTORS, so every peer
	// sees the same tree. The old clamp put it at the peer's root, which is what made a
	// shared folder look like it had arrived without its contents — they were one level up
	// from where the author was looking.
	const casc = await A.page.evaluate(async () => {
		const e = window.__stores.explorer;
		const outer = e.createFolder('Outer', null);
		const inner = e.createFolder('Inner', outer.id);
		const leaf = e.createFolder('Leaf', inner.id);
		const i = await e.addItemFromBytes(new TextEncoder().encode('deep cascade').buffer, 'deep.txt', leaf.id);
		window.__stores.sharedLibrary.shareFolder(leaf.id);
		window.__stores.sharedLibrary.publishMine(true);
		return { outer: outer.id, inner: inner.id, leaf: leaf.id, hash: i.hash };
	});
	await h.eventually(
		() => manifestOf(A),
		(m) => ['outer', 'inner', 'leaf'].every((k) => (m.folders ?? []).some((r) => r.id === casc[k])),
		'sharing a nested folder publishes its whole ANCESTOR CHAIN'
	);
	const cascDoc = await manifestOf(A);
	h.check(
		cascDoc.folders.find((r) => r.id === casc.leaf)?.parentId === casc.inner &&
			cascDoc.folders.find((r) => r.id === casc.inner)?.parentId === casc.outer &&
			cascDoc.folders.find((r) => r.id === casc.outer)?.parentId === null,
		'and the chain keeps its real shape rather than being flattened'
	);
	await h.eventually(
		() => foldersOf(B),
		(fs) => {
			const leaf = fs.find((f) => f.id === casc.leaf);
			const inner = fs.find((f) => f.id === casc.inner);
			return leaf?.parentId === casc.inner && inner?.parentId === casc.outer;
		},
		'the peer rebuilds the SAME tree — project folder consistency'
	);

	// ---- 24. ANYONE may unshare (locked answer), and it STICKS ---------------------
	//
	// This is what the tombstone is for. Without one, the publisher's reconcile notices
	// its own row missing and puts it straight back, and the two peers take turns forever.
	const authority = await B.page.evaluate(() => {
		let v;
		window.__stores.sharedLibrary.unshareAuthority.subscribe((x) => (v = x))();
		return v;
	});
	h.check(authority === 'anyone', `the default is that anyone may unshare (${authority})`);

	const victim = await A.page.evaluate(async () => {
		const i = await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('unshared by the other peer').buffer,
			'theirs.txt',
			null
		);
		window.__stores.sharedLibrary.shareItem(i.id);
		window.__stores.sharedLibrary.publishMine(true);
		return { id: i.id, hash: i.hash };
	});
	await h.eventually(
		() => manifestOf(B),
		(m) => (m.items ?? []).some((r) => r.hash === victim.hash),
		"B receives A's row"
	);
	// B does not hold the bytes, so there is no local record — the tombstone is the whole
	// of the removal
	await B.page.evaluate((hash) => window.__stores.sharedLibrary.unshareHash(hash), victim.hash);
	await h.eventually(
		() => manifestOf(A),
		(m) => !(m.items ?? []).some((r) => r.hash === victim.hash),
		"a peer who does NOT own the file can unshare it, and the owner's document loses the row"
	);
	// THE GUARD: it must not come back. A's reconcile sees its own 'mine' row missing and
	// would republish it, which is precisely the tug-of-war the tombstone exists to stop.
	await A.page.waitForTimeout(2500);
	const stillGone = await manifestOf(A);
	h.check(!(stillGone.items ?? []).some((r) => r.hash === victim.hash),
		'and it STAYS gone — the reconcile does not resurrect a deliberate removal');
	h.check(!!stillGone.removed?.items?.[victim.hash], 'a tombstone records it');
	const ownerSide = (await itemsOf(A)).find((i) => i.hash === victim.hash);
	h.check(ownerSide?.share === 'no' && ownerSide?.wasShared === true,
		`the owner's own record honours it and keeps the file (${JSON.stringify(ownerSide?.share)})`);
	const blobKept = await A.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		const blob = item ? await window.__stores.explorer.itemBlob(item.id) : null;
		return blob ? blob.size : -1;
	}, victim.hash);
	h.check(blobKept > 0, `and the bytes are untouched (${blobKept} bytes)`);

	// re-sharing LIFTS the tombstone — a removal must not be a one-way door
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), victim.id);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === victim.hash) && !m.removed?.items?.[victim.hash],
		're-sharing publishes it again AND lifts the tombstone'
	);

	// ---- 25. the owner-only option still works ------------------------------------
	const gated = await B.page.evaluate((hash) => {
		const sl = window.__stores.sharedLibrary;
		sl.unshareAuthority.set('owner');
		const row = { hash, share: 'peer', owner: { id: 'somebody-else' } };
		const refused = sl.canUnshare(row);
		sl.unshareAuthority.set('anyone');
		const allowed = sl.canUnshare(row);
		return { refused, allowed };
	}, victim.hash);
	h.check(gated.refused === false && gated.allowed === true,
		`the setting gates the offer both ways (${JSON.stringify(gated)})`);

	// ---- 26. no empty `Shared` folder ---------------------------------------------
	//
	// It used to be created the first time any byte arrived, and R1's adoption then moved
	// the file to its row's folder — leaving an empty folder behind for good.
	const sharedFolders = (await foldersOf(B)).filter((f) => f.name === 'Shared');
	const emptyShared = await B.page.evaluate(() => {
		let folders, items;
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return folders
			.filter((f) => f.name === 'Shared')
			.map((f) => items.filter((i) => i.folderId === f.id).length);
	});
	h.check(!emptyShared.some((n) => n === 0),
		`no EMPTY 'Shared' folder was invented (${sharedFolders.length} such folders, contents ${JSON.stringify(emptyShared)})`);

	// ---- 27. THUMBNAILS TRAVEL ----------------------------------------------------
	//
	// A shared file used to show an icon until you downloaded it, because a thumbnail is
	// derived from bytes the peer does not have. It now rides its own tiny channel rather
	// than the manifest, which re-replicates in full on every share.
	const PNG =
		'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';
	const pic = await A.page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'shared-pic.png', null);
		return { id: item.id, hash: item.hash, thumb: !!item.thumbnail };
	}, PNG);
	h.check(pic.thumb, 'the sender rendered a thumbnail for its own image');
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareItem(id), pic.id);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	// B must NOT hold the bytes for this to prove anything
	h.check((await itemsOf(B)).every((i) => i.hash !== pic.hash), 'the peer does not hold the image');
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let v;
				window.__stores.assetShare.sharedThumbs.subscribe((x) => (v = x))();
				return Object.keys(v);
			}),
		(keys) => keys.includes(pic.hash),
		'the PICTURE arrives without the file — pushed on share'
	);
	const thumbVal = await B.page.evaluate((hash) => {
		let v;
		window.__stores.assetShare.sharedThumbs.subscribe((x) => (v = x))();
		return (v[hash] ?? '').slice(0, 22);
	}, pic.hash);
	h.check(thumbVal.startsWith('data:image/'),
		`and it is an inline image, never arbitrary markup (${thumbVal})`);

	// the REQUEST path too: a joiner that missed the push asks for it
	const asked = await B.page.evaluate((hash) => {
		const as = window.__stores.assetShare;
		// clear the cache so the request path is the only way it can come back
		as.forgetSharedThumb(hash);
		as.requestAssetThumb(hash);
		return true;
	}, pic.hash);
	h.check(asked, 'a peer can ASK for a thumbnail it does not have');
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let v;
				window.__stores.assetShare.sharedThumbs.subscribe((x) => (v = x))();
				return Object.keys(v);
			}),
		(keys) => keys.includes(pic.hash),
		'...and it is answered over the same hash-addressed channel'
	);

	// ---- 28. the bulk actions the connect prompt offers ---------------------------
	const counts = await A.page.evaluate(() => window.__stores.sharedLibrary.bulkCounts());
	h.check(typeof counts.local === 'number' && typeof counts.missing === 'number',
		`bulkCounts answers both halves of the union (${JSON.stringify(counts)})`);
	const bulk = await B.page.evaluate(() => {
		const before = window.__stores.sharedLibrary.bulkCounts();
		const asked = window.__stores.sharedLibrary.pullAllShared();
		return { before, asked };
	});
	h.check(bulk.asked === bulk.before.missing,
		`Download all asks for exactly the files it lacks — hash dedupe means nothing redundant (${JSON.stringify(bulk)})`);

	// ---- 29. the FILTER lists every category, and separates the two axes ----------
	await A.page.locator('#explorer-filter').click();
	await A.page.waitForTimeout(300);
	const filterText = await A.page.locator('[role=menu]').first().innerText();
	for (const label of ['Images', 'Audio', '3D models', 'Text and config', 'Scenes', 'Prefabs'])
		h.check(filterText.includes(label), `the filter offers "${label}" whatever the library holds`);
	// case-INSENSITIVE: `.ctx-section` is `text-transform: uppercase`, and innerText
	// reports the transformed text (textContent would not) — so the first version of
	// this check was testing the stylesheet's casing, not whether the labels exist
	h.check(/type/i.test(filterText) && /visibility/i.test(filterText),
		'and the two axes are separated by section labels');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

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
