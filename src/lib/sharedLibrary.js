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
import {
	requestAsset,
	sendAssetThumb,
	forgetSharedThumb,
	loadSharedThumbs,
	sweepStalledTransfers,
	reviveHash
} from './assetShare';
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

/**
 * Is anything in this project shared? Drives the Explorer's local/shared distinction,
 * which is pure noise in a project that has never shared a thing.
 * @param {any} [manifest] pass `$projectManifest` from a component — a helper reading
 *   the store through get() registers no svelte dependency (the documented rule), so
 *   the distinction would appear only on the next unrelated re-render. Omitted, it
 *   reads the live document, which is what a non-reactive caller wants.
 */
export function sharedIndexInUse(manifest) {
	const m = manifest ?? get(projectManifest);
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
	// somebody PRESSED this, so a previous failure is not an answer: clear the
	// gave-up-on-it mark before asking (auto-download does not get this — an automatic
	// retry loop is exactly what the mark exists to stop)
	reviveHash(h);
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
 * @returns {{folders: any[], items: any[], removed: any}}
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

	// PLACEMENT CASCADES (locked answer, R22 round 2). Sharing a folder publishes its
	// ANCESTORS too, so every peer sees the same tree you do — "all peers have project
	// folder consistency" was the deciding requirement, and the alternative (clamping a
	// shared folder to the root when its parent is private) produced exactly the
	// complaint that a shared folder's contents seemed not to arrive: they had, one level
	// up from where the author was looking.
	//
	// The ancestors are published as PLACEMENT ONLY. A folder that is shared merely to
	// carry a path is not marked shared locally and holds no files of its own on the wire
	// — its own contents are published one by one as they are shared, which is the second
	// half of the same answer ("if I create new files in unshared folders, they also
	// should be shared individually").
	const allFolders = get(explorerFolders);
	const byId = new Map(allFolders.map((f) => [f.id, f]));
	const mineFolders = allFolders.filter((f) => f.share === 'mine');
	const mineItems = get(explorerItems).filter((i) => i.share === 'mine');

	/** every folder id we must publish: the ones we shared, plus the ancestor chain of
	 * each of those AND of every shared item, so no `folderId` can dangle. */
	/** @type {Set<string>} */
	const needed = new Set();
	const addChain = (/** @type {string|null|undefined} */ id) => {
		let at = id ?? null;
		// a bounded walk: a cyclic tree is impossible through moveFolder, but a corrupted
		// index must not hang the projection
		for (let i = 0; at && i < 64; i++) {
			if (needed.has(at)) break;
			needed.add(at);
			at = byId.get(at)?.parentId ?? null;
		}
	};
	for (const f of mineFolders) addChain(f.id);
	for (const i of mineItems) addChain(i.folderId);

	/** @type {any[]} */
	const folders = [...needed]
		.map((id) => byId.get(id))
		.filter(Boolean)
		.map((/** @type {any} */ f) =>
			stamp({ id: f.id, name: f.name, parentId: f.parentId ?? null, owner }, 'id')
		);
	/** @type {any[]} */
	const items = mineItems.map((i) =>
		stamp(
			{ hash: i.hash, name: i.name, kind: i.kind, folderId: i.folderId ?? null, owner },
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

	// THE TOMBSTONES have the last word, and they are what makes "anyone may unshare"
	// safe. Without them, removal is only authoritative from the peer that published the
	// row — the owner's reconcile would resurrect anybody else's removal on its next
	// publish, and the two of them would take turns forever. A tombstone is a removal
	// somebody MEANT, so it beats a carried-forward row and it beats the reconcile.
	//
	// A re-share writes a row with a newer `at` and DELETES the tombstone (see shareItem),
	// so this is not a one-way door.
	/** @type {any} */
	const removed = doc.removed ?? {};
	const tombF = removed.folders ?? {};
	const tombI = removed.items ?? {};
	const live = (/** @type {any} */ row, /** @type {any} */ tombs, /** @type {string} */ key) => {
		const at = Number(tombs[row[key]]);
		return !Number.isFinite(at) || (Number(row.at) || 0) > at;
	};
	return {
		folders: folders.filter((r) => live(r, tombF, 'id')),
		items: items.filter((r) => live(r, tombI, 'hash')),
		removed: pruneTombs({ folders: { ...tombF }, items: { ...tombI } }, folders, items)
	};
}

/**
 * Drop a tombstone the live rows have already overruled — a key whose row carries a
 * NEWER stamp has been deliberately re-shared, so the tombstone is spent. That bounds
 * growth to "files unshared and not shared again", which is small and self-cleaning; the
 * alternative is a lifetime policy, which is the thing `hudDocs` warns tombstones drag
 * in behind them.
 * @param {any} tombs @param {any[]} folders @param {any[]} items
 */
function pruneTombs(tombs, folders, items) {
	for (const row of folders) {
		const at = Number(tombs.folders[row.id]);
		if (Number.isFinite(at) && (Number(row.at) || 0) > at) delete tombs.folders[row.id];
	}
	for (const row of items) {
		const at = Number(tombs.items[row.hash]);
		if (Number.isFinite(at) && (Number(row.at) || 0) > at) delete tombs.items[row.hash];
	}
	return tombs;
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
		const { folders, items, removed } = projection();
		return publishSharedIndex(folders, items, removed);
	}
	publishTimer = setTimeout(() => {
		publishTimer = null;
		const { folders, items, removed } = projection();
		publishSharedIndex(folders, items, removed);
	}, 150);
	return true;
}

// ---- share / unshare (R2) --------------------------------------------------------

/**
 * R22 round 2 — WHO MAY UNSHARE. Locked answer: **anyone**, because a project's library
 * is the project's, not a collection of private claims. The shipped owner-only rule
 * survives as the second option, since a session with an author and guests may want it.
 *
 * LOCAL, not replicated, and deliberately: it decides what OUR menu offers, and the wire
 * enforces nothing either way (a tombstone from any peer is honoured by every peer). A
 * replicated policy would imply an enforcement this layer does not have.
 * @type {import('svelte/store').Writable<'anyone' | 'owner'>} */
export const unshareAuthority = writable(readAuthority());

function readAuthority() {
	try {
		return localStorage.getItem('shared:unshareAuthority') === 'owner' ? 'owner' : 'anyone';
	} catch {
		return 'anyone';
	}
}

unshareAuthority.subscribe((v) => {
	try {
		localStorage.setItem('shared:unshareAuthority', v);
	} catch {}
});

/**
 * R22-R8 (user) — AUTOMATICALLY SHARE EVERYTHING. Off by default, because the whole
 * batch rests on "a file is local until somebody says otherwise" and a default that
 * published your library the moment you connected would make that sentence false.
 *
 * With it ON, every file already here and every file created afterwards is shared with
 * no gesture — but a VETO still holds, because an explicit "not this one" is a decision
 * and a blanket setting is a preference. Per-peer and LOCAL: "they work with files as
 * they want" was the instruction, and there is nothing to enforce across the mesh.
 *
 * A NEWLY JOINED PEER IS STILL ASKED. That is deliberate and it is the one place this
 * setting deliberately does not reach: the connect prompt is about a library that
 * already existed before the session, so answering it for somebody is exactly the kind
 * of surprise the default protects against.
 * @type {import('svelte/store').Writable<boolean>} */
export const autoShareAll = writable(readFlag('shared:autoShareAll', false));

/**
 * R22-R8 (user) — AUTOMATICALLY DOWNLOAD what peers share. ON by default, and that is
 * the answer to "is it logical?": without it, every shared file costs each peer a
 * right-click, which is an extra step per file per person for something they already
 * agreed to by being in the session. Turning it OFF is the "download files manually"
 * option, for a metered connection or a huge library.
 * @type {import('svelte/store').Writable<boolean>} */
export const autoDownload = writable(readFlag('shared:autoDownload', true));

/** @param {string} key @param {boolean} fallback */
function readFlag(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : raw === 'true';
	} catch {
		return fallback;
	}
}

