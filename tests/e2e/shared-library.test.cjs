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

	// R22-R8: AUTO-DOWNLOAD is ON by default now, which invalidates every check below
	// that describes a peer NOT holding a shared file — the peer fetches it before the
	// assertion can look. That is the feature working, so the fix is to reach the state
	// the same way a user would (the setting) rather than through a test-only door.
	// Section 31 turns it back on, where it is the thing under test.
	//
	// BOTH peers: round 4 made the pull structural (a request no longer waits for a queue
	// slot), which made auto-download fast enough to beat the observation on A as well —
	// the derived card was gone before the check could look at it.
	for (const peer of [A, B])
		await peer.page.evaluate(() => window.__stores.sharedLibrary.autoDownload.set(false));

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
	// the 'peer' MARK is applied by the debounced adoption sweep, not by the arrival of
	// the bytes — so it lands a couple of hundred milliseconds after the item does. A
	// synchronous read here measured `null` while the feature was perfect.
	await h.eventually(
		() => itemsOf(A),
		(items) => items.find((i) => i.hash === peerFile.hash)?.share === 'peer',
		'A holds it, adopted as a shared file it does not own'
	);
	const adopted = (await itemsOf(A)).find((i) => i.hash === peerFile.hash);
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

	// ================================================================================
	// ROUND 3 — R8: chunked transfer, the ledger, the two settings, and the toggle.

	// ---- 30. the ledger's arithmetic, with no bytes and no peer --------------------
	//
	// The aggregate is the thing a progress bar is wrong about, so it is asserted
	// directly rather than through the UI: a percentage of BYTES and a percentage of
	// FILES are different claims, and mixing them silently is how a bar goes backwards.
	// EMPTY IT FIRST. By now the run has moved real files, so the ledger is full of
	// them — and these checks are about the arithmetic, not about this run. Reading a
	// percentage out of a shared ledger measured 63% where the maths says 13%, which is
	// the assertion being wrong rather than the code.
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	const ledger = await A.page.evaluate(() => {
		const tl = window.__stores.transferLedger;
		const read = () => {
			let v;
			tl.transferSummary.subscribe((x) => (v = x))();
			return v;
		};
		const idle = read();
		const a = tl.beginTransfer({ hash: 'h-a', name: 'a.bin', dir: 'in', size: 1000 });
		const b = tl.beginTransfer({ hash: 'h-b', name: 'b.bin', dir: 'in', size: 3000 });
		tl.progressTransfer(a, 500);
		const mid = read();
		tl.finishTransfer(a);
		const afterOne = read();
		// a transfer with NO known size must flip the whole reading to file counting
		const c = tl.beginTransfer({ hash: 'h-c', name: 'c.bin', dir: 'in' });
		const unsized = read();
		tl.failTransfer(b, 'went quiet');
		const failed = read();
		tl.finishTransfer(c);
		const done = read();
		tl.clearFinished();
		return { idle, mid, afterOne, unsized, failed, done };
	});
	h.check(ledger.idle.left === 0 && ledger.idle.pct === 0, 'an idle ledger reports nothing in flight');
	h.check(ledger.mid.byBytes === true && ledger.mid.pct === 13,
		`progress is a BYTE percentage while every size is known (500/4000 = 13%, got ${ledger.mid.pct})`);
	h.check(ledger.afterOne.left === 1 && ledger.afterOne.pct === 25,
		`a finished file stays in the denominator, so the bar does not restart (${ledger.afterOne.pct}%)`);
	h.check(ledger.unsized.byBytes === false,
		'one transfer of unknown size flips the whole reading to FILE counting — never a silent mix');
	h.check(ledger.failed.failed === 1, 'a failure is counted and excluded from the totals');
	h.check(ledger.done.left === 0, 'and the summary empties when the last one lands');

	// ---- 31. a CHUNKED transfer, end to end ---------------------------------------
	//
	// The point of chunking is not throughput (peerjs already chunks internally, and a
	// single 12 MB message has been measured going through intact) — it is that per-file
	// progress and an integrity check are impossible without slicing it ourselves.
	// back ON: from here it is the subject rather than a nuisance
	for (const peer of [A, B])
		await peer.page.evaluate(() => window.__stores.sharedLibrary.autoDownload.set(true));
	await B.page.waitForTimeout(300);
	const bigHash = await A.page.evaluate(async () => {
		// deterministic content well over the chunk size, so it MUST be sliced
		const n = 700 * 1024;
		const bytes = new Uint8Array(n);
		for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'big.bin', null);
		window.__stores.sharedLibrary.shareItem(item.id);
		window.__stores.sharedLibrary.publishMine(true);
		return { hash: item.hash, size: n };
	});
	h.check(bigHash.size > 256 * 1024, `the fixture is bigger than one chunk (${bigHash.size} bytes)`);
	// auto-download is ON by default, so B should fetch it without being asked
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.hash === bigHash.hash),
		'AUTO-DOWNLOAD fetches a newly shared file with no gesture from the peer'
	);
	const bBlob = await B.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		const blob = item ? await window.__stores.explorer.itemBlob(item.id) : null;
		return blob ? blob.size : -1;
	}, bigHash.hash);
	h.check(bBlob === bigHash.size,
		`the reassembled file is byte-for-byte the right SIZE (${bBlob} vs ${bigHash.size})`);
	// the integrity check is the real guarantee: addItemFromBytes hashes what it stores,
	// so the item existing under this hash means the bytes reassembled correctly
	h.check(
		(await itemsOf(B)).find((i) => i.hash === bigHash.hash)?.hash === bigHash.hash,
		'and it hashes to the hash we asked for — reassembly is verified, not assumed'
	);
	const bLedger = await B.page.evaluate((hash) => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v.filter((t) => t.hash === hash).map((t) => ({ dir: t.dir, state: t.state, size: t.size }));
	}, bigHash.hash);
	h.check(bLedger.some((t) => t.dir === 'in' && t.state === 'done' && t.size === bigHash.size),
		`the receiver logged it as a finished incoming transfer of the right size (${JSON.stringify(bLedger)})`);
	const aLedger = await A.page.evaluate((hash) => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v.filter((t) => t.hash === hash).map((t) => ({ dir: t.dir, state: t.state }));
	}, bigHash.hash);
	h.check(aLedger.some((t) => t.dir === 'out' && t.state === 'done'),
		`and the SENDER logged the outgoing side (${JSON.stringify(aLedger)})`);

	// ---- 32. the share cap moved, because chunking is what pinned it --------------
	const cap = await A.page.evaluate(() => window.__stores.assetShare.MAX_SHARED_BYTES);
	h.check(cap === 25 * 1024 * 1024,
		`the share cap now matches the Explorer's own import limit (${Math.round(cap / 1048576)} MB)`);

	// ---- 33. "download files manually" turns auto-download off -------------------
	const manual = await B.page.evaluate(async () => {
		const sl = window.__stores.sharedLibrary;
		sl.autoDownload.set(false);
		let v;
		sl.autoDownload.subscribe((x) => (v = x))();
		return v;
	});
	h.check(manual === false, 'the peer can opt out of automatic downloads');
	const manualHash = await A.page.evaluate(async () => {
		const item = await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('not fetched automatically').buffer,
			'manual.txt',
			null
		);
		window.__stores.sharedLibrary.shareItem(item.id);
		window.__stores.sharedLibrary.publishMine(true);
		return item.hash;
	});
	await h.eventually(
		() => manifestOf(B),
		(m) => (m.items ?? []).some((r) => r.hash === manualHash),
		'the row still reaches the peer'
	);
	await B.page.waitForTimeout(2000);
	h.check((await itemsOf(B)).every((i) => i.hash !== manualHash),
		'...and with auto-download OFF the bytes are NOT fetched — the card stays greyed');
	// and the manual route still works
	await B.page.evaluate((hash) => window.__stores.sharedLibrary.pullSharedItem(hash), manualHash);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.hash === manualHash),
		'opening it still downloads it'
	);
	await B.page.evaluate(() => window.__stores.sharedLibrary.autoDownload.set(true));

	// ---- 34. "share every file automatically" -------------------------------------
	const autoShared = await A.page.evaluate(async () => {
		const sl = window.__stores.sharedLibrary;
		const e = window.__stores.explorer;
		// a file that is explicitly VETOED must survive the blanket setting
		const vetoed = await e.addItemFromBytes(new TextEncoder().encode('never share me').buffer, 'veto.txt', null);
		sl.shareItem(vetoed.id);
		sl.unshareItem(vetoed.id);
		sl.autoShareAll.set(true);
		const fresh = await e.addItemFromBytes(new TextEncoder().encode('auto shared').buffer, 'auto.txt', null);
		return { vetoed: vetoed.hash, fresh: fresh.hash };
	});
	await h.eventually(
		() => manifestOf(A),
		(m) => (m.items ?? []).some((r) => r.hash === autoShared.fresh),
		'with the setting on, a new file is shared with no gesture at all'
	);
	h.check(!(await manifestOf(A)).items.some((r) => r.hash === autoShared.vetoed),
		'but an explicitly UNSHARED file stays unshared — a decision beats a preference');
	await A.page.evaluate(() => window.__stores.sharedLibrary.autoShareAll.set(false));

	// ---- 35. "Local only" is a TOGGLE, and it reaches folders ---------------------
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(400);
	await A.page.locator('#explorer-filter').click();
	await A.page.waitForTimeout(300);
	const filterRows = await A.page.locator('[role=menu]').first().innerText();
	h.check(/Local only/.test(filterRows), 'the visibility axis is one row named "Local only"');
	h.check(!/Shared only/.test(filterRows), 'and "Shared only" is gone — one switch, one question');
	await A.page.locator('[role=menu]').getByText('Local only', { exact: true }).first().click();
	await A.page.waitForTimeout(500);
	const localView = await A.page.evaluate(() => ({
		cards: [...document.querySelectorAll('.explorer-card')].length,
		folders: [...document.querySelectorAll('.explorer-folder-card')].length
	}));
	const sharedFolderCount = (await foldersOf(A)).filter(
		(f) => f.parentId === null && (f.share === 'mine' || f.share === 'peer')
	).length;
	h.check(localView.folders <= (await foldersOf(A)).filter((f) => f.parentId === null).length,
		`the folder cards are filtered too (${localView.folders} shown, ${sharedFolderCount} shared at root)`);
	const anyShared = await A.page.evaluate(() =>
		[...document.querySelectorAll('.explorer-card .explorer-share-dot')].length
	);
	h.check(anyShared === 0, `no SHARED card survives "Local only" (${anyShared} share dots on screen)`);
	// and it clears
	await A.page.locator('#explorer-filter').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('[role=menu]').getByText('Clear filters', { exact: true }).first().click();
	await A.page.waitForTimeout(400);

	// ---- 36. the transfer indicator and the Logs pane -----------------------------
	//
	// ROUND 6 flipped this: the indicator is ALWAYS visible now. An element that comes and
	// goes reflows the header and trains nobody where to look, so it stays and has to be
	// honest in every state instead (section 49 covers the four). What is asserted here is
	// the popover and the split pane.
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#explorer-transfers').count()) === 1,
		'the transfer indicator is present even with nothing in flight');
	await A.page.evaluate(() =>
		window.__stores.transferLedger.beginTransfer({
			hash: 'ui-probe',
			name: 'probe.bin',
			dir: 'in',
			size: 2048
		})
	);
	await A.page.waitForTimeout(400);
	h.check(/Downloading/.test((await A.page.locator('#explorer-transfers').getAttribute('aria-label')) ?? ''),
		'and it reports the work the moment there is some');
	await A.page.locator('#explorer-transfers').click();
	await A.page.waitForTimeout(300);
	const popText = await A.page.locator('.tx-popover').first().innerText();
	h.check(/probe\.bin/.test(popText), `the popover names the file (${JSON.stringify(popText.slice(0, 60))})`);
	h.check(/%/.test(popText), 'and carries a percentage');
	await A.page.locator('#explorer-transfers-logs').click();
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('.tx-log').count()) === 1, 'the full Logs pane opens from the popover');
	const split = await A.page.evaluate(() => {
		const cards = document.querySelector('.ex-cards');
		const log = document.querySelector('.ex-log');
		if (!cards || !log) return null;
		const a = cards.getBoundingClientRect();
		const b = log.getBoundingClientRect();
		return { cardsW: Math.round(a.width), logW: Math.round(b.width), sideBySide: a.right <= b.left + 8 };
	});
	h.check(!!split && split.sideBySide && split.logW > 100,
		`it SPLITS the Explorer rather than covering it (${JSON.stringify(split)})`);
	const logText = await A.page.locator('.tx-log').first().innerText();
	h.check(/probe\.bin/.test(logText), 'and the pane lists the row');
	await A.page.evaluate(() => window.__stores.transferLedger.clearFinished());

	// ================================================================================
	// ROUND 4 — the R8 starvation fix made structural, and delete-for-everyone.

	// ---- 37. a dead hash resolves by ANSWER, not by timer -------------------------
	//
	// The first fix was a 6s fuse plus a dead-hash mark, which worked and left the app
	// unable to tell "nobody has this" from "the one peer who has it is slow". A peer that
	// lacks a hash now says so, and when the LAST one says so the pull is over.
	const t0 = Date.now();
	await B.page.evaluate(() => window.__stores.sharedLibrary.pullSharedItem('deadbeef'.repeat(8)));
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let v;
				window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
				return v.filter((t) => t.hash === 'deadbeef'.repeat(8)).map((t) => t.state);
			}),
		(states) => states.includes('failed'),
		'a hash nobody holds fails instead of hanging'
	);
	const deadMs = Date.now() - t0;
	// the OLD behaviour was a 6000ms fuse; anything near that means the negative reply is
	// not being used and the timer is doing the work
	h.check(deadMs < 4000, `and it resolves by REPLY rather than by timeout (${deadMs}ms, fuse is 6000ms)`);

	// ---- 38. ...and a dead hash blocks nothing behind it --------------------------
	//
	// THE STARVATION BUG, asserted directly: requests are unlimited now (they are ~40
	// bytes), and the cap moved to the SENDER's outgoing bytes, which is the only scarce
	// thing. Ask for several files nobody has, then a real one, and the real one must not
	// wait for them.
	await B.page.evaluate(() => {
		const sl = window.__stores.sharedLibrary;
		for (let i = 0; i < 6; i++) sl.pullSharedItem(('face' + i).padEnd(64, '0'));
	});
	const realFile = await A.page.evaluate(async () => {
		const item = await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('behind the dead ones').buffer,
			'notblocked.txt',
			null
		);
		window.__stores.sharedLibrary.shareItem(item.id);
		window.__stores.sharedLibrary.publishMine(true);
		return item.hash;
	});
	const t1 = Date.now();
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.hash === realFile),
		'a real download runs while six unanswerable pulls are outstanding'
	);
	const throughMs = Date.now() - t1;
	h.check(throughMs < 5000,
		`and it is not queued behind them (${throughMs}ms — the old cap would have held it for the full fuse)`);

	// ---- 39. DELETE reaches every peer, and never destroys their bytes ------------
	const victimFile = await A.page.evaluate(async () => {
		const item = await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('this one gets deleted').buffer,
			'doomed.txt',
			null
		);
		window.__stores.sharedLibrary.shareItem(item.id);
		window.__stores.sharedLibrary.publishMine(true);
		return { id: item.id, hash: item.hash };
	});
	await h.eventually(
		() => itemsOf(B),
		(items) => items.some((i) => i.hash === victimFile.hash),
		'the peer downloads it'
	);

	await A.page.evaluate((id) => window.__stores.sharedLibrary.deleteSharedItem(id), victimFile.id);
	await h.eventually(
		() => manifestOf(B),
		(m) => (m.deleted ?? []).some((r) => r.hash === victimFile.hash),
		'deleting a shared file writes a DELETED LOG entry every peer receives'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.every((i) => i.hash !== victimFile.hash),
		"...and the peer's card goes away"
	);
	// THE GUARANTEE: the bytes are still on the peer's disk, on the hidden shelf
	const stillHeld = await B.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		const blob = item ? await window.__stores.explorer.itemBlob(item.id) : null;
		return { held: !!item, bytes: blob ? blob.size : -1 };
	}, victimFile.hash);
	h.check(stillHeld.held && stillHeld.bytes > 0,
		`but the BYTES are untouched — a delete is a recycle bin, not a remote wipe (${JSON.stringify(stillHeld)})`);
	h.check(
		await B.page.evaluate((hash) => window.__stores.sharedLibrary.canRestoreDeleted(hash), victimFile.hash),
		'so the peer can restore it from its own disk, with nobody else involved'
	);
	const logRow = (await manifestOf(B)).deleted.find((r) => r.hash === victimFile.hash);
	h.check(!!logRow?.by?.id && logRow.name === 'doomed.txt' && logRow.at > 0,
		`the log says what, who and when (${JSON.stringify(logRow)})`);

	// ---- 40. RESTORE puts it back for everyone -----------------------------------
	await B.page.evaluate((hash) => window.__stores.sharedLibrary.restoreDeletedItem(hash), victimFile.hash);
	await h.eventually(
		() => manifestOf(A),
		(m) =>
			(m.items ?? []).some((r) => r.hash === victimFile.hash) &&
			!(m.deleted ?? []).some((r) => r.hash === victimFile.hash),
		'restoring re-publishes the row AND clears the log entry'
	);
	await h.eventually(
		() => itemsOf(B),
		(items) => items.find((i) => i.hash === victimFile.hash)?.share === 'mine',
		'the restorer becomes its publisher — it was shared when it was deleted'
	);
	// the tombstone has to be lifted too, or the row we just published is filtered out
	h.check(!(await manifestOf(A)).removed?.items?.[victimFile.hash],
		'and the tombstone is lifted, so the restored row survives the next publish');

	// ---- 41. the Deleted view, driven through the real UI -------------------------
	const gone = await A.page.evaluate(async () => {
		const item = await window.__stores.explorer.addItemFromBytes(
			new TextEncoder().encode('for the recycle bin view').buffer,
			'binview.txt',
			null
		);
		const sl = window.__stores.sharedLibrary;
		sl.shareItem(item.id);
		sl.publishMine(true);
		sl.deleteSharedItem(item.id);
		return item.hash;
	});
	await A.page.waitForTimeout(700);
	h.check((await A.page.locator('#deleted-folder').count()) === 1,
		'a Deleted row appears in the tree once something is in the bin');
	await A.page.locator('#deleted-folder').click();
	await A.page.waitForTimeout(500);
	const binCard = A.page.locator('[data-card-id="deleted:' + gone + '"]');
	h.check((await binCard.count()) === 1, 'the deleted file is listed there');
	await binCard.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const binMenu = await A.page.locator('[role=menu]').first().innerText();
	h.check(/Restore/.test(binMenu), 'with a Restore that works, because the bytes are still here');
	h.check(/Delete permanently/.test(binMenu), 'and a permanent delete for reclaiming the disk');
	h.check(/Deleted by/.test(binMenu), 'and it names who deleted it and when');
	await A.page.locator('[role=menu]').getByText('Restore', { exact: true }).first().click();
	await h.eventually(
		() => manifestOf(A),
		(m) => !(m.deleted ?? []).some((r) => r.hash === gone),
		'Restore from the menu empties it out of the bin'
	);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(300);

	// ---- 42. a LOCAL file keeps the plain delete ---------------------------------
	//
	// There is nobody to tell, so "Delete for everyone" would be a claim about an audience
	// that does not exist.
	// in its OWN folder, so the card renders first — top-left of an otherwise empty grid.
	// By this point the root holds a couple of dozen cards, and the last one lands under the
	// Controls HUD in the bottom-right, where playwright correctly refuses to click it
	// (measured: a `Rotate (2)` toolbar button intercepting the press).
	const localFile = await A.page.evaluate(async () => {
		const e = window.__stores.explorer;
		const folder = e.createFolder('Local corner', null);
		const item = await e.addItemFromBytes(
			new TextEncoder().encode('mine alone').buffer,
			'localonly.txt',
			folder.id
		);
		e.activeFolder.set(folder.id);
		return item.id;
	});
	await A.page.waitForTimeout(700);
	await A.page.locator('[data-card-id="' + localFile + '"]').click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const localMenu = await A.page.locator('[role=menu]').first().innerText();
	h.check(/^Delete$/m.test(localMenu) && !/Delete for everyone/.test(localMenu),
		'a local file offers a plain Delete, not one that claims to reach peers');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// ================================================================================
	// ROUND 5 — two reported bugs, the unreachable-file case, and the bin's settings.

	// ---- 43. BUG 2: one file, ONE ledger row -------------------------------------
	//
	// Reported: share two files, and the receiving peer sticks at "Downloading 2 files,
	// 50%" with BOTH already downloaded and duplicate rows queued in the log. The pull
	// opened a row and the transfer that answered it opened another, so every download
	// left an unresolved 'queued' row behind — and the summary counted it forever.
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	await B.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	const pair = await A.page.evaluate(async () => {
		const e = window.__stores.explorer;
		const sl = window.__stores.sharedLibrary;
		const a = await e.addItemFromBytes(new TextEncoder().encode('pair one').buffer, 'pair1.txt', null);
		const b = await e.addItemFromBytes(new TextEncoder().encode('pair two').buffer, 'pair2.txt', null);
		sl.shareItem(a.id);
		sl.shareItem(b.id);
		sl.publishMine(true);
		return [a.hash, b.hash];
	});
	await h.eventually(
		() => itemsOf(B),
		(items) => pair.every((hash) => items.some((i) => i.hash === hash)),
		'the peer downloads both shared files'
	);
	// THE BUG, asserted: no row may be left behind, and the summary must reach zero
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let v;
				window.__stores.transferLedger.transferSummary.subscribe((x) => (v = x))();
				return v;
			}),
		(sum) => sum.left === 0,
		'the transfer summary EMPTIES when the downloads finish — no phantom 50%'
	);
	const rowsPerHash = await B.page.evaluate((hashes) => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return hashes.map((hash) => v.filter((t) => t.hash === hash && t.dir === 'in').map((t) => t.state));
	}, pair);
	h.check(
		rowsPerHash.every((states) => states.length === 1 && states[0] === 'done'),
		`exactly ONE finished row per downloaded file, not two (${JSON.stringify(rowsPerHash)})`
	);

	// ---- 44. BUG 1: the tint applies to the FIRST file in a session ---------------
	//
	// Reported: connect two peers, drop one file — it is not greyed, though nobody else
	// can see it. Drop more and they are. The distinction used to wait for something in
	// the project to be shared; in a session the question exists from the first file.
	await A.page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
		window.__stores.sharedLibrary.publishMine(true);
	});
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(700);
	const firstFile = await addFile(A, 'the very first one', 'first.txt');
	await h.eventually(
		() => A.page.locator('[data-card-id="' + firstFile.id + '"]').count(),
		(n) => n === 1,
		'the first file has a card'
	);
	const firstTint = await A.page.evaluate((id) => {
		const card = document.querySelector('[data-card-id="' + id + '"]');
		const label = card?.querySelector('span:last-of-type');
		const icon = card?.querySelector('span.rounded-sm');
		return {
			label: label ? getComputedStyle(label).color : '',
			icon: icon ? getComputedStyle(icon).color : ''
		};
	}, firstFile.id);
	// muted is text-gray-500/600; unmuted is text-gray-300. Compare against the SECOND
	// file rather than pinning a literal: what matters is that the FIRST one is not
	// treated differently from the ones after it.
	const secondFile = await addFile(A, 'and the second', 'second.txt');
	await A.page.waitForTimeout(600);
	const secondTint = await A.page.evaluate((id) => {
		const card = document.querySelector('[data-card-id="' + id + '"]');
		const label = card?.querySelector('span:last-of-type');
		return label ? getComputedStyle(label).color : '';
	}, secondFile.id);
	h.check(!!firstTint.label && firstTint.label === secondTint,
		`the FIRST file is muted exactly like the ones after it (${firstTint.label} vs ${secondTint})`);
	h.check(
		await A.page.evaluate(() => {
			let v;
			window.__stores.peers.subscribe((x) => (v = x))();
			// a SET: `.length` on one is undefined, which is what this check caught
			return (v?.openedPeers?.size ?? 0) > 0;
		}),
		'...and the reason is that there is a peer to be distinguished from'
	);

	// ---- 45. a file NOBODY here holds says so -------------------------------------
	//
	// The honest answer to "the only peer who had it left". Redundancy is the real fix
	// and it already ships (auto-download is on by default, so everybody holds
	// everything), but a manual session can still reach this, and a card that looks like
	// a download which never finishes is worse than one that admits the file is gone.
	const orphanHash = 'c0ffee'.padEnd(64, '1');
	await B.page.evaluate(async (hash) => {
		// forge an index row for bytes nobody has, which is exactly the state a departed
		// peer leaves behind
		const pm = window.__stores.projectManifest;
		let m;
		pm.projectManifest.subscribe((v) => (m = v))();
		pm.publishSharedIndex(
			m.folders ?? [],
			[...(m.items ?? []), { hash, name: 'orphan.txt', kind: 'text', folderId: null, at: Date.now() }],
			m.removed,
			m.deleted
		);
	}, orphanHash);
	await A.page.evaluate((hash) => window.__stores.sharedLibrary.pullSharedItem(hash), orphanHash);
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let v;
				window.__stores.assetShare.unavailableHashes.subscribe((x) => (v = x))();
				return [...v];
			}),
		(list) => list.includes(orphanHash),
		'a hash no peer holds is recorded as UNAVAILABLE rather than pending forever'
	);
	// and a NEW PEER is new evidence: everything given up on is worth one more ask
	const revived = await A.page.evaluate(() => window.__stores.assetShare.retryUnavailable());
	h.check(revived >= 1, `an arriving peer revives what we gave up on (${revived} hashes)`);
	h.check(
		(await A.page.evaluate(() => {
			let v;
			window.__stores.assetShare.unavailableHashes.subscribe((x) => (v = x))();
			return [...v];
		})).length === 0,
		'...and the unavailable list is cleared so the retry can actually happen'
	);

	// ---- 46. the recycle bin's two settings --------------------------------------
	const binPrefs = await A.page.evaluate(() => {
		const sl = window.__stores.sharedLibrary;
		let bin, keep;
		sl.recycleBinEnabled.subscribe((v) => (bin = v))();
		sl.keepRecycleBin.subscribe((v) => (keep = v))();
		return { bin, keep };
	});
	h.check(binPrefs.bin === true, 'the recycle bin is ON by default — a delete reaches peers, so it must be reversible');
	h.check(binPrefs.keep === false, 'and it does NOT survive a reload by default: a safety net, not storage');

	// the bin OFF means a delete is immediate here
	const immediate = await A.page.evaluate(async () => {
		const sl = window.__stores.sharedLibrary;
		const e = window.__stores.explorer;
		sl.recycleBinEnabled.set(false);
		const item = await e.addItemFromBytes(new TextEncoder().encode('no second chance').buffer, 'nobin.txt', null);
		sl.shareItem(item.id);
		sl.publishMine(true);
		sl.deleteSharedItem(item.id);
		return item.hash;
	});
	await h.eventually(
		() => A.page.evaluate((hash) => !window.__stores.explorer.itemByHash(hash), immediate),
		(gone) => gone === true,
		'with the bin off the bytes go straight away'
	);
	h.check(
		await A.page.evaluate((hash) => (
			(() => {
				let m;
				window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
				return (m.deleted ?? []).some((r) => r.hash === hash);
			})()
		), immediate),
		'...but the LOG entry still exists — "this was deleted" stays true whatever the setting'
	);
	await A.page.evaluate(() => window.__stores.sharedLibrary.recycleBinEnabled.set(true));

	// emptying on load reclaims bytes and leaves the log alone
	const reclaimed = await A.page.evaluate(async () => {
		const sl = window.__stores.sharedLibrary;
		const e = window.__stores.explorer;
		const item = await e.addItemFromBytes(new TextEncoder().encode('reclaim me').buffer, 'reclaim.txt', null);
		sl.shareItem(item.id);
		sl.publishMine(true);
		sl.deleteSharedItem(item.id);
		await new Promise((r) => setTimeout(r, 400));
		const beforeHeld = !!e.itemByHash(item.hash);
		const n = await sl.emptyRecycleBinOnLoad();
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return {
			beforeHeld,
			n,
			afterHeld: !!e.itemByHash(item.hash),
			logKept: (m.deleted ?? []).some((r) => r.hash === item.hash)
		};
	});
	h.check(reclaimed.beforeHeld && !reclaimed.afterHeld,
		`emptying the bin reclaims the bytes (${JSON.stringify(reclaimed)})`);
	h.check(reclaimed.logKept, 'and leaves the deleted LOG alone — it is project data, not local bytes');

	// ---- 47. Settings: the file rows live in their own Explorer section -----------
	await A.page.evaluate(() => window.__stores.settingsOpen?.set?.(true));
	await A.page.waitForTimeout(400);
	const hasExplorerSection = await A.page.evaluate(() =>
		[...document.querySelectorAll('h2')].some((h) => (h.textContent || '').trim() === 'Explorer')
	);
	h.check(hasExplorerSection, 'Settings has an Explorer section of its own');
	// CLOSE IT. A modal left open is a full-viewport click shield for everything after it
	// — measured as a 30s timeout on the next press, with an Accordion header reported as
	// the intercepting element.
	await A.page.evaluate(() => window.__stores.settingsOpen?.set?.(null));
	await A.page.waitForTimeout(400);

	// ================================================================================
	// ROUND 6 — the transfer indicator redesigned.

	// ---- 48. the BATCH, which is what makes a percentage mean anything ------------
	//
	// Counting every row the ledger holds means the fiftieth download of a session reads
	// 50/51 = 98% before it has moved a byte, and the bar effectively stops. A batch opens
	// when work starts from rest, so a new run always begins at 0 — which is also why
	// connecting to a new host needs no reset.
	const batching = await A.page.evaluate(async () => {
		const tl = window.__stores.transferLedger;
		tl.transfers.set([]);
		const read = () => {
			let v;
			tl.transferSummary.subscribe((x) => (v = x))();
			return v;
		};
		// batch 1: two files, both finish
		const a = tl.beginTransfer({ hash: 'b1a', name: 'a', dir: 'in', size: 100 });
		const b = tl.beginTransfer({ hash: 'b1b', name: 'b', dir: 'in', size: 100 });
		tl.finishTransfer(a);
		tl.finishTransfer(b);
		const settled = read();
		// batch 2: one new file from rest — it must NOT inherit batch 1's denominator
		const c = tl.beginTransfer({ hash: 'b2a', name: 'c', dir: 'in', size: 100 });
		const fresh = read();
		tl.progressTransfer(c, 50);
		const half = read();
		tl.finishTransfer(c);
		return { settled, fresh, half };
	});
	h.check(batching.settled.pct === 100, `a finished batch reads 100%, not zero (${batching.settled.pct}%)`);
	h.check(batching.fresh.inBatch === 1 && batching.fresh.pct === 0,
		`a NEW batch starts at 0% and counts only itself (${JSON.stringify(batching.fresh)})`);
	h.check(batching.half.pct === 50,
		`...so its halfway point is 50%, not 83% (${batching.half.pct}%) — the bug a global count causes`);

	// ---- 49. the four states -------------------------------------------------------
	const states = await A.page.evaluate(() => {
		const tl = window.__stores.transferLedger;
		const s = (summary, connected) => tl.indicatorState(summary, connected);
		return {
			offline: s({ left: 0, failed: 0 }, false),
			idle: s({ left: 0, failed: 0 }, true),
			active: s({ left: 2, failed: 0 }, true),
			failed: s({ left: 0, failed: 1 }, true),
			// working beats complaining: something is happening, and that is the more useful
			// thing to report while it is
			busyWithFailures: s({ left: 1, failed: 3 }, true)
		};
	});
	h.check(
		states.offline === 'offline' &&
			states.idle === 'idle' &&
			states.active === 'active' &&
			states.failed === 'failed',
		`the four states resolve as expected (${JSON.stringify(states)})`
	);
	h.check(states.busyWithFailures === 'active',
		'work in progress outranks a past failure — the indicator reports what is happening now');

	// ---- 50. always visible, no chevron, after the filter -------------------------
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	await A.page.waitForTimeout(400);
	const pill = A.page.locator('#explorer-transfers');
	h.check((await pill.count()) === 1, 'the indicator is present with nothing in flight');
	const chrome = await A.page.evaluate(() => {
		const filter = document.querySelector('#explorer-filter');
		const tx = document.querySelector('#explorer-transfers');
		if (!filter || !tx) return null;
		const f = filter.getBoundingClientRect();
		const t = tx.getBoundingClientRect();
		return {
			afterFilter: t.left >= f.right - 2,
			text: (tx.textContent || '').trim(),
			label: tx.getAttribute('aria-label') ?? ''
		};
	});
	h.check(!!chrome && chrome.afterFilter, `it sits AFTER the filter button (${JSON.stringify(chrome)})`);
	h.check(!/⌄|▾|▼/.test(chrome?.text ?? ''), 'and carries no chevron — the pill IS the button');
	h.check(/peers|Up to date/i.test(chrome?.label ?? ''),
		`with an idle state that says something true (${JSON.stringify(chrome?.label)})`);

	// the popover opens and reports the idle/offline case rather than a bare 0%
	await pill.click();
	await A.page.waitForTimeout(300);
	const idlePop = await A.page.locator('.tx-popover').first().innerText();
	h.check(/Up to date|Not connected/.test(idlePop),
		`the popover is honest when nothing is moving (${JSON.stringify(idlePop.split('\n')[0])})`);
	await A.page.locator('.tx-backdrop').first().click({ position: { x: 5, y: 5 } });
	await A.page.waitForTimeout(200);

	// ---- 51. "+N more" is a CONTROL ------------------------------------------------
	await A.page.evaluate(() => {
		const tl = window.__stores.transferLedger;
		tl.transfers.set([]);
		for (let i = 0; i < 7; i++)
			tl.activateTransfer(
				tl.beginTransfer({ hash: 'many' + i, name: 'many' + i + '.bin', dir: 'in', size: 1000 }),
				1000
			);
	});
	await A.page.waitForTimeout(400);
	await A.page.locator('#explorer-transfers').click();
	await A.page.waitForTimeout(300);
	const moreBtn = A.page.locator('#explorer-transfers-more');
	h.check((await moreBtn.count()) === 1, 'a long list offers "+N more"');
	const beforeRows = await A.page.locator('.tx-pop-row').count();
	await moreBtn.click();
	await A.page.waitForTimeout(300);
	const afterRows = await A.page.locator('.tx-pop-row').count();
	h.check(afterRows > beforeRows,
		`clicking it EXPANDS the list rather than being a caption (${beforeRows} -> ${afterRows})`);
	h.check(/Show less/.test(await moreBtn.innerText()), 'and it turns into the way back');
	await A.page.locator('.tx-backdrop').first().click({ position: { x: 5, y: 5 } });
	await A.page.waitForTimeout(200);

	// ---- 52. per-row actions, and RETRY that actually retries ---------------------
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	const retryHash = 'facade'.padEnd(64, '7');
	await A.page.evaluate((hash) => {
		const tl = window.__stores.transferLedger;
		const id = tl.beginTransfer({ hash, name: 'retryme.bin', dir: 'in', size: 500 });
		tl.failTransfer(id, 'no peer has this file');
	}, retryHash);
	await A.page.waitForTimeout(400);
	// the pill goes to the failed state and offers a bulk retry
	const failLabel = await A.page.locator('#explorer-transfers').getAttribute('aria-label');
	h.check(/did not finish/.test(failLabel ?? ''),
		`a failure keeps the indicator visible and says so (${JSON.stringify(failLabel)})`);
	await A.page.locator('#explorer-transfers').click();
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#explorer-transfers-retry').count()) === 1,
		'the popover offers "Retry N failed" — a failure you cannot retry is just a complaint');
	await A.page.locator('.tx-backdrop').first().click({ position: { x: 5, y: 5 } });
	await A.page.waitForTimeout(200);

	// ...and the per-row menu in the log
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
	await A.page.evaluate((hash) => {
		const tl = window.__stores.transferLedger;
		const id = tl.beginTransfer({ hash, name: 'rowmenu.bin', dir: 'in', size: 500 });
		tl.failTransfer(id, 'nobody answered');
	}, retryHash);
	await A.page.waitForTimeout(300);
	// the pane may already be open from section 36 — `logOpen` is a TOGGLE, and clicking
	// it blindly closes what an earlier section left open
	if ((await A.page.locator('.tx-log').count()) === 0) {
		await A.page.locator('#explorer-transfers').click();
		await A.page.waitForTimeout(250);
		await A.page.locator('#explorer-transfers-logs').click();
		await A.page.waitForTimeout(400);
	}
	h.check((await A.page.locator('.tx-log').count()) === 1, 'the log pane is open');
	await A.page.locator('.tx-row-more').first().click();
	await A.page.waitForTimeout(300);
	const rowMenuText = await A.page.locator('[role=menu]').first().innerText();
	h.check(/Retry/.test(rowMenuText), 'a failed row offers Retry');
	h.check(/Remove from log/.test(rowMenuText), 'and a way to drop the row');
	h.check(/nobody answered/i.test(rowMenuText),
		`and the REASON it failed — the one thing a toast cannot carry (${JSON.stringify(rowMenuText)})`);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// a QUEUED incoming row offers Cancel, and an OUTGOING one does not: cancelling
	// somebody else's download from this side would hand them a failure they cannot act on
	await A.page.evaluate(() => {
		const tl = window.__stores.transferLedger;
		tl.transfers.set([]);
		tl.activateTransfer(tl.beginTransfer({ hash: 'out1', name: 'sending.bin', dir: 'out', size: 900 }), 900);
	});
	await A.page.waitForTimeout(400);
	await A.page.locator('.tx-row-more').first().click();
	await A.page.waitForTimeout(300);
	const outMenu = await A.page.locator('[role=menu]').first().innerText();
	h.check(!/Cancel/.test(outMenu),
		`an OUTGOING transfer offers no Cancel (${JSON.stringify(outMenu.replace(/\n/g, ' | '))})`);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));

	// ---- 53. the log pane closes from its OWN ✕ ----------------------------------
	//
	// It did nothing: the pane instance was rendered WITHOUT `bind:open`, so writing the
	// prop mutated that component's local copy and the Explorer never heard about it. A
	// $bindable prop is only two-way for the caller that actually binds it.
	if ((await A.page.locator('.tx-log').count()) === 0) {
		await A.page.locator('#explorer-transfers').click();
		await A.page.waitForTimeout(250);
		await A.page.locator('#explorer-transfers-logs').click();
		await A.page.waitForTimeout(400);
	}
	h.check((await A.page.locator('.tx-log').count()) === 1, 'the log pane is open to close');
	await A.page.locator('#explorer-transfers-hide').click();
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('.tx-log').count()) === 0,
		'its own ✕ closes it — the pane owns a way out that does not live in another popover');

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
