// 36 U9 — WHAT EVERY LOADING FILE IS DOING, and the settings for how a placeholder shows it.
//
// A kit piece in a scene is a STUB until its pack file arrives (packRefs.js, 30c/33 L1), and
// before this module a stub only knew "not yet": a slow link, a 404, a stream that stopped
// half-way and a CORS refusal all looked like the same grey block, forever, with one toast.
// Now each FILE (one template per URL, so every copy of a piece shares one fetch) carries:
//   bytes loaded / total        -> the placeholder's fill level
//   when the last byte arrived  -> amber once that is `stuck` seconds ago
//   the attempt + the error     -> auto-retry (1/3/9 s) or red with the URL, status and reason
// PER FILE, not per object, because that is what is actually fetched; the placeholders read it
// per object through the stub's URL.
//
// A LEAF: svelte/store + safeStorage only. packRefs writes it, the placeholder renderer and
// the UI (Inspector panel, context menu, the Retry-all toast, the settings section) read it.

import { writable, get } from 'svelte/store';
import * as safeStorage from './safeStorage';

// ---- settings ----------------------------------------------------------------------------

/** 'modern' = the hologram boxes (the default since 36 L1, 1.22); 'boxes' = the 33 L1 grey blocks */
export const PLACEHOLDER_STYLES = /** @type {const} */ (['boxes', 'modern']);

/**
 * A persisted setting: read once, written on every change, normalized both ways.
 * @template T @param {string} key @param {T} fallback @param {(raw: any) => T} normalize
 */
function persisted(key, fallback, normalize) {
	/** @type {T} */
	let initial = fallback;
	try {
		const raw = safeStorage.getItem(key);
		if (raw !== null) initial = normalize(JSON.parse(raw));
	} catch {
		initial = fallback;
	}
	const store = writable(initial);
	let first = true;
	store.subscribe((value) => {
		if (first) {
			first = false;
			return;
		}
		safeStorage.setItem(key, JSON.stringify(normalize(value)));
	});
	return store;
}

/** the style a person who never picked one gets (36 L1: Modern, was Colored boxes in 1.21) */
export const DEFAULT_PLACEHOLDER_STYLE = /** @type {'boxes'|'modern'} */ ('modern');

/** @param {any} v @returns {'boxes'|'modern'} */
export function normalizeStyle(v) {
	return v === 'boxes' || v === 'modern' ? v : DEFAULT_PLACEHOLDER_STYLE;
}

/** written with every pick: the stored style is a CHOICE, not a snapshot of the default */
const STYLE_CHOSEN_KEY = 'placeholderStyleChosen';

/**
 * 36 L1 — the stored style only exists when it was CHOSEN: nothing writes `placeholderStyle`
 * except the settings picker (1.21 never wrote it on first run, and neither does this), and each
 * pick also sets `placeholderStyleChosen`. So an explicit "Colored boxes" from 1.21 stays boxes,
 * and a person who never chose follows the default (Modern now) instead of a frozen copy of it.
 * @param {(key: string) => string | null} read @returns {'boxes'|'modern'}
 */
export function initialPlaceholderStyle(read) {
	try {
		const raw = read('placeholderStyle');
		if (raw === null) return DEFAULT_PLACEHOLDER_STYLE;
		return normalizeStyle(JSON.parse(raw));
	} catch {
		return DEFAULT_PLACEHOLDER_STYLE;
	}
}

/**
 * The modern style's triplanar grid. `size` is WORLD metres per cell (scale-independent),
 * `speed` scales every animation of the modern look (0 = still).
 * @typedef {{on: boolean, size: number, color: string, opacity: number, speed: number}} PlaceholderGrid
 */
/** @type {PlaceholderGrid} */
export const DEFAULT_GRID = { on: true, size: 0.5, color: '#bfe6ff', opacity: 0.45, speed: 1 };

/** @param {number} v @param {number} lo @param {number} hi @param {number} d */
function clampNum(v, lo, hi, d) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

/** @param {any} v @returns {PlaceholderGrid} */
export function normalizeGrid(v) {
	const o = v && typeof v === 'object' ? v : {};
	return {
		on: o.on !== false,
		size: clampNum(o.size, 0.05, 10, DEFAULT_GRID.size),
		color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : DEFAULT_GRID.color,
		opacity: clampNum(o.opacity, 0, 1, DEFAULT_GRID.opacity),
		speed: clampNum(o.speed, 0, 4, DEFAULT_GRID.speed)
	};
}

