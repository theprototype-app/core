// R22-R1/R2/R3 — THE SHARED LIBRARY: the Explorer's index, replicated.
//
// THE FINDING THIS EXISTS FOR. Before R1 the Explorer library did not replicate at all
// — no message carried folders and none carried item rows. What replicated was the
// project MANIFEST (scene name -> a history of hashes), so a session agreed on WHICH
// SCENES EXIST and on nothing whatever about where anything lives. A joiner saw a
// `Shared` folder that `applyAssetFile` had invented locally, and a scene a peer added
// reached them as a manifest pointer with no card. This module closes that gap and
// nothing else: the INDEX replicates, per-item opt-in, and the BYTES keep riding
// `assetfile`/`getasset` exactly as they have since golden rule 9.
//
// THE MODEL is `objectPermissions.js` one domain over, which is why the vocabulary is
// already familiar: an object a viewer makes is `__localOnly` until they press Share,
// and a FILE is local until somebody presses Share. Absent = local, so every library
// that already exists is private with no migration step — see the `share` flag's
// contract on `explorerItems` in explorer.js.
//
// ---------------------------------------------------------------------------------
// THE ONE HARD PART: A WHOLE-DOCUMENT LATEST-WINS SINGLETON WITH SEVERAL AUTHORS.
//
// The manifest is `{...doc, changedAt}` latest-wins on a monotonic stamp. That is right
// for scenes (a scene's history is append-only, so nothing is destroyed) and it is NOT
// enough here: two peers pressing Share inside the same millisecond both build their
// document from a view that lacks the other's row, and whole-document latest-wins then
// drops the loser's file on the floor. "I shared it and it vanished" is the failure
// this module has to make impossible.
//
// The tempting fix is per-row stamps and delete tombstones. `hudDocs` already argued
// that one down — per-element needs its own ordering, its own latest-wins and its own
// tombstone lifetime — and it is not needed, because there is a cheaper invariant:
//
//   ONE WRITER PER ROW, and the writer is whoever HOLDS the file (the `peerVars` rule).
//
// Concretely, three rules:
//
//   1. WHAT WE PUBLISH is our own shared rows, PLUS every foreign row the document
//      already carried. Ours we know from the local records; theirs we pass through
//      verbatim. So no publish of ours can ever be the thing that deletes somebody
//      else's file.
//   2. UNSHARE IS AUTHORITATIVE because of rule 1: the owner publishes a document
//      without its row, and nobody else re-adds it — we only ever carry rows that are
//      currently IN the document, never rows we remember.
//   3. THE RECONCILE. On receiving a document, if a row of OURS is missing from it, we
//      re-publish. That is the union the plan asks for, performed by the only peer
//      entitled to perform it, and it converges the concurrent-Share race in one round
//      with no tombstones anywhere.
//
// It TERMINATES because `publishSharedIndex` is idempotent on CONTENT: once the
// document holds everything, a re-publish writes nothing, so there is no stamp to
// ping-pong. The debounce below is a batching convenience, not the thing that stops a
// storm.
//
// ---------------------------------------------------------------------------------
// TWO IDENTITIES. An ITEM is its content hash — two peers holding one file have
// different local record ids and the same hash, which is also why unshare can never
// destroy a peer's copy. A shared FOLDER's id is NETWORK identity: an adopting peer
// creates the folder under that exact uuid, so every `folderId` reference resolves
// everywhere with no remapping.
//
// PLACEMENT IS CLAMPED, NOT CASCADED. Sharing a folder does not share its ancestors —
// that would hand peers the names of folders nobody offered. A shared row whose parent
// is not itself shared publishes with a null parent, so it lands at the peer's library
// root. The LOCAL tree is never touched by this: clamping happens at projection time.
//
// A LEAF as far as the history cycle goes: explorer + projectManifest + assetShare +
// cloudHooks + appStore. Nothing here registers a history kind, and sharing is not an
// undoable edit — it is a statement about who may see a file, not a change to one.
//
// FORK 3 is inherited rather than re-implemented: every write lands in
// `publishSharedIndex`, which refuses for a viewer.