autoShareAll.subscribe((v) => {
	try {
		localStorage.setItem('shared:autoShareAll', String(v));
	} catch {}
});
autoDownload.subscribe((v) => {
	try {
		localStorage.setItem('shared:autoDownload', String(v));
	} catch {}
});

/** May we take this row out of the index? @param {any} row a local record or an index row */
export function canUnshare(row) {
	const state = shareStateOf(row);
	if (!state.shared && !row?.remoteItem) return false;
	if (get(unshareAuthority) === 'anyone') return true;
	return state.mine || row?.owner?.id === myPeerId();
}

/**
 * Write a TOMBSTONE. This — not the absence of a row from our projection — is what makes
 * a removal stick when anybody may perform one: the publisher's reconcile would
 * otherwise notice its own row missing and put it straight back, forever.
 * @param {{items?: string[], folders?: string[]}} keys
 */
function tomb(keys) {
	const doc = get(projectManifest);
	/** @type {any} */
	const prev = doc.removed ?? {};
	const at = Date.now();
	/** @type {any} */
	const next = { items: { ...(prev.items ?? {}) }, folders: { ...(prev.folders ?? {}) } };
	for (const hash of keys.items ?? []) next.items[hash] = at;
	for (const id of keys.folders ?? []) next.folders[id] = at;
	const { folders, items } = projection();
	// the projection filters against the CURRENT document, so hand it the new tombstones
	// explicitly rather than publishing a stale removal set
	const liveF = folders.filter((r) => !(r.id in next.folders) || (Number(r.at) || 0) > next.folders[r.id]);
	const liveI = items.filter((r) => !(r.hash in next.items) || (Number(r.at) || 0) > next.items[r.hash]);
	publishSharedIndex(liveF, liveI, next);
}

