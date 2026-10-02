// 33 — THE LOD GROUP RULE. PURE and import-free, the lodCore.js shape: what a per-object
// `userData.lod` block may hold, which level a group draws for a given screen size, and how
// a pack item's `lods` row becomes a block. The runtime (`lodGroup.js`) owns the geometry,
// the fetches and the render-time swap; this file is arithmetic, so vitest drives it.
//
// THE MODEL IS UNITY'S LOD GROUP. Each level carries a `screenSize` — the share of the
// viewport HEIGHT the object's bounding sphere covers — and level i draws while the object
// is at least that big. Going coarser happens at the threshold; coming back finer needs the
// size back ABOVE it by `hysteresis` of it, so an object sitting on an edge while the camera
// bobs does not pop every frame (the "flickers only while moving" signature). The LAST
// level's threshold is the cull height and only means something when `cull` is on.
//
// Screen size, not distance in radii (31-perf's auto rule): a person tuning a group reads
// "draw the low level once it is a tenth of the screen", which is what every DCC shows on
// its LOD bar, and it already folds in the lens (a headset's wide eye makes everything
// smaller, so it steps down sooner — the right way round for a Quest).

/** @typedef {'self' | 'pack' | 'generated' | 'explorer' | 'object'} LodSource */
/**
 * @typedef {{pos?: number[], rot?: number[], scale?: number[]}} LodOffset
 * @typedef {{color?: string, roughness?: number, metalness?: number}} LodMaterial
 * @typedef {{source: LodSource, ref?: string, name?: string, ratio?: number, screenSize: number,
 *   offset?: LodOffset, material?: LodMaterial}} LodLevel
 * @typedef {{mode: 'auto' | 'forced', forced?: number, bias?: number, cull?: boolean, levels: LodLevel[]}} LodGroup
 */

export const LOD_SOURCES = ['self', 'pack', 'generated', 'explorer', 'object'];

/** The most levels a group may hold (LOD0 included) — a bar with more is unreadable, and
 * no real asset ships more than four. */
export const MAX_LEVELS = 6;

/** Going finer needs the size back above the threshold by this share of it. */
export const LOD_HYSTERESIS = 0.15;

/** Thresholds never come closer than this (a zero-width segment cannot be dragged back). */
export const MIN_GAP = 0.005;

/** Default thresholds for a group of `n` levels: LOD0 until 25% of the screen height, LOD1
 * until 10%, then each level until 40% of the previous. 25% / 10% are ALSO the sizes the pack
 * tool (33-pack-fix-lod) renders its no-visible-pop gate at, so keep them in step.
 * @param {number} n @returns {number[]} */
export function defaultScreenSizes(n) {
	/** @type {number[]} */
	const out = [];
	let s = 0.25;
	for (let i = 0; i < n; i++) {
		out.push(Number(s.toFixed(4)));
		s *= 0.4;
	}
	return out;
}

/** @param {any} v @param {number} lo @param {number} hi */
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {any} a @param {number} n */
const vecOf = (a, n) => (Array.isArray(a) && a.length >= n && a.slice(0, n).every(finite) ? a.slice(0, n).map(Number) : null);

/** @param {any} o @returns {LodOffset | undefined} */
function normalizeOffset(o) {
	if (!o || typeof o !== 'object') return undefined;
	const pos = vecOf(o.pos, 3);
	const rot = vecOf(o.rot, 3);
	const scale = vecOf(o.scale, 3);
	/** @type {LodOffset} */
	const out = {};
	if (pos && pos.some((v) => v !== 0)) out.pos = pos;
	if (rot && rot.some((v) => v !== 0)) out.rot = rot;
	if (scale && scale.some((v) => v !== 1) && scale.every((v) => v !== 0)) out.scale = scale;
	return Object.keys(out).length ? out : undefined;
}

/** @param {any} m @returns {LodMaterial | undefined} */
function normalizeMaterial(m) {
	if (!m || typeof m !== 'object') return undefined;
	/** @type {LodMaterial} */
	const out = {};
	if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) out.color = m.color.toLowerCase();
	if (finite(m.roughness)) out.roughness = clampNum(m.roughness, 0, 1);
	if (finite(m.metalness)) out.metalness = clampNum(m.metalness, 0, 1);
	return Object.keys(out).length ? out : undefined;
}

/**
 * The one boundary. Returns null for anything that is not a usable group (so a hostile or
 * truncated block is the same as no block — today's behaviour). Level 0 is always `self`;
 * thresholds are forced strictly DESCENDING with at least MIN_GAP between them; a forced
 * level outside the list falls back to auto.
 * @param {any} block @returns {LodGroup | null}
 */
