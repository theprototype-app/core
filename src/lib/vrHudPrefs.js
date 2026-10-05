// 36 B12: the VR game HUD's LOCAL settings — a leaf (svelte/store + safeStorage), so the VR
// settings table (vr/settingsSchema.js: the radial rings, the in-headset panel, desktop
// Settings ▸ VR), the board's footer button and vrHud.js all reach one store per setting.
// Never replicated: where my HUD floats is mine.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { coercePlacement, coerceSize, HUD_PLACEMENTS } from './vrHudLayout';

const PLACEMENT_KEY = 'vr:hudPlacement';
const SIZE_KEY = 'vr:hudSize';
const HINTS_KEY = 'vr:hudHints';
/** 30b's head-locked strip switch: off meant "only the wrist" — the one migration */
const LEGACY_STRIP_KEY = 'vr:gameStrip';

/** @param {string} key */
function read(key) {
	try {
		return safeStorage.getItem(key);
	} catch {
		return null;
	}
}
/** @param {string} key @param {string} value */
function write(key, value) {
	try {
		safeStorage.setItem(key, value);
	} catch {}
}

function initialPlacement() {
	const stored = read(PLACEMENT_KEY);
	if (stored) return coercePlacement(stored);
	return read(LEGACY_STRIP_KEY) === 'false' ? 'wrist' : coercePlacement(null);
}

/** 'head' (follows the head with lag) | 'world' (fixed, re-centres after a turn) | 'wrist' (the wrist card only) */
export const vrHudPlacement = writable(initialPlacement());
/** 'small' | 'medium' | 'large' — the band's angular size */
export const vrHudSize = writable(coerceSize(read(SIZE_KEY)));
/** the button hints row (the game's input actions as headset controls) */
export const vrHudHints = writable(read(HINTS_KEY) !== 'false');

/** @param {any} v */
export function setVrHudPlacement(v) {
	const p = coercePlacement(v);
	vrHudPlacement.set(p);
	write(PLACEMENT_KEY, p);
}
/** @param {any} v */
export function setVrHudSize(v) {
	const s = coerceSize(v);
	vrHudSize.set(s);
	write(SIZE_KEY, s);
}
/** @param {boolean} on */
export function setVrHudHints(on) {
	vrHudHints.set(!!on);
	write(HINTS_KEY, on ? 'true' : 'false');
}
/** the board/wrist footer button: Head -> World -> Wrist -> Head */
export function cycleVrHudPlacement() {
	const at = HUD_PLACEMENTS.indexOf(get(vrHudPlacement));
	setVrHudPlacement(HUD_PLACEMENTS[(at + 1) % HUD_PLACEMENTS.length]);
	return get(vrHudPlacement);
}
/** what the footer button says @param {string} p */
export function placementLabel(p) {
	return p === 'world' ? 'World' : p === 'wrist' ? 'Wrist' : 'Head';
}

/** the band's on-screen flag, written by vrHud.js every frame it decides (a plain cell, not a
 * store: nothing should re-render on it) */
export const vrHudShownNow = { value: false };
/** what `api.hud.vrHud()` answers: the player's placement and whether the band is up now */
export function vrHudState() {
	return { placement: get(vrHudPlacement), visible: vrHudShownNow.value };
}