/** @param {any} v */
export function normalizeStuckSeconds(v) {
	return Math.round(clampNum(v, 1, 120, 10));
}

export const placeholderStyle = writable(initialPlaceholderStyle((k) => safeStorage.getItem(k)));
{
	let first = true;
	placeholderStyle.subscribe((value) => {
		if (first) {
			first = false;
			return;
		}
		safeStorage.setItem('placeholderStyle', JSON.stringify(normalizeStyle(value)));
		safeStorage.setItem(STYLE_CHOSEN_KEY, '1');
	});
}
export const placeholderGrid = persisted('placeholderGrid', DEFAULT_GRID, normalizeGrid);
/** no new byte for this long -> amber; 3x this -> the attempt is abandoned and retried */
export const placeholderStuckSeconds = persisted('placeholderStuckSeconds', 10, normalizeStuckSeconds);

/** how many silent `stuck` periods abandon an attempt (a dead socket must not stay amber forever) */
export const STALL_ABORT_FACTOR = 3;
/** auto-retry backoff: three retries, 1 s, 3 s, 9 s */
export const RETRY_DELAYS = [1000, 3000, 9000];

// ---- per-file state ----------------------------------------------------------------------

/**
 * @typedef {{status: number, reason: string, retryable: boolean}} LoadError
 * @typedef {{
 *   url: string, phase: 'fetching'|'waiting'|'parsing'|'failed',
 *   attempt: number, loaded: number, total: number, lastByteAt: number,
 *   retryAt: number, error: LoadError | null
 * }} FileLoad
 */

/** url -> its load, present from the first attempt until it is parsed (then removed)
 * @type {Map<string, FileLoad>} */
const loads = new Map();

/** Bumps when a file CHANGES PHASE (never per byte): the UI re-reads on it. */
export const loadRevision = writable(0);

/** injectable for the unit layer */
let clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** @param {() => number} fn */
export function setLoadClockForTest(fn) {
	clock = fn;
}
export function loadNow() {
	return clock();
}

function bump() {
	loadRevision.update((n) => n + 1);
}

/** @param {string} url @returns {FileLoad | null} */
export function loadOf(url) {
	return loads.get(url) ?? null;
}

/** @param {string} url @param {number} attempt */
export function noteAttempt(url, attempt) {
	loads.set(url, { url, phase: 'fetching', attempt, loaded: 0, total: 0, lastByteAt: clock(), retryAt: 0, error: loads.get(url)?.error ?? null });
	bump();
}

/** Bytes arrived. Never bumps the revision (a 5 MB file is hundreds of chunks).
 * @param {string} url @param {number} loaded @param {number} total 0 = unknown */
export function noteBytes(url, loaded, total) {
	const load = loads.get(url);
	if (!load) return;
	load.loaded = loaded;
	load.total = total > 0 ? total : 0;
	load.lastByteAt = clock();
}

/** @param {string} url */
export function noteParsing(url) {
	const load = loads.get(url);
	if (!load) return;
	load.phase = 'parsing';
	load.lastByteAt = clock();
	if (load.total) load.loaded = Math.max(load.loaded, load.total);
	bump();
}

/** @param {string} url @param {LoadError} error @param {number} delayMs */
export function noteRetryWait(url, error, delayMs) {
	const load = loads.get(url) ?? { url, phase: 'waiting', attempt: 0, loaded: 0, total: 0, lastByteAt: clock(), retryAt: 0, error: null };
	load.phase = 'waiting';
	load.error = error;
	load.retryAt = clock() + delayMs;
	loads.set(url, load);
	bump();
}

/** @param {string} url @param {LoadError} error */
export function noteFailed(url, error) {
	const load = loads.get(url) ?? { url, phase: 'failed', attempt: 0, loaded: 0, total: 0, lastByteAt: clock(), retryAt: 0, error: null };
	load.phase = 'failed';
	load.error = error;
	loads.set(url, load);
	bump();
}

/** The file is parsed (or nothing waits on it any more): forget it. @param {string} url */
export function noteDone(url) {
	if (loads.delete(url)) bump();
}

/** Every file that gave up. @returns {FileLoad[]} */
export function failedLoads() {
	return [...loads.values()].filter((l) => l.phase === 'failed');
}

/** Every file with a record (the suites read it). @returns {FileLoad[]} */
export function allLoads() {
	return [...loads.values()].map((l) => ({ ...l, error: l.error ? { ...l.error } : null }));
}

/** for the suites: forget everything */
export function resetLoadsForTest() {
	loads.clear();
	bump();
}

