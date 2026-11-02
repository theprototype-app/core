// 76 FW2 — ANONYMOUS FIRST-VISIT FUNNEL COUNTERS. Did the first visit work: of the browsers that met
// the Welcome card, how many answered it, changed something, pressed Play, shared, finished the
// quest — and did they come back. Plus the G1 demand signal (a feature-update opt-in, from the
// cloud plugin).
//
// THE PRIVACY RULE, which decides the shape of everything here: an event is a NAME and a few
// closed-vocabulary fields (`c` the Welcome answer, `b` the release, `d` desktop|touch|vr, `x` a
// time bucket or a quest step) — no id of any kind, nothing that could join two events into one
// person. A browser that says Do Not Track or Global Privacy Control sends nothing and remembers
// nothing, and so does the Settings switch once it is off.
//
// CONSENT (owner sign-off S4, option D, 2026-10-31) — storing anything on a device for analytics needs
// consent under ePrivacy, so there are two modes, and the DEFAULT stores nothing at all:
//   · no answer yet: a visit that met the Welcome counts its steps from MEMORY only (`visitStep`):
//     each step once per page load, nothing written to localStorage / IndexedDB, no came-back counts.
//     Someone who sees the Welcome again is simply counted again.
//   · after that person's first successful Play the small card (FunnelConsentCard) asks once:
//     Agree → the note as before: once per browser (`funnelStep`) + came back (`funnelReturns`). The
//     note is in this browser's own storage and never leaves it; only "came back on day 1 / in
//     week 3" is sent.
//     No thanks → nothing more is counted, and only that answer is remembered. It is the Settings
//     switch's off position, so Settings can undo it (back to the default, with no note).
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
import { notifyFunnelEvent, funnelListening } from '../cloudHooks';
import { APP_VERSION } from '../version';
import { releaseLabel } from '../errorReportCore';
import { onboardChoice } from './onboardState.js';

export const FUNNEL_KEY = 'onboard.funnel';
/** The one answer this browser remembers. Absent = not answered (nothing stored). */
export const CONSENT_KEY = 'onboard.funnelConsent';
const AGREED = 'agreed';
const OFF = 'off';

/** the small "count my first steps" card is owed (FunnelConsentCard renders it) */
export const funnelCardOpen = writable(false);

/**
 * Settings ▸ Privacy's switch. LOCAL, default ON — Do Not Track / GPC win over it. Written only when
 * someone changes it (being on by default stores nothing). Off withdraws: the note goes with it.
 */
export const funnelOn = writable(safeStorage.getItem(CONSENT_KEY) !== OFF);
funnelOn.subscribe((on) => {
	const answer = safeStorage.getItem(CONSENT_KEY);
	if (!on && answer !== OFF) {
		safeStorage.setItem(CONSENT_KEY, OFF);
		safeStorage.removeItem(FUNNEL_KEY);
		funnelCardOpen.set(false);
	} else if (on && answer === OFF) {
		safeStorage.removeItem(CONSENT_KEY);
	}
});
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
 * What a visit keeps in MEMORY in the default mode (never stored): when it met the Welcome and what
 * it has counted. Null = this page never met the Welcome.
 * @typedef {{ view: number, sent: string[] }} FunnelVisit
 */

/**
 * One event in the default mode. Pure. A step counts once per page load, and only in a visit that
 * met the Welcome — a person's thousandth session is not a "first change". `ob_waitlist` is the
 * exception, as in `funnelStep`: any browser, whenever it happens (once per page).
 * @param {FunnelVisit | null} visit @param {string} name @param {number} now @param {{x?: string}} [o]
 * @returns {{ send: boolean, visit: FunnelVisit | null, x: string }}
 */
