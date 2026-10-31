// 60 Q5: REFERENCE IMAGE UNDERLAYS — a floor plan, a concept sketch or a photo laid in the scene to
// build over: a locked, unpickable, see-through plane, lying on the ground or standing facing the
// view, with its own opacity. It is a WORKING AID, not scene content, and every rule below follows
// from that:
//  · it is drawn under the world rig but OUTSIDE `sceneObjects` (UnderlayLayer.svelte), so the
//    shared pick (sceneHits), the transform gizmo, the object list, the GLTF/.tpscene/publish
//    exports, autosave and the object sync never see it — excluded BY CONSTRUCTION, not by a filter
//    someone has to remember;
//  · hidden in Play (desktop/phone Play, and Interact in a headset) — a game never shows it;
//  · LOCAL by default (the roadmap's fork F2): yours, on this device, kept per scene in IndexedDB;
//    "Share with session" sends it to the peers in your room, who see it read-only until you turn
//    the switch off (or leave). ONE WRITER PER ROW — the owner — so there is nothing to merge.
//
// Wire (all ROOM_SCOPED; `getunderlays` is a full-state REQUEST on the cloudHooks floor):
//   underlay        {id, rec, src?}  a shared row (src = the image data URL, only when the peer
//                                     may not have it yet: the first share and a full-state reply)
//   underlaydelete  {id}             unshared or removed — peers drop it
//   getunderlays    {sender}         a joiner asks; the reply is every row we share
// A LEAF: svelte/store, the app stores and idb. Scene identity is pushed in by the layer
// (`setUnderlayScene`), so this module never reaches levels.js.
import { get, writable, derived } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { idbGet, idbPut } from './idb';

/**
 * @typedef {{
 *   id: string, name: string, src: string, px: [number, number],
 *   mode: 'ground' | 'view', position: [number, number, number], quaternion: [number, number, number, number],
 *   width: number, opacity: number, visible: boolean, shared: boolean, scene: string,
 *   owner?: string, at: number
 * }} Underlay
 */

/** the longest side an underlay image is kept at (it rides IndexedDB and, when shared, the wire) */
export const UNDERLAY_MAX_SIDE = 2048;
/** the IndexedDB key: every underlay of MINE, each tagged with the scene it belongs to */
const IDB_KEY = 'underlays:v1';
/** the default see-through-ness: enough to trace over, enough to see the model through */
export const DEFAULT_OPACITY = 0.5;

/** mine (persisted) — every scene's, tagged */
const mine = writable(/** @type {Underlay[]} */ ([]));
/** peers' shared rows, keyed by peer id (never persisted) */
const theirs = writable(/** @type {Record<string, Underlay[]>} */ ({}));
/** the scene the editor stands in ('' = an unnamed world) — pushed by UnderlayLayer */
export const underlayScene = writable('');

/** what the layer draws and the window lists: my rows for this scene, then every peer's shared rows */
export const underlays = derived([mine, theirs, underlayScene], ([$mine, $theirs, $scene]) => [
	...$mine.filter((u) => u.scene === $scene),
	...Object.values($theirs).flat()
]);
/** the Reference images window */
export const underlayWindowOpen = writable(false);
/** the image-drop menu: where the files were dropped (the App drop handler sets it) */
export const underlayDropMenu = writable(/** @type {{x: number, y: number, files: File[]} | null} */ (null));

/** @param {string} scene */
export function setUnderlayScene(scene) {
	underlayScene.set(String(scene ?? ''));
}

const myId = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';
const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
const finite = (/** @type {any} */ a, /** @type {number} */ n) => Array.isArray(a) && a.length === n && a.every((v) => Number.isFinite(v));

/**
 * ONE normalizer for every boundary (idb read, the wire, an edit): unknown fields dropped, every
 * number clamped. null = not an underlay.
 * @param {any} raw @returns {Omit<Underlay, 'src'> & {src?: string} | null}
 */
