// 38 R9 — THE PHONE BOTTOM BAR's slots (NOTES-38 #7: "Add · Objects · Play · Explorer · More,
// customisable from day one, per device").
//
// Play is not a slot: it is the bar's fixed centre. The four slots around it hold any of the
// destinations below. ONE rule makes the editor safe: **More always stays on the bar**,
// because "Edit bar…" lives in More (a long press on a tab is the other way in, and a phone
// browser that eats long presses must not strand anybody with a bar they cannot change).
//
// LOCAL (a fact about this device's screen): `phoneBarSlots` in safeStorage, never
// replicated, saved or undone. Pure helpers + one store; tests/unit/phoneBar.test.js.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

/** every destination a slot may hold, in the order the editor lists them */
export const BAR_CATALOG = [
	'add',
	'objects',
	'explorer',
	'chat',
	'flow',
	'animation',
	'scene',
	'ai',
	'notes',
	'flowcode',
	'shader',
	'uv',
	'hud',
	'profiler',
	'code',
	'more'
];
export const DEFAULT_BAR = ['add', 'objects', 'explorer', 'more'];
export const MAX_SLOTS = 4;
export const STORAGE_KEY = 'phoneBarSlots';

/**
 * A stored or edited slot list made safe: known keys only, no repeats, at most four, and
 * More always present (it replaces the LAST slot when missing). A list that is not a list
 * reads as the default.
 * @param {unknown} list @returns {string[]}
 */
export function normalizeBar(list) {
	if (!Array.isArray(list)) return [...DEFAULT_BAR];
	/** @type {string[]} */
	const out = [];
	for (const k of list) if (typeof k === 'string' && BAR_CATALOG.includes(k) && !out.includes(k)) out.push(k);
	out.splice(MAX_SLOTS);
	if (!out.includes('more')) {
		if (out.length >= MAX_SLOTS) out[MAX_SLOTS - 1] = 'more';
		else out.push('more');
	}
	return out;
}

/**
 * The editor's tap on one destination: on the bar → off it (never More); off → appended,
 * kept before More so More stays the last slot. A full bar refuses (returns it unchanged).
 * @param {string[]} slots @param {string} key @returns {string[]}
 */
export function toggleSlot(slots, key) {
	if (!BAR_CATALOG.includes(key) || key === 'more') return slots;
	if (slots.includes(key)) return normalizeBar(slots.filter((k) => k !== key));
	if (slots.length >= MAX_SLOTS) return slots;
	const next = slots.filter((k) => k !== 'more');
	next.push(key);
	if (slots.includes('more')) next.push('more');
	return normalizeBar(next);
}

/**
 * Split the slots around the fixed Play button: the left half gets the extra one.
 * @param {string[]} slots @returns {{left: string[], right: string[]}}
 */
export function splitAroundPlay(slots) {
	const at = Math.ceil(slots.length / 2);
	return { left: slots.slice(0, at), right: slots.slice(at) };
}

function load() {
	try {
		const raw = safeStorage.getItem(STORAGE_KEY);
		return raw ? normalizeBar(JSON.parse(raw)) : [...DEFAULT_BAR];
	} catch {
		return [...DEFAULT_BAR];
	}
}

/** this device's bar (read once, written through) */
export const phoneBarSlots = writable(typeof localStorage === 'undefined' ? [...DEFAULT_BAR] : load());

/** @param {string[]} slots */
export function setBarSlots(slots) {
	const next = normalizeBar(slots);
	phoneBarSlots.set(next);
	try {
		if (next.join() === DEFAULT_BAR.join()) safeStorage.removeItem(STORAGE_KEY);
		else safeStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// private mode: the bar still changes for this session
	}
}
