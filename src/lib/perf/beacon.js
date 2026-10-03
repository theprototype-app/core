// 34 R1 — THE PERFORMANCE BEACON (client half; the PocketBase `perf_reports` collection is
// cloud lane 34-beacon-cloud's). It turns a player's normal play of a preview into numbers
// the next lane can read instead of "OWED on device".
//
// THE RULES (roadmap 34 decision 3 + the brief):
//   - OPT-IN on its own switch, Settings ▸ Interface ▸ "Send performance reports", DEFAULT
//     OFF. A PREVIEW build offers it ONCE (a sticky card); production NEVER prompts.
//   - ABSENT `VITE_PERF_REPORTS_URL` = the feature does not exist: no row, no offer, no
//     request (an OSS build is byte-identical in behaviour).
//   - Data = numbers + versions (T1 light windows): no account id, no scene content. The
//     session id is random per app run.
//   - Every 10 s a light WINDOW is cut from the recorder's ring; every 30 s the queue is
//     POSTed, one record per window (`fetch`, FormData — the CORS-safelisted body PocketBase
//     accepts, see cloud docs/pocketbase-setup.md). On hide / pagehide / XR end the
//     current partial window and the queue go with `navigator.sendBeacon` (≤ 64 KB each;
//     a refused beacon is dropped). A failed send is DROPPED, never retried — a beacon
//     that queues on failure is a beacon that floods the box the moment it comes back.
//   - A window holding a stall > 100 ms is sent as kind `stall` (the window IS the context
//     around it); otherwise `sample`. "Report this moment" (moment.js) sends kind `moment`
//     through `sendReport` here, with its screenshot.
//   - A reporting DOT on the FPS counter while it is on (data-state sent/failed/idle).
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { showInfoToast, dismissToastById } from '../../stores/appStore';
import { globalRenderer } from '../../stores/sceneStore';
import { ringNow, ringWindow } from './recorder.js';
import { validateTpprof, WINDOW_MS, REPORT_LIMITS } from './tpprof.js';
import { registerPerfContext } from './perfMarks.js';

/** the batch cadence */
export const BATCH_MS = 30000;
/** windows held at most (a hidden tab that never flushes cannot grow this) */
export const MAX_QUEUE = 6;
/** a window keeps at most this many frames (a 240 Hz monitor would pass the hook's 1500) */
export const MAX_WINDOW_FRAMES = 1400;

const SEND_KEY = 'perfReports:send';
const OFFERED_KEY = 'perfReports:offered';
const URL_OVERRIDE_KEY = 'perfReports:url';
const OFFER_TOAST = 'perf-reports-offer';

/**
 * Where reports go: the build's env, or — ONLY with the debug hook on — a local override
 * (the e2e mock endpoint). A build-time env var is inlined into whatever the dev server
 * serves, so a personal override must never apply without the debug flag (CLAUDE.md).
 * @returns {string | null}
 */
export function reportsUrl() {
	/** @type {any} */
	const env = import.meta.env ?? {};
	if (safeStorage.getItem('debugStores') === 'true') {
		const o = safeStorage.getItem(URL_OVERRIDE_KEY);
		if (o) return o === 'off' ? null : o;
	}
	return typeof env.VITE_PERF_REPORTS_URL === 'string' && env.VITE_PERF_REPORTS_URL ? env.VITE_PERF_REPORTS_URL : null;
}

/** Is the feature in this build at all. */
export const perfReportsAvailable = writable(!!reportsUrl());

/** The switch. LOCAL, default OFF. */
export const perfReportsOn = writable(safeStorage.getItem(SEND_KEY) === 'true');
perfReportsOn.subscribe((on) => safeStorage.setItem(SEND_KEY, on ? 'true' : 'false'));

/** The dot's state: what the last send did. @type {import('svelte/store').Writable<{state: 'idle' | 'sent' | 'failed', sent: number, failed: number, dropped: number, at: number}>} */
export const perfReportStatus = writable({ state: 'idle', sent: 0, failed: 0, dropped: 0, at: 0 });