export function visitStep(visit, name, now, o = {}) {
	const no = { send: false, visit, x: '' };
	if (name === 'ob_view') {
		if (visit) return no;
		return { send: true, visit: { view: now, sent: ['ob_view'] }, x: '' };
	}
	const base = visit ?? { view: 0, sent: [] };
	if (base.sent.includes(name)) return no;
	if (ANY_BROWSER_EVENTS.includes(name))
		return { send: true, visit: { ...base, sent: [...base.sent, name] }, x: '' };
	if (!visit || !FIRST_VISIT_EVENTS.includes(name)) return no;
	const x =
		name === 'ob_first_play'
			? playBucket(now - visit.view)
			: name === 'ob_tour_skip'
				? String(o.x || '')
				: '';
	return { send: true, visit: { ...visit, sent: [...visit.sent, name] }, x };
}

/**
 * The note a browser starts with when its person Agrees. Pure. The day it starts is today, the steps
 * this page already counted are not counted twice, and the first Play is behind them (the card comes
 * after it); `view` makes the came-back counts apply, since only someone who met the Welcome is asked.
 * @param {FunnelVisit | null} visit @param {number} now @returns {FunnelState}
 */
export function agreedNote(visit, now) {
	const sent = new Set(['ob_view', 'ob_first_play', ...(visit?.sent ?? [])]);
	return { v: 1, first: dayOf(now), view: visit?.view || now, sent: [...sent], w: 0 };
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

/** this page's memory in the default mode @type {FunnelVisit | null} */
let visit = null;
const agreed = () => safeStorage.getItem(CONSENT_KEY) === AGREED;

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
 * Count one event (the default mode: once per page, from memory, see visitStep; after Agree: once per
 * browser, see funnelStep). Returns whether it went out.
 * @param {string} name @param {{x?: string}} [o]
 */
export function funnelEvent(name, o = {}) {
	if (!funnelAllowed()) return false;
	if (!agreed()) {
		const r = visitStep(visit, name, Date.now(), o);
		if (!r.send) return false;
		visit = r.visit;
		emit(name, r.x);
		return true;
	}
	const r = funnelStep(parseFunnelState(safeStorage.getItem(FUNNEL_KEY)), name, Date.now(), o);
	if (!r.send || !r.state) return false;
	save(r.state);
	emit(name, r.x);
	return true;
}

/**
 * The boot's half, called once from startWhatsNew: a browser meeting the Welcome on its first
 * visit counts `ob_view`; a browser whose person agreed to the note reports its returns on every
 * other boot. Without that agreement nothing is read or written here.
 * @param {{ firstWelcome: boolean }} o
 */
export function funnelBoot({ firstWelcome }) {
	if (!funnelAllowed()) return;
	if (!agreed()) {
		if (firstWelcome) funnelEvent('ob_view');
		return;
	}
	const state = parseFunnelState(safeStorage.getItem(FUNNEL_KEY));
	if (firstWelcome && !state) {
		funnelEvent('ob_view');
		return;
	}
	const r = funnelReturns(state, Date.now());
	save(r.state);
	for (const e of r.events) emit(e, '');
}

/**
 * A first successful Play just ended: ask, once. Only where something would be counted at all (a
 * plugin listens, not under DNT / GPC / the switch) and nobody answered yet. What makes it once
 * without storing anything: firstWin calls this only as `simpleUntilPlay` clears, which never returns.
 */
export function offerFunnelNote() {
	if (!funnelAllowed() || !get(funnelListening) || safeStorage.getItem(CONSENT_KEY)) return false;
	funnelCardOpen.set(true);
	return true;
}

/** the card's Agree: keep the note from here on */
export function funnelAgree() {
	safeStorage.setItem(CONSENT_KEY, AGREED);
	save(agreedNote(visit, Date.now()));
	funnelCardOpen.set(false);
}

/** the card's No thanks: nothing more is counted, and only this answer stays */
export function funnelDecline() {
	funnelOn.set(false);
	funnelCardOpen.set(false);
}

/** the suites' view */
export function funnelDebug() {
	return {
		allowed: funnelAllowed(),
		consent: safeStorage.getItem(CONSENT_KEY),
		visit,
		state: parseFunnelState(safeStorage.getItem(FUNNEL_KEY)),
		device: funnelDevice(),
		release: release()
	};
}
