// 36 B14 — NAMED CHECKPOINTS AND A VERSION TIMELINE.
//
// Autosave keeps ONE snapshot (`latest`) and rewrites it as you work, so it answers "what was
// I doing when the tab died" and nothing about "what did this look like an hour ago". A
// checkpoint is that second answer: a copy of the scene, kept on this device, with a name, a
// note, a picture and a time. Two kinds share one list:
//
//   · NAMED — "Save checkpoint…" (Ctrl+Shift+S, the burger menu, the timeline's own button).
//   · AUTO  — every Nth minute that autosave actually wrote something, one more row is cut from
//     the same moment ("Keep automatic checkpoints", Settings ▸ Scene). An untouched scene cuts
//     nothing: a row whose content signature equals the newest row's is not written.
//
// THE FORMAT IS A SESSION PAYLOAD (`buildSessionPayload`), not autosave's GLTF snapshot, and
// that is the decision this file rests on. A restore REPLACES the scene, and the sessions load
// path is the one that already knows how to do that properly: the object-budget gate, the
// module keep/unload question, the clear-then-build order, kit-piece stubs, and — with peers
// connected — the room PROPOSAL everybody has to accept. A second restore path over the GLTF
// format would have to grow every one of those again. The cost is that an auto row builds its
// own payload instead of copying autosave's, which is why an auto row is cut at most every few
// minutes, only after a write autosave already decided was worth doing, only in an idle
// callback, and never while a load or a simulation runs.
//
// STORAGE: one idb key per checkpoint (`checkpoint:<id>`, the payload) + ONE index key
// (`checkpoints:index`, the light rows the timeline draws: no scene bytes, a 256 px thumbnail).
// The index is what a list reads, so opening the timeline never parses a scene. The two can
// disagree after a crash between the writes; `loadCheckpoints` reconciles (an orphan payload is
// re-indexed, an index row with no payload is dropped).
//
// THE CAP: total bytes (Settings, default 250 MB) and a hard count (MAX_CHECKPOINTS). A save
// that would cross either evicts OLDEST-UNPINNED first — automatic rows before named ones,
// because a name is a person saying "this one". Pinned rows are never evicted; a save that
// cannot fit even after every unpinned row is gone is refused with a toast, not forced.
//
// LOCAL ONLY: nothing here replicates. A checkpoint is a private undo-beyond-undo for the
// person at this keyboard; a RESTORE is what touches the room, and it does so through the same
// proposal a session load uses. Scene VERSIONS (21-G7, the library card's history) are the
// shared, project-level counterpart and are untouched by this.
import { writable, get } from 'svelte/store';
import { idbGet, idbPut, idbDelete, idbKeys } from './idb';
import { safeStorage } from './safeStorage';
import { log } from './diagnostics';
import { objectsGroup } from '../stores/sceneStore';
import { showToast, showInfoToast, checkpointSaveOpen } from '../stores/appStore';
import { autosaveStatus } from './autosave';
import { buildSessionPayload, requestLoadPayload } from './sessions';
import { currentLevel, sceneSignature } from './levels';
import { sceneFileName } from './gameSettings';
import { loading as sceneLoading } from './sceneLoader';
// the pure half (vitest: tests/unit/checkpointsCore)
import { planEviction, fingerprint } from './checkpointsCore';
export { planEviction, fingerprint, dayLabel, formatBytes } from './checkpointsCore';

export const KEY = 'checkpoint:';
export const INDEX_KEY = 'checkpoints:index';
/** a hard ceiling on rows, whatever the byte cap says — the timeline is a list a person reads */
export const MAX_CHECKPOINTS = 60;
export const CAP_CHOICES_MB = [100, 250, 500, 1000];
export const DEFAULT_CAP_MB = 250;
export const INTERVAL_CHOICES_MIN = [5, 10, 30, 60];
export const DEFAULT_INTERVAL_MIN = 10;

/**
 * @typedef {{
 *   id: string, name: string, note: string, createdAt: number, count: number, bytes: number,
 *   thumbnail: string | null, pinned: boolean, auto: boolean, scene: string, sig: string
 * }} CheckpointMeta
 */

/** the timeline's rows, newest first @type {import('svelte/store').Writable<CheckpointMeta[]>} */
export const checkpoints = writable([]);
// the timeline window + the save dialog are appStore's (anyModalOpen gates shortcuts on them)
export { checkpointsOpen, checkpointSaveOpen } from '../stores/appStore';
/** a save or restore is running (buttons disable) */
export const checkpointBusy = writable(false);

