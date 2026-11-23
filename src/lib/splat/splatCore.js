// 102-splats (roadmap 102 M5) — GAUSSIAN SPLATS, the PURE half (imports NOTHING).
//
// A splat object is an ordinary mesh in objectsGroup (the CARRIER, splatObject.js) holding
// `userData.splat`, the record below. The scan itself is an Explorer file addressed by its content
// hash (.ply / .spz / .splat), drawn by Spark (@sparkjsdev/spark, a lazy chunk) at the scene root and
// glued to the carrier every frame (splatRuntime.js). The record is what replicates, saves and undoes;
// the bytes ride the Library like every other asset (25 MB cap, explorer.js MAX_ITEM_BYTES).

/** the file extensions a splat may come in */
export const SPLAT_EXT = /\.(ply|spz|splat)$/i;

/** the Library's one-file cap (explorer.js MAX_ITEM_BYTES, the peer-share limit) — duplicated so this stays a leaf */
export const SPLAT_CAP_BYTES = 25 * 1024 * 1024;

/** a file above this is refused before it is read at all (a browser tab cannot hold more comfortably) */
export const SPLAT_MAX_INPUT_BYTES = 768 * 1024 * 1024;

/** reduce-to-fit never keeps fewer than this share of the splats: below it the scan is not itself any more */
export const SPLAT_MIN_KEEP = 0.2;

/**
 * @typedef {{hash: string, file: string, count: number, sh: number, bounds: number[], crop: number[] | null, opacity: number}} SplatRecord
 * bounds = [minX, minY, minZ, maxX, maxY, maxZ] in the carrier's own space (the splat file's space);
 * crop = the same shape, or null for no crop box.
 */

/** @type {Readonly<SplatRecord>} */
export const SPLAT_DEFAULTS = Object.freeze({ hash: '', file: '', count: 0, sh: 0, bounds: [-1, -1, -1, 1, 1, 1], crop: null, opacity: 1 });

/** @param {any} v @param {number} d */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A box as six finite numbers with min <= max per axis, or null.
 * @param {any} b @returns {number[] | null}
 */
export function normalizeBox(b) {
	if (!Array.isArray(b) || b.length !== 6 || !b.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
	return [Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]), Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])];
}

/**
 * The ONE boundary for a splat record: every store, wire and file read goes through it. Unknown
 * fields are kept (a newer peer's additions survive our edits).
 * @param {any} rec @returns {SplatRecord & Record<string, any>}
 */
export function normalizeSplat(rec) {
	const r = rec && typeof rec === 'object' ? rec : {};
	const bounds = normalizeBox(r.bounds) ?? [...SPLAT_DEFAULTS.bounds];
	return {
		...r,
		hash: typeof r.hash === 'string' ? r.hash : '',
		file: typeof r.file === 'string' ? r.file.slice(0, 200) : '',
		count: Math.max(0, Math.round(num(r.count, 0))),
		sh: Math.max(0, Math.min(3, Math.round(num(r.sh, 0)))),
		bounds,
		crop: r.crop == null ? null : normalizeBox(r.crop),
		opacity: Math.max(0, Math.min(1, num(r.opacity, 1)))
	};
}

/**
 * The PLY header as text (up to and including `end_header`), or null when the bytes are not a PLY.
 * @param {Uint8Array} bytes @returns {string | null}
 */
export function readPlyHeader(bytes) {
	if (!bytes || bytes.length < 4 || bytes[0] !== 0x70 || bytes[1] !== 0x6c || bytes[2] !== 0x79) return null; // "ply"
	const max = Math.min(bytes.length, 65536);
	let text = '';
	for (let i = 0; i < max; i++) {
		text += String.fromCharCode(bytes[i]);
		if (text.endsWith('end_header')) return text;
	}
	return null;
}

/**
 * What a PLY holds: a 3D Gaussian splat (the 3DGS layout, or PlayCanvas's compressed chunks), a
 * plain mesh / point cloud, or something unreadable.
 * @param {string | null} header @returns {'gaussian' | 'mesh' | 'unknown'}
 */
export function plyKind(header) {
	if (!header) return 'unknown';
	const props = new Set([...header.matchAll(/^property\s+\S+\s+(\S+)\s*$/gm)].map((m) => m[1]));
	if (/^element\s+chunk\s/m.test(header) && props.has('packed_position')) return 'gaussian';
	if (props.has('f_dc_0') && props.has('opacity') && props.has('scale_0') && props.has('rot_0')) return 'gaussian';
	return /^element\s+vertex\s/m.test(header) ? 'mesh' : 'unknown';
}

/** SPZ bytes per splat for the SH coefficients of each degree (one byte each, three colours) */
const SPZ_SH_BYTES = [0, 9, 24, 45];

