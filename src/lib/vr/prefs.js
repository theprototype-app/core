// VR controls — the COMFORT and BODY preferences 36-vr added (a leaf: svelte/store + safeStorage). Each is a
// LOCAL device preference (never replicated, never saved into a scene), persisted under its own key the
// way the older VR prefs in sceneStore are. What each one does:
//   vrSmoothTurn       the turn stick turns continuously instead of in snaps (outside games, and inside a
//                      game whose own Turning setting is "Default")
//   vrSmoothTurnSpeed  degrees per second at full stick for smooth turning
//   vrComfortVignette  the comfort ring closes in while the stick moves you, everywhere (games could
//                      already turn it on for themselves)
//   vrStance           'seated' lifts the view to a standing eye height (measured from your head at the
//                      start of the session), 'standing' is the real floor
//   vrHeightOffset     metres added on top (−0.5 … +0.5), e.g. a tall player asking for a lower view
//   vrSnapAngleLast    the snap angle to come back to when turning goes Off → Snap
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
/** @type {import('svelte/store').Writable<boolean>} */
export const vrComfortVignette = persisted('vrComfortVignette', false, bool);
/** @type {import('svelte/store').Writable<'standing' | 'seated'>} */
export const vrStance = persisted('vrStance', /** @type {'standing' | 'seated'} */ ('standing'), (r) => (r === 'seated' ? 'seated' : 'standing'));
/** @type {import('svelte/store').Writable<number>} */
export const vrHeightOffset = persisted('vrHeightOffset', 0, (r) => clampHeight(Number(r)));
/** @type {import('svelte/store').Writable<number>} */
export const vrSnapAngleLast = persisted('vrSnapAngleLast', 45, oneOf(SNAP_ANGLES, 45));

/** clamp + round to the centimetre @param {number} v */
export function clampHeight(v) {
	if (!Number.isFinite(v)) return 0;
	return Math.round(Math.max(-HEIGHT_LIMIT, Math.min(HEIGHT_LIMIT, v)) * 100) / 100;
}
