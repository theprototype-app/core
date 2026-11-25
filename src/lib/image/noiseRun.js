// 105-noise — RUNNING THE NOISE OFF THE PAGE. The image editor has no GPU path (it is canvas 2D over plain rasters,
// imageOps.js), so the brief's other branch applies: a worker. A 2048 fill is about a second of arithmetic, so it is
// split by ROWS over a small pool (up to 4 workers, one core left for the page) and stitched back — a band is
// byte-identical to the same rows of the whole (noiseCore, unit-checked), so the split changes nothing but the wait.
// What the page itself does per fill: slice the base into bands (a copy, transferred) and `set` the results back in
// — a few milliseconds at 2048, far inside the 100 ms long-task budget.
//
// The live PREVIEW runs the same thing at a small size (the noise is defined in 0..1 image space, so a 512 preview
// is the same picture as the 2048 fill), latest-wins: an answer for an older request is dropped. Its base is shrunk
// in a worker too, once per working image.
//
// No Worker (vitest, a very old browser): the same functions on the page. The pool closes itself after a minute idle.
import { noiseRaster } from './noiseCore.js';
import { resizeRaster, fitSize } from './imageOps.js';

/** @typedef {import('./noiseCore.js').Raster} Raster */

/** test seam (the decimate.js shape) */
export let makeWorker = () => new Worker(new URL('./noise.worker.js', import.meta.url), { type: 'module' });
/** @param {() => Worker} fn */
export function setNoiseWorkerFactory(fn) {
	makeWorker = fn;
	closeNoisePool();
}

const IDLE_MS = 60_000;
/** a band is at least this many rows: below it the message overhead beats the split */
const MIN_BAND_ROWS = 32;

/** @type {{worker: Worker, busy: number}[]} */
let pool = [];
let nextId = 1;
/** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */
const waiting = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let idleTimer = null;
/** the last fill's timings, for the evidence and the debug pill: {ms, bands, workerMs} */
export let lastNoiseRun = { ms: 0, bands: 0, workerMs: 0 };

function poolSize() {
	const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
	return Math.max(1, Math.min(4, cores - 1));
}

function workersAvailable() {
	return typeof Worker !== 'undefined';
}

function ensurePool() {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(closeNoisePool, IDLE_MS);
	if (pool.length) return pool;
	const n = poolSize();
	for (let i = 0; i < n; i++) {
		const worker = makeWorker();
		worker.onmessage = (event) => {
			const msg = event.data ?? {};
			const job = waiting.get(msg.id);
			if (!job) return;
			waiting.delete(msg.id);
			if (msg.error) job.reject(new Error(msg.error));
			else job.resolve(msg);
		};
		worker.onerror = (event) => {
			// a worker that cannot start (blocked, a bad build): fail every job it holds, and rebuild next time
			event.preventDefault?.();
			for (const [id, job] of waiting) (waiting.delete(id), job.reject(new Error(event?.message || 'the noise worker failed')));
			closeNoisePool();
		};
		pool.push({ worker, busy: 0 });
	}
	return pool;
}

/** stop every worker (idle, or a test) */
export function closeNoisePool() {
	for (const p of pool) p.worker.terminate();
	pool = [];
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = null;
}

/** @param {any} msg @param {Transferable[]} transfer @returns {Promise<any>} */
function post(msg, transfer) {
	const slots = ensurePool();
	const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
	const id = nextId++;
	slot.busy++;
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		slot.worker.postMessage({ ...msg, id }, transfer);
	}).finally(() => {
		slot.busy--;
	});
}

/**
 * A noise fill at full size: `base` given = blended over it (its size wins), else `width` x `height` of noise.
 * Never mutates `base`. @param {any} options @param {{width?: number, height?: number, base?: Raster | null}} size
 * @returns {Promise<Raster>}
 */
export async function renderNoise(options, size) {
	const t = performance.now();
	const base = size.base ?? null;
	const width = Math.max(1, Math.round(base ? base.width : size.width ?? 1));
	const height = Math.max(1, Math.round(base ? base.height : size.height ?? 1));
	if (!workersAvailable()) {
		const r = noiseRaster(options, { width, height, base });
		lastNoiseRun = { ms: performance.now() - t, bands: 0, workerMs: 0 };
		return r;
	}
	const bands = Math.max(1, Math.min(poolSize(), Math.floor(height / MIN_BAND_ROWS)));
	/** @type {[number, number][]} */
	const spans = [];
	for (let b = 0; b < bands; b++) spans.push([Math.floor((b * height) / bands), Math.floor(((b + 1) * height) / bands)]);
	const parts = await Promise.all(
		spans.map(([y0, y1]) => {
			const slice = base ? base.data.slice(y0 * width * 4, y1 * width * 4) : null;
			return post(
				{ op: 'noise', options, width, height, y0, y1, base: slice ? { width, height: y1 - y0, data: slice } : null },
				slice ? [slice.buffer] : []
			);
		})
	);
	const data = new Uint8ClampedArray(width * height * 4);
	let workerMs = 0;
	parts.forEach((part, i) => {
		data.set(part.data, spans[i][0] * width * 4);
		workerMs = Math.max(workerMs, part.ms ?? 0);
	});
	lastNoiseRun = { ms: performance.now() - t, bands, workerMs };
	return { width, height, data };
}

/**
 * The preview's base: `raster` fitted inside maxSide, shrunk in a worker (never on the page past 512 px).
 * @param {Raster} raster @param {number} maxSide @returns {Promise<Raster>}
 */
export async function shrinkForPreview(raster, maxSide) {
	const fit = fitSize(raster.width, raster.height, maxSide, maxSide);
	if (fit.scale >= 1) return raster;
	if (!workersAvailable()) return resizeRaster(raster, fit.width, fit.height);
	const copy = raster.data.slice();
	const r = await post({ op: 'shrink', maxSide, base: { width: raster.width, height: raster.height, data: copy } }, [copy.buffer]);
	return { width: r.width, height: r.height, data: r.data };
}

let previewToken = 0;
/**
 * Latest-wins preview: resolves with the raster, or null when a newer request overtook this one.
 * @param {any} options @param {{width?: number, height?: number, base?: Raster | null}} size
 * @returns {Promise<Raster | null>}
 */
export async function previewNoise(options, size) {
	const token = ++previewToken;
	const r = await renderNoise(options, size);
	return token === previewToken ? r : null;
}
/** drop any preview still in flight */
export function cancelNoisePreview() {
	previewToken++;
}
