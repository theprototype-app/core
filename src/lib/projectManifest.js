// 21-G2 — THE PROJECT MANIFEST: the one mutable thing in a project.
//
// THE MODEL (the 21-F "Next stages" analysis, locked): scene FILES are immutable —
// a scene NAME points at a HISTORY of content hashes, and this document is the only
// thing that changes. Travel-away auto-saves the departing scene to a NEW hash and
// moves the name's pointer; a peer holding an older hash sees an "update available"
// badge and pulls BY HASH; concurrent cross-session edits of one scene land as two
// hashes in one history — last save wins the pointer, NOTHING is destroyed, and
// restore-previous is free. NO merging, ever. Inside one live session the conflict
// cannot occur (one active scene per mesh).
//
// THE SHAPE is the scenePhysics/gameState family: a replicated latest-wins singleton
// with a MONOTONIC stamp, ONE normalize at every boundary, a `manifest` message +
// `getproject` handshake reply — plus idb persistence, because a solo user's project
// must survive a reload with no peer to re-teach it.
//
// A deliberate LEAF: svelte stores + idb + two store-only reads (isViewer for fork 3,
// peers for the sends). levels.js hooks INTO this module, never the other way, so
// nothing here can reach the history family.
//
// FORK 3 (locked): EDITORS publish scene versions; viewers never. Inert without a
// roles plugin — isViewer() is false when nothing publishes rolesInfo.
// FORK 4 (locked): keep ~10 versions per scene + pinned; older bytes prune LOCALLY,
// the manifest keeps the FULL hash list (it is tiny) so any peer still holding old
// bytes serves them.

import { writable, get } from 'svelte/store';
import { peers, showToast, explorerClose, revealExplorerItem } from '../stores/appStore';
import { bottomDockActive } from './bottomDock';
import { showChoice } from './confirmDialog';
import { sessionHost } from './connectionState';
import { isViewer } from './objectPermissions';
import { idbGet, idbPut } from './idb';

const IDB_KEY = 'project:manifest';
/** versions of ONE scene kept locally beyond the pinned set (fork 4) — the DEFAULT of
 * the user-facing setting below, and the value every pre-G7 build used */
export const KEEP_VERSIONS = 10;

/**
 * 21-G7 fork 10 — "Keep N versions per scene" (Settings ▸ Files). A LOCAL preference,
 * never replicated: it is a statement about this machine's disk, exactly like the prune
 * it feeds. **0 means OFF**, and off has a precise meaning: the travel-away auto-save
 * publishes nothing (no versions get cut behind your back) and the prune keeps only the
 * pointer plus your pins — while an explicit Save scene and a manual "Save version…"
 * still publish, because those are things the user asked for.
 * @type {import('svelte/store').Writable<number>}
 */
export const keepVersionsSetting = writable(readKeepVersions());

function readKeepVersions() {
	try {
		const raw = localStorage.getItem('project:keepVersions');
		if (raw === null) return KEEP_VERSIONS;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? Math.floor(n) : KEEP_VERSIONS;
	} catch {
		return KEEP_VERSIONS;
	}
}

keepVersionsSetting.subscribe((n) => {
	try {
		localStorage.setItem('project:keepVersions', String(n));
	} catch {}
});

/** Are auto-cut versions switched off? (the travel-away publish asks) */
export function autoVersionsOff() {
	return (get(keepVersionsSetting) ?? KEEP_VERSIONS) <= 0;
}

/**
 * @typedef {{history: string[], pinned: string[], labels?: Record<string, string>}} SceneEntry
 *   history newest-LAST; the pointer is the last element. `labels` (21-G7) names a
 *   version — absent means every version reads as "Auto", so an older manifest is
 *   byte-unchanged.
 * @typedef {{id: string, name: string, parentId: string|null, owner?: any, at?: number}} SharedFolder
 * @typedef {{hash: string, name: string, kind: string, folderId: string|null, owner?: any,
 *   at?: number}} SharedItem
 * @typedef {{name: string, scenes: Record<string, SceneEntry>, assets: string[],
 *   changedAt: number, folders?: SharedFolder[], items?: SharedItem[],
 *   removed?: {items: Record<string, number>, folders: Record<string, number>},
 *   deleted?: {hash: string, name: string, kind: string, at: number, by?: any,
 *     thumb?: string, localOnly?: boolean}[]}} Manifest
 *   `name` (21-G9) is the project's identity; `folders`/`items` (R22-R1) are THE SHARED
 *   INDEX — see the block comment above normalizeSharedIndex.
 */

/** @returns {Manifest} */
function defaultManifest() {
	return { name: '', scenes: {}, assets: [], changedAt: 0 };
}

/**
 * R22-R1 — THE SHARED INDEX, normalized.
 *
 * WHAT THIS IS. Until R1 the Explorer library did not replicate at ALL: no message
 * carried folders and none carried item rows, so the project agreed on WHICH SCENES
 * EXIST and on nothing about where anything lives. These two sections close that, and
 * they are deliberately the `.tp` FORMAT 2 shape already tested by projectFile.js —
 * `folders[{id,name,parentId}]` + `items[{hash,name,kind,folderId}]` — promoted from a
 * file section into the live document. Nothing here is a new format.
 *
 * WHAT IT IS NOT. It is not the whole library. A file is LOCAL until somebody shares
 * it (fork 1, the `objectPermissions.__localOnly` model one domain over), so these
 * sections carry the SHARED SUBSET only — which is the privacy answer and the size
 * answer at once: a private file's very name never leaves the machine, and a document
 * that replicates on every edit does not grow with a library nobody shared.
 *
 * TWO IDENTITIES, and they are not the same kind of thing:
 *   · an ITEM is its content HASH. Two peers holding one file have different local
 *     record ids and the same hash, so the hash is the only thing a row can be keyed
 *     by — and it is also why unshare can never destroy a peer's copy (R2).
 *   · a FOLDER is its `id`, and a shared folder's id becomes NETWORK identity: a peer
 *     adopting the row creates a local folder with that exact uuid, so every
 *     `folderId` reference resolves on every machine with no remapping. That is the
 *     one place this differs from a .tp import, which REMAPS ids precisely because a
 *     file must not collide with the library it lands in.
 *
 * BYTES ARE NOT HERE. They keep riding `assetfile`/`getasset` by content hash — the
 * push-on-assign, pull-on-demand path from golden rule 9 — so R1 adds no transport. A
 * row whose bytes this peer lacks renders as a card and pulls when opened, exactly as
 * a manifest scene already does.
 *
 * OMITTED WHEN EMPTY (the `labels` precedent, one field over): a project that shares
 * nothing serializes byte-identically to a pre-R1 one, which is what makes the whole
 * batch a no-op until somebody presses Share.
 * @param {any} rows @param {'folder'|'item'} kind @returns {any[]}
 */