export function normalizeLodGroup(block) {
	if (!block || typeof block !== 'object' || !Array.isArray(block.levels)) return null;
	/** @type {LodLevel[]} */
	const levels = [];
	for (const raw of block.levels) {
		if (!raw || typeof raw !== 'object') continue;
		const source = LOD_SOURCES.includes(raw.source) ? raw.source : null;
		if (!source) continue;
		if (levels.length === 0 && source !== 'self') levels.push({ source: 'self', screenSize: 0.25 });
		else if (levels.length > 0 && source === 'self') continue; // only LOD0 is the object itself
		/** @type {LodLevel} */
		const level = { source, screenSize: finite(raw.screenSize) ? clampNum(raw.screenSize, 0, 1) : NaN };
		if (source === 'pack' || source === 'explorer' || source === 'object') {
			if (typeof raw.ref !== 'string' || !raw.ref || raw.ref.length > 512) continue;
			level.ref = raw.ref;
		}
		if (typeof raw.name === 'string' && raw.name) level.name = raw.name.slice(0, 120);
		if (finite(raw.ratio) && raw.ratio > 0 && raw.ratio <= 1) level.ratio = Number(raw.ratio);
		else if (source === 'generated') continue; // a generated level IS its ratio
		const offset = normalizeOffset(raw.offset);
		if (offset) level.offset = offset;
		const material = normalizeMaterial(raw.material);
		if (material) level.material = material;
		levels.push(level);
		if (levels.length >= MAX_LEVELS) break;
	}
	if (!levels.length) return null;
	// thresholds: fill the gaps from the defaults, then force strictly descending
	const defaults = defaultScreenSizes(levels.length);
	let previous = 1 + MIN_GAP;
	levels.forEach((level, i) => {
		let s = Number.isFinite(level.screenSize) ? level.screenSize : defaults[i];
		const ceiling = previous - MIN_GAP;
		if (s > ceiling) s = ceiling;
		if (s < 0) s = 0;
		level.screenSize = Number(s.toFixed(4));
		previous = level.screenSize;
	});
	/** @type {LodGroup} */
	const out = { mode: block.mode === 'forced' ? 'forced' : 'auto', levels };
	if (out.mode === 'forced') {
		const f = Number(block.forced);
		if (Number.isInteger(f) && f >= 0 && f < levels.length) out.forced = f;
		else out.mode = 'auto';
	}
	if (finite(block.bias) && block.bias > 0 && block.bias !== 1) out.bias = clampNum(block.bias, 0.1, 10);
	if (block.cull === true) out.cull = true;
	return out;
}

/**
 * The share of the viewport HEIGHT a bounding sphere covers. Perspective: r / (d·tan(fov/2));
 * orthographic: 2r / (top - bottom) / zoom. Clamped to [0, 1+] — standing inside the sphere
 * reads as filling the screen.
 * @param {number} radius world radius @param {number} distance world distance camera -> centre
 * @param {{fov?: number, isOrthographicCamera?: boolean, top?: number, bottom?: number, zoom?: number}} camera
 */
export function screenSizeOf(radius, distance, camera) {
	if (!(radius > 0)) return 0;
	if (camera?.isOrthographicCamera) {
		const h = Math.abs((camera.top ?? 1) - (camera.bottom ?? -1)) / (camera.zoom || 1);
		return h > 0 ? (2 * radius) / h : 0;
	}
	if (!(distance > radius)) return 2;
	const fov = finite(camera?.fov) ? /** @type {number} */ (camera?.fov) : 50;
	const t = Math.tan((fov * Math.PI) / 360);
	return t > 0 ? radius / (distance * t) : 2;
}

/**
 * The level to draw at `size` (a screenSizeOf value): 0..n-1, or -1 = culled. `current` is
 * last frame's pick (the hysteresis band), `scale` multiplies every threshold DOWN-side
 * (quality bias and the group's own bias fold in here: a threshold of 0.12 at scale 0.5 is
 * met at a size of 0.06 — detail kept longer).
 * @param {number} size @param {number[]} thresholds descending @param {number} current
 * @param {{cull?: boolean, scale?: number, hysteresis?: number}} [opts]
 */
export function pickGroupLevel(size, thresholds, current, opts = {}) {
	const n = thresholds.length;
	if (!n || !Number.isFinite(size)) return 0;
	const scale = finite(opts.scale) && /** @type {number} */ (opts.scale) > 0 ? /** @type {number} */ (opts.scale) : 1;
	const h = finite(opts.hysteresis) ? /** @type {number} */ (opts.hysteresis) : LOD_HYSTERESIS;
	const cull = !!opts.cull;
	// the deepest level the object is allowed to sit on: past the last threshold it is either
	// culled or stays on the last level
	const deepest = cull ? n : n - 1;
	let level = 0;
	for (let i = 0; i < deepest; i++) {
		const edge = thresholds[i] * scale;
		// leaving level i for something coarser needs the size under the edge; once coarser,
		// coming back above it needs the band
		const band = current > i || current === -1 ? edge * (1 + h) : edge;
		if (size < band) level = i + 1;
		else break;
	}
	return level >= n ? -1 : level;
}