/** Lift a tombstone: a re-share is a decision and must not be vetoed by an old removal.
 * @param {{items?: string[], folders?: string[]}} keys */
function untomb(keys) {
	const doc = get(projectManifest);
	/** @type {any} */
	const prev = doc.removed ?? {};
	if (!prev.items && !prev.folders) return;
	/** @type {any} */
	const next = { items: { ...(prev.items ?? {}) }, folders: { ...(prev.folders ?? {}) } };
	let changed = false;
	for (const hash of keys.items ?? [])
		if (hash in next.items) {
			delete next.items[hash];
			changed = true;
		}
	for (const id of keys.folders ?? [])
		if (id in next.folders) {
			delete next.folders[id];
			changed = true;
		}
	if (!changed) return;
	const { folders, items } = projection();
	publishSharedIndex(folders, items, next);
}

/**
 * Share one library item. Idempotent, and it clears any earlier VETO — pressing Share
 * on a file you once unshared is a decision, not a no-op.
 * @param {string} id @returns {boolean}
 */
export function shareItem(id) {
	const item = get(explorerItems).find((i) => i.id === id);
	if (!item) return false;
	patchRecord(id, { share: 'mine', owner: meAsOwner(), wasShared: undefined });
	untomb({ items: [item.hash] });
	// push the PICTURE too, so a peer's card has something to show before it decides
	// whether to download the file at all
	sendAssetThumb(item.hash);
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
	// the VETO is still what stops the inheritance sweep re-sharing it a moment later;
	// the TOMBSTONE is what makes the removal reach peers even when we are not the row's
	// publisher (round 2: anyone may unshare)
	patchRecord(id, { share: 'no', owner: undefined, wasShared: undefined });
	tomb({ items: [item.hash] });
	return true;
}

/**
 * R22 round 2: unshare a row we do NOT hold the bytes for — the derived remote card.
 * There is no local record to veto, so the tombstone is the whole of it.
 * @param {string} hash @returns {boolean}
 */
export function unshareHash(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return false;
	tomb({ items: [h] });
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
	const broughtIn = get(explorerItems).filter((i) => ids.includes(i.folderId ?? ''));
	untomb({ folders: ids, items: broughtIn.map((i) => i.hash) });
	for (const i of broughtIn) sendAssetThumb(i.hash);
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
	// the files inside take the VETO rather than merely being cleared: the folder is no
	// longer shared, so nothing would re-share them — but a user who re-shares the FOLDER
	// later means the folder, and a bare clear would silently re-share every file in it
	const inside = get(explorerItems).filter((i) => ids.includes(i.folderId ?? ''));
	for (const item of inside)
		if (item.share === 'mine')
			patchRecord(item.id, { share: undefined, owner: undefined, wasShared: undefined });
	tomb({ folders: ids, items: inside.map((i) => i.hash) });
	return true;
}

/**
 * R22 round 2 (user) — THE TWO BULK ACTIONS, offered together on connect because they
 * are two halves of one wish: "make this session's library the union of what we all
 * have".
 *
 * `shareAllLocal` publishes everything this machine holds and has not decided against.
 * A VETO is honoured, because a bulk action must not quietly overturn a per-file
 * decision — that is the same reasoning the inheritance sweep already follows.
 * @returns {number} how many were newly shared
 */