function normalizeSharedIndex(rows, kind) {
	if (!Array.isArray(rows)) return [];
	/** @type {Map<string, any>} */
	const byKey = new Map();
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		// the KEY is the identity of the thing, and a row with none is not a row
		const key = kind === 'item' ? String(row.hash ?? '').trim() : String(row.id ?? '').trim();
		if (!key) continue;
		const name = String(row.name ?? '').trim();
		if (!name) continue;
		const folderRef = kind === 'item' ? row.folderId : row.parentId;
		/** @type {any} */
		// spread FIRST: a newer peer's per-row field must survive a round trip through
		// this build (the normalizeAnnotation rule, applied per row rather than per doc)
		const clean = { ...row, name };
		if (kind === 'item') {
			clean.hash = key;
			clean.kind = String(row.kind ?? '').trim() || 'text';
			clean.folderId = folderRef == null ? null : String(folderRef);
			delete clean.id; // an item row is keyed by hash; a local record id means nothing here
		} else {
			clean.id = key;
			clean.parentId = folderRef == null ? null : String(folderRef);
		}
		const at = Number(row.at);
		if (Number.isFinite(at) && at > 0) clean.at = at;
		else delete clean.at;
		// last row for a key wins, so a document carrying a duplicate collapses rather
		// than rendering the same file twice
		byKey.set(key, clean);
	}
	return [...byKey.values()];
}

/**
 * R22 round 4 — THE DELETED LOG. A tombstone says "this is not in the project any more";
 * this says WHAT was removed, by whom and when, so there is something to restore FROM.
 * Deleting a shared file removes it for everyone, and a destructive action that reaches
 * other people's machines needs an undo that is visible rather than implied.
 *
 * Capped, newest last: it is a log, not an archive, and an unbounded array inside a
 * document that replicates whole would grow without limit.
 * @param {any} rows @returns {any[]} */
function normalizeDeleted(rows) {
	if (!Array.isArray(rows)) return [];
	/** @type {Map<string, any>} */
	const byHash = new Map();
	for (const row of rows) {
		const hash = String(row?.hash ?? '').trim();
		const at = Number(row?.at);
		if (!hash || !Number.isFinite(at) || at <= 0) continue;
		// last entry for a hash wins: deleting, restoring and deleting again is one story
		byHash.set(hash, { ...row, hash, name: String(row.name ?? hash), kind: String(row.kind ?? 'text'), at });
	}
	return [...byHash.values()].sort((a, b) => a.at - b.at).slice(-DELETED_LOG_CAP);
}

/** how many deletions the log remembers */
export const DELETED_LOG_CAP = 200;

/** R22 round 2: a tombstone map, with every stamp coerced to a positive number. A key
 * with no usable stamp is dropped rather than kept as a permanent veto nobody can lift.
 * @param {any} data @returns {{items: Record<string, number>, folders: Record<string, number>}} */
function normalizeTombs(data) {
	/** @type {any} */
	const out = { items: {}, folders: {} };
	for (const half of ['items', 'folders']) {
		const raw = data?.[half];
		if (!raw || typeof raw !== 'object') continue;
		for (const [key, at] of Object.entries(raw)) {
			const k = String(key).trim();
			const n = Number(at);
			if (k && Number.isFinite(n) && n > 0) out[half][k] = n;
		}
	}
	return out;
}

/**
 * ONE normalize at every boundary (wire, idb, .tp import). Unknown top-level fields
 * are PRESERVED verbatim (the normalizeAnnotation rule) so a newer peer's manifest
 * survives a round trip through this build.
 * @param {any} data @returns {Manifest & Record<string, any>}
 */
export function normalizeManifest(data) {
	const base = defaultManifest();
	if (!data || typeof data !== 'object') return base;
	/** @type {Record<string, SceneEntry>} */
	const scenes = {};
	const rawScenes = data.scenes && typeof data.scenes === 'object' ? data.scenes : {};
	for (const [name, entry] of Object.entries(rawScenes)) {
		const clean = String(name).trim();
		if (!clean) continue;
		const history = Array.isArray(/** @type {any} */ (entry)?.history)
			? [.../** @type {any} */ (entry).history].map(String).filter(Boolean)
			: [];
		if (!history.length) continue;
		const pinned = Array.isArray(/** @type {any} */ (entry)?.pinned)
			? [.../** @type {any} */ (entry).pinned].map(String).filter((h) => history.includes(h))
			: [];
		// 21-G7: keep only labels whose hash is still in this history (the `pinned` rule
		// one field over), and OMIT the key entirely when there are none — a project
		// that never named a version serializes exactly as it did before G7.
		/** @type {Record<string, string>} */
		const labels = {};
		const rawLabels = /** @type {any} */ (entry)?.labels;
		if (rawLabels && typeof rawLabels === 'object')
			for (const [hash, text] of Object.entries(rawLabels)) {
				const name2 = String(text ?? '').trim();
				if (name2 && history.includes(String(hash))) labels[String(hash)] = name2;
			}
		/** @type {any} */
		const cleanEntry = { ...(/** @type {any} */ (entry)), history, pinned };
		if (Object.keys(labels).length) cleanEntry.labels = labels;
		else delete cleanEntry.labels;
		scenes[clean] = cleanEntry;
	}
	/** @type {any} */
	const out = {
		...data,
		// 21-G9: the project NAME — the Explorer header's identity, the .tp default
		// filename and (G8) the import folder name. A plain trimmed string, absent
		// meaning '' so every pre-G9 manifest normalizes unchanged.
		name: String(data.name ?? '').trim(),
		scenes,
		assets: Array.isArray(data.assets) ? [...new Set(data.assets.map(String).filter(Boolean))] : [],
		changedAt: Number(data.changedAt) || 0
	};
	// R22-R1: the shared index. Present only when there IS one — see normalizeSharedIndex
	const folders = normalizeSharedIndex(data.folders, 'folder');
	const items = normalizeSharedIndex(data.items, 'item');
	if (folders.length) out.folders = folders;
	else delete out.folders;
	if (items.length) out.items = items;
	else delete out.items;
	// R22 round 2: TOMBSTONES. `{items: {hash: at}, folders: {id: at}}` — a removal
	// somebody MEANT, which is what lets any peer unshare (not only whoever published the
	// row) without the publisher's reconcile resurrecting it on the next write. Omitted
	// when empty, like the two indexes, so a project that has never unshared anything
	// still serializes exactly as it did.
	const removed = normalizeTombs(data.removed);
	if (Object.keys(removed.items).length || Object.keys(removed.folders).length) out.removed = removed;
	else delete out.removed;
	const deleted = normalizeDeleted(data.deleted);
	if (deleted.length) out.deleted = deleted;
	else delete out.deleted;
	return out;
}

/** The live document. @type {import('svelte/store').Writable<Manifest>} */
export const projectManifest = writable(defaultManifest());

/** Is there anything in it? A pristine manifest writes no idb key and rides no save.
 * 21-G9: NAMING a project is itself an act of creating one — a user who types a name
 * and reloads must find it there, so the name counts alongside scenes and assets.
 *
 * R22 round 12 — AND SO DOES SHARING A FILE. This predicate predates the shared index
 * (R1) and was never widened for it, so a project whose entire content IS a shared
 * library — files, folders, tombstones, a deletion log, but no name and no saved scene
 * — read as pristine. One blind spot, three bugs. `persist()` never wrote such a
 * document to idb, so an index-only project lost its whole library on reload (a latent
 * data-loss bug nobody had hit yet). `sendProjectManifest` answered a joiner's
 * `getproject` with SILENCE, so a files-only host never taught an arriving peer that
 * anything was on offer — which is the reported "shared files never auto-download on
 * connect", because auto-download hangs off the index arriving and the index never
 * arrived. And the .tp export/download gates offered nothing to save.
 *
 * Everything the document can carry counts, tombstones and the deletion log included:
 * unsharing a file and deleting one are edits somebody made, and a manifest that
 * remembers them is not pristine. ONE predicate, deliberately — a second narrow one
 * would only be the next thing to fall out of step with the shape. */