/** Overlay colours, one per level (LOD0 green ... coarse red), and the culled grey. The
 * DCC convention (Unity's LOD bar uses the same ramp). */
export const LEVEL_COLORS = ['#3fb950', '#d4b106', '#e07b1f', '#d23f3f', '#a052d9', '#3b82f6'];
/** @param {number} level */
export function levelColor(level) {
	return level < 0 ? '#6b7280' : LEVEL_COLORS[Math.min(level, LEVEL_COLORS.length - 1)];
}

/**
 * A pack item row's `lods` (contract P1) as [{file, ratio}], finest first. Files are
 * relative to the item's glTF-Binary folder; a path that climbs out of it is refused.
 * @param {any} row @returns {{file: string, ratio: number}[]}
 */
export function packLodsOf(row) {
	const list = Array.isArray(row?.lods) ? row.lods : [];
	/** @type {{file: string, ratio: number}[]} */
	const out = [];
	for (const l of list) {
		const file = typeof l?.file === 'string' ? l.file.trim() : '';
		if (!file || file.includes('..') || file.startsWith('/') || /^[a-z]+:/i.test(file)) continue;
		const ratio = Number(l.ratio);
		out.push({ file, ratio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0 });
	}
	// finest first: a row listed out of order still reads LOD1 before LOD2
	return out.sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, MAX_LEVELS - 1);
}

/** The group a placed pack piece starts with: itself + every listed file. @param {any} row
 * @returns {LodGroup | null} */
export function groupFromPackLods(row) {
	const lods = packLodsOf(row);
	if (!lods.length) return null;
	const sizes = defaultScreenSizes(lods.length + 1);
	return normalizeLodGroup({
		mode: 'auto',
		levels: [{ source: 'self', screenSize: sizes[0] }, ...lods.map((l, i) => ({ source: 'pack', ref: l.file, ...(l.ratio ? { ratio: l.ratio } : {}), screenSize: sizes[i + 1] }))]
	});
}

/** A generated group (meshopt levels) at the given ratios. @param {number[]} [ratios]
 * @returns {LodGroup} */
export function generatedGroup(ratios = [0.5, 0.25, 0.1]) {
	const keep = ratios.filter((r) => finite(r) && r > 0 && r < 1).slice(0, MAX_LEVELS - 1);
	const sizes = defaultScreenSizes(keep.length + 1);
	return /** @type {LodGroup} */ (
		normalizeLodGroup({ mode: 'auto', levels: [{ source: 'self', screenSize: sizes[0] }, ...keep.map((ratio, i) => ({ source: 'generated', ratio, screenSize: sizes[i + 1] }))] })
	);
}

/**
 * Move threshold `i` to `value`, keeping the bar ordered: it may not cross its neighbours
 * (MIN_GAP from each). Returns a NEW normalized block.
 * @param {LodGroup} block @param {number} i @param {number} value
 */
export function withThreshold(block, i, value) {
	const levels = block.levels.map((l) => ({ ...l }));
	if (!levels[i] || !finite(value)) return block;
	const upper = i > 0 ? levels[i - 1].screenSize - MIN_GAP : 1;
	const lower = i < levels.length - 1 ? levels[i + 1].screenSize + MIN_GAP : 0;
	levels[i].screenSize = clampNum(value, lower, Math.max(lower, upper));
	return /** @type {LodGroup} */ (normalizeLodGroup({ ...block, levels }));
}

/**
 * The group's thresholds as one list, plus the scale the runtime multiplies them by.
 * @param {LodGroup} block @param {number} qualityBias the governor's lodBias (1 = full, < 1 = coarser sooner)
 */
export function thresholdsOf(block, qualityBias = 1) {
	const q = finite(qualityBias) && qualityBias > 0 ? qualityBias : 1;
	const b = finite(block.bias) && /** @type {number} */ (block.bias) > 0 ? /** @type {number} */ (block.bias) : 1;
	// a governor step pulls detail in (threshold up); the group's own bias > 1 keeps it longer
	return { thresholds: block.levels.map((l) => l.screenSize), scale: 1 / (q * b) };
}

/** Is `a` the same group as `b`? (an applier's idempotence test) @param {any} a @param {any} b */
export function sameGroup(a, b) {
	return JSON.stringify(normalizeLodGroup(a)) === JSON.stringify(normalizeLodGroup(b));
}