/**
 * Is this a PREVIEW deployment (where the one-time offer is allowed)? Production
 * (theprototype.app, theprototype.pages.dev) and local dev never are. Pure.
 * `VITE_PERF_REPORTS_OFFER` = '1' | '0' overrides the host rule.
 * @param {string} hostname @param {string | undefined} [override]
 */
export function isPreviewHost(hostname, override) {
	if (override === '1') return true;
	if (override === '0') return false;
	const h = String(hostname || '').toLowerCase();
	return h.endsWith('.theprototype.pages.dev') || /^preview[-.]/.test(h);
}

/** a random session id, per app run (never an account id) */
function makeSession() {
	const a = new Uint8Array(12);
	try {
		crypto.getRandomValues(a);
	} catch {
		for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
export const SESSION = makeSession();

/**
 * One report as the FormData the endpoint takes: kind, session, data (the T1 window as
 * JSON) and, on a moment, the screenshot file. Pure apart from FormData/Blob.
 * @param {'sample' | 'stall' | 'moment'} kind @param {import('./tpprof.js').Tpprof} doc @param {Blob | null} [screenshot]
 */
export function reportForm(kind, doc, screenshot = null) {
	const form = new FormData();
	form.append('kind', kind);
	form.append('session', SESSION);
	form.append('data', JSON.stringify(doc));
	if (screenshot) form.append('screenshot', screenshot, 'moment.jpg');
	return form;
}

/** @type {{kind: 'sample' | 'stall', doc: import('./tpprof.js').Tpprof}[]} */
let queue = [];
let lastCut = 0;
/** @type {any} */
let cutTimer = null;
/** @type {any} */
let flushTimer = null;
let running = false;

/**
 * Cut the ring from the last cut to now into a window and queue it (empty windows — a
 * hidden tab — are skipped). Exported for the suite.
 */
export function cutWindow() {
	const to = ringNow();
	const from = Math.max(lastCut, to - WINDOW_MS);
	lastCut = to;
	let doc = ringWindow(from, to, { kind: 'sample', session: SESSION });
	if (!doc.frames.length) return null;
	if (doc.frames.length > MAX_WINDOW_FRAMES) {
		const first = doc.frames[doc.frames.length - MAX_WINDOW_FRAMES].t;
		doc = { ...doc, frames: doc.frames.slice(-MAX_WINDOW_FRAMES), events: doc.events.filter((e) => e.t >= first) };
	}
	const kind = doc.events.some((e) => e.kind === 'stall') ? 'stall' : 'sample';
	doc.meta.kind = kind;
	queue.push({ kind, doc });
	if (queue.length > MAX_QUEUE) {
		const over = queue.length - MAX_QUEUE;
		queue.splice(0, over);
		perfReportStatus.update((s) => ({ ...s, dropped: s.dropped + over }));
	}
	return kind;
}

/** @param {boolean} ok */
function noteResult(ok) {
	perfReportStatus.update((s) => ({ ...s, state: ok ? 'sent' : 'failed', sent: s.sent + (ok ? 1 : 0), failed: s.failed + (ok ? 0 : 1), at: Date.now() }));
}

/**
 * Send one report now with fetch. Resolves true on a 2xx. Never throws; a failure is
 * counted and dropped. Used by the batch and by "Report this moment".
 * @param {'sample' | 'stall' | 'moment'} kind @param {import('./tpprof.js').Tpprof} doc @param {Blob | null} [screenshot]
 */
export async function sendReport(kind, doc, screenshot = null) {
	const url = reportsUrl();
	if (!url) return false;
	const check = validateTpprof(doc, { report: kind });
	const size = JSON.stringify(doc).length;
	if (!check.ok || size > REPORT_LIMITS[kind].bytes) {
		noteResult(false);
		return false;
	}
	try {
		const res = await fetch(url, { method: 'POST', body: reportForm(kind, doc, screenshot), credentials: 'omit' });
		noteResult(res.ok);
		return res.ok;
	} catch {
		noteResult(false);
		return false;
	}
}

/** POST the queue (one request per window). Exported for the suite. */
export async function flushQueue() {
	const batch = queue;
	queue = [];
	let ok = 0;
	for (const { kind, doc } of batch) if (await sendReport(kind, doc)) ok++;
	return ok;
}

/** The page is going away (hidden, closed) or the headset came off: cut and beacon everything. */
export function beaconNow() {
	if (!running) return 0;
	cutWindow();
	const url = reportsUrl();
	const batch = queue;
	queue = [];
	if (!url || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return 0;
	let sent = 0;
	for (const { kind, doc } of batch) {
		if (!validateTpprof(doc, { report: kind }).ok) continue;
		let ok = false;
		try {
			ok = navigator.sendBeacon(url, reportForm(kind, doc));
		} catch {
			ok = false;
		}
		noteResult(ok);
		if (ok) sent++;
	}
	return sent;
}

function onVisibility() {
	if (document.visibilityState === 'hidden') beaconNow();
	else lastCut = ringNow(); // the hidden stretch is not a window
}

/** @param {any} r */
function hookXR(r) {
	if (!r?.xr || r.__perfBeaconXR) return;
	r.__perfBeaconXR = true;
	r.xr.addEventListener?.('sessionend', () => beaconNow());
}

function start() {
	if (running || typeof window === 'undefined') return;
	running = true;
	lastCut = ringNow();
	cutTimer = setInterval(cutWindow, WINDOW_MS);
	flushTimer = setInterval(() => void flushQueue(), BATCH_MS);
	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('pagehide', beaconNow);
}

function stop() {
	if (!running) return;
	running = false;
	clearInterval(cutTimer);
	clearInterval(flushTimer);
	document.removeEventListener('visibilitychange', onVisibility);
	window.removeEventListener('pagehide', beaconNow);
	queue = [];
	perfReportStatus.update((s) => ({ ...s, state: 'idle' }));
}

/** The one-time preview offer (never on production, never twice, never once decided). */
export function maybeOffer() {
	if (!reportsUrl() || get(perfReportsOn)) return false;
	if (safeStorage.getItem(OFFERED_KEY)) return false;
	/** @type {any} */
	const env = import.meta.env ?? {};
	const host = typeof location !== 'undefined' ? location.hostname : '';
	if (!isPreviewHost(host, env.VITE_PERF_REPORTS_OFFER)) return false;
	const decide = (/** @type {boolean} */ on) => {
		safeStorage.setItem(OFFERED_KEY, on ? 'yes' : 'no');
		perfReportsOn.set(on);
		dismissToastById(OFFER_TOAST);
	};
	showInfoToast(
		OFFER_TOAST,
		'This is a preview build. Send anonymous performance reports (frame times, draw calls and module versions — no account, no scene content) so problems on your device get fixed? You can change it in Settings ▸ Interface.',
		[
			{ label: 'Send reports', action: () => decide(true) },
			{ label: 'No thanks', action: () => decide(false) }
		],
		// the card's ✕ — and Toasts runs onDismiss after an action press too, so only record a
		// dismissal when no answer was given (an accepted offer must stay 'yes')
		() => {
			if (!safeStorage.getItem(OFFERED_KEY)) safeStorage.setItem(OFFERED_KEY, 'dismissed');
		}
	);
	return true;
}

let booted = false;
/** Boot: follow the switch, hook XR end, make the offer on a preview. Idempotent. */
export function startPerfBeacon() {
	if (booted) return;
	booted = true;
	perfReportsAvailable.set(!!reportsUrl());
	perfReportsOn.subscribe((on) => (on && reportsUrl() ? start() : stop()));
	// the headset's FPS strip draws the same dot (vrPerfStrip reads it through the leaf)
	registerPerfContext('reporting', () => (running ? get(perfReportStatus).state : null));
	globalRenderer.subscribe((r) => hookXR(r));
	maybeOffer();
}

/** For the suite. */
export function beaconDebug() {
	return { running, queued: queue.map((q) => ({ kind: q.kind, frames: q.doc.frames.length })), session: SESSION, url: reportsUrl(), status: get(perfReportStatus) };
}