export function manifestInUse() {
	const m = get(projectManifest);
	return (
		!!m.name ||
		Object.keys(m.scenes).length > 0 ||
		m.assets.length > 0 ||
		!!m.folders?.length ||
		!!m.items?.length ||
		Object.keys(m.removed?.items ?? {}).length > 0 ||
		Object.keys(m.removed?.folders ?? {}).length > 0 ||
		!!m.deleted?.length
	);
}

// ---- persistence -------------------------------------------------------------------

let loaded = false;
/** Load the local project on boot. Idempotent. */
export async function loadProjectManifest() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		const stored = await idbGet(IDB_KEY);
		if (stored) {
			projectManifest.set(normalizeManifest(stored));
			// our own index from last session: the Explorer records carry their own flags,
			// so this is a no-op reconcile — but a peer's rows we had adopted need re-adopting
			notifySharedIndex();
		}
	} catch {}
}

async function persist() {
	try {
		if (manifestInUse()) await idbPut(IDB_KEY, get(projectManifest));
	} catch {}
}

// ---- the write path ------------------------------------------------------------------

/** The ONE local write: normalize, stamp MONOTONICALLY (several writes can share a
 * millisecond — the documented latest-wins rule), persist, optionally broadcast.
 * R22 round 30 C3: `above` is a second FLOOR. A merge commits a document that must
 * outrank BOTH sides' stamps — ours and the one we just merged in — or the sender's
 * next copy of its own older document would win the comparison and undo the union.
 * @param {Manifest} next @param {{replicate?: boolean, above?: number}} [opts] */
function commitManifest(next, opts = {}) {
	const before = get(projectManifest);
	const doc = normalizeManifest(next);
	doc.changedAt = Math.max(Date.now(), (before.changedAt ?? 0) + 1, (opts.above ?? 0) + 1);
	projectManifest.set(doc);
	void persist();
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		// R22 round 30 C4: every outbound manifest is SCOPED — see the block above the wire
		if (peer) peer.send({ type: 'manifest', manifest: outboundManifest(doc) });
	}
	return doc;
}

/**
 * Record a NEW VERSION of a scene: append the hash and move the pointer. Idempotent
 * for a hash that is already the pointer (an idle hop must not mint versions — the
 * CALLER also compares content first, this is the second gate). A hash seen earlier
 * in history is RE-APPENDED rather than deduped: "restore the old version" is a real
 * event and the pointer must move to it.
 *
 * FORK 3: a viewer publishes nothing — the write is refused, not queued.
 * @param {string} name @param {string} hash
 */
export function publishSceneVersion(name, hash) {
	const scene = String(name ?? '').trim();
	const h = String(hash ?? '').trim();
	if (!scene || !h) return false;
	if (isViewer()) return false;
	const m = get(projectManifest);
	const entry = m.scenes[scene] ?? { history: [], pinned: [] };
	if (entry.history[entry.history.length - 1] === h) return false;
	commitManifest({
		...m,
		scenes: { ...m.scenes, [scene]: { ...entry, history: [...entry.history, h] } }
	});
	return true;
}

/**
 * 21-I1 — ADOPT versions the manifest never recorded. The reported duplicate-scenes bug
 * has two halves: an item the history does not name stays VISIBLE forever (levels.js
 * folds it by NAME now), and once folded its bytes would sit on the hidden shelf with no
 * door — Version history lists the history, and the history had never heard of it. This
 * is the door.
 *
 * Where they go is the whole design. History is APPEND-ONLY and newest-LAST, and the
 * POINTER — the last element — is what the library shows, what travel-by-name resolves
 * and what every peer agrees the scene currently IS. A migration may not move it. So an
 * adopted orphan is filed as an OLDER version: the run is spliced in immediately BEFORE
 * the pointer, ordered among themselves by the item's `createdAt` (the only ordering
 * signal an orphan carries), and the pointer stays exactly where it was.
 *
 * That is a claim about ORDER, not about time: an orphan minted AFTER the pointer (a
 * viewer's save, a publish that was refused) still lands before it, because the
 * alternative is a migration silently changing which scene the project means.
 *
 * FORK 3, verbatim from publishSceneVersion: an editor writes the project document, a
 * viewer never does.
 * @param {string} name @param {string[]} hashes oldest-first; already-known ones are dropped
 * @returns {number} how many were adopted
 */
export function adoptSceneVersions(name, hashes) {
	const scene = String(name ?? '').trim();
	if (!scene) return 0;
	if (isViewer()) return 0;
	const m = get(projectManifest);
	const entry = m.scenes[scene];
	// no entry, or an entry with no pointer, is not a scene this can file anything under
	if (!entry || !entry.history.length) return 0;
	const fresh = [...new Set((hashes ?? []).map(String).filter(Boolean))].filter(
		(h) => !entry.history.includes(h)
	);
	if (!fresh.length) return 0;
	const before = [...entry.history];
	const pointer = /** @type {string} */ (before.pop());
	commitManifest({
		...m,
		scenes: { ...m.scenes, [scene]: { ...entry, history: [...before, ...fresh, pointer] } }
	});
	return fresh.length;
}

/**
 * 21-G9: name the project. It rides the manifest, so it replicates, persists to idb
 * and travels inside a .tp for free — there is nothing else to build.
 *
 * FORK 3, verbatim from publishSceneVersion: an editor writes the project document, a
 * viewer never does. Inert without a roles plugin. Refused rather than queued, for the
 * same reason a viewer's scene version is: there is no later moment at which it becomes
 * theirs to write.
 * @param {string} name @returns {boolean} did the document change
 */
export function setProjectName(name) {
	const clean = String(name ?? '').trim();
	if (isViewer()) return false;
	const m = get(projectManifest);
	if (clean === m.name) return false;
	// C4: a name given WHILE CONNECTED is a statement about the session's project, so it
	// rides out; one given in private (or before anyone arrived) is as private as the
	// scenes under it. The flag is read by outboundManifest and dies with the session —
	// and it is set BEFORE the write, because commitManifest IS the broadcast, so a flag
	// raised after it would scope out the very rename it was raised for (measured).
	if (openPeerCount() > 0) renamedThisSession = true;
	commitManifest({ ...m, name: clean });
	return true;
}

/** The project's name, or '' while it has none. @returns {string} */
export function projectName() {
	return get(projectManifest).name ?? '';
}

/** Pin/unpin a version so the local prune never drops it (fork 4).
 * @param {string} name @param {string} hash @param {boolean} on */
export function pinSceneVersion(name, hash, on = true) {
	const m = get(projectManifest);
	const entry = m.scenes[String(name ?? '').trim()];
	if (!entry || !entry.history.includes(hash)) return false;
	const pinned = on
		? [...new Set([...entry.pinned, hash])]
		: entry.pinned.filter((p) => p !== hash);
	commitManifest({ ...m, scenes: { ...m.scenes, [String(name).trim()]: { ...entry, pinned } } });
	return true;
}

/**
 * 21-G7: NAME a version. The label rides the manifest entry, so it replicates,
 * persists, exports into a .tp and survives a round trip for free — there is nothing
 * local about "this one is the one we showed the client". An empty label CLEARS it
 * (a named version becomes "Auto" again), which is what a cleared text field means.
 * @param {string} name @param {string} hash @param {string} label
 */
