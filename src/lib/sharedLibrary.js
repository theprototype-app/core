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
	folderPath,
	removeFolderRecords,
	moveItem,
	itemByHash,
	setItemHidden
} from './explorer';
import {
	projectManifest,
	publishSharedIndex,
	registerSharedIndexListener,
	resetSessionScope
} from './projectManifest';
import {
	requestAsset,
	sendAssetThumb,
	forgetSharedThumb,
	loadSharedThumbs,
	sweepStalledTransfers,
	reviveHash,
	retryUnavailable,
	retryPull,
	cancelPull
} from './assetShare';
import { ownerStamp } from './cloudHooks';
import { transfers, removeTransfer } from './transferLedger';
// R22 round 33: automatic downloads WAIT while the joiner is being asked what to do with
// its own scene. A store-only leaf, so this edge closes nothing.
import { pendingConnectDecision } from './connectionState';

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

/** Ask the mesh for a shared file we do not hold. R22 round 12: the pending mark and
 * the caller's "Fetching…" toast follow the ASK, not the attempt — with nobody
 * connected the request cannot leave, and a card that says it is fetching from peers
 * there is a spinner with nothing behind it.
 * @param {string} hash @returns {boolean} did a request actually leave */
export function pullSharedItem(hash) {
	const h = String(hash ?? '').trim();
	if (!h || itemByHash(h)) return false;
	// somebody PRESSED this, so a previous failure is not an answer: clear the
	// gave-up-on-it mark before asking (auto-download does not get this — an automatic
	// retry loop is exactly what the mark exists to stop)
	reviveHash(h);
	const sent = requestAsset(h);
	if (sent) pendingPulls.update((s) => new Set([...s, h]));
	return sent;
}

// ---- the projection ---------------------------------------------------------------

/**
 * WHAT WE PUBLISH. Our own shared records projected into rows, with placement CLAMPED
 * to the shared tree, plus every foreign row the document already carried (rule 1 in
 * the header — a publish of ours may never be the thing that drops somebody else's
 * file).
 * @returns {{folders: any[], items: any[], removed: any, deleted: any[]}}
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
			// R22 round 36 — THE CASCADE STOPS AT A DELETED PLACE. `share: 'no'` on a FOLDER
			// means somebody deleted it and this machine kept the record because it holds a
			// local file the deleter could not see (applySharedIndex). Carrying it along as
			// an ancestor would republish it with a FRESH stamp, which beats the deleter's
			// tombstone — the resurrection this whole batch exists to stop. A file inside it
			// still publishes; its `folderId` simply dangles, and a peer roots a row whose
			// folder it does not have (step 2, "placement we cannot honour").
			if (byId.get(at)?.share === 'no') break;
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
		removed: pruneTombs({ folders: { ...tombF }, items: { ...tombI } }, folders, items),
		// carried through verbatim: an ordinary publish is not a statement about deletions
		deleted: doc.deleted ?? []
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
		const { folders, items, removed, deleted } = projection();
		return publishSharedIndex(folders, items, removed, deleted);
	}
	publishTimer = setTimeout(() => {
		publishTimer = null;
		const { folders, items, removed, deleted } = projection();
		publishSharedIndex(folders, items, removed, deleted);
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
 * R22 round 30 C2 (user) — WHAT HAPPENS TO A FILE YOU ADD DURING A SESSION.
 *
 * This supersedes `autoShareAll`, whose own doc named the gap it now closes: it had
 * TWO answers where the question has three. Ticked, it published everything the moment
 * it was ticked, which is more than "share what I add next"; unticked, a file added
 * mid-session was simply invisible to everyone and nothing said so — which is correct
 * behaviour and reads as the feature being broken. THE MISSING MIDDLE IS THE DEFAULT:
 * ask, once, where the files are.
 *
 *  · `ask`    — the Explorer strip (`pendingShareAsk`) puts the question above the rows
 *               it is about. Ignoring it leaves the file local, which is the old
 *               behaviour, so the default costs nobody anything.
 *  · `always` — the blanket setting `autoShareAll` used to be, VERBATIM: the
 *               inheritance sweep marks every folder and every unvetoed file.
 *  · `never`  — silent. Not the same as `ask` ignored: it is a standing answer, so
 *               nothing is ever asked again.
 *
 * A VETO still holds in every mode, because an explicit "not this one" is a decision
 * and a setting is a preference. LOCAL and per-peer: "they work with files as they
 * want" was the instruction, and the wire enforces nothing either way.
 *
 * THE CONNECT CASE IS NO LONGER AN EXCEPTION. The old text carved it out ("a newly
 * joined peer is still asked") because the only alternative was publishing a library
 * that predates the session behind the user's back. With a real ask that carve-out
 * disappears: `ask` asks about the pre-session files too, on the host as well as the
 * joiner — the old toast offered it to joiners only, which was half the complaint.
 * @type {import('svelte/store').Writable<'ask' | 'always' | 'never'>} */
export const shareNewFiles = writable(readShareNewFiles());

/** The read is also the MIGRATION: a machine that had the old checkbox on means
 * `always`, and one that had it off means the new default rather than `never` — off
 * was "do not publish everything", never "do not ask me". */
function readShareNewFiles() {
	try {
		const raw = localStorage.getItem('shared:shareNewFiles');
		if (raw === 'ask' || raw === 'always' || raw === 'never') return raw;
		return localStorage.getItem('shared:autoShareAll') === 'true' ? 'always' : 'ask';
	} catch {
		return 'ask';
	}
}

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

shareNewFiles.subscribe((v) => {
	try {
		localStorage.setItem('shared:shareNewFiles', v);
	} catch {}
});
autoDownload.subscribe((v) => {
	try {
		localStorage.setItem('shared:autoDownload', String(v));
	} catch {}
});

/**
 * R22 round 7 (user) — SKIP THE CONFIRMATION. Off by default, because a delete that
 * reaches other people's machines should be asked about once. On, for somebody clearing
 * out a library who does not want twenty dialogs — which is only reasonable BECAUSE the
 * recycle bin exists, so the two settings are related and sit together.
 * @type {import('svelte/store').Writable<boolean>} */
export const deleteWithoutConfirm = writable(readFlag('shared:deleteNoConfirm', false));

deleteWithoutConfirm.subscribe((v) => {
	try {
		localStorage.setItem('shared:deleteNoConfirm', String(v));
	} catch {}
});

/**
 * R22 round 5 (user) — THE RECYCLE BIN IS OPTIONAL, and it does not survive a reload
 * unless you say so.
 *
 * The bin exists so a delete that reaches other people is reversible. It is still a
 * pile of bytes you asked to be rid of, so the DEFAULT is that it is emptied on the
 * next load: the log entry stays ("this was deleted" remains true, and it replicates),
 * and only the local blob is reclaimed. Turning the bin off entirely makes a delete
 * immediate here — peers still get their own bin, because their copy is theirs.
 * @type {import('svelte/store').Writable<boolean>} */
export const recycleBinEnabled = writable(readFlag('shared:recycleBin', true));
/** Keep deleted files on disk across a reload. OFF by default — see above.
 * @type {import('svelte/store').Writable<boolean>} */
export const keepRecycleBin = writable(readFlag('shared:keepRecycleBin', false));

recycleBinEnabled.subscribe((v) => {
	try {
		localStorage.setItem('shared:recycleBin', String(v));
	} catch {}
});
keepRecycleBin.subscribe((v) => {
	try {
		localStorage.setItem('shared:keepRecycleBin', String(v));
	} catch {}
});

/**
 * R22 round 13 (user) — THE DELETED FILES LOG, and why it is its OWN switch.
 *
 * "Deleting items from recycle bin should remove from there, not just put as grey, but
 * keep the log with thumbnails ... and they should be kept only if it is enabled in app
 * settings". Right on every count: a permanent delete freed the blob and LEFT the row,
 * so the bin went on listing a file it could no longer restore, dimmed. That reads as a
 * delete that half-worked.
 *
 * THE SPLIT NEEDED NO NEW DATA. `manifest.deleted` was already two things wearing one
 * name: rows whose BYTES ARE STILL HERE (the recycle bin — restorable, and the whole
 * point of the bin) and rows that outlived their bytes (the record — what, who, when,
 * and the picture). `partitionDeleted` names the two, the Explorer draws one view per
 * side, and the purge is unchanged on the wire.
 *
 * DEFAULT ON, because the log exists today: OFF is the opt-out, not a new feature.
 *
 * OFF HIDES; IT NEVER CLEARS. The array replicates whole and latest-wins, so pruning it
 * from a LOCAL preference would delete other people's record — and worse, a peer's row
 * is what makes that peer's own hidden copy visible and restorable, so pruning would
 * strand bytes on machines that still hold them. There is also a timing trap: the bin
 * is emptied on every load by default, so a prune-on-toggle would take the whole
 * history for good the next time the app started, from a checkbox. Clearing is already
 * available as a deliberate, confirmed act — `emptyDeletedLog`, "Empty Deleted" — which
 * is where a destructive decision belongs. Hiding is reversible; clearing is not.
 *
 * What it DOES stop is recording history that nothing else needs: see `deleteSharedItem`.
 * @type {import('svelte/store').Writable<boolean>} */
