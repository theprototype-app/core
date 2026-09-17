import { writable } from 'svelte/store';
import { APP_VERSION, COMMIT_SHA, IS_DEV } from './version.js';

// 27-B (hardening audit H4) — THE ONE PLACE A FAILURE LEAVES A TRACE.
//
// Every recovery path in this app used to end in `console.log` (135 of them in src/lib
// against 17 console.error/warn), and there was no `window.onerror` or
// `unhandledrejection` handler anywhere. Two consequences, both of which this module
// exists to end:
//
//   · an uncaught error inside a store subscriber breaks THAT subscriber chain and
//     nothing else — svelte does not re-subscribe — so the app half-works and says
//     nothing at all;
//   · a user cannot hand over what happened. Every hard bug in this project's history
//     (the P-A connect dance, B5's mesh formation, the R22 room rounds) was diagnosed by
//     adding logs AFTER a report and asking the user to reproduce it.
//
// A ZERO-DEPENDENCY LEAF, deliberately: `version.js` (itself import-free) and
// svelte/store are the only imports, so ANY module can log without thinking about
// cycles — and the modules that most need to log (peerHandler, flowRuntime, autosave,
// moduleSDK) are exactly the ones sitting inside the documented import cycles.
//
// The BUNDLE reads its context through REGISTERED SECTIONS rather than by importing the
// stores. That keeps this file a leaf and makes the seam additive: a module (or the
// cloud plugin) contributes a section without this file knowing it exists. Sections are
// SYNCHRONOUS, because the bundle is assembled at the moment the user presses the
// button, and an await there would report a different instant than the one they saw.
//
// NOTHING LEAVES THE BROWSER. The bundle goes to the clipboard and nowhere else; there
// is no endpoint, no beacon and no telemetry. The user pastes it, or it does not travel.

/** How many entries the ring holds. ~300 lines is a page of context — enough to see the
 * sequence that led to a failure, small enough to paste into an issue. */
const CAP = 300;

/** How much of one entry's `data` is kept, in characters. A stringified scene object
 * would otherwise push the whole ring out of the buffer in one call. */
const DATA_CAP = 400;

/** @typedef {{t: number, level: 'debug'|'info'|'warn'|'error', scope: string, message: string, data?: string}} Entry */

/** @type {Entry[]} */
const ring = [];

/** The last uncaught error/rejection, or null. Toasts.svelte MIRRORS this into one
 * sticky card (the `restoreAvailable` idiom) rather than this module importing appStore
 * — a leaf that toasts is a leaf that imports the UI. */
/** @type {import('svelte/store').Writable<{message: string, at: number} | null>} */
export const lastUncaught = writable(null);

/** Bumped on every entry, so a panel can react without reading the ring. */
export const diagnosticsCount = writable(0);

/** @type {Map<string, () => any>} */
const sections = new Map();

let started = false;
/** @type {{log: typeof console.log, warn: typeof console.warn, error: typeof console.error} | null} */
let realConsole = null;

/** @param {unknown} value @returns {string | undefined} */
function briefly(value) {
	if (value === undefined) return undefined;
	let text;
	try {
		text = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		// a THREE object, a DOM node, anything circular
		text = String(value);
	}
	if (text === undefined) return undefined;
	return text.length > DATA_CAP ? text.slice(0, DATA_CAP) + '…' : text;
}

/**
 * Record one line. Cheap by construction: a push, a shift and a store bump — no
 * formatting until somebody asks for the bundle.
 * @param {Entry['level']} level
 * @param {string} scope the module, e.g. 'peer', 'autosave', 'flow'
 * @param {string} message
 * @param {unknown} [data]
 */
export function log(level, scope, message, data) {
	ring.push({ t: Date.now(), level, scope, message, data: briefly(data) });
	while (ring.length > CAP) ring.shift();
	diagnosticsCount.update((n) => n + 1);
	// In DEV the console stays the developer's: `log()` forwards, so a `log('warn', …)`
	// reads exactly like the `console.log` it replaced. In PROD the shim below is what
	// catches console output, and forwarding here would double every line.
	if (IS_DEV) {
		const out = realConsole ?? console;
		const write = level === 'error' ? out.error : level === 'warn' ? out.warn : out.log;
		if (data === undefined) write.call(console, `[${scope}] ${message}`);
		else write.call(console, `[${scope}] ${message}`, data);
	}
}

/** The ring as printable lines, oldest first. @returns {string[]} */
export function lines() {
	return ring.map(
		(e) =>
			new Date(e.t).toISOString().slice(11, 23) +
			' ' +
			e.level.toUpperCase().padEnd(5) +
			' [' +
			e.scope +
			'] ' +
			e.message +
			(e.data ? ' ' + e.data : '')
	);
}