export function setVersionLabel(name, hash, label) {
	const scene = String(name ?? '').trim();
	const h = String(hash ?? '').trim();
	if (!scene || !h) return false;
	if (isViewer()) return false;
	const m = get(projectManifest);
	const entry = m.scenes[scene];
	if (!entry || !entry.history.includes(h)) return false;
	const text = String(label ?? '').trim();
	const labels = { ...(entry.labels ?? {}) };
	if (text) labels[h] = text;
	else delete labels[h];
	commitManifest({ ...m, scenes: { ...m.scenes, [scene]: { ...entry, labels } } });
	return true;
}

/**
 * R22-R1 — PUBLISH THE SHARED INDEX. The one write for the two sections, and
 * deliberately DUMB: it takes the rows it is given and files them. Deciding WHICH rows
 * (mine, plus the foreign ones this document already carried) belongs to
 * `sharedLibrary.js`, which can see the Explorer; this module is the leaf that cannot.
 *
 * FORK 3, verbatim from publishSceneVersion: an editor writes the project document, a
 * viewer never does. Refused rather than queued.
 *
 * Idempotent on CONTENT, which is what stops the R1 reconcile from becoming a publish
 * storm: two peers that each re-publish the same converged index write nothing at all,
 * so the exchange terminates instead of ping-ponging a monotonic stamp forever.
 * @param {any[]} folders @param {any[]} items
 * @param {any} [removed] the tombstone map; omitted keeps the document's own
 * @param {any} [deleted] the deleted log; omitted keeps the document's own
 * @returns {boolean} did the document change
 */
export function publishSharedIndex(folders, items, removed, deleted) {
	if (isViewer()) return false;
	const m = get(projectManifest);
	const nextF = normalizeSharedIndex(folders, 'folder');
	const nextI = normalizeSharedIndex(items, 'item');
	const nextR = normalizeTombs(removed ?? m.removed);
	const nextD = normalizeDeleted(deleted ?? m.deleted);
	const same =
		JSON.stringify(sortedIndex(nextF, 'id')) === JSON.stringify(sortedIndex(m.folders ?? [], 'id')) &&
		JSON.stringify(sortedIndex(nextI, 'hash')) === JSON.stringify(sortedIndex(m.items ?? [], 'hash')) &&
		JSON.stringify(nextR) === JSON.stringify(normalizeTombs(m.removed)) &&
		JSON.stringify(nextD) === JSON.stringify(normalizeDeleted(m.deleted));
	if (same) return false;
	commitManifest({ ...m, folders: nextF, items: nextI, removed: nextR, deleted: nextD });
	return true;
}

/** A stable ordering for the content compare above — row ORDER is not meaning, so two
 * indexes differing only in it must compare equal or every receive re-publishes.
 * @param {any[]} rows @param {string} key */
function sortedIndex(rows, key) {
	return [...(rows ?? [])].sort((a, b) => String(a?.[key]).localeCompare(String(b?.[key])));
}

/** The shared folder rows, or an empty list. @returns {any[]} */
export function sharedFolderRows() {
	return get(projectManifest).folders ?? [];
}

/** The shared item rows, or an empty list. @returns {any[]} */
export function sharedItemRows() {
	return get(projectManifest).items ?? [];
}

/** Is a content hash in the shared index? @param {string} hash @returns {any|null} the row */
export function sharedRowOf(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return null;
	return (get(projectManifest).items ?? []).find((r) => r.hash === h) ?? null;
}

/**
 * R22-R1 — the seam the shared index is APPLIED through. `applyRemoteManifest` runs in
 * this leaf and the adoption it triggers needs the Explorer (create the folder, look up
 * the hash, mark the record), so the consumer registers instead: a static edge from here
 * to sharedLibrary.js would be a cycle straight back into this file.
 *
 * The registration/re-apply shape is `registerToneMappingOwner`'s, including its trap —
 * a register() that re-applies synchronously must sit BELOW every `let` its closure
 * reads, or the module TDZ-crashes the SSR prerender.
 * @type {((doc: any) => void) | null} */
let sharedIndexListener = null;
/** @param {(doc: any) => void} fn */
export function registerSharedIndexListener(fn) {
	sharedIndexListener = fn;
	try {
		// re-apply at once: the document may already hold an index (idb load, a manifest
		// that arrived while this consumer was still being imported)
		if (manifestInUse()) fn(get(projectManifest));
	} catch (e) {
		console.log('shared index apply failed', e);
	}
}

/** Fire the seam. Called from every path that INSTALLS a document somebody else wrote
 * (the wire, a .tp open) — never from our own commit, which the consumer performed. */
function notifySharedIndex() {
	try {
		sharedIndexListener?.(get(projectManifest));
	} catch (e) {
		console.log('shared index apply failed', e);
	}
}

/** Track an asset the project uses (fork 8: the DISCOVERY list — bytes stay lazy).
 * @param {string[]} hashes */
export function recordProjectAssets(hashes) {
	const fresh = (hashes ?? []).map(String).filter(Boolean);
	if (!fresh.length) return;
	const m = get(projectManifest);
	const merged = [...new Set([...m.assets, ...fresh])];
	if (merged.length === m.assets.length) return;
	commitManifest({ ...m, assets: merged });
}

// ---- reads ---------------------------------------------------------------------------

/** The current pointer for a scene name, or null. @param {string} name */
export function latestSceneHash(name) {
	const entry = get(projectManifest).scenes[String(name ?? '').trim()];
	return entry ? entry.history[entry.history.length - 1] ?? null : null;
}

/** Every scene name, for the travel card's name mode. @returns {string[]} */
export function manifestSceneNames() {
	return Object.keys(get(projectManifest).scenes).sort();
}

/** Is this hash BEHIND the manifest's pointer for any scene it appears in? — the
 * "update available" badge. @param {string} hash @returns {string|null} the scene name
 * whose pointer moved past it, or null */
export function staleSceneHash(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return null;
	for (const [name, entry] of Object.entries(get(projectManifest).scenes)) {
		const at = entry.history.lastIndexOf(h);
		if (at !== -1 && at < entry.history.length - 1) return name;
	}
	return null;
}

/** Which scene a hash belongs to, newest history first — what the Version history
 * panel asks of the item it is looking at. @param {string} hash @returns {string|null} */
export function sceneOfHash(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return null;
	for (const [name, entry] of Object.entries(get(projectManifest).scenes))
		if (entry.history.includes(h)) return name;
	return null;
}

/** The whole entry for one scene, or null. @param {string} name @returns {SceneEntry|null} */
export function sceneEntry(name) {
	return get(projectManifest).scenes[String(name ?? '').trim()] ?? null;
}

/** The hashes the local prune must KEEP for one scene: the newest N (the Settings ▸
 * Files count, default KEEP_VERSIONS) plus everything pinned. At N = 0 that is the
 * POINTER plus the pins — off means "stop keeping history", never "throw away the
 * scene". The manifest itself keeps the FULL list either way: pruning is a statement
 * about local BYTES, never about history. @param {string} name @returns {Set<string>} */
export function keepableHashes(name) {
	const entry = get(projectManifest).scenes[String(name ?? '').trim()];
	if (!entry) return new Set();
	const n = get(keepVersionsSetting) ?? KEEP_VERSIONS;
	const recent = n > 0 ? entry.history.slice(-n) : entry.history.slice(-1);
	return new Set([...recent, ...entry.pinned]);
}

