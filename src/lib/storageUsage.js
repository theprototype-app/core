// R22 round 13 P2 — WHAT IS USING THE DISK, AND WHAT CAN GO.
//
// The user's ask was "clicking on space consumed can open a modal with estimated size
// (what consumed how much space) as a list and allow to cleanup per items or entire
// store". The SHAPE of the answer is decided by one measured fact rather than by taste:
// the whole app has exactly ONE IndexedDB store (`theprototype` / `snapshots`, see
// idb.js) with out-of-line string keys, no cursor and no size introspection. So there is
// no "per store" breakdown to read out of the browser — a breakdown is `idbKeys()` plus
// PREFIX CLASSIFICATION, and a byte number costs one read per key.
//
// A LEAF, deliberately: idb, the stores it classifies against, and arithmetic. No
// protocol, no history kind, nothing replicated. Storage is a fact about THIS machine —
// two peers in one session hold different bytes and always will — so there is nothing
// here for the wire, and that is also why every reclaim below is local and silent.
//
// TWO RULES THIS MODULE DOES NOT BEND.
//
// 1. RECLAIM GOES THROUGH THE OWNING MODULE'S DELETER, NEVER A RAW `idbDelete`. Nearly
//    every key in the store is HALF of something: a library blob has an index row, a
//    hidden version has a manifest pointer, a session has a store the manager renders.
//    Deleting the record behind the app's back leaves the other half claiming a file
//    that is gone — the dead-pointer shape the project already forbids in `.tp` exports.
//    `explorer.deleteItem`, `sessions.deleteSession`, `autosave.clearSavedSession`,
//    `prefabs.removePrefab`, `environment.deleteEnvPreset`, `userModules
//    .removeUserModule`, `sharedLibrary.purgeDeletedItem`, `assetShare
//    .forgetSharedThumb`, `vrSleeve.clearSlot` are the deleters, and each one keeps its
//    own index consistent. An UNKNOWN key — a prefix no module in this build claims — is
//    the single case that may be deleted directly, and its row says so out loud.
//
// 2. NOT EVERYTHING IS REMOVABLE, AND THE MODAL SAYS WHY RATHER THAN HIDING IT. The
//    app's convention is the Users popover's disabled Watch button with the reason
//    beside it: a control that is absent teaches nothing, a control that is refused
//    teaches the rule. `explorer:index` and `project:manifest` are STRUCTURE — dropping
//    them loses the library or the project's whole version record while freeing almost
//    nothing — and a version hash still inside `keepableHashes(name)` is what the
//    project currently POINTS AT. All three render with a disabled tick and a sentence.
//
// THE ESTIMATE IS A WHOLE-ORIGIN QUOTA. `navigator.storage.estimate()` covers
// localStorage, the caches, the service worker and IndexedDB's own overhead, not the
// library alone — which is exactly the honesty the Explorer chip's comment already
// insists on, so `unaccounted` is reported as its own figure instead of being quietly
// folded into a category. It is deliberately UNCLAMPED: `used - accounted` can come out
// NEGATIVE (idb may store a JSON record more compactly than its own text length), and a
// negative number is the truth about a coarse measurement while a clamped zero is a
// claim. The identity `accounted + unaccounted === used` therefore always holds, which
// is what makes the sum checkable.

import { writable, get } from 'svelte/store';
import { idbKeys, idbGet, idbDelete } from './idb';
import { explorerItems, hiddenItems, deleteItem } from './explorer';
import { sessions, loadSessions, deleteSession } from './sessions';
import { projectManifest, keepableHashes } from './projectManifest';
import { deletedLog, purgeDeletedItem } from './sharedLibrary';
import { prefabs, removePrefab } from './prefabs';
import { envPresets, deleteEnvPreset } from './environment';
import { userModules, removeUserModule } from './userModules';
import { sharedThumbs, forgetSharedThumb } from './assetShare';
import { sleeveSlots, clearSlot } from './vrSleeve';
import { clearSavedSession } from './autosave';
import { fmtBytes } from './transferLedger';

/**
 * ONE formatter, not a fifth. The app already had four byte formatters (Explorer's
 * `fmtSize`, SessionsManager's `fmtBytes`, userModules' private `humanSize`, and this
 * one) — adding another for a panel that is ABOUT bytes would have been the joke
 * writing itself. `transferLedger.fmtBytes` was the only one already exported, so it
 * gained the GB tier it was missing (a whole-origin quota reads in gigabytes; "10240 MB"
 * is a number nobody parses at a glance) and every reading here goes through it.
 */