/* ---------------------------------------------------------------- settings ---- */

/** @param {string} key @param {number} fallback @param {number[]} allowed */
function readChoice(key, fallback, allowed) {
	try {
		const n = Number(safeStorage.getItem(key));
		return allowed.includes(n) ? n : fallback;
	} catch {
		return fallback;
	}
}

/** LOCAL, default ON @type {import('svelte/store').Writable<boolean>} */
export const autoCheckpoints = writable(safeStorage.getItem('checkpoints:auto') !== 'false');
/** minutes between automatic rows @type {import('svelte/store').Writable<number>} */
export const autoCheckpointMinutes = writable(readChoice('checkpoints:every', DEFAULT_INTERVAL_MIN, INTERVAL_CHOICES_MIN));
/** the byte cap in MB @type {import('svelte/store').Writable<number>} */
export const checkpointCapMb = writable(readChoice('checkpoints:capMb', DEFAULT_CAP_MB, CAP_CHOICES_MB));
autoCheckpoints.subscribe((v) => safeStorage.setItem('checkpoints:auto', String(v)));
autoCheckpointMinutes.subscribe((v) => safeStorage.setItem('checkpoints:every', String(v)));
checkpointCapMb.subscribe((v) => safeStorage.setItem('checkpoints:capMb', String(v)));

/* --------------------------------------------------------------- the index ---- */

/** @param {any} payload @param {any} extra @returns {CheckpointMeta} */
function metaOf(payload, extra = {}) {
	const cp = payload?.checkpoint ?? {};
	return {
		id: String(cp.id ?? payload?.id ?? ''),
		name: String(cp.name ?? payload?.name ?? 'Checkpoint'),
		note: String(cp.note ?? ''),
		createdAt: Number(payload?.createdAt) || Date.now(),
		count: Number(payload?.count) || 0,
		bytes: Number(cp.bytes) || 0,
		thumbnail: payload?.thumbnail ?? null,
		pinned: !!cp.pinned,
		auto: !!cp.auto,
		scene: String(cp.scene ?? ''),
		sig: String(cp.sig ?? ''),
		...extra
	};
}

/** @param {CheckpointMeta[]} rows */
async function writeIndex(rows) {
	const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
	await idbPut(INDEX_KEY, sorted);
	checkpoints.set(sorted);
}

let loaded = false;

/**
 * Read the index and RECONCILE it with the payload keys (a crash between the two writes of a
 * save or a delete leaves them disagreeing). Cheap in the normal case: one keys() + one get.
 */
export async function loadCheckpoints() {
	try {
		/** @type {CheckpointMeta[]} */
		const index = (await idbGet(INDEX_KEY)) ?? [];
		const keys = new Set((await idbKeys()).map(String).filter((/** @type {string} */ k) => k.startsWith(KEY)));
		let changed = false;
		const rows = index.filter((r) => {
			const ok = keys.has(KEY + r.id);
			if (!ok) changed = true;
			return ok;
		});
		const known = new Set(rows.map((r) => KEY + r.id));
		for (const key of keys) {
			if (known.has(key)) continue;
			const payload = await idbGet(key);
			if (!payload) continue;
			rows.push(metaOf(payload, { id: key.slice(KEY.length) }));
			changed = true;
		}
		if (changed) await writeIndex(rows);
		else checkpoints.set([...rows].sort((a, b) => b.createdAt - a.createdAt));
		loaded = true;
	} catch (error) {
		log('warn', 'checkpoints', 'load failed', String(error));
	}
}

async function ensureLoaded() {
	if (!loaded) await loadCheckpoints();
}

/* ---------------------------------------------------------------- the save ---- */

/** the name the scene is known by NOW — it is what a restore must hand back to the load
 * (sessions.applySession makes the payload's name the game's identity for its settings) */
function currentSceneName() {
	return get(currentLevel)?.name || sceneFileName() || '';
}

/** Is there anything worth keeping? An empty scene with no graph is not a checkpoint. @param {any} p */
function hasContent(p) {
	if ((p?.objects?.length ?? 0) > 0) return true;
	return Object.values(p?.graphs ?? {}).some((/** @type {any} */ g) => (g?.nodes?.length ?? 0) > 0);
}

let saving = false;
/** TEST SEAM: a byte cap below the smallest setting, so eviction runs on a few small scenes */
/** @type {number | null} */
let capOverride = null;

