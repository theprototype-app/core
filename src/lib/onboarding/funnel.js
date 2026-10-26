// 76 FW2 — ANONYMOUS FIRST-VISIT FUNNEL COUNTERS. Did the first visit work: of the browsers that met
// the Welcome card, how many answered it, changed something, pressed Play, shared, finished the
// quest — and did they come back. Plus the G1 demand signal (a feature-update opt-in, from the
// cloud plugin).
//
// THE PRIVACY RULE, which decides the shape of everything here: an event is a NAME and a few
// closed-vocabulary fields (`c` the Welcome answer, `b` the release, `d` desktop|touch|vr, `x` a
// time bucket or a quest step) — no id of any kind, nothing that could join two events into one
// person. "Once per browser" is a flag in this browser's own storage and never leaves it; the day
// a browser was first seen stays here too (only "came back on day 1 / in week 3" is sent). A browser
// that says Do Not Track or Global Privacy Control sends nothing, and remembers nothing either.
//
// Core only DECIDES; it sends nothing itself. Events go out through the cloudHooks seam
// (`onFunnelEvent`), so the open-source build with no plugin counts nothing anywhere. Under test
// nothing is counted unless the suite opts in with `funnelUnderTest` (the toursUnderTest precedent).
//
// Two layers: the PURE rules (`funnelStep`, `funnelReturns`, `playBucket`) the unit suite drives
// with a synthetic clock, and the thin wrappers that read storage, check the guards and emit.

import { get, writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { coarsePointer } from '../inputDevice';
import { notifyFunnelEvent } from '../cloudHooks';
import { APP_VERSION } from '../version';
import { releaseLabel } from '../errorReportCore';
import { onboardChoice } from './onboardState.js';

export const FUNNEL_KEY = 'onboard.funnel';
const SEND_KEY = 'onboard.funnelSend';

/** Settings ▸ Privacy's switch. LOCAL, default ON (absent = on) — Do Not Track / GPC win over it. */
export const funnelOn = writable(safeStorage.getItem(SEND_KEY) !== 'false');
funnelOn.subscribe((on) => safeStorage.setItem(SEND_KEY, on ? 'true' : 'false'));
/** the first-visit events, each sent at most once per browser, and only by a browser that met the Welcome */
export const FIRST_VISIT_EVENTS = [
	'ob_view',
	'ob_choice',
	'ob_first_edit',
	'ob_first_play',
	'ob_first_share',
	'ob_quest_done',
	'ob_tour_skip'
];
/** sent once per browser by ANY browser (the G1 waitlist signal) */
export const ANY_BROWSER_EVENTS = ['ob_waitlist'];
const DAY_MS = 86400000;

/**
 * What this browser remembers (never sent): the UTC day it was first seen, when it met the Welcome
 * (0 = it never did — an invite, a returning user from before FW2), what it has sent, and the last
 * returning week it reported.
 * @typedef {{ v: 1, first: number, view: number, sent: string[], w: number }} FunnelState
 */

/** @param {number} t */
const dayOf = (t) => Math.floor(t / DAY_MS);

/** ob_first_play: minutes from the Welcome to the first Play, as a bucket @param {number} ms */
export function playBucket(ms) {
	const min = Math.max(0, ms) / 60000;
	return min < 1 ? 'lt1' : min < 3 ? '1to3' : min < 10 ? '3to10' : 'gt10';
}

/** @param {any} raw @returns {FunnelState | null} */
export function parseFunnelState(raw) {
	try {
		const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!s || s.v !== 1 || !Number.isFinite(s.first)) return null;
		return {
			v: 1,
			first: s.first,
			view: Number(s.view) || 0,
			sent: Array.isArray(s.sent) ? s.sent.map(String) : [],
			w: Number(s.w) || 0
		};
	} catch {
		return null;
	}
}

/**
 * One event against the state. Pure. Returns the next state (null = unchanged) and the event's
 * `x`, or `send: false` when it is not to be counted.
 * @param {FunnelState | null} state @param {string} name @param {number} now @param {{x?: string}} [o]
 * @returns {{ send: boolean, state: FunnelState | null, x: string }}
 */
export function funnelStep(state, name, now, o = {}) {
	const no = { send: false, state: null, x: '' };
	if (name === 'ob_view') {
		// the first visit only: a browser with any history (even a legacy one) has met the app before
		if (state) return no;
		return {
			send: true,
			state: { v: 1, first: dayOf(now), view: now, sent: ['ob_view'], w: 0 },
			x: ''
		};
	}
	if (FIRST_VISIT_EVENTS.includes(name)) {
		if (!state?.view || state.sent.includes(name)) return no;
		const x =
			name === 'ob_first_play'
				? playBucket(now - state.view)
				: name === 'ob_tour_skip'
					? String(o.x || '')
					: '';
		return { send: true, state: { ...state, sent: [...state.sent, name] }, x };
	}
	if (ANY_BROWSER_EVENTS.includes(name)) {
		const base = state ?? { v: 1, first: dayOf(now), view: 0, sent: [], w: 0 };
		if (base.sent.includes(name)) return no;
		return { send: true, state: { ...base, sent: [...base.sent, name] }, x: '' };
	}
	return no;
}