import { get, writable } from 'svelte/store';
import { peers, userdata, showToast } from '../stores/appStore';
import {
	explorerFolders,
	explorerItems,
	hiddenItems,
	createFolder,
	patchRecord,
	folderSubtree,
	itemByHash
} from './explorer';
import {
	projectManifest,
	publishSharedIndex,
	registerSharedIndexListener
} from './projectManifest';
import { requestAsset } from './assetShare';
import { ownerStamp } from './cloudHooks';

/**
 * Hashes we have ASKED the mesh for and not yet received. A remote card with nothing to
 * show would otherwise read as dead the moment it is clicked — `requestAsset` is
 * fire-and-forget behind a one-ask-per-session guard, so this is the only place a
 * "fetching" state can live. Cleared when the bytes LAND (the item appears) rather than
 * on a timer, because a peer holding them may simply be slow.
 * @type {import('svelte/store').Writable<Set<string>>} */
export const pendingPulls = writable(new Set());

// ---- who we are ------------------------------------------------------------------

/** Our own peer id, or '' before the mesh is up. */
function myPeerId() {
	return String(/** @type {any} */ (get(peers))?.peer?.id ?? '');
}

/** The owner stamp for a row we publish: peer id + the nickname the roster already
 * replicates (slot 1) + an account name if the cloud plugin vouched for one. */
function meAsOwner() {
	const id = myPeerId();
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((e) => e?.[0] === id);
	return ownerStamp(id, row?.[1] ?? '');
}

// ---- reads -----------------------------------------------------------------------

/** Is anything in this project shared? Drives the Explorer's local/shared distinction,
 * which is pure noise in a project that has never shared a thing. */
export function sharedIndexInUse() {
	const m = get(projectManifest);
	return (m.items ?? []).length > 0 || (m.folders ?? []).length > 0;
}

/** Every content hash this machine holds, on either shelf. @returns {Set<string>} */
function heldHashes() {
	return new Set([...get(explorerItems), ...get(hiddenItems)].map((i) => i.hash));
}

/**
 * The shared rows whose BYTES are not on this machine — the Explorer renders one card
 * each, dimmed, and opening one pulls it. Deliberately DERIVED and never stored: an
 * index row is not a library record, and writing one would leave a phantom card behind
 * the moment the owner unshared it.
 * @param {any} manifest pass `$projectManifest` so a component stays reactive — a
 *   helper reading through get() registers no dependency (the documented rule)
 * @returns {any[]}
 */
export function remoteSharedRows(manifest) {
	const held = heldHashes();
	return (manifest?.items ?? []).filter((/** @type {any} */ r) => r?.hash && !held.has(r.hash));
}

/** Ask the mesh for a shared file we do not hold. @param {string} hash */
export function pullSharedItem(hash) {
	const h = String(hash ?? '').trim();
	if (!h || itemByHash(h)) return false;
	pendingPulls.update((s) => new Set([...s, h]));
	requestAsset(h);
	return true;
}

// ---- the projection ---------------------------------------------------------------

/**
 * WHAT WE PUBLISH. Our own shared records projected into rows, with placement CLAMPED
 * to the shared tree, plus every foreign row the document already carried (rule 1 in
 * the header — a publish of ours may never be the thing that drops somebody else's
 * file).
 * @returns {{folders: any[], items: any[]}}
 */
