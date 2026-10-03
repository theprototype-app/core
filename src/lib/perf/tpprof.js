// 34 R1/PF — THE PERF FORMAT (contract T1). One shape for a profiler recording (light or
// detailed), a beacon report (a light recording's 10-s window — the same keys) and a
// "Report this moment" (30 s of light data + a note + the eye-view screenshot). The JSON
// Schema beside this file (`tpprof.schema.json`) is the published contract; THIS file is
// its executable half: the validator, the derived summary, windowing and the `.tpprof`
// file encoding (gzip).
//
// A DELIBERATE LEAF apart from fflate (pure JS, already a dependency): the profiler UI,
// the beacon, the cloud's perf-reports script and the unit layer all read it, so it
// must never reach a store or the scene. Every function is pure over its arguments.
//
// FORWARD COMPATIBLE BY RULE: an unknown key anywhere is KEPT and never an error (a newer
// app's recording opens in an older profiler); a KNOWN key of the wrong type is an error.
// `validateTpprof` reports every problem with a JSON-pointer-ish path rather than stopping
// at the first, so a consumer can say what is wrong with a file someone handed it.
import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';

/** The format version this build writes and the only one it reads. */
export const TPPROF_VERSION = 1;

/** The file extension of an exported recording (gzip of the JSON). */
export const TPPROF_EXT = '.tpprof';

/** Event kinds this build emits. Any other string is legal and drawn as a generic marker. */
export const EVENT_KINDS = Object.freeze([
	'scene-load',
	'teleport',
	'grab',
	'menu',
	'stall',
	'quality',
	'xr-start',
	'xr-end',
	'mode',
	'capture',
	'moment',
	'mark',
	'stale-module'
]);

/** The CPU phases a detailed recording measures (frame.cpu / capture.cpu keys). */
export const CPU_PHASES = Object.freeze(['input', 'physics', 'modules', 'flow', 'render', 'other']);

/** A frame longer than this is a STALL (an event with what was happening). */
export const STALL_MS = 100;

/** The beacon's window length and the moment report's look-back. */
export const WINDOW_MS = 10000;
export const MOMENT_MS = 30000;

/** Server-side caps the beacon must stay inside (cloud pb_hooks/perf-lib.js LIMITS). */
export const REPORT_LIMITS = Object.freeze({
	sample: { frames: 1500, bytes: 196608 },
	stall: { frames: 1500, bytes: 196608 },
	moment: { frames: 4500, bytes: 524288 }
});

const isObj = (/** @type {any} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
const count = (/** @type {any} */ v) => finite(v) && v >= 0 && Math.floor(v) === v;
const nullable = (/** @type {any} */ v) => v === null || v === undefined;

/**
 * @typedef {{t: number, ms: number, calls?: number | null, tris?: number | null, quality?: number | null, cpu?: Record<string, number>, gpu?: number}} TpFrame
 * @typedef {{t: number, kind: string, detail?: any}} TpEvent
 * @typedef {{uuid: string, name?: string, path?: string, module?: string | null, calls: number, tris: number, material?: string, shadow?: boolean, transparent?: boolean, ms?: number}} TpDrawn
 * @typedef {{t: number, frames?: number, objects: TpDrawn[], cpu?: Record<string, number>, memory?: Record<string, number | null>}} TpCapture
 * @typedef {{t: number, text?: string, screenshot?: string}} TpNote
 * @typedef {{build: string, version: string, modules: Record<string, string>, device: string, gpu?: string | null, xr: boolean, refreshRate?: number | null, framebufferScale?: number | null, scene?: string | null, game?: string | null, startedAt: number, mode: 'light' | 'detailed', name?: string, pinned?: boolean, durationMs?: number, session?: string, kind?: string, gpuTimer?: boolean}} TpMeta
 * @typedef {{tpprof: 1, meta: TpMeta, frames: TpFrame[], events: TpEvent[], captures?: TpCapture[], notes?: TpNote[], summary?: Record<string, any>}} Tpprof
 */