export function normalizeUnderlay(raw) {
	if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
	const px = finite(raw.px, 2) ? /** @type {[number, number]} */ ([Math.max(1, raw.px[0]), Math.max(1, raw.px[1])]) : /** @type {[number, number]} */ ([1, 1]);
	return {
		id: raw.id,
		name: String(raw.name ?? 'Reference').slice(0, 120),
		...(typeof raw.src === 'string' && raw.src.startsWith('data:image/') ? { src: raw.src } : {}),
		px,
		mode: raw.mode === 'view' ? 'view' : 'ground',
		position: finite(raw.position, 3) ? raw.position : [0, 0, 0],
		quaternion: finite(raw.quaternion, 4) ? raw.quaternion : [0, 0, 0, 1],
		width: clamp(Number(raw.width) || 10, 0.01, 10000),
		opacity: clamp(Number.isFinite(Number(raw.opacity)) ? Number(raw.opacity) : DEFAULT_OPACITY, 0.02, 1),
		visible: raw.visible !== false,
		shared: raw.shared === true,
		scene: String(raw.scene ?? ''),
		at: Number(raw.at) || 0
	};
}

/** the plane's height in metres (the image keeps its aspect) @param {{width: number, px: number[]}} u */
export function underlayHeight(u) {
	return (u.width * u.px[1]) / Math.max(1, u.px[0]);
}

// ---- persistence (mine only) ------------------------------------------------------------------

let loaded = false;
let saveTimer = /** @type {any} */ (null);
function persist() {
	if (!loaded) return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		void idbPut(IDB_KEY, get(mine)).catch(() => showToast('Could not save the reference images on this device'));
	}, 250);
}

/** read my underlays back (once, at start) */
export async function loadUnderlays() {
	if (loaded) return;
	try {
		const rows = await idbGet(IDB_KEY);
		/** @type {Underlay[]} */
		const list = [];
		for (const row of Array.isArray(rows) ? rows : []) {
			const u = normalizeUnderlay(row);
			if (u?.src) list.push(/** @type {Underlay} */ (u));
		}
		// what this session added before the read landed stays, after what was stored
		mine.update((now) => [...list.filter((u) => !now.some((n) => n.id === u.id)), ...now]);
	} catch {
		/* nothing stored, or storage refused — the session simply starts empty */
	}
	loaded = true;
	// rows that were shared when the page closed are shared again: a reload is not an unshare
	for (const u of get(mine)) if (u.shared && u.scene === get(underlayScene)) send({ type: 'underlay', id: u.id, rec: wireRec(u), src: u.src });
}

// ---- the wire ----------------------------------------------------------------------------------

/** a row as it travels: the record without `scene` (rooms are the scene gate) or the image */
function wireRec(/** @type {Underlay} */ u) {
	const { src: _s, scene: _c, owner: _o, ...rec } = u;
	return rec;
}

function send(/** @type {any} */ message) {
	/** @type {any} */
	const peer = get(peers);
	try {
		peer?.send?.(message);
	} catch {
		/* no session */
	}
}

/** a shared row changed (pose, opacity…): debounced per row, without the image */
const pending = new Map();
function sendUpdate(/** @type {Underlay} */ u) {
	clearTimeout(pending.get(u.id));
	pending.set(
		u.id,
		setTimeout(() => {
			pending.delete(u.id);
			const now = get(mine).find((m) => m.id === u.id);
			if (now?.shared) send({ type: 'underlay', id: now.id, rec: wireRec(now) });
		}, 120)
	);
}

/** the full-state reply: every row I share in the scene I stand in @param {string} peerId @param {number} [attempt] */
export function sendUnderlays(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.peer?.connections?.[peerId]?.[0] ?? peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (attempt < 40) setTimeout(() => sendUnderlays(peerId, attempt + 1), 250);
		return;
	}
	for (const u of get(mine)) if (u.shared && u.scene === get(underlayScene)) conn.send({ type: 'underlay', id: u.id, rec: wireRec(u), src: u.src });
}

/** a peer's shared row arrived (the owner is the CONNECTION, never a field of the message)
 * @param {any} data @param {string} from */
export function applyRemoteUnderlay(data, from) {
	if (!from) return;
	const rec = normalizeUnderlay({ ...(data?.rec ?? {}), id: data?.id, src: data?.src });
	if (!rec) return;
	theirs.update((all) => {
		const list = all[from] ?? [];
		const old = list.find((u) => u.id === rec.id);
		const src = rec.src ?? old?.src;
		if (!src) {
			// an update for a row we never got the image of (we joined between): ask for the lot
			send({ type: 'getunderlays', sender: myId() });
			return all;
		}
		const next = /** @type {Underlay} */ ({ ...rec, src, shared: true, scene: '', owner: from });
		return { ...all, [from]: old ? list.map((u) => (u.id === rec.id ? next : u)) : [...list, next] };
	});
}