/** Drop everything (tests, and the "start again" case). */
export function clearDiagnostics() {
	ring.length = 0;
	diagnosticsCount.set(0);
	lastUncaught.set(null);
}

/**
 * Contribute a named section to the bundle. The function must be SYNCHRONOUS and must
 * not throw — and if it does throw, the bundle records that instead of failing, because
 * a diagnostics bundle that cannot be produced when something is broken is worthless.
 * @param {string} name @param {() => any} read @returns {() => void} unregister
 */
export function registerDiagnosticsSection(name, read) {
	sections.set(name, read);
	return () => sections.delete(name);
}

/**
 * Everything a report needs, assembled now. Synchronous on purpose (see the header).
 * `extra` carries the one fact that cannot be read synchronously — the storage estimate
 * — which `copyDiagnostics` awaits before calling this.
 * @param {Record<string, any>} [extra]
 */
export function bundle(extra = {}) {
	/** @type {Record<string, any>} */
	const out = {
		version: APP_VERSION,
		sha: COMMIT_SHA,
		dev: IS_DEV,
		at: new Date().toISOString(),
		ua: typeof navigator === 'undefined' ? '' : navigator.userAgent,
		language: typeof navigator === 'undefined' ? '' : navigator.language,
		viewport:
			typeof window === 'undefined' ? '' : window.innerWidth + 'x' + window.innerHeight + '@' + (window.devicePixelRatio ?? 1),
		entries: ring.length,
		sections: /** @type {Record<string, any>} */ ({}),
		...extra
	};
	for (const [name, read] of sections) {
		try {
			out.sections[name] = read();
		} catch (error) {
			out.sections[name] = { failed: String(error) };
		}
	}
	out.lines = lines();
	return out;
}

/** The bundle as the text that goes on the clipboard. @param {Record<string, any>} [extra] */
export function bundleText(extra = {}) {
	try {
		return JSON.stringify(bundle(extra), null, 2);
	} catch (error) {
		// the bundle itself must never be the thing that fails
		return 'diagnostics bundle failed: ' + String(error) + '\n' + lines().join('\n');
	}
}

/**
 * Put the bundle on the clipboard. Async only because `storage.estimate()` is, and a
 * report that says how full the disk is answers the whole autosave-stopped class of
 * question at a glance. Falls back to a hidden textarea where the async clipboard is
 * unavailable (a non-secure context, an older browser).
 * @returns {Promise<boolean>} did it land on the clipboard?
 */
export async function copyDiagnostics() {
	/** @type {Record<string, any>} */
	const extra = {};
	try {
		if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
			const estimate = await navigator.storage.estimate();
			extra.storage = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
		}
	} catch {
		/* private mode, or a browser without it — the rest of the bundle still stands */
	}
	const text = bundleText(extra);
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through to the textarea */
	}
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(area);
		return ok;
	} catch (error) {
		log('warn', 'diagnostics', 'could not copy the bundle', String(error));
		return false;
	}
}

/**
 * Install the global capture. Idempotent, and safe to call before anything else in
 * App.svelte's onMount — it is the first thing that runs there precisely so that a
 * failure DURING boot is already being recorded.
 *
 * The console shim is PROD-ONLY: it tees `console.log/warn/error` into the ring so the
 * 135 legacy call sites are covered before they are migrated one by one, while a
 * developer's console keeps its exact line numbers and object inspection in dev.
 */
export function startDiagnostics() {
	if (started || typeof window === 'undefined') return;
	started = true;

	window.addEventListener('error', (event) => {
		// `event.error` is absent for a resource load failure, where `message` still is not
		const message = event.error?.message ?? event.message ?? 'unknown error';
		const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
		log('error', 'window', message + where, event.error?.stack);
		lastUncaught.set({ message, at: Date.now() });
	});

	window.addEventListener('unhandledrejection', (event) => {
		const reason = /** @type {any} */ (event).reason;
		const message = reason?.message ?? String(reason ?? 'unknown rejection');
		log('error', 'promise', message, reason?.stack);
		lastUncaught.set({ message, at: Date.now() });
	});

	if (!IS_DEV) {
		realConsole = { log: console.log, warn: console.warn, error: console.error };
		/** @param {Entry['level']} level @param {(...args: any[]) => void} original */
		const tee = (level, original) =>
			/** @param {any[]} args */
			(...args) => {
				try {
					log(level, 'console', args.map((a) => (typeof a === 'string' ? a : briefly(a) ?? '')).join(' '));
				} catch {
					/* never let logging break the thing that logged */
				}
				original.apply(console, args);
			};
		console.log = tee('info', realConsole.log);
		console.warn = tee('warn', realConsole.warn);
		console.error = tee('error', realConsole.error);
	}

	log('info', 'app', 'started ' + APP_VERSION + ' (' + COMMIT_SHA + ')');
}