// ---- what a placeholder shows ------------------------------------------------------------

/** visual states, as the shader reads them */
export const VIS_LOADING = 0;
export const VIS_STUCK = 1;
export const VIS_FAILED = 2;

/**
 * Loading / stuck (amber) / failed (red) for one file. Stuck = no byte for `stuckMs`, or an
 * attempt already failed and the next one is waiting out its backoff.
 * @param {FileLoad | null} load @param {number} now @param {number} stuckMs
 */
export function visualState(load, now, stuckMs) {
	if (!load) return VIS_LOADING;
	if (load.phase === 'failed') return VIS_FAILED;
	if (load.phase === 'waiting') return VIS_STUCK;
	if (load.phase === 'fetching' && now - load.lastByteAt >= stuckMs) return VIS_STUCK;
	return VIS_LOADING;
}

/**
 * The fill level: bytes / total, 1 once parsing, -1 when the size is unknown (the shader
 * draws an indeterminate sweep). A compressed response counts DECOMPRESSED bytes against a
 * compressed content-length, hence the clamp.
 * @param {FileLoad | null} load
 */
export function progressOf(load) {
	if (!load) return 0;
	if (load.phase === 'parsing') return 1;
	if (load.phase === 'failed' || load.phase === 'waiting') return load.total ? Math.min(1, load.loaded / load.total) : 0;
	if (!load.total) return load.loaded > 0 ? -1 : 0;
	return Math.min(1, load.loaded / load.total);
}

// ---- errors ------------------------------------------------------------------------------

/** A response that came back with an error status. */
export class HttpError extends Error {
	/** @param {number} status */
	constructor(status) {
		super('HTTP ' + status);
		this.status = status;
	}
}

/** The stream went silent for too long and the attempt was abandoned. */
export class StallError extends Error {
	/** @param {number} ms */
	constructor(ms) {
		super('no data for ' + Math.round(ms / 1000) + ' s');
		this.name = 'StallError';
	}
}

/** Short reasons per status a person can act on. @type {Record<number, string>} */
const STATUS_REASONS = {
	401: 'needs a login',
	403: 'access denied',
	404: 'file not found',
	410: 'file removed',
	408: 'the server timed out',
	429: 'too many requests',
	500: 'server error',
	502: 'bad gateway',
	503: 'server unavailable',
	504: 'gateway timeout'
};

/**
 * What went wrong, for the tooltip and the retry decision. A network error, a CORS refusal
 * (the browser reports both as the same TypeError), 408/429/5xx and a stall are worth
 * retrying; any other 4xx and a file that does not parse are not.
 * @param {any} error @returns {LoadError}
 */
export function describeLoadError(error) {
	if (error instanceof HttpError || (error && typeof error.status === 'number' && /^HTTP /.test(String(error.message)))) {
		const status = Number(error.status);
		const retryable = status === 408 || status === 429 || status >= 500;
		return { status, reason: STATUS_REASONS[status] ?? (status >= 500 ? 'server error' : 'request refused'), retryable };
	}
	if (error instanceof StallError || error?.name === 'StallError') return { status: 0, reason: 'the download stalled (' + error.message + ')', retryable: true };
	if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(error?.message))) {
		return { status: 0, reason: 'network error — offline, or blocked by CORS', retryable: true };
	}
	if (error?.name === 'AbortError') return { status: 0, reason: 'the download was cancelled', retryable: true };
	return { status: 0, reason: 'the file could not be read (' + String(error?.message || error || 'unknown').slice(0, 80) + ')', retryable: false };
}

/** One line for a tooltip. @param {FileLoad | null} load */
export function describeLoad(load) {
	if (!load) return 'Loading…';
	if (load.phase === 'failed' && load.error)
		return 'Failed: ' + load.error.reason + (load.error.status ? ' (HTTP ' + load.error.status + ')' : '') + ' — ' + load.url;
	if (load.phase === 'waiting' && load.error)
		return 'Retrying (' + load.error.reason + ') — attempt ' + (load.attempt + 2) + ' of ' + (RETRY_DELAYS.length + 1);
	if (load.phase === 'parsing') return 'Preparing…';
	const pct = progressOf(load);
	return 'Loading ' + (pct >= 0 ? Math.round(pct * 100) + '%' : formatBytes(load.loaded)) + ' — ' + load.url;
}

/** @param {number} n */
export function formatBytes(n) {
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
	return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** current setting values without a subscription (the frame loop reads these) */
export function currentStuckMs() {
	return get(placeholderStuckSeconds) * 1000;
}