export function shareAllLocal() {
	const owner = meAsOwner();
	const fresh = get(explorerItems).filter((i) => !i.share);
	for (const item of fresh) {
		patchRecord(item.id, { share: 'mine', owner, wasShared: undefined });
		sendAssetThumb(item.hash);
	}
	// folders come too, or the files land at the peers' root and the tree is lost
	for (const folder of get(explorerFolders)) if (!folder.share) patchRecord(folder.id, { share: 'mine', owner }, 'folder');
	if (fresh.length) untomb({ items: fresh.map((i) => i.hash) });
	publishMine(true);
	return fresh.length;
}

/**
 * ...and `pullAllShared` fetches every shared file this machine lacks. NO REDUNDANT
 * DOWNLOAD is free rather than clever: `remoteSharedRows` is by definition the rows
 * whose content hash we do not hold, so a file we already have — under any name, in any
 * folder, however it got here — is simply not in the list.
 * @returns {number} how many pulls were started
 */
export function pullAllShared() {
	const rows = remoteSharedRows(get(projectManifest));
	let asked = 0;
	for (const row of rows) if (pullSharedItem(row.hash)) asked++;
	return asked;
}

/**
 * R22-R8 (locked answer) — SAVE INTO SESSION: "saves your current project in sessions
 * and cleans files in explorer, then downloads everything from peers/host".
 *
 * The point is CONSISTENCY: stop carrying your own copy of a project and take the
 * session's, so every peer's Explorer is the same Explorer. The middle step throws away
 * local files, so the first one saves them into a session that carries the whole library
 * (`saveSessionWithLibrary`) rather than an ordinary scene snapshot — otherwise the
 * files a scene does not reference would simply be gone.
 *
 * NOTHING IS RE-DOWNLOADED that we would still hold, and that is free rather than
 * clever: hash-addressing means the pull list is computed AFTER the wipe, so it is
 * exactly what the session has and this machine does not.
 *
 * Behind a confirm, because it is the second destructive file operation in the app and
 * the first one (`openProject`) set the precedent.
 * @returns {Promise<{saved: string, cleared: number, pulling: number} | null>}
 */
export async function saveIntoSessionAndAdopt() {
	const { showConfirm } = await import('./confirmDialog');
	const mine = get(explorerItems).length;
	const ok = await showConfirm({
		title: 'Save into session and take the project',
		message:
			'Your current scene and all ' +
			mine +
			' Explorer file' +
			(mine === 1 ? '' : 's') +
			' are saved as a session first, so nothing is lost. Your Explorer is then emptied and refilled from the session — every peer ends up with the same library. Continue?',
		confirmLabel: 'Save and adopt'
	});
	if (!ok) return null;
	const { saveSessionWithLibrary } = await import('./sessions');
	const { clearLibrary } = await import('./explorer');
	const saved = await saveSessionWithLibrary('Before adopting ' + (get(projectManifest).name || 'the session'));
	if (!saved) {
		showToast('Could not save a session — nothing was cleared');
		return null;
	}
	await clearLibrary();
	// the index is UNTOUCHED by the wipe: it is the project's document, not our library,
	// so every shared row is now a row whose bytes we lack — which is the pull list
	const pulling = pullAllShared();
	showToast('Saved "' + saved.name + '" — fetching ' + pulling + ' file' + (pulling === 1 ? '' : 's') + ' from peers');
	return { saved: saved.name, cleared: mine, pulling };
}

/** What the connect prompt needs to know: is there anything worth offering?
 * @returns {{local: number, missing: number}} */