/**
 * Check a document against T1. Never throws.
 * @param {any} doc
 * @param {{report?: 'sample' | 'stall' | 'moment'}} [opts] `report`: also hold it to what the
 *   beacon endpoint accepts for that kind (light only, no captures, frame cap, notes only on a moment)
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTpprof(doc, opts = {}) {
	/** @type {string[]} */
	const errors = [];
	const err = (/** @type {string} */ path, /** @type {string} */ msg) => {
		if (errors.length < 50) errors.push(`${path}: ${msg}`);
	};
	if (!isObj(doc)) return { ok: false, errors: ['/: not an object'] };
	if (doc.tpprof !== TPPROF_VERSION) err('/tpprof', `must be ${TPPROF_VERSION}`);

	const meta = doc.meta;
	if (!isObj(meta)) err('/meta', 'required object');
	else {
		for (const k of ['build', 'version', 'device']) if (typeof meta[k] !== 'string') err(`/meta/${k}`, 'required string');
		if (!isObj(meta.modules)) err('/meta/modules', 'required {id: version}');
		else for (const [id, v] of Object.entries(meta.modules)) if (typeof v !== 'string') err(`/meta/modules/${id}`, 'version must be a string');
		if (typeof meta.xr !== 'boolean') err('/meta/xr', 'required boolean');
		if (!finite(meta.startedAt)) err('/meta/startedAt', 'required epoch ms');
		if (meta.mode !== 'light' && meta.mode !== 'detailed') err('/meta/mode', "must be 'light' or 'detailed'");
		for (const k of ['refreshRate', 'framebufferScale', 'durationMs']) if (!nullable(meta[k]) && !(finite(meta[k]) && meta[k] >= 0)) err(`/meta/${k}`, 'number >= 0 or null');
		for (const k of ['scene', 'game', 'gpu', 'name', 'session', 'kind']) if (!nullable(meta[k]) && typeof meta[k] !== 'string') err(`/meta/${k}`, 'string or null');
		for (const k of ['pinned', 'gpuTimer']) if (!nullable(meta[k]) && typeof meta[k] !== 'boolean') err(`/meta/${k}`, 'boolean');
	}

	if (!Array.isArray(doc.frames)) err('/frames', 'required array');
	else
		doc.frames.forEach((/** @type {any} */ f, /** @type {number} */ i) => {
			const p = `/frames/${i}`;
			if (!isObj(f)) return err(p, 'not an object');
			if (!finite(f.t)) err(`${p}/t`, 'required number');
			if (!finite(f.ms) || f.ms < 0) err(`${p}/ms`, 'required number >= 0');
			for (const k of ['calls', 'tris', 'quality']) if (!nullable(f[k]) && !count(f[k])) err(`${p}/${k}`, 'integer >= 0 or null');
			if (!nullable(f.cpu)) {
				if (!isObj(f.cpu)) err(`${p}/cpu`, '{phase: ms}');
				else for (const [k, v] of Object.entries(f.cpu)) if (!(finite(v) && v >= 0)) err(`${p}/cpu/${k}`, 'ms >= 0');
			}
			if (!nullable(f.gpu) && !(finite(f.gpu) && f.gpu >= 0)) err(`${p}/gpu`, 'ms >= 0');
		});

	if (!Array.isArray(doc.events)) err('/events', 'required array');
	else
		doc.events.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
			const p = `/events/${i}`;
			if (!isObj(e)) return err(p, 'not an object');
			if (!finite(e.t)) err(`${p}/t`, 'required number');
			if (typeof e.kind !== 'string' || !e.kind || e.kind.length > 40) err(`${p}/kind`, 'string, 1-40 chars');
		});

	if (!nullable(doc.captures)) {
		if (!Array.isArray(doc.captures)) err('/captures', 'array');
		else
			doc.captures.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
				const p = `/captures/${i}`;
				if (!isObj(c)) return err(p, 'not an object');
				if (!finite(c.t)) err(`${p}/t`, 'required number');
				if (!Array.isArray(c.objects)) return err(`${p}/objects`, 'required array');
				c.objects.forEach((/** @type {any} */ o, /** @type {number} */ j) => {
					const q = `${p}/objects/${j}`;
					if (!isObj(o)) return err(q, 'not an object');
					if (typeof o.uuid !== 'string') err(`${q}/uuid`, 'required string');
					for (const k of ['calls', 'tris']) if (!(finite(o[k]) && o[k] >= 0)) err(`${q}/${k}`, 'required number >= 0');
					if (!nullable(o.ms) && !(finite(o.ms) && o.ms >= 0)) err(`${q}/ms`, 'number >= 0');
					for (const k of ['shadow', 'transparent']) if (!nullable(o[k]) && typeof o[k] !== 'boolean') err(`${q}/${k}`, 'boolean');
				});
			});
	}

	if (!nullable(doc.notes)) {
		if (!Array.isArray(doc.notes)) err('/notes', 'array');
		else
			doc.notes.forEach((/** @type {any} */ n, /** @type {number} */ i) => {
				const p = `/notes/${i}`;
				if (!isObj(n)) return err(p, 'not an object');
				if (!finite(n.t)) err(`${p}/t`, 'required number');
				if (!nullable(n.text) && (typeof n.text !== 'string' || n.text.length > 1000)) err(`${p}/text`, 'string <= 1000 chars');
				if (!nullable(n.screenshot) && typeof n.screenshot !== 'string') err(`${p}/screenshot`, 'string');
			});
	}

	if (opts.report) {
		const lim = REPORT_LIMITS[opts.report];
		if (!lim) err('/', `unknown report kind ${opts.report}`);
		else {
			if (isObj(meta) && meta.mode !== 'light') err('/meta/mode', 'a report is a light recording');
			if (!nullable(doc.captures)) err('/captures', 'a report carries no captures');
			if (Array.isArray(doc.frames) && doc.frames.length > lim.frames) err('/frames', `at most ${lim.frames} for a ${opts.report}`);
			if (!nullable(doc.notes) && opts.report !== 'moment') err('/notes', 'only a moment carries notes');
			if (Array.isArray(doc.events) && doc.events.length > 300) err('/events', 'at most 300');
			if (Array.isArray(doc.notes)) doc.notes.forEach((/** @type {any} */ n, /** @type {number} */ i) => {
				if (typeof n?.screenshot === 'string' && n.screenshot.length > 200) err(`/notes/${i}/screenshot`, 'a report names its screenshot; the image is a separate file');
			});
		}
	}
	return { ok: errors.length === 0, errors };
}