function projection() {
	const doc = get(projectManifest);
	const owner = meAsOwner();
	const now = Date.now();

	/**
	 * `at` MUST BE STABLE FOR AN UNCHANGED ROW, or `publishSharedIndex`'s content compare
	 * sees a difference on every call and the whole idempotence argument — the thing that
	 * stops the reconcile becoming a stamp ping-pong — quietly stops holding. So a row
	 * keeps the stamp the document already gave it and takes a fresh one only when
	 * something about it actually moved.
	 * @param {any} row @param {'id'|'hash'} key
	 */
	const stamp = (row, key) => {
		const prev = (key === 'hash' ? (doc.items ?? []) : (doc.folders ?? [])).find(
			(/** @type {any} */ r) => r[key] === row[key]
		);
		if (prev) {
			const { at: _drop, ...was } = prev;
			if (JSON.stringify(was) === JSON.stringify(row)) return { ...row, at: prev.at ?? now };
		}
		return { ...row, at: now };
	};

	const mineFolders = get(explorerFolders).filter((f) => f.share === 'mine');
	const sharedFolderIds = new Set(mineFolders.map((f) => f.id));
	// a peer's shared folder is a legitimate parent for one of ours: the tree the row
	// graph describes is the union of everybody's, not just what we published
	for (const row of doc.folders ?? []) if (row?.id) sharedFolderIds.add(row.id);

	/** placement a peer can actually resolve: null unless the parent is shared too */
	const clamp = (/** @type {string|null|undefined} */ id) =>
		id && sharedFolderIds.has(id) ? id : null;

	/** @type {any[]} */
	const folders = mineFolders.map((f) =>
		stamp({ id: f.id, name: f.name, parentId: clamp(f.parentId), owner }, 'id')
	);
	/** @type {any[]} */
	const items = get(explorerItems)
		.filter((i) => i.share === 'mine')
		.map((i) =>
			stamp(
				{ hash: i.hash, name: i.name, kind: i.kind, folderId: clamp(i.folderId), owner },
				'hash'
			)
		);

	// CARRYING THE FOREIGN ROWS, and the one rule that makes unshare possible at all.
	//
	// The first version of this simply kept every document row that was not in our own
	// projection — which meant an unshared file was instantly carried forward AS IF IT
	// WERE SOMEBODY ELSE'S, so unshare could never remove anything. (The suite caught it:
	// the row survived on both peers with its old `at` intact.)
	//
	// The test is the invariant the header states: THE WRITER OF A ROW IS WHOEVER HOLDS
	// THE FILE. So a row we hold no record for is foreign by definition — we could not
	// publish it if we wanted to — and a row we DO hold is foreign only while our record
	// says 'peer'. Anything else (ours, vetoed, or cleared) means our projection above is
	// the authority on it, and its absence there is a removal rather than an omission.
	const myFolderIds = new Set(folders.map((f) => f.id));
	const myHashes = new Set(items.map((i) => i.hash));
	for (const row of doc.folders ?? []) {
		if (myFolderIds.has(row.id)) continue;
		const held = get(explorerFolders).find((f) => f.id === row.id);
		if (!held || held.share === 'peer') folders.push(row);
	}
	for (const row of doc.items ?? []) {
		if (myHashes.has(row.hash)) continue;
		const held = itemByHash(row.hash);
		if (!held || held.share === 'peer') items.push(row);
	}

	return { folders, items };
}

/** @type {any} */
let publishTimer = null;

/**
 * Publish the projection, collapsing a burst (sharing a folder touches every child).
 * @param {boolean} [now] skip the debounce — the reconcile and the tests want
 *   determinism, and a caller that is about to read the document needs it written
 * @returns {boolean}
 */
export function publishMine(now = false) {
	if (publishTimer) {
		clearTimeout(publishTimer);
		publishTimer = null;
	}
	if (now) {
		const { folders, items } = projection();
		return publishSharedIndex(folders, items);
	}
	publishTimer = setTimeout(() => {
		publishTimer = null;
		const { folders, items } = projection();
		publishSharedIndex(folders, items);
	}, 150);
	return true;
}

// ---- share / unshare (R2) --------------------------------------------------------

/**
 * Share one library item. Idempotent, and it clears any earlier VETO — pressing Share
 * on a file you once unshared is a decision, not a no-op.
 * @param {string} id @returns {boolean}
 */
export function shareItem(id) {
	const item = get(explorerItems).find((i) => i.id === id);
	if (!item) return false;
	patchRecord(id, { share: 'mine', owner: meAsOwner(), wasShared: undefined });
	publishMine();
	return true;
}

/**
 * Stop publishing an item's placement. THE RULE THE PLAN IS EMPHATIC ABOUT: this can
 * never delete a peer's copy, and hash-addressing is what gives that for free — the
 * bytes they pulled are theirs, and all that leaves the document is the placement.
 *
 * `share: 'no'` rather than absent is the difference between "never decided" and
 * "decided against", and only the second one survives the inheritance sweep — without
 * it, unsharing a file that sits in a shared folder would put it straight back.
 * @param {string} id @returns {boolean}
 */