// ---- R22 round 30 C3 — THE UNION MERGE -----------------------------------------------
//
// WHY THIS EXISTS. Until here the receive side was whole-document latest-wins: a newer
// stamp REPLACED the older document outright. Inside one project that is honest — one
// active scene, one line of history, nothing to reconcile. Across a MESH it is
// destruction. A peer arriving with a project of its own and a newer stamp took the
// host's scene histories with it, and the user's report is the general case: ten joins
// from ten tabs must not be able to wipe a project's whole record. The ruling, verbatim
// in intent — connecting MERGES, disconnecting must not destroy (you keep your copy),
// reconnecting merges again BY HASH, a real divergence is shown rather than silently
// resolved, and the host is told when one of its pointers moved.
//
// THE SHAPE. A scene's `history` is an ordered hash array and ORDER IS THE POINTER: the
// last element is what the project currently means. So the merge is per scene NAME:
//   · a name only ONE side holds is carried WHOLE. That single line IS the wipe
//     protection, and it is why any number of joins can no longer destroy anything.
//   · equal histories, or one a strict PREFIX of the other, need no judgement. History
//     is append-only, so a prefix is the honest subset test and the longer line already
//     contains the shorter one.
//   · anything else has DIVERGED — a subset that is not a prefix included, because two
//     lines whose ORDER disagrees were written without seeing each other. The side with
//     the newer document stamp keeps its tail and its pointer; the loser's NOVEL hashes
//     are spliced in immediately BEFORE that pointer, in the loser's own relative order.
//     That is `adoptSceneVersions`' rule and it is here for the same reason: a merge may
//     ADD history, never silently change which scene the project means.
// A CLASH is recorded only when BOTH sides held hashes the other lacked. One side merely
// being behind is not a conflict, it is a catch-up, and a dialog for it would be noise.
//
// WHAT IS NOT MERGED, deliberately: the two index sections (`folders`/`items`), their
// tombstones and the deletion log stay WHOLESALE latest-wins exactly as before —
// sharedLibrary.js owns their convergence through its own reconcile (one writer per row,
// idempotent on content), and a second merge rule here would be two mechanisms fighting
// over one document. Unknown top-level fields keep latest-wins too, which is the
// normalize rule one layer out.

/**
 * @typedef {{remoteWon: boolean, novelLoser: number, tip: string}} ClashDetail
 *   Which side kept the pointer (`remoteWon`), how many hashes the OTHER side brought
 *   that the winner's line lacked (`novelLoser`), and the pointer the scene now means
 *   (`tip`). `remoteWon` is a document-level fact, so every scene in one merge agrees on
 *   it — it is carried per scene anyway because the thing that reads this is a sentence
 *   about ONE scene.
 */

/**
 * @typedef {{doc: Manifest, clashes: string[], clashDetails: Record<string, ClashDetail>,
 *   pointerMoves: string[], senderLacks: string[]}} MergeResult
 *   `clashes` = scenes where both sides had something the other lacked · `clashDetails`
 *   = the same scenes, keyed, with what a person needs to be TOLD about each (round 32:
 *   "the newest save is now current" never said WHOSE) · `pointerMoves` = scenes whose
 *   pointer moved away from what LOCAL had · `senderLacks` = merged content the REMOTE
 *   document does not carry, which is the whole reason to answer it.
 */

/** Is `a` a strict prefix of `b`? Append-only history makes this the subset test.
 * @param {string[]} a @param {string[]} b */
function isPrefix(a, b) {
	return a.length < b.length && a.every((h, i) => b[i] === h);
}

/** Same list, same order. @param {string[]} a @param {string[]} b */
function sameList(a, b) {
	return a.length === b.length && a.every((h, i) => b[i] === h);
}

/** Set union that keeps an EXISTING array untouched when it already covers the other —
 * the merged document must be byte-stable in the common case, or the deep compares below
 * see a difference that is only an ordering and every receive answers itself.
 * @param {string[]} [a] @param {string[]} [b] @returns {string[]} */
function unionKeepingOrder(a = [], b = []) {
	const setA = new Set(a);
	if (b.every((x) => setA.has(x))) return [...a];
	const setB = new Set(b);
	if (a.every((x) => setB.has(x))) return [...b];
	return [...new Set([...a, ...b])];
}

/**
 * Merge ONE scene's two entries. `remoteNewer` decides only the DIVERGED case and the
 * per-hash label tie — there is no per-entry stamp to ask, and inventing one would be a
 * migration.
 * @param {SceneEntry} a ours @param {SceneEntry} b theirs @param {boolean} remoteNewer
 * @returns {{entry: SceneEntry, clash: boolean, novelLoser: number}}
 */
function mergeSceneEntry(a, b, remoteNewer) {
	const winner = remoteNewer ? b : a;
	const loser = remoteNewer ? a : b;
	/** @type {string[]} */
	let history;
	let clash = false;
	// how many of the loser's saves the winner's line did not have. Counted HERE because
	// this is the only place that knows which side lost; the caller turns it into the
	// sentence that tells a user what happened to their work.
	let novelLoser = 0;
	if (sameList(a.history, b.history)) history = [...a.history];
	else if (isPrefix(a.history, b.history)) history = [...b.history];
	else if (isPrefix(b.history, a.history)) history = [...a.history];
	else {
		const winSet = new Set(winner.history);
		const loseSet = new Set(loser.history);
		// deduped: a loser that RE-APPENDED an old version says the same thing twice, and
		// the winner's line has no place for the repeat
		const novel = [...new Set(loser.history.filter((h) => !winSet.has(h)))];
		// a clash is MUTUAL, never one side simply being behind
		clash = novel.length > 0 && winner.history.some((h) => !loseSet.has(h));
		novelLoser = novel.length;
		const head = [...winner.history];
		const pointer = /** @type {string} */ (head.pop());
		history = [...head, ...novel, pointer];
	}
	/** @type {any} */
	const entry = {
		// spread both, winner LAST: an unknown per-entry field a newer peer added survives
		// the round trip (the normalizeAnnotation rule, applied per entry)
		...loser,
		...winner,
		history,
		pinned: unionKeepingOrder(a.pinned, b.pinned),
		// labels union, winner wins a per-hash tie; normalizeManifest prunes both back to
		// history membership, so nothing here has to
		labels: { ...(loser.labels ?? {}), ...(winner.labels ?? {}) }
	};
	return { entry, clash, novelLoser };
}

/** Which merged content the SENDER does not carry — scenes, assets and the project name
 * only. The index sections are deliberately absent: sharedLibrary's own reconcile is what
 * republishes a row a peer is missing, and answering for it here would be two writers.
 * @param {Manifest} merged @param {Manifest} theirs @returns {string[]} */
function senderLacking(merged, theirs) {
	/** @type {string[]} */
	const out = [];
	for (const [name, entry] of Object.entries(merged.scenes)) {
		const mine = theirs.scenes[name];
		if (!mine) {
			out.push(name);
			continue;
		}
		const pinDiff = entry.pinned.some((h) => !mine.pinned.includes(h));
		const labDiff = Object.entries(entry.labels ?? {}).some(
			([h, text]) => (mine.labels ?? {})[h] !== text
		);
		if (!sameList(entry.history, mine.history) || pinDiff || labDiff) out.push(name);
	}
	if (merged.assets.some((h) => !theirs.assets.includes(h))) out.push('assets');
	if (merged.name && merged.name !== theirs.name) out.push('name');
	return out;
}

/**
 * THE MERGE. Pure: no store reads, no side effects, both sides normalized on the way in
 * — which is what makes it a unit the suite can table-drive with no peer and no bytes
 * (the transferLedger/hudArrange shape).
 * @param {any} local @param {any} remote @returns {MergeResult}
 */