/**
 * Cut a checkpoint of the scene as it is now.
 * `backup` (a restore's safety copy): when a row already holds exactly this content, that row is
 * returned and nothing is written — the scene being left is already in the timeline.
 * @param {{name?: string, note?: string, auto?: boolean, quiet?: boolean, pinned?: boolean, backup?: boolean}} [opts]
 * @returns {Promise<CheckpointMeta | null>} the new row, or null (nothing to save, refused, busy)
 */
export async function saveCheckpoint(opts = {}) {
	const { auto = false, quiet = false, pinned = false, backup = false } = opts;
	if (saving) return null;
	saving = true;
	checkpointBusy.set(true);
	try {
		await ensureLoaded();
		const scene = currentSceneName();
		const name = String(opts.name ?? '').trim() || (auto ? 'Autosave' : 'Checkpoint ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
		/** @type {any} */
		const payload = buildSessionPayload(scene || name);
		if (!payload || !hasContent(payload)) {
			if (!quiet) showToast('Nothing to checkpoint yet — the scene is empty');
			return null;
		}
		const sig = fingerprint(sceneSignature(payload));
		const rows = get(checkpoints);
		if (backup) {
			const same = rows.find((r) => r.sig === sig);
			if (same) return same;
		} else if (auto && rows[0]?.sig === sig) return null; // nothing changed since the newest row
		const bytes = JSON.stringify(payload).length;
		const capBytes = capOverride ?? get(checkpointCapMb) * 1024 * 1024;
		if (bytes > capBytes) {
			if (!quiet) showToast('This scene is larger than the checkpoint storage limit (' + get(checkpointCapMb) + ' MB, Settings ▸ Scene)');
			return null;
		}
		const id = String(payload.id);
		payload.checkpoint = { id, name, note: String(opts.note ?? '').trim(), auto, pinned, scene, sig, bytes };
		const meta = metaOf(payload);
		const plan = planEviction([meta, ...rows], capBytes, MAX_CHECKPOINTS, id);
		if (!plan.fits) {
			if (!quiet) showToast('Checkpoint storage is full of pinned checkpoints — unpin or delete some in the timeline');
			return null;
		}
		await idbPut(KEY + id, payload);
		for (const gone of plan.evict) await idbDelete(KEY + gone).catch(() => {});
		await writeIndex([meta, ...rows.filter((r) => !plan.evict.includes(r.id))]);
		if (!quiet)
			showToast(
				'Checkpoint saved: ' + name +
					(plan.evict.length ? ' — ' + plan.evict.length + ' oldest unpinned checkpoint' + (plan.evict.length === 1 ? '' : 's') + ' removed to make room' : '')
			);
		return meta;
	} catch (error) {
		log('warn', 'checkpoints', 'save failed', String(error));
		if (!quiet) showToast('Could not save the checkpoint: ' + String(/** @type {any} */ (error)?.message ?? error));
		return null;
	} finally {
		saving = false;
		checkpointBusy.set(false);
	}
}

/* ------------------------------------------------------------ edit a row ---- */

/** @param {string} id @param {(meta: CheckpointMeta, payload: any) => void} change */
async function editRow(id, change) {
	await ensureLoaded();
	const rows = get(checkpoints);
	const row = rows.find((r) => r.id === id);
	if (!row) return false;
	const payload = await idbGet(KEY + id);
	const next = { ...row };
	change(next, payload);
	if (payload) {
		payload.checkpoint = { ...(payload.checkpoint ?? {}), name: next.name, note: next.note, pinned: next.pinned };
		await idbPut(KEY + id, payload);
	}
	await writeIndex(rows.map((r) => (r.id === id ? next : r)));
	return true;
}

/** @param {string} id @param {string} name */
export function renameCheckpoint(id, name) {
	const clean = String(name ?? '').trim();
	if (!clean) return Promise.resolve(false);
	return editRow(id, (m) => (m.name = clean));
}

/** @param {string} id @param {string} note */
export function setCheckpointNote(id, note) {
	return editRow(id, (m) => (m.note = String(note ?? '').trim()));
}

/** @param {string} id @param {boolean} [on] */
export function pinCheckpoint(id, on) {
	return editRow(id, (m) => (m.pinned = on ?? !m.pinned));
}

/** @param {string} id */
export async function deleteCheckpoint(id) {
	await ensureLoaded();
	await idbDelete(KEY + id);
	await writeIndex(get(checkpoints).filter((r) => r.id !== id));
}

/** the stored payload (the compare view reads nothing else from it) @param {string} id */
export function checkpointPayload(id) {
	return idbGet(KEY + id);
}

/* ------------------------------------------------------------- the restore ---- */

/**
 * Put a checkpoint back. The scene being LEFT is cut first as an automatic row ("Before
 * restoring …"), so a restore is itself undoable from the same list — which is also why the
 * sessions load is asked NOT to write its "Backup before" into Sessions. With peers connected
 * this is a proposal like any session load: it applies when everybody in the room accepted.
 * @param {string} id @returns {Promise<'applied' | 'proposed' | 'cancelled' | 'missing'>}
 */
export async function restoreCheckpoint(id) {
	await ensureLoaded();
	const row = get(checkpoints).find((r) => r.id === id);
	const payload = await idbGet(KEY + id);
	if (!row || !payload) {
		if (row) await writeIndex(get(checkpoints).filter((r) => r.id !== id));
		showToast('That checkpoint is gone from this device');
		return 'missing';
	}
	/** @type {CheckpointMeta | null} */
	const kept =
		(get(objectsGroup)?.children.length ?? 0) > 0
			? await saveCheckpoint({ name: 'Before restoring “' + row.name + '”', auto: true, quiet: true, backup: true })
			: null;
	checkpointBusy.set(true);
	try {
		// the load's name is the SCENE's name (the game identity rides on it), never the row's
		const load = { ...payload, name: row.scene || payload.name };
		const applied = await requestLoadPayload(load, { backup: false, quiet: true });
		if (applied) {
			showInfoToast(
				'checkpoint-restored',
				'Restored “' + row.name + '” (' + row.count + ' object' + (row.count === 1 ? '' : 's') + ').' +
					(kept ? ' The scene before it is in the timeline as “' + kept.name + '”.' : '')
			);
			return 'applied';
		}
		return 'proposed';
	} finally {
		checkpointBusy.set(false);
	}
}

/* ------------------------------------------------------------ automatic rows ---- */

let started = false;
let lastAutoAt = 0;
/** @type {any} */
let idleHandle = null;

/** @param {() => void} fn */
function whenIdle(fn) {
	const w = /** @type {any} */ (globalThis);
	if (typeof w.requestIdleCallback === 'function') return w.requestIdleCallback(fn, { timeout: 5000 });
	return setTimeout(fn, 200);
}

/** May an automatic row be cut right now? @param {number} now */
export function autoDue(now = Date.now()) {
	if (!get(autoCheckpoints)) return false;
	if (now - lastAutoAt < get(autoCheckpointMinutes) * 60_000) return false;
	if (sceneLoading()) return false;
	return true;
}

async function maybeAuto() {
	idleHandle = null;
	if (!autoDue()) return;
	try {
		const physics = await import('./physics');
		if (get(physics.simulating)) return; // a running world is not a state anyone authored
	} catch {}
	lastAutoAt = Date.now();
	await saveCheckpoint({ auto: true, quiet: true });
}

/**
 * Install once (the timeline component mounts it). Loads the index and follows autosave:
 * every successful write is a chance for an automatic row.
 */
export function startCheckpoints() {
	if (started || typeof window === 'undefined') return;
	started = true;
	lastAutoAt = Date.now(); // the first automatic row is one interval into the session
	void loadCheckpoints();
	// Ctrl+Shift+S — "Save" with a name; rebindable in Settings ▸ Shortcuts. A dynamic import:
	// shortcuts sits in history's import family, and this module is a consumer of it, not a member
	void import('./shortcuts').then(({ registerShortcut }) =>
		registerShortcut({
			id: 'scene.checkpoint',
			keys: 'Ctrl+Shift+S',
			group: 'Scene',
			label: 'Save checkpoint…',
			action: () => checkpointSaveOpen.set(true)
		})
	);
	let writes = get(autosaveStatus).writes;
	autosaveStatus.subscribe((s) => {
		if (s.writes === writes) return;
		writes = s.writes;
		if (idleHandle === null && autoDue()) idleHandle = whenIdle(() => void maybeAuto());
	});
}

/** TEST SEAM: what the suites need to drive the auto path without waiting minutes */
export const checkpointsDebug = {
	resetAutoClock: (/** @type {number} */ at = 0) => (lastAutoAt = at),
	capBytes: (/** @type {number | null} */ bytes) => (capOverride = bytes),
	maybeAuto,
	planEviction,
	reload: loadCheckpoints
};