export function unshareItem(id) {
	const item = get(explorerItems).find((i) => i.id === id);
	if (!item) return false;
	patchRecord(id, { share: 'no', owner: undefined, wasShared: undefined });
	publishMine();
	return true;
}

/**
 * Share a folder — and everything in it, now and later (the folder is the unit of
 * intent: someone who shares `Textures` means the textures). The sweep at the bottom of
 * this module is the "and later" half.
 *
 * SUBTREE, not just the direct children: a subfolder of a shared folder is shared, or
 * the peer receives a folder with a hole in it.
 * @param {string} id @returns {boolean}
 */
export function shareFolder(id) {
	const ids = folderSubtree(id);
	if (!ids.length) return false;
	const owner = meAsOwner();
	for (const fid of ids) patchRecord(fid, { share: 'mine', owner, wasShared: undefined }, 'folder');
	for (const item of get(explorerItems))
		// a VETO inside the folder is honoured — sharing the folder is not a licence to
		// overturn a decision the user made about one file
		if (ids.includes(item.folderId ?? '') && item.share !== 'no' && item.share !== 'peer')
			patchRecord(item.id, { share: 'mine', owner, wasShared: undefined });
	publishMine();
	return true;
}

/**
 * Unshare a folder and its subtree. Same guarantee as unshareItem: peers keep what they
 * pulled. Clears to ABSENT rather than to the veto — a folder is a place, and "this
 * place is not shared" is the default state rather than a decision about one file.
 * @param {string} id @returns {boolean}
 */
export function unshareFolder(id) {
	const ids = folderSubtree(id);
	if (!ids.length) return false;
	for (const fid of ids)
		patchRecord(fid, { share: undefined, owner: undefined, wasShared: undefined }, 'folder');
	for (const item of get(explorerItems))
		if (ids.includes(item.folderId ?? '') && item.share === 'mine')
			patchRecord(item.id, { share: undefined, owner: undefined, wasShared: undefined });
	publishMine();
	return true;
}

/** Is this record shared, and by whom? @param {any} row
 * @returns {{shared: boolean, mine: boolean, owner: any}} */
export function shareStateOf(row) {
	const share = row?.share;
	return {
		shared: share === 'mine' || share === 'peer',
		mine: share === 'mine',
		owner: row?.owner ?? null
	};
}

// ---- adoption + the reconcile ----------------------------------------------------

/**
 * Apply an index somebody else wrote. Three jobs, in this order:
 *
 *   1. ADOPT FOLDERS. Create a local folder under the row's own uuid (network
 *      identity), parents before children so placement resolves. A row naming a folder
 *      we already publish as 'mine' is left alone — we are its writer.
 *   2. ADOPT ITEMS WE HOLD. The bytes are already here (an assetShare pull, a .tp
 *      import, the same file dropped independently), so all that is missing is the
 *      placement and the mark. An item we do NOT hold gets no record at all — it is a
 *      derived card (`remoteSharedRows`), because a phantom index row would outlive the
 *      share that made it.
 *   3. NOTICE WHAT LEFT. A record marked 'peer' whose row is gone was unshared by its
 *      owner: keep the file, drop the mark, and say so (`wasShared`).
 *
 * Then the reconcile — see rule 3 in the header.
 * @param {any} doc
 */