export function mergeManifests(local, remote) {
	const mine = normalizeManifest(local);
	const theirs = normalizeManifest(remote);
	// a TIE goes to the INCOMING side: an ordered DataConnection means an equal stamp
	// arrived later (the documented latest-wins rule, kept verbatim)
	const remoteNewer = (theirs.changedAt ?? 0) >= (mine.changedAt ?? 0);
	const newer = remoteNewer ? theirs : mine;
	// the BASE is the newer side WHOLE — which is also how the index sections, the
	// tombstones, the deletion log and any unknown field a future build adds stay
	// wholesale latest-wins without a line of their own
	/** @type {any} */
	const doc = { ...newer };
	doc.changedAt = Math.max(mine.changedAt ?? 0, theirs.changedAt ?? 0);
	// an EMPTY name never overwrites a real one; two real ones are a latest-wins field
	doc.name = mine.name && theirs.name ? newer.name : mine.name || theirs.name;
	doc.assets = unionKeepingOrder(mine.assets, theirs.assets);
	/** @type {string[]} */
	const clashes = [];
	/** @type {Record<string, ClashDetail>} */
	const clashDetails = {};
	/** @type {string[]} */
	const pointerMoves = [];
	/** @type {Record<string, SceneEntry>} */
	const scenes = {};
	for (const name of new Set([...Object.keys(mine.scenes), ...Object.keys(theirs.scenes)])) {
		const a = mine.scenes[name];
		const b = theirs.scenes[name];
		if (!a || !b) {
			// THE WIPE PROTECTION: a scene only one side knows about is carried whole
			scenes[name] = /** @type {SceneEntry} */ (a ?? b);
			continue;
		}
		const { entry, clash, novelLoser } = mergeSceneEntry(a, b, remoteNewer);
		scenes[name] = entry;
		if (clash) {
			clashes.push(name);
			// keyed by the SAME names as `clashes` — a detail for a scene that did not clash
			// would be a report of something nobody needs telling about
			clashDetails[name] = {
				remoteWon: remoteNewer,
				novelLoser,
				tip: entry.history[entry.history.length - 1]
			};
		}
		// a pointer MOVE is a statement about what we used to think this scene was, so a
		// name we never held is not one — that is an arrival, not a move
		if (a.history[a.history.length - 1] !== entry.history[entry.history.length - 1])
			pointerMoves.push(name);
	}
	doc.scenes = scenes;
	const out = normalizeManifest(doc);
	return { doc: out, clashes, clashDetails, pointerMoves, senderLacks: senderLacking(out, theirs) };
}

/** A canonical string for "these two documents mean the same thing". Key ORDER is not
 * meaning (every write spreads), and neither is the order of the SET-LIKE arrays —
 * `assets`, `pinned` and the two index sections, which `sortedIndex` already treats that
 * way. `history` and `deleted` ARE ordered and stay untouched.
 * @param {any} value @param {string} [key] @returns {string} */
function stableJson(value, key) {
	if (Array.isArray(value)) {
		const parts = value.map((row) => stableJson(row));
		if (key === 'assets' || key === 'pinned' || key === 'folders' || key === 'items')
			parts.sort();
		return '[' + parts.join(',') + ']';
	}
	if (value && typeof value === 'object')
		return (
			'{' +
			Object.keys(value)
				.sort()
				.map((k) => JSON.stringify(k) + ':' + stableJson(value[k], k))
				.join(',') +
			'}'
		);
	return JSON.stringify(value ?? null);
}

/** Same CONTENT? The stamp is excluded by construction — two documents that differ only
 * in when they were written are the same project. @param {any} a @param {any} b */
function sameContent(a, b) {
	return stableJson({ ...a, changedAt: 0 }) === stableJson({ ...b, changedAt: 0 });
}

// ---- R22 round 30 C4 — THE OUTBOUND SCOPE --------------------------------------------
//
// THE REPORT, verbatim: "when peer connects and does not open his .tpscene it shared".
//
// C3 made the RECEIVE side a union, which is what stops one join destroying a project —
// and it is exactly what makes this the next bug, because a union KEEPS everything it is
// handed. A joiner arrives carrying its own work: every scene name it ever saved, the
// version history under each, and the name it gave the whole thing. All of it landed in
// the host's document and, from there, in every peer's and in every `.tp` any of them
// exported. Nobody consented to that and nobody was asked.
//
// THE RULE, and it is a SEND boundary and nothing else. Receiving stays exactly as C3
// left it: a document you are handed is a document you keep. What changes is what a
// JOINER (`sessionHost !== null`) puts on the wire. A host — and a solo user, who is one
// — publishes its project whole, because inside a session the host's project IS the
// project. A joiner may send:
//   · `sessionSceneNames` — every scene NAME that arrived in somebody else's manifest.
//     Those are the session's own rows and they travel back VERBATIM, which is the
//     sharedIndex one-writer rule: a peer that drops rows it was taught picks a fight
//     with the peer that taught them.
//   · `openedScenes` — scenes this peer deliberately touched HERE: travelled to, saved,
//     saved a version of, or brought in by OPENING a project. That is the consent, and
//     every entry is an act a person performed.
// Everything else stays home. It is still in the LOCAL document, still in idb, still in a
// `.tp` export — nothing is deleted, it simply does not leave the machine.
//
// THE PROJECT NAME rides out only if you RENAMED during the session. A private project's
// name is as private as its scenes, and a joiner's stale one would otherwise win a
// latest-wins field against the room's. Scoped out it goes as '', which is SAFE rather
// than destructive precisely because of C3's merge rule: an empty name never overwrites a
// real one.
//
// WHAT TRAVELS WHOLE, deliberately: `assets` (content hashes, carrying no names), and the
// shared index sections with their tombstones and the deletion log. Those rows are the
// ones the user has ALREADY consented to, one at a time, through the Explorer — R1's
// whole point is that a private file's NAME never enters them — and scoping them again
// here would break sharedLibrary's reconcile, which depends on a peer carrying foreign
// rows back.
//
// READER AUDIT, because a scope that leaked into a READ would be data loss rather than
// privacy: every reader takes the LOCAL store and not one of them goes near this
// function — the remote-scene cards (`manifestSceneNames`), travel (`travelToScene` /
// `latestSceneHash`), the update dot (`staleSceneHash`), the local prune
// (`keepableHashes`), Version history (`sceneEntry`) and the `.tp` export
// (`projectFile`). Nothing loses a row here.

/** Scenes this peer opened, saved or imported THIS session — its consent to publish them.
 * @type {Set<string>} */
let openedScenes = new Set();
/** Scene names somebody else's manifest taught us this session — the session's own rows,
 * carried back verbatim so our copy can never read as a deletion. @type {Set<string>} */
let sessionSceneNames = new Set();
/** Did WE rename the project while connected? Only then does our name ride out. */
let renamedThisSession = false;
/**
 * R22 ROUND 35 — SCENES THIS PEER IS EDITING PRIVATELY. A name in here is withheld from
 * every outbound manifest, and it OVERRIDES consent in both directions.
 *
 * It has to be a set of its own rather than "absent from `openedScenes`", for the case
 * that matters most: a HOST publishes its project WHOLE (the rule two functions down), so
 * for the person most likely to be hosting, withholding consent buys nothing at all and
 * the promise "the name never leaves this machine" would be a joiner-only half-truth.
 *
 * `currentLevel.private` remains the source of truth about the SCREEN — this is a note
 * about the WIRE, written by the same two acts that set and clear that flag (the private
 * open, and `sharePrivateScene`), which is what keeps the two from drifting.
 * @type {Set<string>} */
