// 103 (H13): TOUCH FEEDBACK FOR THE EDITOR'S OWN CONTROLS — one service, named events -> short
// phone-motor patterns. The game's vibration (hapticOutput, the Vibrate node) owns Interact and Play;
// this file owns the editor and stays silent there.
//
//   tick     a value moved one step (a slider, a scrubbed number)
//   detent   the value landed on something: its default, 0, a whole number on a drag, a snap point
//   limit    the min / max reached (firmer, once per arrival)
//   on/off   a switch flipped (the two feel different: one firm pulse vs. a light double)
//   select   a pick (segmented, tab, list), a long press recognised, a card picked up
//   confirm  something done      warn  something refused
//
// GATES, in order: the level (Settings ▸ Touch controls ▸ Touch feedback: Off · Light · Medium ·
// Strong), the per-kind switch (buttons and switches · sliders and values · snapping · gestures), a
// motor to drive, TOUCH input (a pen counts; a mouse, the keyboard or a pad never), not in Interact /
// Play, not while a film take records, not in a hidden tab — then the RATE CAP: ticks closer than
// 40 ms to the last pulse are skipped, never queued (a fast drag is ~25 ticks a second, not a buzz).
//
// A phone motor takes length only, no strength: a level scales each pulse's LENGTH (floor 8 ms).
// The motor itself is hapticPatterns' phoneVibrate, the one call site of navigator.vibrate.
// LOCAL: a per-device pref in safeStorage, never replicated, never in a scene.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { reducedMotion } from './motion';
import { gameFeelActive } from './gameFeel';
import { phoneVibrate } from './hapticPatterns';

/** @typedef {'off' | 'light' | 'medium' | 'strong'} UiHapticLevel */
/** @typedef {'buttons' | 'values' | 'snap' | 'gestures'} UiHapticKind */
/** @typedef {{level: UiHapticLevel, buttons: boolean, values: boolean, snap: boolean, gestures: boolean}} UiHapticPrefs */

/** each event at MEDIUM, as a vibrate pattern [on, off, on, ...] ms (gaps never scale) */
export const UI_HAPTIC_EVENTS = /** @type {Record<string, number[]>} */ ({
	tick: [12],
	detent: [18],
	limit: [30],
	on: [16],
	off: [8, 40, 8],
	select: [12],
	confirm: [12, 60, 20],
	warn: [28, 70, 28]
});
/** which switch an event answers to when the caller does not say */
const KIND_OF = /** @type {Record<string, UiHapticKind>} */ ({ tick: 'values', detent: 'values', limit: 'values' });
export const UI_HAPTIC_LEVELS = /** @type {Record<UiHapticLevel, number>} */ ({ off: 0, light: 0.7, medium: 1, strong: 1.5 });
export const UI_HAPTIC_TICK_GAP_MS = 40;
const KINDS = ['buttons', 'values', 'snap', 'gestures'];

/** A pattern at a level: every ON length scaled (floor 8 ms), the gaps kept. PURE.
 * @param {number[]} base @param {UiHapticLevel} level @returns {number[]} */
export function scalePattern(base, level) {
	const k = UI_HAPTIC_LEVELS[level] ?? 0;
	if (!k) return [];
	return base.map((ms, i) => (i % 2 ? ms : Math.max(8, Math.round(ms * k))));
}

/**
 * What a value change should feel like. PURE. `prev` -> `next` on a control spanning [min, max]:
 * 'limit' arriving at an end, 'detent' crossing or landing on one of `detents`, else 'tick'; null when
 * nothing moved (staying at a limit is silent: the bump plays once).
 * @param {number} prev @param {number} next @param {{min?: number, max?: number, detents?: number[]}} [opts]
 * @returns {'tick' | 'detent' | 'limit' | null}
 */
export function valueFeel(prev, next, opts = {}) {
	const a = Number(prev);
	const b = Number(next);
	if (!Number.isFinite(b) || !Number.isFinite(a) || Math.abs(b - a) < 1e-9) return null;
	const eps = 1e-9;
	for (const end of [opts.min, opts.max]) {
		if (Number.isFinite(end) && Math.abs(b - Number(end)) < eps && Math.abs(a - Number(end)) >= eps) return 'limit';
	}
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (const d of opts.detents ?? []) {
		if (!Number.isFinite(d)) continue;
		// landed on it, or passed it (not merely leaving it)
		if (Math.abs(a - d) >= eps && d >= lo - eps && d <= hi + eps) return 'detent';
	}
	return 'tick';
}