/** nearest-rank percentile of an ASCENDING array (the cloud script's definition). @param {number[]} sorted @param {number} p 0..100 */
export function percentile(sorted, p) {
	if (!sorted.length) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round1 = (/** @type {number | null} */ v) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * The derived numbers a reader wants first. Pure; never trusted from a file (recompute).
 * `fpsP5` is 1000 / p95 frame ms — the slow end, the number that matters on a headset.
 * @param {Pick<Tpprof, 'frames' | 'events'>} doc
 */
export function summarize(doc) {
	const frames = Array.isArray(doc?.frames) ? doc.frames : [];
	const ms = frames.map((f) => f.ms).filter(finite).sort((a, b) => a - b);
	const calls = frames.map((f) => f.calls).filter(finite).sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b));
	const tris = frames.map((f) => f.tris).filter(finite).sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b));
	const p50 = percentile(ms, 50);
	const p95 = percentile(ms, 95);
	const first = frames.length ? frames[0].t - frames[0].ms : 0;
	const last = frames.length ? frames[frames.length - 1].t : 0;
	return {
		frames: frames.length,
		durationMs: Math.max(0, Math.round(last - first)),
		fpsP50: p50 ? round1(1000 / p50) : null,
		fpsP5: p95 ? round1(1000 / p95) : null,
		msP50: round1(p50),
		msP95: round1(p95),
		msP99: round1(percentile(ms, 99)),
		msMax: round1(ms.length ? ms[ms.length - 1] : null),
		callsP50: /** @type {number | null} */ (percentile(/** @type {number[]} */ (calls), 50)),
		callsMax: calls.length ? /** @type {number} */ (calls[calls.length - 1]) : null,
		trisP50: /** @type {number | null} */ (percentile(/** @type {number[]} */ (tris), 50)),
		trisMax: tris.length ? /** @type {number} */ (tris[tris.length - 1]) : null,
		stalls: (Array.isArray(doc?.events) ? doc.events : []).filter((e) => e?.kind === 'stall').length
	};
}

/**
 * The part of a recording between two times (ms since startedAt), RE-BASED so the window
 * starts at 0 and its meta.startedAt is the window's own wall-clock start. Captures and notes
 * inside the window ride along; the result is a valid T1 document of the same mode.
 * This is how a beacon sample and a moment report are cut from the light ring.
 * @param {Tpprof} doc @param {number} from @param {number} to @param {Partial<TpMeta>} [metaPatch]
 * @returns {Tpprof}
 */
export function windowOf(doc, from, to, metaPatch = {}) {
	const inside = (/** @type {{t: number}} */ x) => x.t > from && x.t <= to;
	const shift = (/** @type {any} */ x) => ({ ...x, t: Math.round((x.t - from) * 10) / 10 });
	/** @type {Tpprof} */
	const out = {
		tpprof: TPPROF_VERSION,
		meta: { ...doc.meta, startedAt: Math.round(doc.meta.startedAt + from), durationMs: Math.max(0, Math.round(to - from)), ...metaPatch },
		frames: doc.frames.filter(inside).map(shift),
		events: doc.events.filter(inside).map(shift)
	};
	if (doc.captures) {
		const c = doc.captures.filter(inside).map(shift);
		if (c.length) out.captures = c;
	}
	if (doc.notes) {
		const n = doc.notes.filter(inside).map(shift);
		if (n.length) out.notes = n;
	}
	return out;
}

/**
 * A recording as `.tpprof` bytes (gzip of the JSON; the summary is written alongside so a
 * reader without the maths still has the headline).
 * @param {Tpprof} doc @returns {Uint8Array}
 */
export function encodeTpprof(doc) {
	return gzipSync(strToU8(JSON.stringify({ ...doc, summary: summarize(doc) })), { level: 6 });
}

/**
 * Bytes or text back to a document. Accepts the gzip `.tpprof` AND plain JSON (a beacon
 * export, a hand-edited file). Throws with a readable message when it is neither or when
 * the document fails `validateTpprof`.
 * @param {Uint8Array | ArrayBuffer | string} input @returns {Tpprof}
 */
export function decodeTpprof(input) {
	let text;
	if (typeof input === 'string') text = input;
	else {
		const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
		text = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b ? strFromU8(gunzipSync(bytes)) : strFromU8(bytes);
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new Error('Not a performance recording (the file is neither gzip nor JSON)');
	}
	const { ok, errors } = validateTpprof(doc);
	if (!ok) throw new Error('Not a valid performance recording: ' + errors.slice(0, 3).join('; '));
	return /** @type {Tpprof} */ (doc);
}
