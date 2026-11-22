// 98 P1 — BAKED LIGHTING as SCENE DATA: the one `bake` record, its wire, its save, its undo.
//
// The scenePost / sceneMusic singleton shape: a latest-wins record on a monotonic `changedAt`,
// ONE normalize at every boundary (bakeRecordCore), a `scenebake` message pushed in the handshake
// (+ `getscenebake` to re-pull), `bake` in the .tpscene / autosave only when there is one (an
// unbaked scene saves byte-identical to 1.62), and ONE `bake` history step per bake / clear.
//
// THIS MODULE IS SMALL ON PURPOSE (boot-size gate): it holds stores and plain data. Applying a
// record to the scene (decode the atlas, build the bake UVs, set the materials) lives in
// bake/bakeApply.js and the baker itself in bake/bakeRunner.js + the Worker; both load by dynamic
// import, only when a scene actually has a bake or someone presses Bake.
//
// The pixels are two Explorer content hashes (the atlas + its phone / Quest copy), so they ride
// the same push / pull every scene asset does (assetfile / getasset) and a .tpscene bundles them
// through the scene-assets manifest (registered below).

import { writable, get } from 'svelte/store';
import { sessionNow } from './sessionClock';
import { peers } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { normalizeBakeRecord } from './bake/bakeRecordCore.js';
import { registerSceneEntrySource } from './sceneAssets';

/** the scene's bake record (normalized) or null @type {import('svelte/store').Writable<any | null>} */
export const bakeRecord = writable(null);
let changedAt = 0;

/**
 * The running bake on THIS device (never replicated): phase, progress 0..1, eta, and the
 * last result's notes. @type {import('svelte/store').Writable<{ running: boolean, phase: string,
 *   progress: number, startedAt: number, error: string, notes: string[] }>}
 */
export const bakeJob = writable({ running: false, phase: '', progress: 0, startedAt: 0, error: '', notes: [] });

/** stale = baked objects moved / were deleted / the lights changed since the bake (bakeApply writes it)
 * @type {import('svelte/store').Writable<{ stale: boolean, moved: number, missing: number, lights: boolean }>} */
export const bakeStale = writable({ stale: false, moved: 0, missing: 0, lights: false });

/** what this device shows of the bake: 'full' | 'lite' | 'none' + why, applied object count
 * @type {import('svelte/store').Writable<{ map: string, applied: number, pending: number, note: string }>} */
export const bakeShown = writable({ map: 'none', applied: 0, pending: 0, note: '' });

let applyRef = /** @type {Promise<any> | null} */ (null);
/** the apply half, loaded only when a record exists */
function applier() {
	if (!applyRef) applyRef = import('./bake/bakeApply.js');
	return applyRef;
}

/** @param {any} record */
function reconcile(record) {
	if (!record && !applyRef) return; // never loaded: nothing to take off
	applier()
		.then((m) => m.applyBakeRecord(record))
		.catch((error) => console.warn('bake apply failed', error));
}

/** the wire message @returns {any} */
export function sceneBakeState() {
	return { type: 'scenebake', record: get(bakeRecord), changedAt };
}

/** send the record to every peer */
export function broadcastSceneBake() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(sceneBakeState());
}

/** push the atlas bytes so a peer without them can show the bake @param {any} record */
async function pushBytes(record) {
	if (!record) return;
	const { sendAsset } = await import('./assetShare');
	sendAsset(record.full.hash);
	if (record.lite?.hash) sendAsset(record.lite.hash);
}

/**
 * The ONE local write: set (or clear with null) the scene's bake, record ONE undo step and
 * replicate. @param {any} raw @param {{ history?: boolean, label?: string }} [opts]
 */
export function setBakeRecord(raw, opts = {}) {
	const before = get(bakeRecord);
	const next = raw ? normalizeBakeRecord(raw) : null;
	if (raw && !next) return false;
	changedAt = Math.max(sessionNow(), changedAt + 1);
	if (next) next.changedAt = changedAt;
	bakeRecord.set(next);
	if (opts.history !== false && JSON.stringify(before) !== JSON.stringify(next)) {
		recordEntry({ kind: 'bake', label: opts.label ?? (next ? 'Bake light' : 'Clear baked light'), beforeRec: before, afterRec: next, before: 'before', after: 'after' });
	}
	reconcile(next);
	broadcastSceneBake();
	pushBytes(next);
	return true;
}

// undo / redo replays the stored record and replicates it, like every scene singleton
registerHistoryKind('bake', (entry, state) => {
	const target = state === entry.before ? entry.beforeRec : entry.afterRec;
	setBakeRecord(target, { history: false });
	return true;
});

/** remote / handshake apply: newest change wins @param {any} data */
export function applyRemoteSceneBake(data) {
	const stamp = Number(data?.changedAt);
	if (!Number.isFinite(stamp) || stamp <= changedAt) return false;
	const next = data.record ? normalizeBakeRecord(data.record) : null;
	if (data.record && !next) return false;
	changedAt = stamp;
	if (next) next.changedAt = stamp;
	bakeRecord.set(next);
	reconcile(next);
	return true;
}

/**
 * Answer `getscenebake`, retrying until the connection opens (the sendScenePost pattern).
 * Says nothing when the scene has never been baked. @param {string} peerId
 */
export function sendSceneBake(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer || (!get(bakeRecord) && !changedAt)) return;
	const conn = peer.connections?.[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendSceneBake(peerId, attempt + 1), 500);
		return;
	}
	conn.send(sceneBakeState());
}

/** for sessions / .tpscene / autosave: null when unbaked, so no field is written */
export function sceneBakeSnapshot() {
	const record = get(bakeRecord);
	return record ? structuredClone(record) : null;
}

/**
 * Restore from a save. A scene load is a whole-world replace, so an ABSENT field clears any bake
 * the room had (the musicRestore rule). `replicate` re-broadcasts and pushes the bytes.
 * @param {any} payload @param {boolean} [replicate]
 */
export function sceneBakeRestore(payload, replicate = false) {
	const next = payload ? normalizeBakeRecord(payload) : null;
	if (!next && !get(bakeRecord)) return;
	changedAt = Math.max(sessionNow(), changedAt + 1);
	if (next) next.changedAt = changedAt;
	bakeRecord.set(next);
	reconcile(next);
	if (replicate) {
		broadcastSceneBake();
		pushBytes(next);
	}
}

// the atlas is a scene asset: listed in Scene ▸ textures and bundled into a .tpscene export
registerSceneEntrySource(() => {
	const record = get(bakeRecord);
	if (!record) return [];
	return [
		{ id: 'bake:' + record.full.hash, group: 'textures', name: 'Baked light.png', kind: 'image', hash: record.full.hash, derived: false },
		...(record.lite?.hash ? [{ id: 'bake:' + record.lite.hash, group: 'textures', name: 'Baked light (small).png', kind: 'image', hash: record.lite.hash, derived: false }] : [])
	];
});

/** test / debug view */
export function sceneBakeDebug() {
	return { record: get(bakeRecord), changedAt, job: get(bakeJob), stale: get(bakeStale), shown: get(bakeShown) };
}