/** whole numbers crossed between two values, as detents (a drag of a fractional field) PURE
 * @param {number} prev @param {number} next @returns {number[]} */
export function wholeDetents(prev, next) {
	const lo = Math.ceil(Math.min(prev, next));
	const hi = Math.floor(Math.max(prev, next));
	return hi - lo > 64 || !Number.isFinite(lo) || !Number.isFinite(hi) ? [] : hi >= lo ? [lo, hi] : [];
}

/* ------------------------------------------------------------------- prefs ---- */

const KEY = 'ui:touchFeedback';

/** may this browser vibrate at all? (iPhone: no Vibration API.) A desktop Chrome says yes and has no motor:
 * the card shows there too and stays silent, because only touch input ever triggers it */
export function uiHapticsSupport() {
	const nav = typeof navigator !== 'undefined' ? /** @type {any} */ (navigator) : null;
	const vibrate = !!nav && typeof nav.vibrate === 'function';
	const touch = !!nav && Number(nav.maxTouchPoints ?? 0) > 0;
	const ios = !!nav && (/iPhone|iPad|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && touch));
	return { ok: vibrate, vibrate, touch, ios };
}

/** The pref as stored, or null. A first read MIGRATES the old touch-controls "Haptic tick" switch:
 * on -> Light, off -> Off. @returns {Partial<UiHapticPrefs> | null} */
function readStored() {
	try {
		const raw = safeStorage.getItem(KEY);
		if (raw) return JSON.parse(raw);
		const old = JSON.parse(safeStorage.getItem('touchControlsPrefs') || 'null');
		if (old && typeof old.haptics === 'boolean') return { level: old.haptics ? 'light' : 'off' };
	} catch {
		/* a broken value is the default */
	}
	return null;
}

/** @param {any} raw @returns {UiHapticPrefs} */
export function coerceUiHapticPrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	/** @type {any} */
	const out = { level: r.level in UI_HAPTIC_LEVELS ? r.level : defaultLevel() };
	for (const k of KINDS) out[k] = r[k] !== false;
	return out;
}

/** Light where the device can vibrate, Off when the OS (or Settings ▸ Motion) asks for reduced motion
 * @returns {UiHapticLevel} */
function defaultLevel() {
	let reduced = false;
	try {
		reduced = !!get(reducedMotion);
	} catch {
		/* no store yet */
	}
	return reduced ? 'off' : 'light';
}

/** what was saved (null = nothing chosen yet: the default follows reduced motion) */
let stored = readStored();
/** the resolved prefs, as a store (Settings draws from it) */
export const uiHapticPrefs = writable(coerceUiHapticPrefs(stored));
reducedMotion.subscribe(() => {
	if (!stored?.level) uiHapticPrefs.set(coerceUiHapticPrefs(stored));
});

/** @param {Partial<UiHapticPrefs>} patch */
export function setUiHapticPrefs(patch) {
	stored = { ...(stored ?? {}), ...get(uiHapticPrefs), ...patch };
	try {
		safeStorage.setItem(KEY, JSON.stringify(stored));
	} catch {
		/* storage full: this session keeps it */
	}
	uiHapticPrefs.set(coerceUiHapticPrefs(stored));
}

/** Settings' category reset: the default again — and the old switch is not read a second time, so an
 * empty record is written (absent would migrate "Haptic tick" again) */
export function resetUiHapticPrefs() {
	stored = {};
	try {
		safeStorage.setItem(KEY, '{}');
	} catch {
		/* this session keeps it */
	}
	uiHapticPrefs.set(coerceUiHapticPrefs(stored));
}

/* ------------------------------------------------------------------ the gate ---- */