export function applySharedIndex(doc) {
	const folderRows = doc?.folders ?? [];
	const itemRows = doc?.items ?? [];

	// 1. folders, parents first. Bounded passes rather than a topological sort: the
	// graph is tiny, and a cyclic or orphaned row must land SOMEWHERE rather than
	// vanish (restoreFolderTree's rule, one module over).
	let pending = [...folderRows];
	for (let pass = 0; pass < 8 && pending.length; pass++) {
		/** @type {any[]} */
		const again = [];
		for (const row of pending) {
			const parent = row.parentId ? get(explorerFolders).find((f) => f.id === row.parentId) : null;
			if (row.parentId && !parent) {
				again.push(row);
				continue;
			}
			const held = get(explorerFolders).find((f) => f.id === row.id);
			if (held) {
				// ours stays ours; a peer's row may have been renamed or re-parented
				if (held.share !== 'mine')
					patchRecord(
						row.id,
						{
							share: 'peer',
							owner: row.owner,
							name: row.name,
							parentId: row.parentId ?? null,
							wasShared: undefined
						},
						'folder'
					);
			} else {
				createFolder(row.name, row.parentId ?? null, {
					id: row.id,
					share: 'peer',
					owner: row.owner
				});
			}
		}
		if (again.length === pending.length) {
			// nothing resolved this pass — whatever is left is orphaned; root it
			for (const row of again)
				if (!get(explorerFolders).some((f) => f.id === row.id))
					createFolder(row.name, null, { id: row.id, share: 'peer', owner: row.owner });
			break;
		}
		pending = again;
	}

	// 2. items we hold
	const rowByHash = new Map(itemRows.map((/** @type {any} */ r) => [r.hash, r]));
	for (const row of itemRows) {
		const item = itemByHash(row.hash);
		if (!item) continue;
		if (item.share === 'mine') continue; // we are its writer
		/** @type {any} */
		const patch = { share: 'peer', owner: row.owner, wasShared: undefined };
		// place it where the row says, but only into a folder that exists HERE — a row
		// pointing at a folder nobody shared is placement we cannot honour
		const dest = row.folderId
			? (get(explorerFolders).find((f) => f.id === row.folderId)?.id ?? null)
			: null;
		if ((item.folderId ?? null) !== dest) patch.folderId = dest;
		patchRecord(item.id, patch);
	}

	// 3. what left the index
	let dropped = 0;
	for (const item of get(explorerItems))
		if (item.share === 'peer' && !rowByHash.has(item.hash)) {
			patchRecord(item.id, { share: undefined, owner: undefined, wasShared: true });
			dropped++;
		}
	const liveFolderIds = new Set(folderRows.map((/** @type {any} */ r) => r.id));
	for (const folder of get(explorerFolders))
		if (folder.share === 'peer' && !liveFolderIds.has(folder.id))
			patchRecord(folder.id, { share: undefined, owner: undefined, wasShared: true }, 'folder');
	noticeUnshared(dropped);

	// THE RECONCILE: is anything of OURS missing from the document somebody just wrote?
	const docHashes = new Set(itemRows.map((/** @type {any} */ r) => r.hash));
	const docFolders = new Set(folderRows.map((/** @type {any} */ r) => r.id));
	const lostItem = get(explorerItems).some((i) => i.share === 'mine' && !docHashes.has(i.hash));
	const lostFolder = get(explorerFolders).some((f) => f.share === 'mine' && !docFolders.has(f.id));
	if (lostItem || lostFolder) publishMine();
}

// ---- inheritance (R3, and the user's rule: a shared folder shares what lands in it)

/** the placement+flags we last swept, so an unrelated store write does no work */
let sweptKey = '';
/** @type {any} */
let sweepTimer = null;

/**
 * ADOPT WHAT WE NOW HOLD. A document can arrive long before the bytes it names — that
 * is the whole point of a pull — so `applySharedIndex` alone leaves an arriving file
 * unmarked and unplaced: the suite measured exactly that, a pulled item sitting in
 * assetShare's `Shared` folder with no share flag at all. Same shape as the documented
 * shaderGraph reconcile (a graph can arrive before its object), and the same cure: run
 * it off the LIBRARY too, debounced.
 */
function adoptHeld() {
	const doc = get(projectManifest);
	if (!(doc.items ?? []).length && !(doc.folders ?? []).length) return;
	applySharedIndex(doc);
}

/**
 * NEW CONTENTS OF A SHARED FOLDER ARE SHARED. The folder is the unit of intent, so
 * dropping a file into `Textures` after sharing it must not need a second gesture — and
 * this is also the honest reading of R3: a drop places a file LOCAL, unless it lands
 * somewhere its owner has already declared shared.
 *
 * A SWEEP rather than a hook on each import path, because there are many of those
 * (`importFiles`, `addItemFromBytes`, a pack, a save, drag-to-folder, a .tp merge) and a
 * rule that only holds on the paths somebody remembered to edit is not a rule.
 * Debounced, and it publishes only when it actually marked something.
 *
 * The VETO is what makes this safe: `share: 'no'` survives the sweep, so "I unshared
 * this one file" is not undone a moment later by the folder it happens to sit in.
 */