export const deletedLogEnabled = writable(readFlag('shared:deletedLog', true));

deletedLogEnabled.subscribe((v) => {
	try {
		localStorage.setItem('shared:deletedLog', String(v));
	} catch {}
});

/**
 * Empty the bin at startup unless it is being kept. LOCAL BYTES ONLY: the deleted LOG
 * is project data and is left completely alone, so the history of what was removed
 * survives and a peer who kept its own copy can still restore.
 * @returns {Promise<number>} how many blobs were reclaimed
 */
export async function emptyRecycleBinOnLoad() {
	if (get(keepRecycleBin)) return 0;
	const log = get(projectManifest).deleted ?? [];
	if (!log.length) return 0;
	let n = 0;
	for (const row of log) if (await purgeDeletedItem(row.hash)) n++;
	return n;
}

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
	publishSharedIndex(liveF, liveI, next, get(projectManifest).deleted ?? []);
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
	const { folders, items, deleted } = projection();
	publishSharedIndex(folders, items, next, deleted);
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
	// ...and clear it out of the DELETED log. Sharing a file is putting it back, so a
	// deletion recorded against that hash is spent — otherwise the next sweep hides the
	// file you just shared (the reported bug).
	clearDeletedEntry(item.hash);
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
 * R22-R8 / round 7 — STASH INTO SESSIONS (the name the user settled on: "stash" says it
 * is put away and retrievable, where "save" only says it is written down).
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
export async function stashIntoSessions() {
	// NO CONFIRM HERE any more (round 7): the caller arms itself — the toast's button
	// becomes the question and the second press is the answer. A modal that repeats a
	// question the user has already been asked is how the old flow read as confusing.
	const mine = get(explorerItems).length;
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

/** R22 round 6: retry one failed download. @param {string} hash */
export function retryDownload(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return false;
	// R22 round 8: DROP THE FAILED ROW FIRST. `askFor` opens a fresh one, so a retry that
	// left the old one in place doubled the log every press — and the summary counted both,
	// which is the reported "retry doubles the items to retry".
	for (const row of get(transfers))
		if (row.hash === h && row.state === 'failed') removeTransfer(row.id);
	pendingPulls.update((s) => (s.has(h) ? s : new Set([...s, h])));
	return retryPull(h);
}

/** R22 round 6: retry every failed download in one press. @param {string[]} hashes */
export function retryDownloads(hashes) {
	let n = 0;
	for (const hash of hashes ?? []) if (retryDownload(hash)) n++;
	return n;
}

/** R22 round 6: stop waiting for one. @param {string} hash */
export function cancelDownload(hash) {
	const h = String(hash ?? '').trim();
	pendingPulls.update((s) => {
		if (!s.has(h)) return s;
		const next = new Set(s);
		next.delete(h);
		return next;
	});
	return cancelPull(h);
}

/** What the connect prompt needs to know: is there anything worth offering?
 * @returns {{local: number, missing: number}} */
export function bulkCounts() {
	return {
		local: get(explorerItems).filter((i) => !i.share).length,
		missing: remoteSharedRows(get(projectManifest)).length
	};
}

/**
 * R22 round 30 C2 — THE ASK IS A STORE, NOT A CALLBACK.
 *
 * The detector lives here (it rides the sweep, which is where every import path already
 * converges) and the question is drawn by the Explorer, which is a different module and
 * may not even be mounted. A callback would make this module depend on which surface is
 * on screen; a store lets BOTH consumers read it — the strip when the Explorer is open,
 * and a toast pointing at the Explorer when it is not.
 *
 * `kind` is what the copy turns on: `new` is "you just added these", `connect` is "you
 * brought these with you". The list is the resolution unit — answering answers all of it.
 * @type {import('svelte/store').Writable<{kind: 'new' | 'connect', items: {id: string, name: string, hash: string}[]} | null>}
 */
export const pendingShareAsk = writable(null);

/**
 * Share exactly these items. NOT `shareAllLocal`, which is the bulk action and takes
 * every unshared file plus every folder — an ask about three files must publish three
 * files. The ancestor folders come anyway, because `projection()` walks the chain of
 * every shared item's `folderId` (the locked placement cascade), so nothing is lost by
 * not naming them here.
 * @param {string[]} ids @returns {number} how many were newly shared
 */
export function shareItems(ids) {
	let n = 0;
	for (const id of ids ?? []) if (shareItem(id)) n++;
	if (n) publishMine(true);
	return n;
}

/**
 * Answer the standing ask. THREE answers, and the middle one is the important one:
 *
 *  · `share` publishes the listed items.
 *  · `keep`  DISMISSES AND WRITES NOTHING. The records stay flag-ABSENT rather than
 *            taking the `no` veto — "not right now" is not "not ever", so a later folder
 *            move, an inheritance sweep or a plain Share gesture still works. The delete
 *            strip's Cancel set that precedent: declining a question is not a decision
 *            about the thing it asked about.
 *  · `stash` is the connect card's destructive option, kept because it is the honest
 *            answer to "I would rather have the session's library than mine".
 *
 * REMEMBER MY CHOICE (round 31, user) — the second parameter is the browser-permission
 * checkbox, and it is deliberately NOT a "share automatically" toggle. A toggle that only
 * means share sits beside a Keep local button it contradicts; a remember-my-choice box
 * modifies WHICHEVER answer is pressed, so both standing rules are reachable from one
 * surface, the action stays primary (the box never acts on its own), and the preference
 * can never disagree with the click that carried it.
 *
 * `always` is the blanket rule the sweep already implements, so it reaches the files
 * still sitting local as well as the next one — which is what somebody pressing Share and
 * asking never to be asked again is agreeing to.
 *
 * `stash` TAKES NO RULE. Replacing your library with the session's is a one-off act about
 * the files you brought, not a policy about the files you will add next: there is no
 * standing answer it could mean, so the box is ignored on that path rather than guessed at.
 *
 * AND THE SETTING SAYS SO OUT LOUD. A preference changed as a side effect of a button is
 * only honest if it announces itself and names the way back, which is why the consequence
 * toast lives HERE and not in the Explorer: whoever answers a remembered ask is told,
 * once, on the same call that wrote it.
 * @param {'share' | 'keep' | 'stash'} choice
 * @param {boolean} [remember] make this answer the standing one (`shareNewFiles`)
 * @returns {number} items acted on
 */
export function resolveShareAsk(choice, remember = false) {
	const ask = get(pendingShareAsk);
	if (!ask) return 0;
	pendingShareAsk.set(null);
	if (remember && (choice === 'share' || choice === 'keep')) {
		shareNewFiles.set(choice === 'share' ? 'always' : 'never');
		showToast(
			choice === 'share'
				? 'New files will now be shared automatically — change this in File settings'
				: 'New files will now be kept local — change this in File settings'
		);
	}
	if (choice === 'stash') {
		void stashIntoSessions();
		return ask.items.length;
	}
	if (choice !== 'share') return 0;
	return shareItems(ask.items.map((i) => i.id));
}

/**
 * R22 round 4 (locked answer) — DELETE REACHES EVERY PEER, AND IS UNDOABLE.
 *
 * Deleting a SHARED file is not the same act as unsharing one. Unshare says "stop
 * offering this" and is explicitly forbidden from touching a peer's copy; delete says
 * "this is not part of the project", and leaving it sitting in everybody else's library
 * is exactly the inconsistency this batch exists to close.
 *
 * WHAT IT DOES NOT DO IS DESTROY BYTES ON ANOTHER MACHINE. Each peer moves its copy to
 * the HIDDEN shelf — the same `setItemHidden` that carries a scene's old versions, which
 * moves a record and never touches its blob — so Restore works from your own disk and
 * needs nobody's cooperation. "Delete permanently" is a separate, local, deliberate act.
 *
 * The LOG is what makes that discoverable: a deletion you cannot see is a deletion you
 * cannot undo.
 * @param {string} id a VISIBLE library item id @returns {boolean}
 */
/**
 * R22 round 7 (user) — LOG A DELETION FOR ANYTHING, not only a shared library file.
 * A prefab removed by mistake is exactly as annoying as a texture removed by mistake,
 * and the bin already knows how to hold a record with a name, a kind and a thumbnail.
 *
 * Prefabs are LOCAL, so there is nothing to tombstone and nothing to tell peers: the
 * entry is a record for this machine, and Restore hands the prefab back from the same
 * bytes it was always stored in.
 * @param {{hash: string, name: string, kind: string, thumb?: string|null,
 *   folderId?: string|null, path?: string[]}} spec R22 round 36: `folderId` and `path`
 *   are WHERE IT WAS, so Restore can put it back there. Both optional — a prefab has no
 *   library folder, and an omitted `folderId` reads as the root.
 */
export function logLocalDeletion(spec) {
	const hash = String(spec?.hash ?? '').trim();
	if (!hash) return false;
	const doc = get(projectManifest);
	const log = [...(doc.deleted ?? []).filter((/** @type {any} */ r) => r.hash !== hash)];
	log.push({
		hash,
		name: String(spec.name ?? hash),
		kind: String(spec.kind ?? 'text'),
		at: Date.now(),
		by: meAsOwner(),
		localOnly: true,
		...(spec.folderId === undefined ? {} : { folderId: spec.folderId ?? null }),
		...(spec.path?.length ? { path: spec.path } : {}),
		...(spec.thumb ? { thumb: spec.thumb } : {})
	});
	noteApplied(hash);
	const { folders, items, removed } = projection();
	publishSharedIndex(folders, items, removed, log);
	return true;
}

/** @param {string} id a VISIBLE library item id @returns {boolean} */
export function deleteSharedItem(id) {
	const item = get(explorerItems).find((i) => i.id === id);
	if (!item) return false;
	const doc = get(projectManifest);
	// R22 round 13: THE ONE PLACE "stop recording" can mean something. With the bin off
	// the bytes go immediately, so the row it would write is not a bin entry at all — it
	// is pure history, and with the log off nobody asked for history. With the bin ON the
	// row IS the bin entry and must be written whatever this preference says, or the file
	// goes to the hidden shelf with nothing pointing at it. Deliberately not extended to
	// rows already in the document: see the deletedLogEnabled header.
	const keepRow = get(recycleBinEnabled) || get(deletedLogEnabled);
	const log = [...(doc.deleted ?? []).filter((/** @type {any} */ r) => r.hash !== item.hash)];
	if (keepRow)
		log.push({
			hash: item.hash,
			name: item.name,
			kind: item.kind,
			at: Date.now(),
			by: meAsOwner(),
			// R22 round 36: WHERE IT WAS, so Restore can put it back rather than dropping
			// it at the root — and the names beside it, because the folder may be gone by
			// the time anybody looks
			folderId: item.folderId ?? null,
			path: folderPath(item.folderId),
			// R22 round 7: keep the PICTURE. It cannot be re-derived once the bytes are
			// reclaimed, so a bin full of generic icons is what you get by not recording it.
			...(item.thumbnail ? { thumb: item.thumbnail } : {})
		});
	// THE PATCH GOES FIRST, and this is a bug fix rather than a tidy-up: `patchRecord`
	// writes into `explorerItems` only, so patching a record that `setItemHidden` has
	// already moved to the hidden shelf silently did NOTHING. The deleted copy therefore
	// kept `share: 'peer'`, which meant the projection went on carrying the row forward
	// verbatim (see the foreign-row rule) and the restore rule in `applySharedIndex` —
	// hidden AND `share: 'no'` AND applied — could never match on the deleter's own machine.
	patchRecord(item.id, { share: 'no', owner: undefined, wasShared: undefined });
	// off the visible shelf, bytes intact — unless the bin is switched off, in which case
	// the user has already said they do not want a second chance at this
	if (get(recycleBinEnabled)) setItemHidden(item.id, true);
	else void import('./explorer').then((m) => m.deleteItem(item.id));
	// ...and OUR OWN applied-set is right immediately. Without this the row we just wrote
	// is a deletion we have not "seen", so the next sweep applies it against the copy —
	// harmless today, and the thing that would re-hide a file restored a second later.
	noteApplied(item.hash);
	// ...and out of the index for everybody, through the tombstone that already exists
	const { folders, items } = projection();
	const tombs = {
		items: { ...((doc.removed ?? {}).items ?? {}), [item.hash]: Date.now() },
		folders: { ...((doc.removed ?? {}).folders ?? {}) }
	};
	publishSharedIndex(
		folders,
		items.filter((/** @type {any} */ r) => r.hash !== item.hash),
		tombs,
		log
	);
	return true;
}

// ---- R22 round 36: DELETE GOES THROUGH ONE PATH, AND IT IS THE BIN'S ---------------
//
// The report this closes: "deleting a folder recreates it, and its files, when a peer has
// share-new-files: always". `explorer.deleteFolder` DESTROYS locally and writes no
// tombstone and no log row, so the peer went on holding the folder as `peer` and the files
// as `peer`; the rows leaving the index stripped those marks to `wasShared`, the `always`
// sweep claimed everything unshared as `mine` and republished — and the deleter adopted
// its own folder back and auto-downloaded its own files. Nothing anywhere was ever told
// that a deletion had happened, which is the whole of it.
//
// So both bulk deletes below write the same three things the single-item path writes: the
// LOG ROW (what, who, when, where), the TOMBSTONE (so the removal beats the reconcile) and
// the APPLIED mark (so we do not re-apply our own deletion). ONE publish each, because a
// folder of forty files is one act.

/** The per-item half, shared by both entry points below. Mutates `log`/`tombs` and returns
 * the item so the caller can filter its hash out of the published rows.
 * @param {any} item a VISIBLE library record @param {any[]} log @param {any} tombs
 * @param {number} at @param {any} by @param {boolean} keepRow */
function binOneItem(item, log, tombs, at, by, keepRow) {
	// SHARED vs LOCAL is the only branch: a shared file needs a tombstone so it leaves
	// every peer's index, a local one has nothing to tell anybody and takes `localOnly`
	// so Restore knows to put it back LOCAL rather than publishing it (round 36's fourth
	// report — restoring a local deletion used to share it).
	const shared = item.share === 'mine' || item.share === 'peer';
	const i = log.findIndex((/** @type {any} */ r) => r.hash === item.hash);
	if (i >= 0) log.splice(i, 1);
	if (keepRow)
		log.push({
			hash: item.hash,
			name: item.name,
			kind: item.kind,
			at,
			by,
			folderId: item.folderId ?? null,
			path: folderPath(item.folderId),
			...(shared ? {} : { localOnly: true }),
			...(item.thumbnail ? { thumb: item.thumbnail } : {})
		});
	// the patch before the hide — see the note in `deleteSharedItem`
	if (shared) patchRecord(item.id, { share: 'no', owner: undefined, wasShared: undefined });
	if (get(recycleBinEnabled)) setItemHidden(item.id, true);
	else void import('./explorer').then((m) => m.deleteItem(item.id));
	if (shared) tombs.items[item.hash] = at;
	noteApplied(item.hash);
	return item;
}

/** The tombstone map to build on, as a fresh copy of the document's. @param {any} doc */
function tombsOf(doc) {
	return {
		items: { ...((doc.removed ?? {}).items ?? {}) },
		folders: { ...((doc.removed ?? {}).folders ?? {}) }
	};
}

/**
 * Move library items to Deleted — the ONE delete path the Explorer offers, whether that
 * is one card, a marquee selection or a drop onto the bin.
 *
 * A ROW IS WRITTEN ONLY IF THERE IS SOMEWHERE FOR IT TO GO: with the recycle bin OFF the
 * bytes are gone immediately, and with the log OFF as well nobody asked for history — the
 * same `keepRow` reading `deleteSharedItem` has always used, applied to local files too.
 * @param {string[]} ids VISIBLE library item ids @returns {number} how many went
 */
export function deleteItemsToBin(ids) {
	const visible = get(explorerItems);
	const targets = (ids ?? [])
		.map((id) => visible.find((i) => i.id === id))
		.filter(/** @returns {v is any} */ (v) => !!v);
	if (!targets.length) return 0;
	const doc = get(projectManifest);
	const keepRow = get(recycleBinEnabled) || get(deletedLogEnabled);
	const log = [...(doc.deleted ?? [])];
	const tombs = tombsOf(doc);
	const at = Date.now();
	const by = meAsOwner();
	const gone = new Set();
	for (const item of targets) {
		binOneItem(item, log, tombs, at, by, keepRow);
		gone.add(item.hash);
	}
	const { folders, items } = projection();
	publishSharedIndex(
		folders,
		items.filter((/** @type {any} */ r) => !gone.has(r.hash)),
		tombs,
		log
	);
	return targets.length;
}

/**
 * Move a FOLDER to Deleted: the folder, its subfolders, and every visible file inside —
 * each file through exactly the rule above, KEEPING its `folderId` so the tree can be
 * rebuilt on the way back.
 *
 * WHAT IT DOES NOT TOUCH: bytes, and the hidden shelf. An old scene version living inside
 * the folder keeps its record and its `folderId`, so restoring the folder finds it again;
 * `removeFolderRecords` takes the PLACES and nothing else, which is what separates this
 * from `explorer.deleteFolder` (still there, for `clearLibrary`-class callers).
 * @param {string} id @returns {{folders: number, files: number}}
 */
export function deleteFolderToBin(id) {
	const ids = folderSubtree(String(id ?? '').trim());
	const byId = new Map(get(explorerFolders).map((f) => [f.id, f]));
	if (!ids.length || !byId.has(ids[0])) return { folders: 0, files: 0 };
	const inside = new Set(ids);
	const doc = get(projectManifest);
	const keepRow = get(recycleBinEnabled) || get(deletedLogEnabled);
	const log = [...(doc.deleted ?? [])];
	const tombs = tombsOf(doc);
	const at = Date.now();
	const by = meAsOwner();
	// THE ITEMS FIRST, while the folder records still exist: `folderPath` reads the live
	// tree, so a row written after the removal would carry an empty path — and the path is
	// the only thing left once the log row itself is evicted by the cap.
	const targets = get(explorerItems).filter((i) => inside.has(i.folderId ?? ''));
	const gone = new Set();
	for (const item of targets) {
		binOneItem(item, log, tombs, at, by, keepRow);
		gone.add(item.hash);
	}
	for (const fid of ids) {
		const folder = byId.get(fid);
		if (!folder) continue;
		const shared = folder.share === 'mine' || folder.share === 'peer';
		const i = log.findIndex((/** @type {any} */ r) => r.hash === folderRowKey(fid));
		if (i >= 0) log.splice(i, 1);
		if (keepRow)
			log.push({
				hash: folderRowKey(fid),
				name: folder.name,
				kind: 'folder',
				at,
				by,
				// a folder row's own `folderId` is its PARENT — the row IS the folder
				folderId: folder.parentId ?? null,
				path: folderPath(folder.parentId),
				...(shared ? {} : { localOnly: true })
			});
		if (shared) tombs.folders[fid] = at;
		noteApplied(folderRowKey(fid));
	}
	removeFolderRecords(ids);
	const { folders, items } = projection();
	// the projection carries a FOREIGN row forward verbatim, and a folder we have just
	// stopped holding now looks foreign — so the doomed ids are filtered here explicitly
	// rather than trusted to the tombstone, which the projection matched against the OLD
	// document (the same shape `deleteSharedItem` uses for its one hash)
	publishSharedIndex(
		folders.filter((/** @type {any} */ r) => !inside.has(r.id)),
		items.filter((/** @type {any} */ r) => !gone.has(r.hash)),
		tombs,
		log
	);
	return { folders: ids.length, files: targets.length };
}

/** Drop one hash out of the deleted log (and out of the applied set), leaving the rest
 * of the document alone. @param {string} hash */
export function clearDeletedEntry(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return false;
	forgetApplied(h);
	const doc = get(projectManifest);
	const log = doc.deleted ?? [];
	if (!log.some((/** @type {any} */ r) => r.hash === h)) return false;
	const { folders, items, removed } = projection();
	publishSharedIndex(
		folders,
		items,
		removed,
		log.filter((/** @type {any} */ r) => r.hash !== h)
	);
	return true;
}

/** R22 round 7: empty the whole bin — the Deleted section's own context menu. Local
 * bytes AND the log, because "empty the bin" is a statement about both. R22 round 36:
 * FOLDER ROWS GO TOO and need no special case — `purgeDeletedItem` finds no item for a
 * `'folder:'` hash and does nothing, and the publish of `[]` takes the whole array. */
export async function emptyDeletedLog() {
	const log = get(projectManifest).deleted ?? [];
	if (!log.length) return 0;
	for (const row of log) {
		await purgeDeletedItem(row.hash);
		forgetApplied(row.hash);
	}
	const { folders, items, removed } = projection();
	publishSharedIndex(folders, items, removed, []);
	return log.length;
}

/**
 * R22 round 36 (user) — "CLEAR THE LOG" CLEARS THE LOG, and nothing else.
 *
 * It used to run `emptyDeletedLog`, which reclaims every byte in the bin as well; round 13
 * had folded the two into one gesture on the reasoning that both act on one array. The
 * user's reading is the right one: the LOG is the half whose bytes are already gone from
 * this device (the cleaned-up records), the BIN is what can still be put back, and a menu
 * entry called "Clear the log" that also empties the bin is a delete wearing a bookkeeping
 * label. So this drops exactly the rows `partitionDeleted` calls spent HERE — item rows
 * with no bytes on either shelf, folder rows whose files are all gone — and leaves every
 * restorable row where it is. `emptyDeletedLog` stays the destructive act, under the
 * "Empty Deleted" name that says so.
 *
 * REPLICATED, like every write to this array: a spent row of ours may still be a bin row
 * on a peer that kept the bytes, and their copy stays on their hidden shelf (reclaimable
 * from the storage panel) rather than being surfaced or destroyed on the strength of a
 * message — the same trade `emptyDeletedLog` has always made, on a narrower set.
 * @returns {number} how many records were forgotten
 */
export function clearDeletedRecords() {
	const log = get(projectManifest).deleted ?? [];
	if (!log.length) return 0;
	const { spent } = partitionDeleted(log, heldHashes(), get(explorerFolders));
	if (!spent.length) return 0;
	const gone = new Set(spent.map((/** @type {any} */ r) => r.hash));
	for (const h of gone) forgetApplied(h);
	const { folders, items, removed } = projection();
	publishSharedIndex(
		folders,
		items,
		removed,
		log.filter((/** @type {any} */ r) => !gone.has(r.hash))
	);
	return gone.size;
}

/** R22 round 7: the DELETED log carries the thumbnail now, so a card in the bin looks
 * like the file it was. It is a picture we already rendered — re-deriving it after the
 * bytes are reclaimed is impossible, which is exactly why it has to be recorded at
 * delete time. @param {any} row @returns {string|null} */
export function deletedThumb(row) {
	return row?.thumb ?? null;
}

/** The deleted log, newest first — what the Explorer's Deleted view lists.
 * @param {any} [manifest] pass `$projectManifest` from a component (the reactivity rule)
 * @returns {any[]} */
export function deletedLog(manifest) {
	const m = manifest ?? get(projectManifest);
	return [...(m.deleted ?? [])].reverse();
}

// ---- R22 round 36: the bin keeps its structure -----------------------------------
//
// THE LOG GREW ONE ROW KIND AND TWO FIELDS (plan 1.1) and nothing else changed on the
// wire. A FOLDER ROW is `hash: 'folder:' + id`, which follows the `'prefab:'` precedent
// so one latest-wins array keeps on being keyed by one field; every row (folder or item)
// carries the `folderId` it lived under AT DELETION TIME plus a `path` of ancestor names
// as a display fallback.
//
// A folder id is NETWORK IDENTITY for a shared folder (R22-R1), which is the whole
// reason this works across peers: the restorer may no longer hold the folder, but the
// log does, and recreating it under the SAME uuid makes every other row's `folderId`
// resolve on both machines with no remapping.

const FOLDER_ROW = 'folder:';

/** Is this log row a deleted FOLDER rather than a deleted file? Both halves are checked
 * because either one alone is guessable: a file could be named `folder:x` and a hand-
 * written row could carry the prefix with no kind. @param {any} row */
export function isFolderRow(row) {
	return row?.kind === 'folder' && String(row?.hash ?? '').startsWith(FOLDER_ROW);
}

/** The folder id a folder row stands for. @param {any} row @returns {string|null} */
export function folderRowId(row) {
	const hash = String(row?.hash ?? '');
	if (!hash.startsWith(FOLDER_ROW)) return null;
	return hash.slice(FOLDER_ROW.length) || null;
}

/** The log key a folder id takes. @param {string} id @returns {string} */
export function folderRowKey(id) {
	return FOLDER_ROW + String(id ?? '');
}

/**
 * @typedef {{id: string, name: string, parentId: string|null, row: any, ghost: boolean}} DeletedNode
 */

/**
 * THE BIN IS A TREE, read from the rows' own recorded locations (plan 1.2).
 *
 * A node is one of two things, and the difference is visible rather than structural:
 *
 *  · a DELETED FOLDER — a folder row in the log. Restorable as a folder, and it may be
 *    empty (a folder deleted with nothing in it is still a thing you can put back).
 *  · a GHOST — a folder that is STILL IN THE LIBRARY but has deleted rows pointing at it,
 *    because somebody walked into it and deleted its contents. It is a place, not a thing
 *    to restore, and it is named from the live record.
 *
 * RESOLUTION ORDER for a `folderId` is log row → live folder → unresolvable, and the log
 * wins deliberately: a peer that KEPT the folder record (because it held a local file the
 * deleter could not see, see applySharedIndex) must still draw the deletion the deleter
 * meant. An unresolvable ancestor ENDS THE CHAIN — whatever hangs under it is shown at the
 * bin root — and an item whose own `folderId` resolves to nothing shows at the root with
 * its recorded `path` as the location text.
 *
 * PURE, and it takes the live folders as an argument rather than reading the store: the
 * documented `get()`-registers-no-dependency rule, which is exactly the trap round 9's
 * purge fell into one layer up. It is also what makes the whole shape suite-testable with
 * no browser.
 *
 * @param {any[]} rows the log, in any order
 * @param {any[]} liveFolders `explorerFolders` — pass `[]` for a pure structural read
 * @returns {{children: Map<string|null, {folders: DeletedNode[], items: any[]}>,
 *   nodes: Map<string, DeletedNode>, locationOf: (row: any) => string,
 *   descendants: (id: string) => {folders: DeletedNode[], items: any[]}}}
 */
export function buildDeletedTree(rows, liveFolders) {
	const log = rows ?? [];
	/** @type {Map<string, any>} */
	const rowFor = new Map();
	for (const row of log) {
		const id = isFolderRow(row) ? folderRowId(row) : null;
		if (id) rowFor.set(id, row);
	}
	const liveById = new Map((liveFolders ?? []).map((/** @type {any} */ f) => [f.id, f]));

	/** @type {Map<string, DeletedNode>} */
	const nodes = new Map();

	/**
	 * Materialise a node and every ancestor it can still reach. GHOSTS ARE CREATED ONLY
	 * WHERE SOMETHING HANGS UNDER THEM, which falls out of only ever being called for an
	 * id a row actually names (or an ancestor of one).
	 * @param {string|null|undefined} fid @returns {DeletedNode|null}
	 */
	const ensure = (fid) => {
		let at = fid ?? null;
		/** @type {DeletedNode|null} */
		let first = null;
		// bounded, like every parent walk in this codebase: a corrupt tree (a cycle, a
		// hand-edited manifest) must not hang the bin. `nodes.has` also breaks a cycle on
		// its second visit, so 64 is the belt to that brace.
		for (let i = 0; at && i < 64; i++) {
			const seen = nodes.get(at);
			if (seen) return first ?? seen;
			const row = rowFor.get(at);
			const live = row ? null : liveById.get(at);
			if (!row && !live) break; // unresolvable — the chain ends here
			/** @type {DeletedNode} */
			const node = {
				id: at,
				name: String((row ?? live)?.name ?? ''),
				parentId: (row ? (row.folderId ?? null) : (live?.parentId ?? null)) || null,
				row: row ?? null,
				ghost: !row
			};
			nodes.set(at, node);
			first = first ?? node;
			at = node.parentId;
		}
		return first ?? nodes.get(String(fid ?? '')) ?? null;
	};

	for (const row of log) ensure(isFolderRow(row) ? folderRowId(row) : row?.folderId);

	/** Where a node hangs: its parent, or the ROOT when the parent resolved to nothing.
	 * @param {DeletedNode} node @returns {string|null} */
	const parentOf = (node) => (node.parentId && nodes.has(node.parentId) ? node.parentId : null);

	/** @type {Map<string|null, {folders: DeletedNode[], items: any[]}>} */
	const children = new Map();
	/** @param {string|null} key */
	const bucket = (key) => {
		let slot = children.get(key);
		if (!slot) children.set(key, (slot = { folders: [], items: [] }));
		return slot;
	};
	bucket(null);
	for (const node of nodes.values()) {
		bucket(node.id);
		bucket(parentOf(node)).folders.push(node);
	}
	// FOLDER ROWS ARE NOT ITEMS of anything — they ARE the nodes, and listing them twice
	// is how a folder would offer both "Restore folder" and "Restore file" on one row.
	for (const row of log) {
		if (isFolderRow(row)) continue;
		const fid = row?.folderId ?? null;
		bucket(fid && nodes.has(fid) ? fid : null).items.push(row);
	}

	/** @param {any} row @returns {string} */
	const locationOf = (row) => {
		const fid = row?.folderId ?? null;
		if (!fid) return '';
		const node = nodes.get(fid);
		// the recorded path is the ONLY thing left when the folder is gone from both the
		// library and the log — it cannot be re-derived, which is why it is written down
		if (!node) return Array.isArray(row?.path) ? row.path.join(' / ') : '';
		/** @type {string[]} */
		const names = [];
		/** @type {DeletedNode|null} */
		let at = node;
		for (let i = 0; at && i < 64; i++) {
			names.push(at.name);
			const up = parentOf(at);
			at = up ? (nodes.get(up) ?? null) : null;
		}
		return names.reverse().join(' / ');
	};

	/** The WHOLE subtree under a node — folders and items, however deep.
	 * @param {string} id @returns {{folders: DeletedNode[], items: any[]}} */
	const descendants = (id) => {
		/** @type {DeletedNode[]} */
		const folders = [];
		/** @type {any[]} */
		const items = [];
		/** @type {Set<string>} */
		const seen = new Set();
		const queue = [String(id ?? '')];
		while (queue.length) {
			const at = queue.shift();
			if (!at || seen.has(at)) continue; // a cycle visits each node once, then stops
			seen.add(at);
			const slot = children.get(at);
			if (!slot) continue;
			items.push(...slot.items);
			for (const child of slot.folders) {
				folders.push(child);
				queue.push(child.id);
			}
		}
		return { folders, items };
	};

	return { children, nodes, locationOf, descendants };
}

/**
 * R22 round 13: THE TWO HALVES THE LOG HAS ALWAYS HELD. A row whose bytes are still on
 * one of this machine's two shelves is a RECYCLE BIN entry — restorable, which is the
 * whole reason the bin exists. A row that outlived its bytes is a RECORD: what, who,
 * when, and the picture that can never be re-derived.
 *
 * PURE, and it takes the held set as an argument rather than reaching for it: the
 * shelves are stores, and a helper that reads them with `get()` registers no
 * dependency — which is precisely the bug round 9 fixed one layer up, where a purge
 * changed nothing observable because the derived around it never re-ran.
 *
 * R22 round 36 — AND A FOLDER ROW HAS NO BYTES, so the question has to be asked about
 * what is UNDER it. A folder is in the bin when it still holds something restorable OR
 * when it holds no item rows at all. The second clause is not a nicety: the recycle bin
 * is emptied on every load by default, so without it every start would leave a bin made
 * entirely of empty folders that could never be put back — and a folder deleted empty has
 * nothing but a name to reclaim in the first place.
 *
 * @param {any[]} rows the log, in whatever order the caller wants back
 * @param {Set<string>|string[]} held every hash this device still holds bytes for
 * @param {any[]} [liveFolders] `explorerFolders`, so an item sitting in a GHOST folder
 *   nested inside a deleted one is still counted under it. Omitted, the classification is
 *   purely structural — which is what a suite driving this with no library wants.
 * @returns {{bin: any[], spent: any[]}}
 */
export function partitionDeleted(rows, held, liveFolders) {
	const has = held instanceof Set ? held : new Set(held ?? []);
	/** @type {any[]} */ const bin = [];
	/** @type {any[]} */ const spent = [];
	// built ONCE for the whole log rather than per folder row: the walk is the expensive
	// half and the answer is the same for every row in one call
	const tree = buildDeletedTree(rows ?? [], liveFolders ?? []);
	for (const row of rows ?? []) {
		if (!isFolderRow(row)) {
			(has.has(row?.hash) ? bin : spent).push(row);
			continue;
		}
		const id = folderRowId(row);
		const inside = id ? tree.descendants(id).items : [];
		const restorable = !inside.length || inside.some((/** @type {any} */ r) => has.has(r.hash));
		(restorable ? bin : spent).push(row);
	}
	return { bin, spent };
}

/** Do we still hold the bytes of a deleted file? Restore is only offered when we do —
 * see the header: a button that cannot work is worse than no button.
 * @param {string} hash */
export function canRestoreDeleted(hash) {
	return !!itemByHash(hash);
}

/**
 * R22 round 36 — RESTORE RECREATES THE WAY BACK (plan 1.3).
 *
 * Every desktop bin does this (Windows recreates missing parents, macOS "Put Back" too),
 * and here it is the only answer that survives two peers: the restorer may not hold the
 * folder any more — a peer whose whole folder record was removed when it applied the
 * deletion — but the LOG does, and a folder id is network identity, so recreating it under
 * the same uuid puts the file back in the same place on every machine at once.
 *
 * Walks the chain from `fid` upward, PARENTS FIRST, stopping at the first ancestor that is
 * already live (which becomes the anchor) or that the log cannot name (which means the
 * root). Each recreated folder is `mine` unless its row was `localOnly`, its row is
 * consumed and its tombstone lifted.
 * @param {string|null|undefined} fid @param {any[]} log @param {any} tombs
 * @param {Set<string>} consumed rows to drop from the log, filled in as we go
 * @returns {string|null} the folder the caller should land in — null = the library root
 */
function ensureRestoreTarget(fid, log, tombs, consumed) {
	const want = fid ?? null;
	if (!want) return null;
	/**
	 * A folder that is live again — recreated just now, or one a peer KEPT because it held
	 * a local file the deleter could not see — has a row still calling it deleted, and that
	 * row is spent: it is a place things are being put back into. `shareItem`'s
	 * `clearDeletedEntry` makes the same argument one act over.
	 * @param {string} id
	 */
	const reclaim = (id) => {
		const row = log.find((/** @type {any} */ r) => r.hash === folderRowKey(id));
		if (!row) return;
		consumed.add(row.hash);
		forgetApplied(row.hash);
		if (row.localOnly) return;
		// a LOCAL folder was never in the index, so it has no tombstone to lift
		delete tombs.folders[id];
		const held = get(explorerFolders).find((f) => f.id === id);
		// ...and lift the `share: 'no'` the deletion left on a kept folder, or the place we
		// are restoring into is one no peer is allowed to see. Never over a 'peer' mark:
		// somebody else is that row's writer.
		if (held && held.share !== 'mine' && held.share !== 'peer')
			patchRecord(id, { share: 'mine', owner: meAsOwner(), wasShared: undefined }, 'folder');
	};
	if (get(explorerFolders).some((f) => f.id === want)) {
		reclaim(want);
		return want;
	}
	/** @type {any[]} */
	const chain = [];
	let at = want;
	// bounded, and it also terminates a cycle: a row whose parent chain loops stops after
	// 64 hops and whatever it built so far lands under the root
	for (let i = 0; at && i < 64; i++) {
		if (get(explorerFolders).some((f) => f.id === at)) break; // a live ancestor: the anchor
		const row = log.find((/** @type {any} */ r) => r.hash === folderRowKey(at));
		if (!row) break; // the log cannot name it either — the chain ends
		chain.push(row);
		at = row.folderId ?? null;
	}
	if (!chain.length) return null; // nothing to recreate and nothing live: the root
	for (const row of chain.reverse()) {
		const id = folderRowId(row);
		if (!id) continue;
		const parent =
			row.folderId && get(explorerFolders).some((f) => f.id === row.folderId) ? row.folderId : null;
		createFolder(
			row.name,
			parent,
			row.localOnly ? { id } : { id, share: 'mine', owner: meAsOwner() }
		);
		reclaim(id);
	}
	return want;
}

/**
 * Put ONE file back where it was. The shared half of both restore entry points, so the
 * per-item rules cannot drift between "restore this file" and "restore this folder".
 * @param {any} row the log row @param {any[]} log @param {any} tombs
 * @param {Set<string>} consumed
 * @param {string|null} [into] R22 round 36 (user): a DRAG out of Deleted onto a Library
 *   folder (or its root, `null`) says WHERE explicitly, and that beats the recorded
 *   location — the gesture is the answer to the question Restore would otherwise decide.
 *   `undefined` = not given, put it back where it was. A folder that is not live here
 *   falls back to the root rather than to the recorded place, because the user pointed.
 * @returns {boolean}
 */
function restoreOneItem(row, log, tombs, consumed, into) {
	const item = itemByHash(String(row?.hash ?? '').trim());
	if (!item) return false;
	// AN OLD ROW HAS NO `folderId` AT ALL, and that is not the same as `folderId: null`.
	// The hidden record kept its own placement while it sat there, so a row that never
	// recorded one leaves the item exactly where it is; an explicit null means the root.
	const target =
		into !== undefined
			? into && get(explorerFolders).some((f) => f.id === into)
				? into
				: null
			: row && 'folderId' in row
				? ensureRestoreTarget(row.folderId ?? null, log, tombs, consumed)
				: get(explorerFolders).some((f) => f.id === item.folderId)
					? item.folderId
					: null;
	setItemHidden(item.id, false);
	forgetApplied(item.hash);
	// A `localOnly` ROW RESTORES LOCAL. Marking it `mine` was the reported "restoring a
	// local deletion shares it": restore puts a file back as it was, and a file nobody
	// ever shared was not shared.
	if (row?.localOnly) patchRecord(item.id, { share: undefined, owner: undefined, wasShared: undefined });
	else {
		patchRecord(item.id, { share: 'mine', owner: meAsOwner(), wasShared: undefined });
		// lift the tombstone, or the row we are about to publish is filtered straight out
		delete tombs.items[item.hash];
	}
	moveItem(item.id, target ?? null);
	consumed.add(item.hash);
	// the picture, so a peer's card has something to show before it decides to download —
	// but only for a file that is going back into the index at all
	if (!row?.localOnly) sendAssetThumb(item.hash);
	return true;
}

/**
 * Put a deleted file back: on the visible shelf, IN THE FOLDER IT CAME FROM (recreating
 * the way there if it has to), out of the log, and shared again — unless it was never
 * shared, in which case it comes back local.
 * @param {string} hash
 * @param {{into?: string|null}} [opts] `into` = an explicit destination folder id (null =
 *   the library root) from a drag out of Deleted; omitted = where it was
 * @returns {boolean}
 */
export function restoreDeletedItem(hash, opts = {}) {
	const h = String(hash ?? '').trim();
	if (!itemByHash(h)) return false;
	const doc = get(projectManifest);
	const log = doc.deleted ?? [];
	const row = log.find((/** @type {any} */ r) => r.hash === h) ?? { hash: h };
	const tombs = tombsOf(doc);
	/** @type {Set<string>} */
	const consumed = new Set();
	if (!restoreOneItem(row, log, tombs, consumed, 'into' in opts ? opts.into ?? null : undefined))
		return false;
	const { folders, items } = projection();
	publishSharedIndex(
		folders,
		items,
		tombs,
		log.filter((/** @type {any} */ r) => !consumed.has(r.hash))
	);
	return true;
}

/**
 * Put a whole FOLDER back: the node itself, every descendant folder row, and every item
 * row under it whose bytes are still here.
 *
 * A GHOST NODE OFFERS THIS TOO, and it costs nothing to allow: the folder is already in
 * the library, so `ensureRestoreTarget` recreates nothing and the call means "put back
 * what is under this place", which is exactly what somebody pressing it on a ghost wants.
 *
 * ROWS WHOSE BYTES ARE GONE HERE STAY IN THE LOG, pointing at the now-live folders — a
 * peer may still hold them and still restore them, and they show under what is now a
 * ghost. Emptying reclaims bytes; it never takes the record.
 * R22 round 36 (user): `into` — a DRAG of a deleted folder onto a Library folder (or the
 * root, `null`) re-parents the folder THERE instead of recreating the way to where it was:
 * the node's own record is created directly under the destination and its subtree hangs
 * off it as recorded. Ignored for a GHOST (the folder is live; only its contents are being
 * put back, and they go into it) and when the destination is not a live folder here.
 * @param {string} id @param {{into?: string|null}} [opts]
 * @returns {{folders: number, files: number}}
 */
export function restoreDeletedFolder(id, opts = {}) {
	const fid = String(id ?? '').trim();
	if (!fid) return { folders: 0, files: 0 };
	const doc = get(projectManifest);
	const log = doc.deleted ?? [];
	const tree = buildDeletedTree(log, get(explorerFolders));
	const node = tree.nodes.get(fid);
	if (!node) return { folders: 0, files: 0 };
	const tombs = tombsOf(doc);
	/** @type {Set<string>} */
	const consumed = new Set();
	const into = 'into' in opts ? (opts.into ?? null) : undefined;
	if (into !== undefined && node.row && !get(explorerFolders).some((f) => f.id === fid)) {
		// re-parented by the gesture: the node is minted under the destination and the chain
		// above it is left alone (its rows stay — those places are still deleted)
		const parent = into && get(explorerFolders).some((f) => f.id === into) ? into : null;
		createFolder(
			node.row.name,
			parent,
			node.row.localOnly ? { id: fid } : { id: fid, share: 'mine', owner: meAsOwner() }
		);
	}
	ensureRestoreTarget(fid, log, tombs, consumed);
	let folderCount = node.row ? 1 : 0;
	const kids = tree.descendants(fid);
	for (const child of kids.folders) {
		if (!child.row) continue; // a ghost is already in the library
		ensureRestoreTarget(child.id, log, tombs, consumed);
		folderCount++;
	}
	let files = 0;
	for (const row of kids.items) if (restoreOneItem(row, log, tombs, consumed)) files++;
	const { folders, items } = projection();
	publishSharedIndex(
		folders,
		items,
		tombs,
		log.filter((/** @type {any} */ r) => !consumed.has(r.hash))
	);
	return { folders: folderCount, files };
}

/**
 * Reclaim the disk. LOCAL and deliberate: the recycle bin exists so a delete is
 * reversible, and emptying it is the one moment somebody has actually said they want the
 * bytes gone. It leaves the log entry, because "this was deleted" stays true.
 * @param {string} hash @returns {Promise<boolean>}
 */
export async function purgeDeletedItem(hash) {
	const item = itemByHash(String(hash ?? '').trim());
	if (!item) return false;
/** @type {any} */
	const mod = await import('./explorer');
	const deleteItem = mod.deleteItem;
	await deleteItem(item.id);
	return true;
}

/**
 * R22 round 36 — "Delete permanently" on a folder NODE: reclaim every held item under it,
 * however deep.
 *
 * WHAT IT DROPS FROM THE LOG is only the folder rows with NO item rows under them at all.
 * A folder that HELD something keeps its row, because the rows of the files it held keep
 * theirs — emptying reclaims BYTES, never the record (round 13's ruling), and a folder row
 * whose children are still listed is what gives those children a place to be listed under.
 * A folder deleted empty has nothing but a name to reclaim, so its row is the only thing
 * this can free and it goes.
 * @param {string} id @returns {Promise<number>} items whose bytes were reclaimed
 */
export async function purgeDeletedFolder(id) {
	const fid = String(id ?? '').trim();
	if (!fid) return 0;
	// the tree is read BEFORE the purge and used throughout: purging leaves every item row
	// in place (that is the ruling), so the shape cannot change under us — and reading it
	// afterwards would count the same rows anyway
	const before = get(projectManifest).deleted ?? [];
	const tree = buildDeletedTree(before, get(explorerFolders));
	const node = tree.nodes.get(fid);
	if (!node) return 0;
	const kids = tree.descendants(fid);
	let reclaimed = 0;
	for (const row of kids.items) if (await purgeDeletedItem(row.hash)) reclaimed++;
	/** @type {Set<string>} */
	const doomed = new Set();
	for (const folder of [node, ...kids.folders]) {
		if (!folder.row) continue; // a ghost has no row to drop
		if (tree.descendants(folder.id).items.length) continue;
		doomed.add(folder.row.hash);
		forgetApplied(folder.row.hash);
	}
	const doc = get(projectManifest);
	const log = (doc.deleted ?? []).filter((/** @type {any} */ r) => !doomed.has(r.hash));
	const { folders, items, removed } = projection();
	publishSharedIndex(folders, items, removed, log);
	return reclaimed;
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

	// 1b. R22 round 36 — A LIVE ROW FOR SOMETHING WE HOLD HIDDEN AND DELETED IS A RESTORE.
	//
	// The reported "restored files do not appear for peers": the peer's copy sits on the
	// HIDDEN shelf, step 2 below finds it (`itemByHash` searches both shelves), marks it
	// `peer` and never un-hides it — and its log row is gone, because the restorer removed
	// it, so it is not in the peer's bin either. Invisible everywhere.
	//
	// THE CONDITION IS THREE-WAY on purpose. Hidden alone is not enough: the shelf also
	// carries a scene's old versions (21-G7), and one of those must never be surfaced just
	// because a peer happened to share the same bytes. Hidden AND `share: 'no'` AND a
	// deletion we applied is the state only a delete-for-everyone can produce.
	for (const row of itemRows) {
		if (!appliedDeletes.has(row.hash)) continue;
		const held = itemByHash(row.hash);
		if (!held || held.share !== 'no') continue;
		if (get(explorerItems).some((i) => i.id === held.id)) continue; // already visible
		setItemHidden(held.id, false);
		forgetApplied(row.hash);
		// step 2 does the rest: the `peer` mark and the placement the row asks for
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

	// R22 round 4: a DELETION somebody else performed. Our copy goes to the hidden shelf
	// — bytes intact, so Restore works from this machine alone — rather than being
	// destroyed, which is the difference between a recycle bin and a remote wipe.
	// ONCE PER ROW, and this is the reported "clicking Share made the file disappear".
	// The loop ran on EVERY library sweep over the WHOLE log, and the log persists in idb
	// — so any file whose hash had ever been deleted was re-hidden the instant anything
	// touched the library, including re-importing it and pressing Share. A delete is an
	// EVENT to apply once, not a standing instruction.
	for (const row of doc?.deleted ?? []) {
		// FOLDER ROWS ARE APPLIED AFTER EVERY ITEM ROW of the same document (see below):
		// "is anything left in this folder" can only be answered once the items that were
		// deleted alongside it have gone
		if (isFolderRow(row)) continue;
		if (appliedDeletes.has(row.hash)) continue;
		const held = get(explorerItems).find((i) => i.hash === row.hash);
		if (!held) {
			// nothing here to hide, but the event is still seen — otherwise it fires later,
			// against a copy the user has since put back
			noteApplied(row.hash);
			continue;
		}
		// the PATCH BEFORE the hide: `patchRecord` writes into `explorerItems` only, so
		// patching a record `setItemHidden` has already moved does nothing at all — which
		// left every applied deletion sitting on the hidden shelf still marked `peer`, and
		// the restore rule above (hidden AND `share: 'no'` AND applied) unable to fire
		patchRecord(held.id, { share: 'no', owner: undefined, wasShared: undefined });
		if (get(recycleBinEnabled)) setItemHidden(held.id, true);
		else void import('./explorer').then((m) => m.deleteItem(held.id));
		noteApplied(row.hash);
	}

	// R22 round 36 — AND THE FOLDER ROWS, once per row like an item row (`appliedDeletes`
	// keyed `'folder:' + id`).
	//
	// TWO ENDINGS, and the second one is why this cannot simply mirror the item rule. If
	// nothing VISIBLE is left in the subtree, the folder RECORDS go — records only: no blob
	// is touched and the hidden items inside keep their `folderId`, which is what lets the
	// bin draw the tree and Restore rebuild it. But if something IS left — a local file the
	// deleter could never see — destroying the folder would take a place that still has
	// contents, so the folder STAYS and is marked `share: 'no', wasShared: true`: the
	// `always` sweep skips it (it only claims folders with no flag at all) and the
	// projection stops carrying it, so the deletion still sticks for everyone else.
	// `shareFolder` lifts that by hand, and so does a restore into it.
	for (const row of doc?.deleted ?? []) {
		if (!isFolderRow(row) || appliedDeletes.has(row.hash)) continue;
		const fid = folderRowId(row);
		const held = fid ? get(explorerFolders).find((f) => f.id === fid) : null;
		if (fid && held) {
			const subtree = folderSubtree(fid);
			const left = get(explorerItems).some((i) => subtree.includes(i.folderId ?? ''));
			if (!left) removeFolderRecords(subtree);
			else patchRecord(fid, { share: 'no', owner: undefined, wasShared: true }, 'folder');
		}
		// seen either way, exactly like an item row we hold nothing for
		noteApplied(row.hash);
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
	if (get(autoDownload)) autoPullWhenAllowed();
}

/**
 * R22 round 33 — HOLD WHILE A CONNECT DECISION IS OPEN.
 *
 * "It should not share or download any changes unless I choose." The connect decision asks
 * a joiner whether to save its unsaved work or dismiss it, and until that is answered
 * nothing about the two worlds has been agreed — so a sweep that quietly pulls the host's
 * library down is the same surprise the decision exists to remove, and `Disconnect` would
 * leave those files on a machine that never joined anything.
 *
 * ASK ONCE, THEN WATCH — never a second attempt that never comes (the LUT rule). ONE watch
 * covers however many sweeps are held behind it, because `autoPullMissing` is a full
 * re-scan of the document rather than a queue of individual files.
 * @type {(() => void) | null} */
let heldPull = null;

function autoPullWhenAllowed() {
	if (!get(pendingConnectDecision)) return autoPullMissing();
	if (heldPull) return;
	heldPull = pendingConnectDecision.subscribe((pending) => {
		// the subscribe fires immediately with the CURRENT value, which we have just
		// established is non-null, so this first call can never release the hold
		if (pending) return;
		// deferred a microtask: unsubscribing from inside the callback would reach the
		// binding before the assignment (the `waitForSceneName` shape)
		const unsub = heldPull;
		heldPull = null;
		queueMicrotask(() => {
			try {
				unsub?.();
			} catch {
				/* already gone */
			}
		});
		if (get(autoDownload)) autoPullMissing();
	});
}

/** Fetch every shared file this machine lacks, honouring the queue. Silent when there
 * is nothing to do, which is the common case on every subsequent document. */
function autoPullMissing() {
	const rows = remoteSharedRows(get(projectManifest));
	if (!rows.length) return;
	// requestAsset, not pullSharedItem: an automatic sweep must respect the dead-hash
	// mark, or it re-queues an unanswerable file on every index change forever.
	// R22 round 12: the pending mark arms only when the request actually left. This
	// sweep runs with no connection open more often than it looks (an idb-restored
	// manifest at boot, a .tp open), and marking those hashes pending drew a permanent
	// row of downloading cards for files nobody had been asked for.
	for (const row of rows)
		if (requestAsset(row.hash))
			pendingPulls.update((s) => (s.has(row.hash) ? s : new Set([...s, row.hash])));
}

// ---- inheritance (R3, and the user's rule: a shared folder shares what lands in it)

/**
 * Deletions we have already acted on. PERSISTED, because the log lives in the manifest
 * and the manifest survives a reload: without this, every boot replays every deletion
 * the project has ever recorded against whatever happens to be in the library now.
 * @type {Set<string>} */
const appliedDeletes = new Set(readApplied());

function readApplied() {
	try {
		return JSON.parse(localStorage.getItem('shared:appliedDeletes') ?? '[]');
	} catch {
		return [];
	}
}

/** @param {string} hash */
function noteApplied(hash) {
	appliedDeletes.add(hash);
	try {
		// bounded: the log itself is capped at 200, so this cannot outgrow it by much
		localStorage.setItem('shared:appliedDeletes', JSON.stringify([...appliedDeletes].slice(-400)));
	} catch {}
}

/** A file is being put BACK, so the deletion that removed it is spent. @param {string} hash */
function forgetApplied(hash) {
	if (!appliedDeletes.delete(hash)) return;
	try {
		localStorage.setItem('shared:appliedDeletes', JSON.stringify([...appliedDeletes]));
	} catch {}
}

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
	// R22-R8: the blanket setting rides the sweep rather than hooking every import path,
	// for the same reason folder inheritance does — there are many of those paths and a
	// rule that only holds on the ones somebody remembered to edit is not a rule. Round 30
	// C2 renamed it: `always` is this branch, `never` is silence, and `ask` is the strip
	// armed by `detectNewShares` below.
	const everything = get(shareNewFiles) === 'always';
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

// ---- R22 round 30 C2: the share-new-files ask --------------------------------
//
// The user's report: "adding a new file to Explorer or creating a new scene when you are
// connected for the first time to host should give a notification below Library asking to
// share files automatically". So the trigger is a file appearing WHILE A SESSION IS OPEN
// — which is a fact about the library, and the library already has one place where every
// import path converges: the debounced sweep. Hooking `importFiles`/`addItemFromBytes`/a
// pack/a save/a drop one at a time is the rule-that-only-holds-where-somebody-remembered
// trap the inheritance sweep's own comment warns about.

/** When this session began. 0 while disconnected, which is also the "do not ask" gate. */
let connectedSince = 0;
/** Ids the library already held. REFRESHED WHOLESALE while disconnected, so an idb load
 * — which arrives item by item long after boot — can never read as "added just now".
 * @type {Set<string>} */
let seenItemIds = new Set();
/** Hashes already offered this session: an ask declined is not re-asked five seconds
 * later by the next unrelated import. Cleared when the session ends. @type {Set<string>} */
let askedHashes = new Set();

/**
 * Which of these are worth asking about at all. Every clause is a case where the answer
 * is already decided or belongs to somebody else.
 * @param {any[]} all
 */
function askCandidates(all) {
	const rows = new Set((get(projectManifest).items ?? []).map((r) => r.hash));
	const pend = get(pendingPulls);
	const sharedFolders = new Set(
		get(explorerFolders)
			.filter((f) => f.share === 'mine')
			.map((f) => f.id)
	);
	return all.filter((i) => {
		if (i.share) return false; // decided: ours, theirs, or vetoed
		// A SCENE IS NOT ASKED ABOUT HERE. Scenes travel through `manifest.scenes` and the
		// project's own consent channel (adoption + the open guard), so a second question on
		// this surface would be about a file the other one already governs — and answering
		// "share" would publish a row beside the one the manifest is already publishing.
		if (i.kind === 'scene') return false;
		if (rows.has(i.hash)) return false; // a peer's file that landed on this machine
		if (pend.has(i.hash)) return false; // ...or one still on its way here
		if (sharedFolders.has(i.folderId ?? '')) return false; // inheritance owns these
		if (askedHashes.has(i.hash)) return false;
		return true;
	});
}

/** Arm, or APPEND to what is already standing — a connect batch still unanswered when a
 * file lands is one question, not two, so the standing `kind` (and its copy) wins.
 * @param {'new' | 'connect'} kind @param {any[]} items */
function armShareAsk(kind, items) {
	const rows = items.map((i) => ({ id: i.id, name: i.name, hash: i.hash }));
	for (const r of rows) askedHashes.add(r.hash);
	pendingShareAsk.update((cur) => {
		if (!cur) return { kind, items: rows };
		const have = new Set(cur.items.map((r) => r.id));
		return { kind: cur.kind, items: [...cur.items, ...rows.filter((r) => !have.has(r.id))] };
	});
}

/** The detector proper, called from the sweep AFTER adoption and inheritance have run —
 * a file that is about to be marked by either of those is not a file to ask about. */
function detectNewShares() {
	const all = get(explorerItems);
	// CREATED SINCE WE CONNECTED, and both halves are needed: `seenItemIds` catches a file
	// that appears without a plausible timestamp (a restore, a merge), while `createdAt`
	// catches the opposite — an idb library that finishes loading after the session opened,
	// where every item is unseen and none of them is new.
	const fresh =
		connectedSince && get(shareNewFiles) === 'ask'
			? askCandidates(
					all.filter((i) => !seenItemIds.has(i.id) && (Number(i.createdAt) || 0) >= connectedSince)
				)
			: [];
	seenItemIds = new Set(all.map((i) => i.id));
	if (fresh.length) armShareAsk('new', fresh);
}

/** The 0 -> >0 peer edge: a session exists, so the pre-session library becomes askable.
 * The HOST is included, deliberately — the old connect toast was joiner-only, and a host
 * sitting on a library nobody can see is the same problem seen from the other end. */
function beginShareSession() {
	connectedSince = Date.now();
	seenItemIds = new Set(get(explorerItems).map((i) => i.id));
	askedHashes = new Set();
	if (get(shareNewFiles) !== 'ask') return;
	const mine = askCandidates(get(explorerItems));
	if (mine.length) armShareAsk('connect', mine);
}

/** ...and the last peer leaving retracts it. A question about a session is meaningless
 * once there is no session, and leaving it on screen invites an answer that does nothing. */
function endShareSession() {
	connectedSince = 0;
	askedHashes = new Set();
	pendingShareAsk.set(null);
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
		detectNewShares();
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
	// R22 round 5: the bin is emptied on load unless it is being kept. After the manifest
	// has settled, because the LOG is what names what to reclaim.
	setTimeout(() => void emptyRecycleBinOnLoad(), 2500);
	// R22-R8: a transfer that goes quiet has to be reaped, or its reassembly buffers and
	// its queue slot are held forever by a peer that closed the tab. A slow timer, because
	// the thing it is looking for is measured in tens of seconds.
	setInterval(sweepStalledTransfers, 5000);
	// R22 round 5: a NEW PEER is new evidence, so everything we gave up on is worth one
	// more ask. Triggered by an arrival rather than a timer — which is the difference
	// between a retry and a loop — and it is the only automatic retry in the module.
	//
	// R22 round 12 — AND THE SWEEP IS UNCONDITIONAL NOW. The pull used to hang off
	// `revived`, i.e. it only ran for a session that had already given up on something,
	// which is never true of a CLEAN FIRST CONNECT: retryUnavailable returns 0 and the
	// rise edge did nothing at all. Auto-download was therefore relying entirely on an
	// index ARRIVING to trigger it — and an index does not always arrive. Our own idb
	// manifest can carry the newer stamp, in which case the incoming document is refused
	// (latest-wins, correctly) and `applySharedIndex` never runs, so nothing on either
	// path ever asks for the bytes that the rows in our OWN document name. The rise edge
	// is the one moment that is true regardless of who won the stamp comparison.
	//
	// Cheap enough to do on every arrival: `remoteSharedRows` is empty in the common case
	// (auto-download means we already hold everything), and `enqueuePull` refuses a hash
	// that is in flight, already held, or recently dead — so a repeat is a no-op, not a
	// second request.
	let lastPeerCount = 0;
	peers.subscribe((p) => {
		const n = /** @type {any} */ (p)?.openedPeers?.size ?? 0;
		if (n > lastPeerCount) {
			// C2: the FIRST peer opens the share session — the rise from zero, not every rise
			if (!lastPeerCount) beginShareSession();
			retryUnavailable();
			// R22 round 33: the peer RISE is the very edge a connect decision sits on, so
			// this is the sweep most likely to be held — see `autoPullWhenAllowed`
			if (get(autoDownload)) autoPullWhenAllowed();
		}
		if (!n && lastPeerCount) {
			endShareSession();
			// C4: the outbound scope dies with the session too. A scene name learned from one
			// room is not public knowledge in the next, and a scene opened here was consent
			// for HERE — so the next connect starts from nothing (projectManifest.js).
			resetSessionScope();
		}
		lastPeerCount = n;
	});
	explorerItems.subscribe((items) => {
		settlePulls(items);
		scheduleSweep();
	});
	explorerFolders.subscribe(() => scheduleSweep());
	registerSharedIndexListener((doc) => applySharedIndex(doc));
}
