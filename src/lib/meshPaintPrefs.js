// 102 M6 — PAINT ON MESHES: the brush settings. A LEAF (svelte/store + safeStorage), so the UV editor's panel and
// the VR brush can read and write them without loading the painter (meshPaint.js, a lazy chunk). Every value is a
// LOCAL pref, like the shipped colour and size: a brush is a fact about how YOU paint; what a stroke paints is
// what replicates.
import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';

/**
 * A persisted store. The stored text is parsed by `read`, which returns undefined for "use the default".
 * @template T @param {string} key @param {T} fallback @param {(raw: string) => T | undefined} read
 * @returns {import('svelte/store').Writable<T>}
 */
function pref(key, fallback, read) {
	const raw = safeStorage.getItem(key);
	const parsed = raw == null ? undefined : read(raw);
	const store = writable(parsed === undefined ? fallback : parsed);
	store.subscribe((value) => safeStorage.setItem(key, String(value)));
	return store;
}

/** @param {number} lo @param {number} hi */
const num = (lo, hi) => (/** @type {string} */ raw) => {
	const n = Number(raw);
	return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
const bool = (/** @type {string} */ raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined);

/** which map the brush paints: 'color' | 'roughness' | 'metalness' | 'emissive' */
export const paintChannel = pref('paint:channel', 'color', (raw) =>
	['color', 'roughness', 'metalness', 'emissive'].includes(raw) ? raw : undefined
);
/** the value a roughness / metalness stroke paints (0..1) */
export const paintValue = pref('paint:value', 0.5, num(0, 1));
/** 1 = the shipped hard edge, 0 = soft all the way in */
export const paintHardness = pref('paint:hardness', 1, num(0, 1));
/** the most one stroke can reach */
export const paintOpacity = pref('paint:opacity', 1, num(0.01, 1));
/** how much each dab adds */
export const paintFlow = pref('paint:flow', 1, num(0.01, 1));
/** the eraser: paints the value that lets the material's own setting show (meshPaintCore.CHANNELS `erase`) */
export const paintErase = pref('paint:erase', false, bool);
/** mirror X on the model (the object's own X) */
export const paintMirror = pref('paint:mirror', false, bool);
/** the stamp brush: an Explorer image's content hash, '' = a round brush */
export const paintStamp = pref('paint:stamp', '', (raw) => (/^[A-Za-z0-9_:.-]{0,128}$/.test(raw) ? raw : undefined));
/** the size a NEW map is made at (the first stroke on a slot with no image) */
export const paintMapSize = pref('paint:mapSize', 1024, (raw) => (raw === '1024' ? 1024 : raw === '2048' ? 2048 : undefined));
/** LOCAL view: show the painted channel alone on the model (never saved, never sent) */
export const paintShowChannel = writable(false);
/** what the brush does on the selected object right now, for the panel: map, or vertex colours and why */
export const paintTargetInfo = writable(/** @type {{mode: 'map' | 'vertex', reason: string} | null} */ (null));

/** the brush as one plain object (meshPaintCore.normalizeBrush takes it) */
export const BRUSH_STORES = { hardness: paintHardness, opacity: paintOpacity, flow: paintFlow, erase: paintErase, mirror: paintMirror, stamp: paintStamp };
