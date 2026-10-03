// 34 PF — FRAME COLUMNS WITHOUT A PER-FRAME ALLOCATION. The Quest budget rule is "no
// per-frame allocations in the hot path", and a recorder that pushed `{t, ms, calls, tris,
// quality}` objects would make one garbage object per frame for as long as it ran — the
// GC pause it eventually causes is exactly the kind of stall it exists to catch.
//
// So a track is COLUMNS of typed arrays. Two shapes over one implementation:
//   - a RING (fixed capacity, oldest overwritten) — the always-on light buffer that a
//     beacon window and "Report this moment" are cut from;
//   - a LOG (append, grows a CHUNK at a time, capped) — a user's recording.
// Objects are only built when somebody READS (`frames()`), i.e. on export/save, never per frame.
//
// Pure: no stores, no DOM, no clock — the caller passes every time. vitest drives it.
import { CPU_PHASES } from './tpprof.js';

const CHUNK = 4096;
const NO_VALUE = -1;

/**
 * @param {{capacity: number, ring?: boolean, cpu?: boolean}} opts
 *   capacity: a ring's size, or a log's hard cap (frames past it are refused, `full` turns true)
 *   cpu: keep a CPU-phase column per phase (detailed mode)
 */
export function createTrack({ capacity, ring = false, cpu = false }) {
	/** @type {{t: Float64Array, ms: Float32Array, calls: Int32Array, tris: Int32Array, quality: Int8Array, gpu: Float32Array, cpu: Float32Array[] | null}[]} */
	const chunks = [];
	const chunkSize = ring ? capacity : Math.min(CHUNK, capacity);
	let written = 0; // frames ever pushed (a ring keeps the last `capacity` of them)
	let full = false;

	function newChunk() {
		const n = chunkSize;
		chunks.push({
			t: new Float64Array(n),
			ms: new Float32Array(n),
			calls: new Int32Array(n),
			tris: new Int32Array(n),
			quality: new Int8Array(n),
			gpu: new Float32Array(n),
			cpu: cpu ? CPU_PHASES.map(() => new Float32Array(n)) : null
		});
	}
	newChunk();

	/** where frame number `i` (0-based, ever pushed) lives @param {number} i */
	function slot(i) {
		if (ring) return { c: chunks[0], j: i % capacity };
		return { c: chunks[Math.floor(i / chunkSize)], j: i % chunkSize };
	}

	return {
		/**
		 * One frame. `calls`/`tris`/`quality` may be null (not measured). `cpuMs` is read
		 * (copied), never kept. Returns false when a LOG is full.
		 * @param {number} t @param {number} ms @param {number | null} calls @param {number | null} tris
		 * @param {number | null} quality @param {ArrayLike<number> | null} [cpuMs] @param {number | null} [gpuMs]
		 */
		push(t, ms, calls, tris, quality, cpuMs = null, gpuMs = null) {
			if (!ring && written >= capacity) {
				full = true;
				return false;
			}
			if (!ring && written > 0 && written % chunkSize === 0) newChunk();
			const i = ring ? written % capacity : written % chunkSize;
			const c = ring ? chunks[0] : chunks[chunks.length - 1];
			c.t[i] = t;
			c.ms[i] = ms;
			c.calls[i] = calls === null || calls === undefined ? NO_VALUE : calls;
			c.tris[i] = tris === null || tris === undefined ? NO_VALUE : tris;
			c.quality[i] = quality === null || quality === undefined ? NO_VALUE : quality;
			c.gpu[i] = gpuMs === null || gpuMs === undefined ? NO_VALUE : gpuMs;
			if (c.cpu) for (let p = 0; p < c.cpu.length; p++) c.cpu[p][i] = cpuMs ? cpuMs[p] || 0 : NO_VALUE;
			written++;
			return true;
		},
		/** frames held right now */
		get length() {
			return ring ? Math.min(written, capacity) : written;
		},
		/** a LOG that refused a frame because it reached its cap */
		get full() {
			return full;
		},
		/** the oldest HELD frame's time, or null */
		get firstT() {
			if (!written) return null;
			const n = ring ? Math.min(written, capacity) : written;
			const { c, j } = slot(written - n);
			return c.t[j];
		},
		/** the newest frame's time, or null */
		get lastT() {
			if (!written) return null;
			const { c, j } = slot(written - 1);
			return c.t[j];
		},
		/**
		 * The held frames with from < t <= to, as T1 frame objects (oldest first). Values are
		 * rounded for the file (ms to 0.1, t to 0.1) — the format's precision, not the track's.
		 * @param {number} [from] @param {number} [to]
		 * @returns {import('./tpprof.js').TpFrame[]}
		 */
		frames(from = -Infinity, to = Infinity) {
			const out = [];
			const n = ring ? Math.min(written, capacity) : written;
			const first = written - n;
			for (let k = first; k < written; k++) {
				const { c, j } = slot(k);
				const t = c.t[j];
				if (!(t > from && t <= to)) continue;
				/** @type {any} */
				const f = { t: Math.round(t * 10) / 10, ms: Math.round(c.ms[j] * 10) / 10 };
				f.calls = c.calls[j] === NO_VALUE ? null : c.calls[j];
				f.tris = c.tris[j] === NO_VALUE ? null : c.tris[j];
				f.quality = c.quality[j] === NO_VALUE ? null : c.quality[j];
				if (c.gpu[j] !== NO_VALUE) f.gpu = Math.round(c.gpu[j] * 100) / 100;
				if (c.cpu && c.cpu[0][j] !== NO_VALUE) {
					/** @type {Record<string, number>} */
					const cpuOut = {};
					for (let p = 0; p < c.cpu.length; p++) cpuOut[CPU_PHASES[p]] = Math.round(c.cpu[p][j] * 100) / 100;
					f.cpu = cpuOut;
				}
				out.push(f);
			}
			return out;
		},
		/** forget everything (keeps the first chunk's memory) */
		clear() {
			chunks.length = 1;
			written = 0;
			full = false;
		}
	};
}

/** @typedef {ReturnType<typeof createTrack>} Track */