/**
 * A size estimate for N splats written as .spz (positions 24-bit, alpha, colour, scale, rotation
 * = ~20 bytes, plus the SH bytes, gzipped ~0.9x). Pure arithmetic; good to ~20 %.
 * @param {number} count @param {number} sh
 */
export function spzBytesFor(count, sh) {
	return Math.round(Math.max(0, count) * (20 + (SPZ_SH_BYTES[Math.max(0, Math.min(3, sh))] ?? 0)) * 0.9);
}

/**
 * Reduce to fit: the ladder an over-cap file is offered, smallest change first. Each step keeps
 * everything the step before kept. `keep` is the share of splats kept (1 = all).
 *   spz       convert to .spz, nothing dropped
 *   sh        convert, and drop the colour-by-view (spherical-harmonic) bands
 *   decimate  convert, drop the bands, and keep a share of the splats (the most opaque first)
 * `fits: false` with a `why` = refuse. The reducer re-checks the REAL size after writing.
 * @param {{bytes: number, count: number, sh: number}} f @param {number} [cap]
 * @returns {{step: 'none'|'spz'|'sh'|'decimate', keep: number, sh: number, estimate: number, fits: boolean, why?: string}}
 */
export function reducePlan(f, cap = SPLAT_CAP_BYTES) {
	const count = Math.max(0, f.count | 0);
	const target = cap * 0.92; // headroom for the estimate's error
	if (f.bytes <= cap) return { step: 'none', keep: 1, sh: f.sh, estimate: f.bytes, fits: true };
	if (!count) return { step: 'none', keep: 1, sh: f.sh, estimate: f.bytes, fits: false, why: 'The file holds no splats.' };
	const full = spzBytesFor(count, f.sh);
	if (full <= target) return { step: 'spz', keep: 1, sh: f.sh, estimate: full, fits: true };
	const flat = spzBytesFor(count, 0);
	if (flat <= target) return { step: 'sh', keep: 1, sh: 0, estimate: flat, fits: true };
	const keep = Math.floor((target / flat) * 1000) / 1000;
	if (keep < SPLAT_MIN_KEEP)
		return {
			step: 'decimate',
			keep,
			sh: 0,
			estimate: Math.round(flat * keep),
			fits: false,
			why: `It would keep only ${Math.round(keep * 100)} % of its ${count.toLocaleString('en')} splats to fit the 25 MB file limit. Cut it down in a splat editor first (crop or simplify), then import it again.`
		};
	return { step: 'decimate', keep, sh: 0, estimate: Math.round(flat * keep), fits: true };
}

/**
 * Which splats to keep when decimating: the most opaque first (a faint splat costs as much as a solid
 * one and shows least), ties by index so every run keeps the same set.
 * @param {ArrayLike<number>} opacities @param {number} keep share 0..1
 * @returns {Uint32Array} kept indices, ascending
 */
export function decimateOrder(opacities, keep) {
	const n = opacities.length;
	const want = Math.max(1, Math.min(n, Math.round(n * keep)));
	const idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	const sorted = Array.from(idx).sort((a, b) => opacities[b] - opacities[a] || a - b);
	return Uint32Array.from(sorted.slice(0, want)).sort();
}

/**
 * How many splats a device draws before the splat objects stand down with a notice. A headset
 * renders two eyes at 72-90 Hz on a phone GPU; the PC is limited by memory, not a budget.
 * @param {'pc'|'phone'|'quest'} tier
 */
export function splatBudget(tier) {
	if (tier === 'quest') return 1_000_000;
	if (tier === 'phone') return 2_000_000;
	return Infinity;
}

/**
 * Which splat objects draw within a budget: in scene order, each whole object fits or stands down
 * (a half-drawn scan reads as broken).
 * @param {{uuid: string, count: number}[]} objs @param {number} budget
 * @returns {{shown: Set<string>, hidden: string[], total: number}}
 */
export function withinBudget(objs, budget) {
	const shown = new Set();
	/** @type {string[]} */
	const hidden = [];
	let total = 0;
	for (const o of objs) {
		if (total + o.count <= budget) {
			shown.add(o.uuid);
			total += o.count;
		} else hidden.push(o.uuid);
	}
	return { shown, hidden, total };
}

/** "1.2 M splats" / "840 k splats" / "12 splats" @param {number} n */
export function splatCountText(n) {
	if (n >= 1e6) return (Math.round(n / 1e5) / 10).toLocaleString('en') + ' M splats';
	if (n >= 1e4) return Math.round(n / 1e3).toLocaleString('en') + ' k splats';
	return n.toLocaleString('en') + (n === 1 ? ' splat' : ' splats');
}

/** "24.5 MB" @param {number} bytes */
export function mbText(bytes) {
	return (Math.round((bytes / 1048576) * 10) / 10).toLocaleString('en') + ' MB';
}