/** the last input this page saw: a pointer type, or 'key' */
let lastInput = '';
let lastInputAt = -1e9;
/** @type {(() => number) | null} */
let clockFake = null;
const now = () => (clockFake ? clockFake() : typeof performance !== 'undefined' ? performance.now() : Date.now());
/** suites: a fake clock (null = the real one) and a fake last input @param {(() => number) | null} clock */
export function setUiHapticsClockForTest(clock) {
	clockFake = clock;
}
/** @param {string} type 'touch' | 'pen' | 'mouse' | 'key' */
export function setUiInputForTest(type) {
	lastInput = type;
	lastInputAt = now();
}
/** suites: forget what was saved and read storage again (the migration runs once more) */
export function reloadUiHapticPrefsForTest() {
	stored = readStored();
	uiHapticPrefs.set(coerceUiHapticPrefs(stored));
}
if (typeof window !== 'undefined') {
	/** @param {any} e */
	const seen = (e) => {
		if (!e.isTrusted) return;
		lastInput = e.type === 'keydown' ? 'key' : e.type.startsWith('touch') ? 'touch' : e.pointerType || 'mouse';
		lastInputAt = now();
	};
	for (const t of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown']) window.addEventListener(t, seen, { capture: true, passive: true });
}
/** a finger (or pen) is what drove the page in the last moment */
function touchNow() {
	return (lastInput === 'touch' || lastInput === 'pen') && now() - lastInputAt < 800;
}

/** reasons the page is quiet (a film take records), by owner @type {Set<string>} */
const quiet = new Set();
/** @param {string} owner @param {boolean} on */
export function setUiHapticsQuiet(owner, on) {
	if (on) quiet.add(owner);
	else quiet.delete(owner);
}

let lastPulseAt = -1e9;
/** @type {{calls: any[], skipped: Record<string, number>}} */
const debug = { calls: [], skipped: {} };
/** @param {string} why */
const skip = (why) => {
	debug.skipped[why] = (debug.skipped[why] ?? 0) + 1;
	return false;
};

/**
 * Play a UI event on this phone's motor. Returns true when a pattern went to the motor.
 * @param {string} name a UI_HAPTIC_EVENTS name
 * @param {{kind?: UiHapticKind, touch?: boolean, play?: boolean, pattern?: number[]}} [opts]
 *   kind = which switch (default: values for tick/detent/limit, else buttons); touch = the caller KNOWS
 *   a finger did it (a long-press timer); play = also in Interact / Play (the on-screen game buttons);
 *   pattern = a fixed pattern played as is (film's own countdown), only the level Off and the gates apply
 */
export function uiHaptic(name, opts = {}) {
	const prefs = get(uiHapticPrefs);
	if (prefs.level === 'off') return skip('off');
	const kind = opts.kind ?? KIND_OF[name] ?? 'buttons';
	if (!opts.pattern && !prefs[kind]) return skip('kind');
	if (!opts.touch && !touchNow()) return skip('input');
	if (!opts.play && gameFeelActive()) return skip('play');
	if (quiet.size && !opts.pattern) return skip('quiet');
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return skip('hidden');
	const pattern = opts.pattern ?? scalePattern(UI_HAPTIC_EVENTS[name] ?? [], prefs.level);
	if (!pattern.length) return skip('unknown');
	const t = now();
	if (name === 'tick' && t - lastPulseAt < UI_HAPTIC_TICK_GAP_MS) return skip('rate');
	lastPulseAt = t;
	const ok = phoneVibrate(pattern);
	debug.calls.push({ name, kind, pattern, ok, t: Math.round(t) });
	if (debug.calls.length > 200) debug.calls.shift();
	return true;
}

/** A value control moved: feel it (tick / detent / limit) — the kit's one-liner.
 * @param {number} prev @param {number} next @param {{min?: number, max?: number, detents?: number[], kind?: UiHapticKind}} [opts] */
export function feelValue(prev, next, opts = {}) {
	const f = valueFeel(prev, next, opts);
	return f ? uiHaptic(f, { kind: opts.kind ?? 'values' }) : false;
}

/** what each snapping gesture last landed on, keyed by the gesture itself @type {WeakMap<object, string>} */
const snapLast = new WeakMap();
/**
 * A snapping gesture landed somewhere: a detent (kind snap) each time the snapped result CHANGES — the
 * first call of a gesture only takes its starting point. `gesture` is any object that lives as long as
 * the drag (the timeline's move, a scrub token); `value` is what snapped (null = not snapped now).
 * @param {object} gesture @param {unknown} value */
export function feelSnap(gesture, value) {
	if (!gesture) return false;
	const k = value === null || value === undefined ? '' : String(value);
	const had = snapLast.has(gesture);
	const prev = snapLast.get(gesture);
	snapLast.set(gesture, k);
	return had && k !== '' && k !== prev ? uiHaptic('detent', { kind: 'snap' }) : false;
}

/** suites' view @returns {any} */
export function uiHapticsDebug() {
	return { calls: debug.calls.map((c) => ({ ...c })), skipped: { ...debug.skipped }, prefs: get(uiHapticPrefs), lastInput, quiet: [...quiet] };
}
export function resetUiHapticsDebug() {
	debug.calls = [];
	debug.skipped = {};
	lastPulseAt = -1e9;
}