function sweepInheritance() {
	const shared = new Set(
		get(explorerFolders)
			.filter((f) => f.share === 'mine')
			.map((f) => f.id)
	);
	if (!shared.size) return;
	const owner = meAsOwner();
	let marked = 0;
	for (const item of get(explorerItems)) {
		if (!shared.has(item.folderId ?? '')) continue;
		if (item.share) continue; // 'mine' already, 'peer' theirs, 'no' vetoed
		if (patchRecord(item.id, { share: 'mine', owner, wasShared: undefined })) marked++;
	}
	if (marked) publishMine();
}

function scheduleSweep() {
	// a cheap key: only placement and the share flags can change the answer
	const key =
		get(explorerItems)
			.map((i) => i.id + ':' + (i.folderId ?? '') + ':' + (i.share ?? ''))
			.join('|') +
		'#' +
		get(explorerFolders)
			.map((f) => f.id + ':' + (f.share ?? ''))
			.join('|');
	if (key === sweptKey) return;
	sweptKey = key;
	if (sweepTimer) clearTimeout(sweepTimer);
	sweepTimer = setTimeout(() => {
		sweepTimer = null;
		// adoption FIRST: a file that just arrived must take its share mark before the
		// inheritance sweep looks at it, or a peer's file landing in one of OUR shared
		// folders would be claimed as ours to publish
		adoptHeld();
		sweepInheritance();
	}, 200);
}

/** Clear the pending mark for hashes that have arrived. @param {any[]} items */
function settlePulls(items) {
	const pend = get(pendingPulls);
	if (!pend.size) return;
	const held = new Set(items.map((i) => i.hash));
	let changed = false;
	const next = new Set(pend);
	for (const h of pend)
		if (held.has(h)) {
			next.delete(h);
			changed = true;
		}
	if (changed) pendingPulls.set(next);
}

/** Test seam: the projection this machine WOULD publish, without publishing it. */
export function projectionForTest() {
	return projection();
}

/** A one-line summary for a toast or the Explorer header. */
export function sharedCounts() {
	const m = get(projectManifest);
	const held = heldHashes();
	const rows = m.items ?? [];
	return {
		items: rows.length,
		folders: (m.folders ?? []).length,
		missing: rows.filter((/** @type {any} */ r) => !held.has(r.hash)).length,
		mine: get(explorerItems).filter((i) => i.share === 'mine').length
	};
}

/**
 * R2: a file a peer stopped sharing is still OURS to keep — one counted nudge saying so,
 * rather than a badge per card that nobody reads.
 * @param {number} n
 */
export function noticeUnshared(n) {
	if (n > 0)
		showToast(
			n === 1
				? 'A shared file is no longer shared — your copy is still here'
				: n + ' shared files are no longer shared — your copies are still here'
		);
}

// ---------------------------------------------------------------------------------

let started = false;

/**
 * WIRING. An explicit start called from App.svelte, the `startGamePresence` convention,
 * rather than side effects at module eval — the alternative is relying on somebody's
 * static import to bring this module in, and the only candidate was the debugStores
 * hook, which is opt-in via localStorage. A feature wired by the test hook is a feature
 * that does not exist for users.
 *
 * Everything it touches is declared ABOVE it, which is not decoration: a subscribe runs
 * its callback SYNCHRONOUSLY, and a callback reading a `let` above its declaration
 * TDZ-crashes the SSR prerender (the documented rule, which has cost this project a
 * booting dev server three times). `registerSharedIndexListener` re-applies immediately
 * for the same reason it is last.
 */
export function startSharedLibrary() {
	if (started) return;
	started = true;
	explorerItems.subscribe((items) => {
		settlePulls(items);
		scheduleSweep();
	});
	explorerFolders.subscribe(() => scheduleSweep());
	registerSharedIndexListener((doc) => applySharedIndex(doc));
}
