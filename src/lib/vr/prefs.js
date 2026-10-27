// VR controls — the COMFORT and BODY preferences 36-vr added (a leaf: svelte/store + safeStorage). Each is a
// LOCAL device preference (never replicated, never saved into a scene), persisted under its own key the
// way the older VR prefs in sceneStore are. What each one does:
//   vrSmoothTurn       the turn stick turns continuously instead of in snaps (outside games, and inside a
//                      game whose own Turning setting is "Default")
//   vrSmoothTurnSpeed  degrees per second at full stick for smooth turning
//   vrComfortVignette  the comfort ring closes in while the stick moves you, everywhere (games could
//                      already turn it on for themselves). 53 (A7): 'off' | 'low' | 'high' — a stored
//                      'true' (and a set(true) from older code) is 'high', today's ring
//   vrStance           'seated' lifts the view to a standing eye height (measured from your head at the
//                      start of the session), 'standing' is the real floor
//   vrHeightOffset     metres added on top (−0.5 … +0.5), e.g. a tall player asking for a lower view
//   vrSnapAngleLast    the snap angle to come back to when turning goes Off → Snap
//   vrWorldSnap        37 R10: the two-grip world gesture snaps (15° yaw steps, 1/2/5/10× scale detents)
//   vrBothGripsWorld   52 (V5): 'always' (default) — both grips are the world gesture whatever the rays hit or the
//                      hands are inside (a first-hand grab that has not moved yet is dropped); 'emptyAir' — the
//                      pre-52 rule, both grips must close on empty air
//   vrOneHanded        53 (A7): 'off' | 'left' | 'right' — play with ONE controller: that stick moves
//                      (forward/back) and turns (sideways), holding its press aims a teleport, B/Y opens
//                      the radial menu (which then offers Edit / Interact and the game menu), A/X talks or
//                      jumps, and its laser points at every panel (bindings.js applies the layout)
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

/**
 * A persisted writable. `parse` turns the stored string back (null = absent → `fallback`).
 * @template T @param {string} key @param {T} fallback @param {(raw: string) => T} parse
 * @returns {import('svelte/store').Writable<T>}
 */
function persisted(key, fallback, parse) {
	let initial = fallback;
	try {
		const raw = typeof localStorage !== 'undefined' ? safeStorage.getItem(key) : null;
		if (raw !== null && raw !== undefined) initial = parse(raw);
	} catch {}
	const store = writable(initial);
	let first = true;
	store.subscribe((v) => {
		if (first) {
			first = false;
			return;
		}
		try {
			safeStorage.setItem(key, String(v));
		} catch {}
	});
	return store;
}

const bool = (/** @type {string} */ r) => r === 'true';
/** @param {number[]} allowed @param {number} fallback */
const oneOf = (allowed, fallback) => (/** @type {string} */ r) => (allowed.includes(Number(r)) ? Number(r) : fallback);

export const SMOOTH_SPEEDS = [45, 90, 135, 180];
export const SNAP_ANGLES = [15, 30, 45, 90];
export const HEIGHT_LIMIT = 0.5;

/** @type {import('svelte/store').Writable<boolean>} */
export const vrSmoothTurn = persisted('vrSmoothTurn', false, bool);
/** @type {import('svelte/store').Writable<number>} */
export const vrSmoothTurnSpeed = persisted('vrSmoothTurnSpeed', 90, oneOf(SMOOTH_SPEEDS, 90));
/** 53 (A7): a vignette level from anything older code stores or sets @param {any} v @returns {'off' | 'low' | 'high'} */
export function vignetteLevel(v) {
	if (v === true || v === 'true' || v === 'high') return 'high';
	if (v === 'low') return 'low';
	return 'off';
}
const vignetteInner = persisted('vrComfortVignette', /** @type {'off' | 'low' | 'high'} */ ('off'), vignetteLevel);
/** 53 (A7): Off / Low / High; `set(true|false)` still works (High / Off). @type {import('svelte/store').Writable<any>} */
export const vrComfortVignette = {
	subscribe: vignetteInner.subscribe,
	set: (/** @type {any} */ v) => vignetteInner.set(vignetteLevel(v)),
	update: (/** @type {(v: any) => any} */ fn) => vignetteInner.update((v) => vignetteLevel(fn(v)))
};
/** @type {import('svelte/store').Writable<'standing' | 'seated'>} */
export const vrStance = persisted('vrStance', /** @type {'standing' | 'seated'} */ ('standing'), (r) => (r === 'seated' ? 'seated' : 'standing'));
/** @type {import('svelte/store').Writable<number>} */
export const vrHeightOffset = persisted('vrHeightOffset', 0, (r) => clampHeight(Number(r)));
/** @type {import('svelte/store').Writable<number>} */
export const vrSnapAngleLast = persisted('vrSnapAngleLast', 45, oneOf(SNAP_ANGLES, 45));
/** @type {import('svelte/store').Writable<boolean>} */
export const vrWorldSnap = persisted('vrWorldSnap', true, bool);
/** 52 (V5) @type {import('svelte/store').Writable<'always' | 'emptyAir'>} */
export const vrBothGripsWorld = persisted('vrBothGripsWorld', /** @type {'always' | 'emptyAir'} */ ('always'), (r) => (r === 'emptyAir' ? 'emptyAir' : 'always'));

/** @type {import('svelte/store').Writable<'off' | 'left' | 'right'>} */
export const vrOneHanded = persisted('vrOneHanded', /** @type {'off' | 'left' | 'right'} */ ('off'), (r) => (r === 'left' || r === 'right' ? r : 'off'));

/** clamp + round to the centimetre @param {number} v */
export function clampHeight(v) {
	if (!Number.isFinite(v)) return 0;
	return Math.round(Math.max(-HEIGHT_LIMIT, Math.min(HEIGHT_LIMIT, v)) * 100) / 100;
}