export { fmtBytes };

/** Is the breakdown modal open? Lives HERE rather than in appStore so the three entry
 * points (the Explorer chip, its background menu and Settings) and the modal itself
 * share one store with no component owning it — the `openToolboxes` shape.
 * @type {import('svelte/store').Writable<boolean>} */
export const storageModalOpen = writable(false);

/** The last completed scan, so the modal can re-render without re-reading the store.
 * @type {import('svelte/store').Writable<StorageScan | null>} */
export const storageScan = writable(null);

/** @type {import('svelte/store').Writable<boolean>} a scan is in flight */
export const storageScanning = writable(false);

/**
 * @typedef {Object} StorageRow
 * @property {string} id           unique within a scan — the idb key, plus a suffix for
 *                                 the keys that hold many things (prefabs, modules)
 * @property {string} category     which category key this row belongs to
 * @property {string} label        the name a person recognises
 * @property {string} [sub]        a second line: what it is, or when it arrived
 * @property {number} bytes        estimated, and labelled as such in the UI
 * @property {boolean} removable
 * @property {string} [reason]     WHY it is refused — required when removable is false
 * @property {string} kind         which deleter reclaims it (see `reclaimRow`)
 * @property {any} [ref]           what that deleter needs: an id, a hash, a name, a key
 */

/**
 * @typedef {Object} StorageCategory
 * @property {string} key
 * @property {string} label
 * @property {string} note   one sentence: what lives here and what deleting it costs
 * @property {number} bytes
 * @property {StorageRow[]} rows
 */

/**
 * @typedef {Object} StorageScan
 * @property {number} at
 * @property {{used: number, quota: number} | null} estimate  null where the browser has
 *   no `storage.estimate()` — an absence, never a zero, which would be a claim
 * @property {StorageCategory[]} categories
 * @property {number} accounted       the sum of every category
 * @property {number | null} unaccounted  `used - accounted`, UNCLAMPED (may be negative)
 * @property {number} keys            how many idb keys were read
 */

/**
 * The category ORDER, as data. Declared here rather than derived from what a scan
 * happened to find, so an empty category still has a defined place the day it fills up,
 * and two scans of the same store list in the same order.
 */
export const CATEGORIES = [
	{
		key: 'library',
		label: 'Library files',
		note: 'The files in your Explorer library. Deleting one here is the same delete as in the Explorer.'
	},
	{
		key: 'versions',
		label: 'Old scene versions',
		note: 'Earlier versions of your scenes, kept so you can go back. The project keeps the RECORD either way — this is only the bytes on this machine.'
	},
	{
		key: 'bin',
		label: 'Deleted files',
		note: 'Files in the recycle bin. Their bytes are still here so a delete can be undone; reclaiming them leaves the record of what was deleted.'
	},
	{
		key: 'scenes',
		label: 'Saved scenes',
		note: 'Saved sessions holding one scene.'
	},
	{
		key: 'projects',
		label: 'Saved projects',
		note: 'Saved sessions that carry a whole library with them, which is why they are the largest entries here.'
	},
	{
		key: 'autosave',
		label: 'Autosave',
		note: 'The snapshot the app restores after a crash or a reload. It is rewritten as you work, so clearing it only loses the restore point.'
	},
	{
		key: 'structure',
		label: 'Project structure',
		note: 'The library index and the project manifest. Tiny, and everything else here is addressed THROUGH them — so they cannot be removed.'
	},
	{
		key: 'prefabs',
		label: 'Prefabs',
		note: 'Objects you saved to reuse.'
	},
	{
		key: 'thumbs',
		label: 'Peer thumbnails',
		note: 'Pictures of files other people shared but you never downloaded. Purely a cache — they come back the next time you see those files.'
	},
	{
		key: 'modules',
		label: 'Installed modules',
		note: 'Modules you installed from a .zip or a URL, with their packaged files.'
	},
	{
		key: 'presets',
		label: 'Environment presets',
		note: 'Lighting and sky presets you saved.'
	},
	{
		key: 'sleeve',
		label: 'VR sleeve slots',
		note: 'The objects on your VR forearm strip.'
	},
	{
		key: 'other',
		label: 'Other',
		note: 'Keys no part of this build claims — left over from an older version, or from a module that is gone. These are the one thing here deleted directly, because there is nothing left to keep consistent with them.'
	}
];