let privateScenes = new Set();

/** Mark (or unmark) a scene as private to this machine for the rest of the session.
 * @param {string} name @param {boolean} on */
export function setScenePrivateHere(name, on) {
	const scene = String(name ?? '').trim();
	if (!scene) return;
	if (on) privateScenes.add(scene);
	else privateScenes.delete(scene);
}

/**
 * WOULD OPENING THIS SCENE TELL THE SESSION SOMETHING IT DOES NOT ALREADY KNOW?
 *
 * The question the private-open ask is built on, and it is deliberately about the NAME and
 * not about the bytes: a scene the session has already been told about (its name arrived in
 * somebody's manifest, or we consented to publish it here) cannot be made private again by
 * opening it, so asking would be theatre. A scene we have marked private is NOT shared,
 * whatever else is true of it.
 * @param {string} name @returns {boolean}
 */
export function sceneNameShared(name) {
	const scene = String(name ?? '').trim();
	if (!scene || privateScenes.has(scene)) return false;
	return sessionSceneNames.has(scene) || openedScenes.has(scene);
}

/** How many peers are actually here. The roster is populated at DIAL time, so this is
 * `openedPeers` and never `userdata.length` — the documented trap. */
function openPeerCount() {
	/** @type {any} */
	const peer = get(peers);
	return peer?.openedPeers?.size ?? 0;
}

/**
 * CONSENT. Called from levels.js (save, save-a-version, travel) and from
 * `manifestRestore` when a `.tp` OPEN promises to bring the room along.
 *
 * Deliberately NOT called by `adoptSceneIdentity`: adopting the host's scene NAME is
 * something the app does to a joiner unasked, and consent has to be an act the user
 * performed. It would buy nothing anyway — an adopted name arrived in the host's
 * manifest, so it is already in `sessionSceneNames`.
 * @param {string} name
 */
export function noteSceneOpened(name) {
	const scene = String(name ?? '').trim();
	if (scene) openedScenes.add(scene);
}

/**
 * The session ended — the last peer left. The next one starts from nothing, which is what
 * makes "still private after a reconnect" a rule rather than a one-time accident: a name
 * learned in ONE room is not public knowledge in the next, and carrying it forward would
 * walk one room's scene list into another. Wired to the same 0-peer edge sharedLibrary's
 * `endShareSession` hangs on.
 */
export function resetSessionScope() {
	openedScenes = new Set();
	sessionSceneNames = new Set();
	renamedThisSession = false;
	// R22 round 35: privacy is a fact about THIS session too. With nobody here there is
	// nothing to be private FROM, and the next connect re-asks the question the moment the
	// user opens something the new room has never seen.
	privateScenes = new Set();
}

/** A received document's scene names are the SESSION's, so they may be carried back. Fed
 * before the merge branches, so a name the host teaches us in this very message is
 * already publishable in the send-back that answers it. @param {Manifest} doc */
function noteSessionScenes(doc) {
	for (const name of Object.keys(doc.scenes ?? {})) sessionSceneNames.add(name);
}

/**
 * THE SEND BOUNDARY: every outbound `manifest` message goes through here, and nothing
 * else does.
 * @param {Manifest} doc @returns {Manifest}
 */
export function outboundManifest(doc) {
	// R22 round 35: a PRIVATE scene is withheld from both branches, and it is the host's
	// branch that makes it necessary — "publishes its project whole" would otherwise hand
	// the room the name and the whole version history of the file the user has just said is
	// theirs. Withholding a scene is safe by C3's own merge rule (a scene only one side has
	// is carried WHOLE, so an omission can never read as a deletion over there).
	const hidden = privateScenes;
	const drop = (/** @type {Record<string, SceneEntry>} */ scenes) => {
		if (!hidden.size) return scenes;
		/** @type {Record<string, SceneEntry>} */
		const out = {};
		for (const [name, entry] of Object.entries(scenes ?? {})) if (!hidden.has(name)) out[name] = entry;
		return out;
	};
	// the host — and a solo user, who is one — publishes its project whole
	if (get(sessionHost) === null)
		return hidden.size ? { ...doc, scenes: drop(doc.scenes ?? {}) } : doc;
	const allowed = new Set([...sessionSceneNames, ...openedScenes]);
	/** @type {Record<string, SceneEntry>} */
	const scenes = {};
	for (const [name, entry] of Object.entries(doc.scenes ?? {}))
		if (allowed.has(name)) scenes[name] = entry;
	return { ...doc, scenes: drop(scenes), name: renamedThisSession ? doc.name : '' };
}

// ---- the merge, surfaced -------------------------------------------------------------
//
// Session-deduped, because a merge is re-derived on every document that arrives and a
// dialog per message would be unusable. Both sets are cleared when the last peer goes,
// so a RECONNECT gets to speak again — which is exactly the moment the user asked to be
// told about, offline edits meeting each other.

/** @type {Set<string>} scene names we have already shown a divergence for */
let clashesTold = new Set();
/** @type {Set<string>} scene names we have already toasted a pointer move for */
let pointersTold = new Set();
let hadOpenPeers = false;

/** Are we the session's writer AND is anyone actually here? The pointer notice is for the
 * HOST — a joiner adopting the host's line is the normal case and needs no toast. */
function amHostWithPeers() {
	return get(sessionHost) === null && openPeerCount() > 0;
}

/** ONE scene's divergence, in words. R22 round 32: the old copy named the scenes and
 * then said "the newest save is now current", which is true of every merge and tells the
 * one person who cares — the one whose save just stopped being current — nothing. The
 * sentence names the WINNER plainly and, either way, says where the other line went: the
 * merge is a union, so nothing is ever lost and the copy has to make that obvious rather
 * than leave it to be feared.
 * @param {string} name @param {ClashDetail} detail */
function clashSentence(name, detail) {
	const n = detail.novelLoser || 1;
	const saves = n === 1 ? '1 diverging save' : n + ' diverging saves';
	return detail.remoteWon
		? `"${name}": their newer save is now current — your ${saves} ${n === 1 ? 'is' : 'are'} kept as ${n === 1 ? 'an earlier version' : 'earlier versions'}.`
		: `"${name}": your save stays current — their ${saves} ${n === 1 ? 'was' : 'were'} added as ${n === 1 ? 'an earlier version' : 'earlier versions'}.`;
}

/** @param {string[]} clashes @param {string[]} pointerMoves
 * @param {Record<string, ClashDetail>} [details] */
