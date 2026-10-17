// 48 O1 — ERROR AND CRASH REPORTS FROM REAL USERS (runtime half; the shape rules are the
// pure leaf errorReportCore.js, the receiving end is the cloud's community Worker).
//
// THE RULES (roadmap 48 decisions — "On, with opt-out"):
//   - ABSENT `VITE_ERROR_REPORTS_URL` = the feature does not exist: no listener sends, no
//     request, no Settings row says it sends (the perf beacon's rule — an OSS build is
//     byte-identical in behaviour). A dev server never sends unless the debug hook asks.
//   - Default ON, with Settings ▸ Privacy ▸ "Send anonymous error reports" to switch it off
//     (LOCAL, safeStorage). Off means NOTHING is sent, not "sent and ignored".
//   - Four seams: `window` error, `unhandledrejection`, the main renderer's WebGL context loss
//     (the `contextLost` store Scene sets — offscreen thumbnail renderers lose their contexts
//     on purpose and are never counted), and out-of-memory: an error that names it, OR a tab
//     that died while VISIBLE (the alive flag below), which is what an OOM kill looks like on a
//     phone or a headset — no JavaScript error ever fires for it.
//   - Scrub (errorReportCore) → dedupe by signature → at most MAX_PER_SESSION per tab session
//     (sessionStorage, so a crash-reload loop cannot multiply it) → one `sendBeacon` each,
//     JSON as text/plain (a CORS-simple request: no preflight, nothing to read back). A failed
//     send is dropped, never retried.
//   - The Worker stores no IP; this file sends no account id, no peer id and no scene content.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { APP_VERSION, COMMIT_SHA, IS_DEV } from './version.js';
import { buildReport, browserOf, deviceClassOf, envOf, MAX_PER_SESSION } from './errorReportCore.js';

const SEND_KEY = 'errorReports:send';
const URL_OVERRIDE_KEY = 'errorReports:url';
const COUNT_KEY = 'tp.errorReports.count';
const SEEN_KEY = 'tp.errorReports.seen';
const ALIVE_KEY = 'tp.errorReports.alive';

/**
 * Where reports go: the build's env, or — ONLY with the debug hook on — a local override (the
 * e2e mock endpoint; 'off' turns a configured build off). The perf beacon's rule.
 * @returns {string | null}
 */
export function errorReportsUrl() {
	/** @type {any} */
	const env = import.meta.env ?? {};
	if (safeStorage.getItem('debugStores') === 'true') {
		const o = safeStorage.getItem(URL_OVERRIDE_KEY);
		if (o) return o === 'off' ? null : o;
	}
	if (IS_DEV) return null;
	return typeof env.VITE_ERROR_REPORTS_URL === 'string' && env.VITE_ERROR_REPORTS_URL ? env.VITE_ERROR_REPORTS_URL : null;
}

/** Is the feature in this build at all (the Settings row reads it). */
export const errorReportsAvailable = writable(!!errorReportsUrl());

/** The switch. LOCAL, default ON (absent = on). */
export const errorReportsOn = writable(safeStorage.getItem(SEND_KEY) !== 'false');
errorReportsOn.subscribe((on) => safeStorage.setItem(SEND_KEY, on ? 'true' : 'false'));

/** the suites' view: what was caught, built, sent and why something was not */
export const errorReportsDebug = {
	caught: 0,
	sent: 0,
	/** @type {Record<string, number>} */
	skipped: {},
	/** @type {any[]} */
	last: []
};

/** count why a report was not sent @param {string} why @returns {null} */
function skip(why) {
	errorReportsDebug.skipped[why] = (errorReportsDebug.skipped[why] || 0) + 1;
	return null;
}

/** sessionStorage, guarded (a sandboxed frame throws on touch) */
const session = {
	/** @param {string} k */
	get(k) {
		try {
			return sessionStorage.getItem(k);
		} catch {
			return null;
		}
	},
	/** @param {string} k @param {string} v */
	set(k, v) {
		try {
			sessionStorage.setItem(k, v);
		} catch {
			/* private mode / sandbox — the in-memory cap below still holds */
		}
	},
	/** @param {string} k */
	remove(k) {
		try {
			sessionStorage.removeItem(k);
		} catch {
			/* nothing to clear */
		}
	}
};

let memCount = 0;
/** @type {Set<string>} */
const memSeen = new Set();

function sentCount() {
	return Math.max(memCount, Number(session.get(COUNT_KEY)) || 0);
}
/** @param {string} sig */
function seen(sig) {
	if (memSeen.has(sig)) return true;
	return String(session.get(SEEN_KEY) || '').split(',').includes(sig);
}
/** @param {string} sig */
function remember(sig) {
	memSeen.add(sig);
	memCount = sentCount() + 1;
	session.set(COUNT_KEY, String(memCount));
	const list = String(session.get(SEEN_KEY) || '').split(',').filter(Boolean);
	list.push(sig);
	session.set(SEEN_KEY, list.slice(-MAX_PER_SESSION * 2).join(','));
}

/** @type {null | (() => {gpu: string, area: string})} what the app is doing, read lazily */
let liveContext = null;