/**
 * The returns a boot reports. Pure. A browser with no state starts one (first seen today, never met
 * the Welcome) and reports nothing; afterwards: back on day 1 (`return_d1`) and in days 7-13
 * (`return_d7`) for a browser that met the Welcome, and once in every later 7-day week since it was
 * first seen (`return_w`) for any browser — the G1 "weekly returning users" line.
 * @param {FunnelState | null} state @param {number} now
 * @returns {{ state: FunnelState, events: string[] }}
 */
export function funnelReturns(state, now) {
	if (!state) return { state: { v: 1, first: dayOf(now), view: 0, sent: [], w: 0 }, events: [] };
	const age = dayOf(now) - state.first;
	const events = [];
	let next = state;
	const once = (/** @type {string} */ name) => {
		if (next.sent.includes(name)) return;
		events.push(name);
		next = { ...next, sent: [...next.sent, name] };
	};
	if (state.view && age === 1) once('return_d1');
	if (state.view && age >= 7 && age < 14) once('return_d7');
	const week = Math.floor(age / 7);
	if (week >= 1 && week > state.w) {
		events.push('return_w');
		next = { ...next, w: week };
	}
	return { state: next, events };
}

// ------------------------------------------------------------------------------ the wrappers

/** May this page count anything? Not under DNT / GPC; not under test unless the suite opts in. */
export function funnelAllowed() {
	if (typeof navigator !== 'undefined') {
		const nav = /** @type {any} */ (navigator);
		if (nav.doNotTrack === '1' || nav.globalPrivacyControl === true) return false;
	}
	if (typeof window !== 'undefined' && /** @type {any} */ (window).doNotTrack === '1') return false;
	if (!get(funnelOn)) return false;
	if (!safeStorage.getItem('debugStores')) return true;
	return safeStorage.getItem('funnelUnderTest') === 'true';
}

/** desktop | touch | vr — a device CLASS, nothing finer */
export function funnelDevice() {
	const ua = typeof navigator === 'undefined' ? '' : String(navigator.userAgent ?? '');
	if (/OculusBrowser|Quest|Pico|VRShell|Wolvic|Vive/i.test(ua)) return 'vr';
	return coarsePointer() ? 'touch' : 'desktop';
}

function release() {
	const env = /** @type {any} */ (import.meta.env ?? {});
	return releaseLabel(
		APP_VERSION,
		typeof location !== 'undefined' ? location.hostname : '',
		env.VITE_RELEASE_LABEL
	);
}

/** @param {FunnelState} s */
function save(s) {
	safeStorage.setItem(FUNNEL_KEY, JSON.stringify(s));
}

/** @param {string} e @param {string} x */
function emit(e, x) {
	// the Welcome answer rides every first-visit event after it, so the funnel splits by answer
	const c =
		e.startsWith('ob_') && e !== 'ob_view' && e !== 'ob_waitlist'
			? String(get(onboardChoice) || '')
			: '';
	notifyFunnelEvent({ e, c, b: release(), d: funnelDevice(), x });
}

/**
 * Count one event (once per browser; see funnelStep). Returns whether it went out.
 * @param {string} name @param {{x?: string}} [o]
 */
export function funnelEvent(name, o = {}) {
	if (!funnelAllowed()) return false;
	const r = funnelStep(parseFunnelState(safeStorage.getItem(FUNNEL_KEY)), name, Date.now(), o);
	if (!r.send || !r.state) return false;
	save(r.state);
	emit(name, r.x);
	return true;
}

/**
 * The boot's half, called once from startWhatsNew: a browser meeting the Welcome on its first
 * visit counts `ob_view`; every other boot reports its returns.
 * @param {{ firstWelcome: boolean }} o
 */
export function funnelBoot({ firstWelcome }) {
	if (!funnelAllowed()) return;
	const state = parseFunnelState(safeStorage.getItem(FUNNEL_KEY));
	if (firstWelcome && !state) {
		funnelEvent('ob_view');
		return;
	}
	const r = funnelReturns(state, Date.now());
	save(r.state);
	for (const e of r.events) emit(e, '');
}

/** the suites' view (state only — what this browser remembers) */
export function funnelDebug() {
	return {
		allowed: funnelAllowed(),
		state: parseFunnelState(safeStorage.getItem(FUNNEL_KEY)),
		device: funnelDevice(),
		release: release()
	};
}