/** @param {any} data @param {string} from */
export function applyRemoteUnderlayDelete(data, from) {
	const id = data?.id;
	if (!from || typeof id !== 'string') return;
	theirs.update((all) => (all[from]?.some((u) => u.id === id) ? { ...all, [from]: all[from].filter((u) => u.id !== id) } : all));
}

/** a peer left (or we left the session): their rows go with them @param {string | null} [peerId] null = everyone */
export function dropPeerUnderlays(peerId = null) {
	theirs.update((all) => {
		if (peerId == null) return {};
		if (!all[peerId]) return all;
		const { [peerId]: _gone, ...rest } = all;
		return rest;
	});
}

// ---- the edits (mine only) --------------------------------------------------------------------

/** @param {string} id */
export function isMine(id) {
	return get(mine).some((u) => u.id === id);
}

/**
 * Add an underlay from an image file, posed by the caller (UnderlayLayer knows the camera).
 * @param {File | Blob} file @param {{name?: string, mode: 'ground' | 'view', position: number[], quaternion: number[], width: number}} pose
 * @returns {Promise<Underlay | null>}
 */
export async function addUnderlay(file, pose) {
	let src = '';
	/** @type {[number, number]} */
	let px = [1, 1];
	try {
		const { downscaleImage } = await import('./materialsHandler');
		src = await downscaleImage(file, UNDERLAY_MAX_SIDE);
		px = await imageSize(src);
	} catch {
		showToast('Could not read that image');
		return null;
	}
	const rec = normalizeUnderlay({
		id: 'ul-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
		name: (/** @type {any} */ (file).name ?? 'Reference').replace(/\.[a-z0-9]+$/i, ''),
		src,
		px,
		mode: pose.mode,
		position: pose.position,
		quaternion: pose.quaternion,
		width: pose.width,
		opacity: DEFAULT_OPACITY,
		visible: true,
		shared: false,
		scene: get(underlayScene),
		at: Date.now()
	});
	if (!rec?.src) return null;
	const u = /** @type {Underlay} */ (rec);
	mine.update((list) => [...list, u]);
	persist();
	return u;
}

/** @param {string} src @returns {Promise<[number, number]>} */
function imageSize(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve([img.naturalWidth || 1, img.naturalHeight || 1]);
		img.onerror = () => reject(new Error('decode'));
		img.src = src;
	});
}

/**
 * Change one of MY underlays (a peer's is read-only here). Shared rows follow to the room.
 * @param {string} id @param {Record<string, any>} patch normalized like every boundary
 */
export function updateUnderlay(id, patch) {
	let changed = /** @type {Underlay | null} */ (null);
	mine.update((list) =>
		list.map((u) => {
			if (u.id !== id) return u;
			const n = normalizeUnderlay({ ...u, ...patch, id: u.id, src: u.src, scene: u.scene, at: Date.now() });
			changed = n ? /** @type {Underlay} */ ({ ...n, src: u.src }) : u;
			return /** @type {Underlay} */ (changed);
		})
	);
	if (!changed) return;
	persist();
	if (/** @type {Underlay} */ (changed).shared) sendUpdate(changed);
}

/** "Share with session": on sends the row (with its image) to the room, off takes it back
 * @param {string} id @param {boolean} on */
export function setUnderlayShared(id, on) {
	const u = get(mine).find((m) => m.id === id);
	if (!u || u.shared === on) return;
	updateUnderlay(id, { shared: on });
	const now = get(mine).find((m) => m.id === id);
	if (!now) return;
	clearTimeout(pending.get(id));
	pending.delete(id);
	if (on) send({ type: 'underlay', id, rec: wireRec(now), src: now.src });
	else send({ type: 'underlaydelete', id });
}

/** @param {string} id */
export function removeUnderlay(id) {
	const u = get(mine).find((m) => m.id === id);
	if (!u) return;
	mine.update((list) => list.filter((m) => m.id !== id));
	persist();
	if (u.shared) send({ type: 'underlaydelete', id });
}

/** test/debug view */
export function underlaysDebug() {
	return {
		mine: get(mine).map(({ src, ...u }) => ({ ...u, srcBytes: src.length })),
		theirs: Object.fromEntries(Object.entries(get(theirs)).map(([k, list]) => [k, list.map(({ src, ...u }) => ({ ...u, srcBytes: src.length }))])),
		scene: get(underlayScene),
		loaded
	};
}