const KEY_INDEX = 'explorer:index';
const KEY_THUMBS = 'explorer:thumbs';
const KEY_BLOB = 'explorer:blob:';
const KEY_SESSION = 'session:';
const KEY_MANIFEST = 'project:manifest';
const KEY_PREFABS = 'prefabs-v1';
const KEY_MODULES = 'user-modules-v1';
const KEY_PRESET = 'envpreset:';
const KEY_SLEEVE = 'vrsleeve-slots-v1';
const KEY_AUTOSAVE = 'latest';

/** how long one idb read may take before the scan gives up on measuring it */
const READ_TIMEOUT_MS = 5000;
/** a sentinel the timeout resolves with — `undefined` is a legitimate stored value */
const UNMEASURED = Symbol('unmeasured');
/**
 * A BOUNDED read. `idb.js` settles its promise on the request's own `onsuccess` /
 * `onerror` and nothing else — so a transaction that ABORTS without firing either leaves
 * the promise pending FOREVER, and an `await` on it stalls whatever is holding it with no
 * error anywhere. Measured here, and it is worth stating precisely because the symptom is
 * so unhelpful: a scan opened from the header chip stopped after three keys, the panel
 * kept showing the PREVIOUS reading, `unhandledrejection` never fired, and a scan started
 * a few seconds later over the same store completed normally.
 *
 * A panel whose whole job is to report a number must not be able to hang silently, so a
 * read that does not come back inside the window is reported as an UNMEASURED row rather
 * than being waited on. It is the honest degradation: the row still appears, still says
 * what it is, and still offers to remove itself — only its size is missing, and it says
 * so. (The scan needs six of these now rather than one per file: see the blob branch.)
 * @param {string} key @returns {Promise<{value: any, measured: boolean}>}
 */
