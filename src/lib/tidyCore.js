// 102b-arrange row 2 — TIDY, the pure half (vitest): select similar keys, rename many, randomise.
// A LEAF: plain data in, plain data out; tidyActions.js reads the scene and records.

/** mulberry32: a small seeded generator, [0, 1) (the duplicateCore one, so the agent and the
 * Inspector make the same scatter from the same seed) @param {number} seed */
export function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const SIMILAR_BY = /** @type {const} */ (['shape', 'material', 'prefab', 'tag', 'layer']);

/**
 * What makes two objects "similar" by one rule, as a key (null = this object has nothing to match
 * on). `d` is a plain descriptor tidyActions builds: {gtype, geomType, verts, materialId, matType,
 * color, mapped, prefab, tags, layer}.
 * @param {any} d @param {string} by @returns {string | string[] | null}
 */
export function similarKey(d, by) {
	if (!d) return null;
	if (by === 'shape') return d.gtype ? 'prim:' + d.gtype : d.geomType ? `geo:${d.geomType}:${d.verts ?? 0}` : null;
	if (by === 'material') return d.materialId ? 'id:' + d.materialId : d.matType ? `${d.matType}:${d.color ?? ''}:${d.mapped ? 1 : 0}` : null;
	if (by === 'prefab') return d.prefab ? String(d.prefab) : null;
	if (by === 'tag') return Array.isArray(d.tags) && d.tags.length ? d.tags.map(String) : null;
	if (by === 'layer') return d.layer ? String(d.layer) : null;
	return null;
}

/** does `d` match `key` (tags: any shared tag) @param {any} d @param {string} by @param {any} key */
export function matchesSimilar(d, by, key) {
	const k = similarKey(d, by);
	if (k == null || key == null) return false;
	if (Array.isArray(key)) return Array.isArray(k) && k.some((t) => key.includes(t));
	return k === key;
}

/**
 * Rename many: `pattern` with {n} (the counter, zero-padded to `pad` digits) and {name} (the old
 * name). A pattern without {n} gets " {n}" added, so the names stay distinct.
 * @param {string[]} names @param {string} pattern @param {number} [start] @param {number} [pad]
 * @returns {string[]}
 */
export function renamePlan(names, pattern, start = 1, pad = 0) {
	let p = typeof pattern === 'string' ? pattern.trim().slice(0, 100) : '';
	if (!p) p = '{name}';
	if (!p.includes('{n}')) p += ' {n}';
	const first = Number.isFinite(start) ? Math.round(start) : 1;
	const width = Math.max(0, Math.min(6, Math.round(pad) || 0));
	return names.map((old, i) => {
		const n = String(first + i).padStart(width, '0');
		return p.replaceAll('{n}', n).replaceAll('{name}', old ?? '').slice(0, 120);
	});
}

/** @param {any} v @param {number} lo @param {number} hi */
const clampNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/**
 * Randomise within ranges: each object turns by up to ±rot degrees per axis, is resized by a factor
 * in [scale[0], scale[1]] (uniform) and moves by up to ±offset metres per axis. Seeded, so the same
 * call gives the same result on every run. Poses are local {pos, rot (radians, XYZ), scale}.
 * @param {{pos: number[], rot: number[], scale: number[]}[]} poses
 * @param {{rot?: number[], scale?: number[], offset?: number[], seed?: number}} opts
 */
export function randomisePlan(poses, opts) {
	const rot = (opts.rot ?? [0, 0, 0]).map((d) => (clampNum(d, 0, 180) * Math.PI) / 180);
	const off = (opts.offset ?? [0, 0, 0]).map((m) => clampNum(m, 0, 1000));
	let [lo, hi] = Array.isArray(opts.scale) ? opts.scale.map((f) => clampNum(f, 0.01, 100)) : [1, 1];
	if (!lo) lo = 1;
	if (!hi) hi = 1;
	if (lo > hi) [lo, hi] = [hi, lo];
	const rand = seeded(Number.isInteger(opts.seed) ? /** @type {number} */ (opts.seed) : 1);
	const r6 = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;
	return poses.map((p) => {
		const dr = rot.map((r) => (r ? (rand() * 2 - 1) * r : 0));
		const f = lo === hi ? lo : lo + rand() * (hi - lo);
		const dp = off.map((m) => (m ? (rand() * 2 - 1) * m : 0));
		return {
			pos: p.pos.map((v, i) => r6(v + dp[i])),
			rot: p.rot.map((v, i) => r6(v + dr[i])),
			scale: p.scale.map((v) => r6(v * f))
		};
	});
}