function surfaceMerge(clashes, pointerMoves, details) {
	const freshClashes = clashes.filter((n) => !clashesTold.has(n));
	if (freshClashes.length) {
		for (const n of freshClashes) clashesTold.add(n);
		// three named, the rest counted — the pointer toast's rule, for the same reason: a
		// dialog is read, not scrolled
		const named = freshClashes.slice(0, 3);
		const lines = named.map((n) =>
			clashSentence(n, details?.[n] ?? { remoteWon: true, novelLoser: 1, tip: '' })
		);
		if (freshClashes.length > named.length)
			lines.push('...and ' + (freshClashes.length - named.length) + ' more.');
		// fire-and-forget: by the time this shows, the divergence is already RESOLVED (both
		// lines are in the history). The dialog reports it and offers the door; it gates
		// nothing, so nothing waits on the answer.
		//
		// ONE BUTTON PER SCENE (capped at the three named): `showChoice` already renders a
		// row of them — the module-requirement prompt ships four — and a single door
		// labelled "Review versions..." cannot say WHICH history it opens when two scenes
		// diverged at once. With one clash, which is the normal case, it reads exactly as
		// it did before.
		void showChoice({
			title: 'Scene versions diverged',
			message: lines.join(' '),
			// the value is an INDEX, not the scene name: ConfirmModal builds a DOM id out of
			// it, and a scene name may hold anything a person can type
			choices: named.map((n, i) => ({
				value: 'history-' + i,
				label: named.length > 1 ? `Review "${n}"...` : 'Review versions...'
			})),
			cancelLabel: 'OK'
		}).then((answer) => {
			if (!answer?.startsWith('history-')) return;
			const name = named[Number(answer.slice('history-'.length))];
			if (!name) return;
			// LAND somewhere, rather than merely opening the panel: the Explorer, made the
			// visible dock panel (settleSceneIdentity's ritual — a card behind the Flow tab
			// is no answer), then the write-once reveal request the panel consumes. The tip
			// is passed because it is the row the user is looking for; the panel falls back
			// to the newest version it holds when this machine has no copy of that one.
			explorerClose.set(false);
			bottomDockActive.set('explorer');
			revealExplorerItem(name, details?.[name]?.tip ?? '');
		});
	}
	const freshMoves = pointerMoves.filter((n) => !pointersTold.has(n));
	if (freshMoves.length && amHostWithPeers()) {
		for (const n of freshMoves) pointersTold.add(n);
		const named = freshMoves
			.slice(0, 3)
			.map((n) => '"' + n + '"')
			.join(', ');
		showToast(
			named +
				" now points at a peer's newer save — earlier versions are kept in Version history"
		);
	}
}

/** The send-back. DEBOUNCED (the publishMine shape) because several documents can land
 * inside one connect and the answer to all of them is the same union.
 *
 * IT TERMINATES, and the argument is content-idempotence rather than the timer: the peer
 * receiving our union merges it against its own document, finds the result identical to
 * what we just sent (we already carry everything it had), installs it QUIETLY and has
 * nothing left to lack — so it does not answer. One round trip, whoever starts it. The
 * debounce only batches. (The `publishSharedIndex` precedent, one section up.)
 * @type {any} */
let sendBackTimer = null;
function scheduleManifestSendBack() {
	if (sendBackTimer) return;
	sendBackTimer = setTimeout(() => {
		sendBackTimer = null;
		// FORK 3, verbatim: an editor teaches the room, a viewer never publishes
		if (isViewer()) return;
		/** @type {any} */
		const peer = get(peers);
		// C4: the answer is scoped like every other send — see outboundManifest
		if (peer) peer.send({ type: 'manifest', manifest: outboundManifest(get(projectManifest)) });
	}, 150);
}

// ---- the wire ------------------------------------------------------------------------

/**
 * Receive side. R22 round 30 C3: this UNIONS instead of replacing — see the merge block
 * above for why, and for what stays wholesale latest-wins.
 *
 * The only refusal left is a STAMPLESS document, which is not a document. An OLDER one is
 * merged too, and that is the reconnect case the user described: a peer that edited
 * offline comes back with a lower stamp and hashes nobody else has, and refusing it would
 * throw its work away for the sake of a number. When it IS older, every wholesale section
 * stays ours by the newer-side rule, so all such a document can contribute is history.
 *
 * Three outcomes, and only two of them write:
 *   · the union says nothing new -> return false. No write, no stamp bump, no answer,
 *     which is what keeps two settled peers quiet.
 *   · the union IS what they sent -> install it quietly, keeping THEIR stamp. That is the
 *     old code path exactly, and it is the common case.
 *   · a genuine union -> commit locally above BOTH stamps, then teach the sender.
 * @param {any} data
 */
export function applyRemoteManifest(data) {
	const doc = normalizeManifest(data?.manifest);
	if (!doc.changedAt) return false;
	const mine = get(projectManifest);
	// C4: the session's own scene names, recorded BEFORE anything branches — a name taught
	// in this very message is publishable in the send-back that answers it
	noteSessionScenes(doc);
	const { doc: merged, clashes, clashDetails, pointerMoves } = mergeManifests(mine, doc);
	surfaceMerge(clashes, pointerMoves, clashDetails);
	if (sameContent(merged, mine)) return false;
	if (sameContent(merged, doc)) {
		// their document already IS the union: keep their stamp so the mesh stays on one
		// number, which is what makes the common case indistinguishable from the old code
		projectManifest.set(doc);
		void persist();
	} else {
		// above BOTH: the sender must not be able to win the next comparison with the very
		// document we just merged in
		commitManifest(merged, {
			replicate: false,
			above: Math.max(mine.changedAt ?? 0, doc.changedAt ?? 0)
		});
		// C4: judge the answer on what we can ACTUALLY send. `mergeManifests` reports what
		// the sender lacks of the FULL union, so a joiner whose only novel content is its
		// own PRIVATE scenes would answer with a document carrying nothing the sender is
		// missing — a wasted round trip per connect, and a misleading one to read on the
		// wire. Asking the SCOPED document is the same question with the scope applied.
		if (senderLacking(outboundManifest(merged), doc).length) scheduleManifestSendBack();
	}
	// R22-R1: a document somebody else wrote may carry shared rows this machine has not
	// adopted yet, and may be MISSING rows of ours (two peers sharing inside one
	// millisecond — the index sections are still whole-document latest-wins). The consumer
	// does both. Fired on every INSTALL, exactly as before: the no-change branch returns
	// early because a document identical to ours has nothing to adopt.
	notifySharedIndex();
	return true;
}

/** The late-joiner reply (rides `getproject`). Silent while pristine. @param {string} _sender */
export function sendProjectManifest(_sender) {
	if (!manifestInUse()) return;
	/** @type {any} */
	const peer = get(peers);
	// C4: a joiner answers the handshake with the SESSION's rows plus what it opened here
	if (peer) peer.send({ type: 'manifest', manifest: outboundManifest(get(projectManifest)) });
}

/** Test/import seam. Local by default; a .tp import passes replicate to bring the
 * room along. @param {any} doc @param {boolean} [replicate] */
export function manifestRestore(doc, replicate = false) {
	if (!doc) {
		projectManifest.set(defaultManifest());
		return;
	}
	const next = normalizeManifest(doc);
	// C4 CONSENT. `replicate` is the caller saying "bring the room along" — today that is
	// exactly one path, a `.tp` OPEN, which is a person at a file dialog choosing to make
	// this the project. So its scenes are consented, and so is its NAME: without both, the
	// outbound scope would keep the freshly-opened project to itself and the promise the
	// flag makes would be a lie. It lives here rather than at the call site because this
	// is the seam that knows what the document contains.
	if (replicate) {
		for (const name of Object.keys(next.scenes)) noteSceneOpened(name);
		renamedThisSession = true;
	}
	commitManifest(next, { replicate });
	// a .tp open installs somebody else's document, so its index needs adopting too
	notifySharedIndex();
}

// R22 round 30 C3, LAST in the file on purpose: a module-level subscribe runs
// SYNCHRONOUSLY at import, so every `let` its callback reads must already be declared
// (the documented TDZ trap). `peers` ticks on every open and close, so the last peer
// leaving is the edge that lets the merge notices speak again on the next connect.
peers.subscribe((p) => {
	const open = /** @type {any} */ (p)?.openedPeers?.size ?? 0;
	if (!open && hadOpenPeers) {
		clashesTold = new Set();
		pointersTold = new Set();
	}
	hadOpenPeers = open > 0;
});
