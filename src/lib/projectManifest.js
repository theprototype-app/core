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
/** versions of ONE scene kept locally beyond the pinned set (fork 4) */
export const KEEP_VERSIONS = 10;

/**
 * @typedef {{history: string[], pinned: string[]}} SceneEntry  history newest-LAST;
 *   the pointer is the last element
 * @typedef {{name: string, scenes: Record<string, SceneEntry>, assets: string[],
 *   changedAt: number}} Manifest
 */

/** @returns {Manifest} */
function defaultManifest() {
	return { name: '', scenes: {}, assets: [], changedAt: 0 };
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
		scenes[clean] = { history, pinned };
	}
	return {
		...data,
		// 21-G9: the project NAME — the Explorer header's identity, the .tp default
		// filename and (G8) the import folder name. A plain trimmed string, absent
		// meaning '' so every pre-G9 manifest normalizes unchanged.
		name: String(data.name ?? '').trim(),
		scenes,
		assets: Array.isArray(data.assets) ? [...new Set(data.assets.map(String).filter(Boolean))] : [],
		changedAt: Number(data.changedAt) || 0
	};
}

/** The live document. @type {import('svelte/store').Writable<Manifest>} */
export const projectManifest = writable(defaultManifest());

/** Is there anything in it? A pristine manifest writes no idb key and rides no save.
 * 21-G9: NAMING a project is itself an act of creating one — a user who types a name
 * and reloads must find it there, so the name counts alongside scenes and assets. */
export function manifestInUse() {
	const m = get(projectManifest);
	return !!m.name || Object.keys(m.scenes).length > 0 || m.assets.length > 0;
}

// ---- persistence -------------------------------------------------------------------

let loaded = false;
/** Load the local project on boot. Idempotent. */
export async function loadProjectManifest() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		const stored = await idbGet(IDB_KEY);
		if (stored) projectManifest.set(normalizeManifest(stored));
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

/** The hashes the local prune must KEEP for one scene: the newest KEEP_VERSIONS plus
 * everything pinned. The manifest itself keeps the FULL list — pruning is a statement
 * about local BYTES, never about history. @param {string} name @returns {Set<string>} */
export function keepableHashes(name) {
	const entry = get(projectManifest).scenes[String(name ?? '').trim()];
	if (!entry) return new Set();
	return new Set([...entry.history.slice(-KEEP_VERSIONS), ...entry.pinned]);
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
}