export function bulkCounts() {
	return {
		local: get(explorerItems).filter((i) => !i.share).length,
		missing: remoteSharedRows(get(projectManifest)).length
	};
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
	// a TOMBSTONED row is not a row. A document may legitimately carry both for a moment
	// (a removal racing a carry-forward), and the removal wins — see the projection.
	/** @type {any} */
	const tombAll = doc?.removed ?? {};
	const notTombed = (/** @type {any} */ row, /** @type {string} */ key, /** @type {any} */ map) => {
		const at = Number(map?.[row[key]]);
		return !Number.isFinite(at) || (Number(row.at) || 0) > at;
	};
	const folderRows = (doc?.folders ?? []).filter((/** @type {any} */ r) =>
		notTombed(r, 'id', tombAll.folders)
	);
	const itemRows = (doc?.items ?? []).filter((/** @type {any} */ r) =>
		notTombed(r, 'hash', tombAll.items)
	);
	// OUR OWN row being tombstoned means somebody else unshared our file. Honour it: drop
	// the mark so we stop republishing, and keep the file (nothing here ever deletes bytes).
	for (const item of get(explorerItems))
		if (item.share === 'mine' && Number.isFinite(Number(tombAll.items?.[item.hash])))
			patchRecord(item.id, { share: 'no', owner: undefined, wasShared: true });
	for (const folder of get(explorerFolders))
		if (folder.share === 'mine' && Number.isFinite(Number(tombAll.folders?.[folder.id])))
			patchRecord(folder.id, { share: undefined, owner: undefined, wasShared: true }, 'folder');

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
	// ...but NEVER against a tombstone. A row of ours that is missing because somebody
	// DELIBERATELY removed it is not a lost race, and re-publishing it is how the
	// publisher and the remover would take turns forever (round 2: anyone may unshare).
	/** @type {any} */
	const tombs = doc?.removed ?? {};
	const tombed = (/** @type {any} */ map, /** @type {string} */ key) =>
		Number.isFinite(Number(map?.[key]));
	const lostItem = get(explorerItems).some(
		(i) => i.share === 'mine' && !docHashes.has(i.hash) && !tombed(tombs.items, i.hash)
	);
	const lostFolder = get(explorerFolders).some(
		(f) => f.share === 'mine' && !docFolders.has(f.id) && !tombed(tombs.folders, f.id)
	);
	if (lostItem || lostFolder) publishMine();

	// R22-R8 (user): AUTO-DOWNLOAD. "When I click share, the other peers should
	// automatically download it — otherwise it adds an extra step for peers to right
	// click and download." Correct, and it belongs HERE rather than on a message: the
	// index arriving is the only moment that tells us a file is on offer, and it covers
	// every route to that state at once — a share, a folder share, a late join, a .tp
	// open, a peer re-sharing something.
	//
	// The queue does the rate limiting (see enqueuePulls), so a folder of two hundred
	// files does not become two hundred simultaneous requests.
	if (get(autoDownload)) autoPullMissing();
}

/** Fetch every shared file this machine lacks, honouring the queue. Silent when there
 * is nothing to do, which is the common case on every subsequent document. */
function autoPullMissing() {
	const rows = remoteSharedRows(get(projectManifest));
	if (!rows.length) return;
	// requestAsset, not pullSharedItem: an automatic sweep must respect the dead-hash
	// mark, or it re-queues an unanswerable file on every index change forever
	for (const row of rows) {
		pendingPulls.update((s) => (s.has(row.hash) ? s : new Set([...s, row.hash])));
		requestAsset(row.hash);
	}
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
	const owner = meAsOwner();
	// R22-R8: `autoShareAll` rides the sweep rather than hooking every import path, for
	// the same reason folder inheritance does — there are many of those paths and a rule
	// that only holds on the ones somebody remembered to edit is not a rule.
	const everything = get(autoShareAll);
	if (everything) for (const f of get(explorerFolders)) if (!f.share) patchRecord(f.id, { share: 'mine', owner }, 'folder');
	for (const item of get(explorerItems)) {
		if (!everything && !shared.has(item.folderId ?? '')) continue;
		if (item.share) continue; // 'mine' already, 'peer' theirs, 'no' vetoed
		patchRecord(item.id, { share: 'mine', owner, wasShared: undefined });
	}
	// THE REPORTED BUG, and it read as two separate ones — "cannot drag files into
	// folders" and "a shared folder's contents do not appear". Both were the same fault:
	// this used to publish ONLY when it had marked something new, so dragging an
	// ALREADY-shared file into a folder changed the local record, changed nothing on the
	// wire, and left every peer holding the old placement. Measured: the row still read
	// `folderId: null` after the file had visibly moved.
	//
	// So publish on ANY library change. It costs nothing when nothing moved, because
	// `publishSharedIndex` is idempotent on content — the same property the reconcile
	// already depends on — and it is what makes the locked answer true: "moving a file
	// also moves it for peers, so all peers have project folder consistency".
	publishMine();
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
			// the file is here, so its OWN thumbnail is the better one — two sources of
			// truth for one card is how they drift
			forgetSharedThumb(h);
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
	void loadSharedThumbs();
	// R22-R8: a transfer that goes quiet has to be reaped, or its reassembly buffers and
	// its queue slot are held forever by a peer that closed the tab. A slow timer, because
	// the thing it is looking for is measured in tens of seconds.
	setInterval(sweepStalledTransfers, 5000);
	explorerItems.subscribe((items) => {
		settlePulls(items);
		scheduleSweep();
	});
	explorerFolders.subscribe(() => scheduleSweep());
	registerSharedIndexListener((doc) => applySharedIndex(doc));
}