async function safeGet(key) {
	/** @type {any} */
	let timer = null;
	try {
		const value = await Promise.race([
			idbGet(key),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(UNMEASURED), READ_TIMEOUT_MS);
			})
		]);
		return value === UNMEASURED ? { value: null, measured: false } : { value, measured: true };
	} catch {
		return { value: null, measured: false };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Bytes of one stored value, measured the way it is STORED. A Blob is structure-cloned
 * whole, so `.size` is the truth; everything else is JSON, whose size has to be encoded
 * to be known. An ESTIMATE either way — idb's own per-record overhead is not observable
 * from in here, which is why every number in this module is labelled as estimated.
 * @param {any} value @returns {number}
 */
export function valueBytes(value) {
	if (value == null) return 0;
	try {
		if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
		if (value instanceof ArrayBuffer) return value.byteLength;
		if (typeof value?.byteLength === 'number') return value.byteLength;
		if (typeof value === 'string') return new TextEncoder().encode(value).length;
		return new TextEncoder().encode(JSON.stringify(value)).length;
	} catch {
		return 0;
	}
}

/**
 * A module record's bytes: its packaged files plus the record around them. `userModules`
 * has a private `describeFiles` doing the same sum for its cards — it is not exported,
 * and the four lines of arithmetic here are not worth widening that module's surface to
 * share. @param {any} record @returns {number}
 */
function moduleBytes(record) {
	let bytes = 0;
	try {
		const { files, ...rest } = record ?? {};
		for (const f of Object.values(files ?? {})) bytes += Number(/** @type {any} */ (f)?.byteLength ?? /** @type {any} */ (f)?.length) || 0;
		bytes += valueBytes(rest);
	} catch {}
	return bytes;
}

/** short, locale-correct, sortable-looking — the Explorer's own date shape @param {number} t */
function fmtWhen(t) {
	if (!t) return '';
	try {
		return new Date(t).toLocaleDateString(undefined, {
			year: '2-digit',
			month: 'short',
			day: 'numeric'
		});
	} catch {
		return '';
	}
}

/**
 * Every hash the project's version history currently wants to keep, across every scene.
 * A hidden item whose hash is in here is what "the latest of Arena" MEANS — refusing it
 * is the same rule `pruneSceneVersions` already honours, said out loud in the UI instead
 * of silently skipping the row. @returns {Set<string>}
 */
function keptHashes() {
	const out = new Set();
	try {
		const names = Object.keys(get(projectManifest).scenes ?? {});
		for (const name of names) for (const h of keepableHashes(name)) out.add(h);
	} catch {}
	return out;
}

/**
 * READ THE STORE AND CLASSIFY IT. One `idbGet` per key, except for `session:` keys:
 * `loadSessions()` already reads every payload in full and publishes `bytes` (through
 * its own `payloadBytes`) and `hasLibrary` on each meta, so re-reading them here would
 * both cost twice and duplicate the one measurement that knows a project session's
 * library rows are Blobs.
 * @returns {Promise<StorageScan>}
 */
export async function scanStorage() {
	storageScanning.set(true);
	try {
		/** @type {any} */
		let estimate = null;
		try {
			const est = await navigator?.storage?.estimate?.();
			if (est && typeof est.usage === 'number')
				estimate = { used: est.usage ?? 0, quota: est.quota ?? 0 };
		} catch {}

		// the session metas are the authority on `session:` keys — see the note above
		try {
			await loadSessions();
		} catch {}

		/** @type {any[]} */
		let keys = [];
		try {
			keys = await idbKeys();
		} catch {}

		/** @type {Map<string, StorageRow[]>} */
		const buckets = new Map();
		for (const c of CATEGORIES) buckets.set(c.key, []);
		/** @param {StorageRow} row */
		const push = (row) => buckets.get(row.category)?.push(row);

		const visible = new Map(get(explorerItems).map((/** @type {any} */ i) => [i.id, i]));
		const hidden = new Map(get(hiddenItems).map((/** @type {any} */ i) => [i.id, i]));
		const binHashes = new Set(deletedLog(get(projectManifest)).map((/** @type {any} */ r) => r.hash));
		const kept = keptHashes();
		const sessionMetas = new Map(get(sessions).map((/** @type {any} */ m) => [m.id, m]));

		for (const raw of keys) {
			const key = String(raw);

			// ---- library files, hidden versions, the recycle bin -----------------------
			// One key SHAPE, four populations, and they are told apart by which SHELF the
			// record sits on rather than by anything in the key: the blob is id-addressed
			// and hiding is a move between two lists that never touches it (21-G7).
			if (key.startsWith(KEY_BLOB)) {
				const id = key.slice(KEY_BLOB.length);
				const item = visible.get(id) ?? hidden.get(id);
				// THE RECORD ALREADY KNOWS. `explorer.writeItem` mirrors `blob.size` onto the
				// item as it stores it, so reading the blob back to measure it buys nothing and
				// costs everything: the first version of this loop pulled EVERY file in the
				// library into memory on every scan — up to the 25 MB import cap per file — to
				// learn a number already sitting in the index. It is also what exposed the
				// unsettling-read trap above, since it made one read per file instead of six in
				// total. Only an ORPHAN, whose record is gone, has to be opened.
				let bytes = Number(item?.size) || 0;
				let measured = true;
				if (!item) {
					const got = await safeGet(key);
					bytes = valueBytes(got.value);
					measured = got.measured;
				}
				if (visible.has(id)) {
					push({
						id: key,
						category: 'library',
						label: item.name,
						sub: item.kind + (item.hash ? ' · ' + String(item.hash).slice(0, 8) : ''),
						bytes,
						removable: true,
						kind: 'item',
						ref: id
					});
				} else if (hidden.has(id)) {
					const inBin = binHashes.has(item.hash);
					const isKept = kept.has(item.hash);
					push({
						id: key,
						category: inBin ? 'bin' : 'versions',
						label: item.name,
						sub: inBin
							? 'in the recycle bin'
							: 'version ' + String(item.hash ?? '').slice(0, 8),
						bytes,
						removable: !isKept,
						reason: isKept
							? 'The project points at this version — it is the current or a pinned one. Unpin it, or lower Settings ▸ Explorer ▸ versions kept, and it becomes removable.'
							: undefined,
						kind: inBin ? 'bin' : 'item',
						ref: inBin ? item.hash : id
					});
				} else {
					// no record on either shelf: real garbage, and `deleteItem` is still the
					// right deleter — it removes the bytes and rewrites the index, so an
					// orphan cannot come back as a half-row
					push({
						id: key,
						category: 'other',
						label: 'Orphaned file bytes',
						sub: id.slice(0, 12) + (measured ? ' — no library record' : ' — size could not be read'),
						bytes,
						removable: true,
						kind: 'item',
						ref: id
					});
				}
				continue;
			}

			// ---- saved sessions: a scene, or a whole project --------------------------
			if (key.startsWith(KEY_SESSION)) {
				const id = key.slice(KEY_SESSION.length);
				const meta = sessionMetas.get(id);
				if (meta) {
					push({
						id: key,
						category: meta.hasLibrary ? 'projects' : 'scenes',
						label: meta.name || 'Untitled',
						sub: meta.hasLibrary
							? meta.libraryCount + (meta.libraryCount === 1 ? ' file' : ' files') + ' · ' + fmtWhen(meta.createdAt)
							: fmtWhen(meta.createdAt),
						bytes: Number(meta.bytes) || 0,
						removable: true,
						kind: 'session',
						ref: id
					});
				} else {
					// a record `loadSessions` could not read — it still occupies the disk
					push({
						id: key,
						category: 'scenes',
						label: 'Unreadable session',
						sub: id.slice(0, 12),
						bytes: valueBytes((await safeGet(key)).value),
						removable: true,
						kind: 'session',
						ref: id
					});
				}
				continue;
			}

			// ---- environment presets --------------------------------------------------
			if (key.startsWith(KEY_PRESET)) {
				const name = key.slice(KEY_PRESET.length);
				push({
					id: key,
					category: 'presets',
					label: name,
					bytes: valueBytes((await safeGet(key)).value),
					removable: true,
					kind: 'preset',
					ref: name
				});
				continue;
			}

			// ---- the two STRUCTURE keys ----------------------------------------------
			if (key === KEY_INDEX) {
				push({
					id: key,
					category: 'structure',
					label: 'Library index',
					sub: get(explorerItems).length + ' files · ' + get(hiddenItems).length + ' hidden',
					bytes: valueBytes((await safeGet(key)).value),
					removable: false,
					reason: 'Every file above is addressed through this index. Removing it would lose the whole library while freeing almost nothing — delete the files instead and it shrinks with them.',
					kind: 'none'
				});
				continue;
			}
			if (key === KEY_MANIFEST) {
				push({
					id: key,
					category: 'structure',
					label: 'Project manifest',
					sub: Object.keys(get(projectManifest).scenes ?? {}).length + ' scenes',
					bytes: valueBytes((await safeGet(key)).value),
					removable: false,
					reason: 'This is the project: which scenes exist and every version of each. Removing it would lose that record while freeing almost nothing.',
					kind: 'none'
				});
				continue;
			}

			// ---- one key, many things -------------------------------------------------
			if (key === KEY_PREFABS) {
				const list = get(prefabs);
				for (const p of list)
					push({
						id: key + '#' + p.id,
						category: 'prefabs',
						label: p.name || 'Prefab',
						sub: fmtWhen(p.createdAt),
						bytes: valueBytes(p),
						removable: true,
						kind: 'prefab',
						ref: p.id
					});
				continue;
			}
			if (key === KEY_MODULES) {
				for (const m of get(userModules))
					push({
						id: key + '#' + m.id,
						category: 'modules',
						label: m.name || m.id,
						sub: (m.version ? 'v' + m.version : '') + (m.source ? ' · ' + m.source : ''),
						bytes: moduleBytes(m),
						removable: true,
						kind: 'module',
						ref: m.id
					});
				continue;
			}
			if (key === KEY_SLEEVE) {
				for (const s of get(sleeveSlots))
					push({
						id: key + '#' + s.id,
						category: 'sleeve',
						label: s.name || 'Slot',
						bytes: valueBytes(s),
						removable: true,
						kind: 'sleeve',
						ref: s.id
					});
				continue;
			}
			if (key === KEY_THUMBS) {
				// ONE row, not five hundred. Every entry is a few KB of the same cache with
				// the same answer, so a list of them would be five hundred identical
				// decisions — which is the shape the user asked to be able to clear "entire
				// store" in one gesture.
				const map = get(sharedThumbs);
				const hashes = Object.keys(map);
				let bytes = 0;
				for (const h of hashes) bytes += valueBytes(map[h]);
				if (hashes.length)
					push({
						id: key,
						category: 'thumbs',
						label: 'Cached pictures of files you do not hold',
						sub: hashes.length + (hashes.length === 1 ? ' thumbnail' : ' thumbnails'),
						bytes,
						removable: true,
						kind: 'thumbs',
						ref: hashes
					});
				continue;
			}
			if (key === KEY_AUTOSAVE) {
				push({
					id: key,
					category: 'autosave',
					label: 'Restore point',
					sub: 'the snapshot a reload offers to restore',
					bytes: valueBytes((await safeGet(key)).value),
					removable: true,
					kind: 'autosave'
				});
				continue;
			}

			// ---- anything else --------------------------------------------------------
			push({
				id: key,
				category: 'other',
				label: key,
				sub: 'no part of this build claims this key',
				bytes: valueBytes((await safeGet(key)).value),
				removable: true,
				kind: 'raw',
				ref: key
			});
		}

		/** @type {StorageCategory[]} */
		const categories = CATEGORIES.map((c) => {
			const rows = (buckets.get(c.key) ?? []).sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
			return { ...c, rows, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
		});
		const accounted = categories.reduce((n, c) => n + c.bytes, 0);
		/** @type {StorageScan} */
		const scan = {
			at: Date.now(),
			estimate,
			categories,
			accounted,
			// UNCLAMPED on purpose — see the header. A negative figure says our own sum
			// exceeds what the browser reports, which is a fact about a coarse
			// measurement, not an error to hide.
			unaccounted: estimate ? estimate.used - accounted : null,
			keys: keys.length
		};
		storageScan.set(scan);
		return scan;
	} finally {
		storageScanning.set(false);
	}
}

/**
 * Reclaim ONE row through whoever owns it. Returns the bytes it claims to have freed,
 * or 0 when it refused. A non-removable row is refused HERE as well as in the UI: the
 * disabled tick is a courtesy, this is the rule.
 * @param {StorageRow} row @returns {Promise<number>}
 */
export async function reclaimRow(row) {
	if (!row?.removable) return 0;
	try {
		switch (row.kind) {
			case 'item':
				await deleteItem(String(row.ref));
				return row.bytes;
			case 'bin':
				// the LOG entry stays: "this was deleted" is still true once the bytes go
				await purgeDeletedItem(String(row.ref));
				return row.bytes;
			case 'session':
				await deleteSession(String(row.ref));
				return row.bytes;
			case 'autosave':
				await clearSavedSession();
				return row.bytes;
			case 'prefab':
				await removePrefab(String(row.ref));
				return row.bytes;
			case 'preset':
				await deleteEnvPreset(String(row.ref));
				return row.bytes;
			case 'module':
				await removeUserModule(String(row.ref));
				return row.bytes;
			case 'sleeve':
				clearSlot(String(row.ref));
				return row.bytes;
			case 'thumbs':
				for (const h of /** @type {string[]} */ (row.ref ?? [])) forgetSharedThumb(h);
				return row.bytes;
			case 'raw':
				// THE ONE DIRECT DELETE. Nothing in this build reads this key, so there is
				// no index to keep consistent and no module to route through.
				await idbDelete(String(row.ref));
				return row.bytes;
			default:
				return 0;
		}
	} catch {
		return 0;
	}
}

/**
 * Reclaim a SET of rows and re-scan. Rows are taken in a defined order — biggest first
 * within the order the categories are declared — so two runs over one selection do the
 * same thing, and a failure part-way leaves a state that reads the same either way.
 * @param {StorageRow[]} rows @returns {Promise<{freed: number, removed: number, scan: StorageScan}>}
 */
export async function reclaimRows(rows) {
	let freed = 0;
	let removed = 0;
	for (const row of rows ?? []) {
		const n = await reclaimRow(row);
		if (n > 0 || (row?.removable && n === 0 && row.bytes === 0)) removed++;
		freed += n;
	}
	const scan = await scanStorage();
	return { freed, removed, scan };
}

/** The bytes a selection would free — the footer's number, and the arithmetic behind the
 * confirm. Skips anything refused, so it can never promise bytes that will not move.
 * @param {StorageRow[]} rows @returns {number} */
export function selectionBytes(rows) {
	return (rows ?? []).reduce((n, r) => n + (r?.removable ? r.bytes : 0), 0);
}

/** Open the breakdown, scanning as it goes. The three entry points share this so none of
 * them has to know that a scan is asynchronous. */
export function openStorageModal() {
	storageModalOpen.set(true);
	void scanStorage();
}