/** the parts of the context that do not change during a session */
function staticContext() {
	const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
	const ua = String(nav.userAgent || '');
	const { browser, os } = browserOf(ua, nav.userAgentData?.brands);
	let coarse = false;
	let minSide = 0;
	try {
		coarse = matchMedia('(pointer: coarse)').matches;
		minSide = Math.min(screen.width, screen.height);
	} catch {
		/* not a browser */
	}
	return {
		origin: typeof location !== 'undefined' ? location.origin : '',
		release: APP_VERSION,
		build: COMMIT_SHA,
		device: deviceClassOf({ ua, coarse, minSide }),
		browser,
		os,
		env: envOf(typeof location !== 'undefined' ? location.hostname : '')
	};
}

/**
 * Report one caught failure (the four seams call this; exported for the suite). Returns the
 * report that was sent, or null with the reason counted in `errorReportsDebug.skipped`.
 * @param {{kind: string, message: string, stack?: string, filename?: string}} caught
 */
export function reportError(caught) {
	errorReportsDebug.caught++;
	const url = errorReportsUrl();
	if (!url) return skip('no-endpoint');
	// 48 O3: a status-page probe is not a user (it runs no app, but a headless check one day might)
	if (typeof navigator !== 'undefined' && /upptime/i.test(navigator.userAgent || '')) return skip('probe');
	if (!get(errorReportsOn)) return skip('off');
	if (sentCount() >= MAX_PER_SESSION) return skip('cap');
	let live = { gpu: 'unknown', area: 'boot' };
	try {
		if (liveContext) live = liveContext();
	} catch {
		/* a broken store must not stop the report about it */
	}
	const report = buildReport(caught, { ...staticContext(), ...live });
	if (!report) return skip('ignored');
	if (seen(report.sig)) return skip('duplicate');
	remember(report.sig);
	const body = JSON.stringify(report);
	let ok = false;
	try {
		ok = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
	} catch {
		ok = false;
	}
	if (!ok) {
		try {
			void fetch(url, { method: 'POST', body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
			ok = true;
		} catch {
			/* dropped — never retried */
		}
	}
	if (ok) errorReportsDebug.sent++;
	errorReportsDebug.last = [...errorReportsDebug.last, report].slice(-MAX_PER_SESSION);
	return report;
}

/** the alive flag: set while this tab is VISIBLE, cleared on hide and on a clean unload */
function markAlive() {
	let area = 'boot';
	try {
		if (liveContext) area = liveContext().area;
	} catch {
		/* keep 'boot' */
	}
	session.set(ALIVE_KEY, JSON.stringify({ at: Date.now(), area }));
}

let started = false;

/**
 * Install the four seams. Idempotent; App.svelte calls it right after the diagnostics capture.
 * The live context (graphics API, app area) is read through stores loaded lazily so this file
 * stays out of the scene stores' import graph at module evaluation.
 */
export function startErrorReports() {
	if (started || typeof window === 'undefined') return;
	started = true;
	errorReportsAvailable.set(!!errorReportsUrl());

	// a tab that died while visible, last time: the OOM kill no JavaScript error reports
	const prev = session.get(ALIVE_KEY);
	const discarded = /** @type {any} */ (document).wasDiscarded === true;
	if (prev && !discarded) {
		let area = 'unknown';
		try {
			area = String(JSON.parse(prev).area || 'unknown');
		} catch {
			/* an old flag */
		}
		const saved = liveContext;
		liveContext = () => ({ gpu: 'unknown', area });
		reportError({ kind: 'crash', message: 'The tab ended without closing (out of memory or a renderer crash)' });
		liveContext = saved;
	}
	session.remove(ALIVE_KEY);

	window.addEventListener('error', (event) => {
		// a resource load failure (img/script 404) has no `error` and is not a code failure
		if (!event.error && !event.message) return;
		reportError({ kind: 'error', message: event.error?.message ?? event.message ?? '', stack: event.error?.stack, filename: event.filename });
	});
	window.addEventListener('unhandledrejection', (event) => {
		const reason = /** @type {any} */ (event).reason;
		reportError({ kind: 'rejection', message: reason?.message ?? String(reason ?? ''), stack: reason?.stack });
	});

	const onVisibility = () => (document.visibilityState === 'visible' ? markAlive() : session.remove(ALIVE_KEY));
	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('pagehide', () => session.remove(ALIVE_KEY));
	window.addEventListener('pageshow', () => document.visibilityState === 'visible' && markAlive());

	Promise.all([import('../stores/sceneStore.js')])
		.then(([scene]) => {
			liveContext = () => {
				const r = /** @type {any} */ (get(scene.globalRenderer));
				const gpu = !r ? 'none' : r.isWebGPURenderer ? 'webgpu' : r.capabilities?.isWebGL2 ? 'webgl2' : 'webgl1';
				const area = get(scene.isVRMode) || r?.xr?.isPresenting ? 'vr' : get(scene.isLocked) === true ? 'play' : 'edit';
				return { gpu, area };
			};
			if (document.visibilityState === 'visible') markAlive();
			let wasLost = false;
			scene.contextLost.subscribe((lost) => {
				if (lost && !wasLost) reportError({ kind: 'webgl', message: 'WebGL context lost' });
				wasLost = !!lost;
			});
		})
		.catch(() => {
			/* the stores failed to load — the app has bigger problems and the error seam saw them */
		});
}
