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
import { peers } from '../stores/appStore';
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
 * @param {Manifest} next @param {{replicate?: boolean}} [opts] */
function commitManifest(next, opts = {}) {
	const before = get(projectManifest);
	const doc = normalizeManifest(next);
	doc.changedAt = Math.max(Date.now(), (before.changedAt ?? 0) + 1);
	projectManifest.set(doc);
	void persist();
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'manifest', manifest: doc });
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

// ---- the wire ------------------------------------------------------------------------

/** Receive side: latest-wins on the stamp, STRICTLY older refused (an ordered
 * DataConnection means an equal stamp arrived later — the documented rule).
 * @param {any} data */
export function applyRemoteManifest(data) {
	const doc = normalizeManifest(data?.manifest);
	if (!doc.changedAt) return false;
	const mine = get(projectManifest);
	if (doc.changedAt < mine.changedAt) return false;
	projectManifest.set(doc);
	void persist();
	// R22-R1: a document somebody else wrote may carry shared rows this machine has not
	// adopted yet, and may be MISSING rows of ours (two peers sharing inside one
	// millisecond — whole-document latest-wins drops the loser). The consumer does both.
	notifySharedIndex();
	return true;
}

/** The late-joiner reply (rides `getproject`). Silent while pristine. @param {string} _sender */
export function sendProjectManifest(_sender) {
	if (!manifestInUse()) return;
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'manifest', manifest: get(projectManifest) });
}

/** Test/import seam. Local by default; a .tp import passes replicate to bring the
 * room along. @param {any} doc @param {boolean} [replicate] */
export function manifestRestore(doc, replicate = false) {
	if (!doc) {
		projectManifest.set(defaultManifest());
		return;
	}
	commitManifest(normalizeManifest(doc), { replicate });
	// a .tp open installs somebody else's document, so its index needs adopting too
	notifySharedIndex();
}
