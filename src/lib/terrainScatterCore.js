// 47 T2 — TERRAIN SCATTER, the pure half (imports NOTHING; unit-tested in tests/unit).
//
// A scattered terrain carries `userData.terrainScatter = {v: 1, sets: [...]}`; one SET per
// source (a primitive or a Library model) holds its instances as COMPACT bytes — four
// little-endian Uint16 per instance (8 bytes): local x and z quantized across the tile's
// XZ bounds, yaw over a full turn, scale in thousandths. Height is NOT stored: every peer
// derives it (and the align-to-normal tilt) from the terrain's own heights at render time,
// so a later sculpt stroke carries the instances with it and the data never goes stale.
// 2,000 instances = 16 KB raw (~21 KB base64), a tenth of one sculpt preview.

export const SCATTER_VERSION = 1;
/** total instances on one terrain, every set together — the Quest note in STATUS-47 is
 *  measured at 2,000; the cap leaves room for a desktop scene without an unbounded blob */
export const MAX_INSTANCES = 8000;
export const MAX_SETS = 8;
export const DENSITY_MIN = 0.01; // instances per m²
export const DENSITY_MAX = 4;
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 20;
const Q = 65535;
const TAU = Math.PI * 2;

/** 48 B1: the static collider a set's instances get in a simulation. 'none' is the default
 * and is NEVER written (a set without `collider` is the 47 shape), so every scene saved
 * before this, and every set nobody gave a collider, stays byte-identical. */
export const SCATTER_COLLIDERS = Object.freeze(['none', 'box', 'sphere', 'hull']);

/** @param {any} c @returns {string} 'none' for anything that is not a known kind */
export function scatterColliderOf(c) {
	return typeof c === 'string' && SCATTER_COLLIDERS.includes(c) ? c : 'none';
}

/** The primitives a scatter set may draw (the Library model path is `{kind: 'library'}`). */
export const SCATTER_PRIMITIVES = Object.freeze(['Box', 'Sphere', 'Cone', 'Cylinder', 'Capsule', 'Dodecahedron']);

/** @typedef {{x: number, z: number, yaw: number, scale: number}} Instance */
/** @typedef {{minX: number, minZ: number, sizeX: number, sizeZ: number}} Bounds */

/** Seeded PRNG (mulberry32) so a test can pin a stroke. @param {number} seed */
export function rng32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const clampQ = (/** @type {number} */ n) => Math.max(0, Math.min(Q, Math.round(n)));

/** @param {Instance[]} list @param {Bounds} b @returns {Uint8Array} */
export function encodeInstances(list, b) {
	const out = new Uint8Array(list.length * 8);
	const view = new DataView(out.buffer);
	list.forEach((inst, k) => {
		const o = k * 8;
		view.setUint16(o, clampQ(((inst.x - b.minX) / b.sizeX) * Q), true);
		view.setUint16(o + 2, clampQ(((inst.z - b.minZ) / b.sizeZ) * Q), true);
		const yaw = ((inst.yaw % TAU) + TAU) % TAU;
		view.setUint16(o + 4, clampQ((yaw / TAU) * Q), true);
		view.setUint16(o + 6, clampQ(inst.scale * 1000), true);
	});
	return out;
}

/** @param {Uint8Array} bytes @param {Bounds} b @returns {Instance[]} */
export function decodeInstances(bytes, b) {
	const n = Math.floor(bytes.length / 8);
	const view = new DataView(bytes.buffer, bytes.byteOffset, n * 8);
	/** @type {Instance[]} */
	const out = new Array(n);
	for (let k = 0; k < n; k++) {
		const o = k * 8;
		out[k] = {
			x: b.minX + (view.getUint16(o, true) / Q) * b.sizeX,
			z: b.minZ + (view.getUint16(o + 2, true) / Q) * b.sizeZ,
			yaw: (view.getUint16(o + 4, true) / Q) * TAU,
			scale: view.getUint16(o + 6, true) / 1000
		};
	}
	return out;
}

/**
 * Paint instances into a brush circle until it holds `density × area` (never more): the
 * count already inside is honoured, so painting over a full patch adds nothing, and a
 * minimum spacing (0.7 of the mean gap) keeps the fill even instead of clumped.
 * @param {Instance[]} existing the set's instances (read only)
 * @param {{cx: number, cz: number, radius: number, density: number, scaleMin: number, scaleMax: number,
 *   randomRotation: boolean, bounds: Bounds, rng: () => number, room?: number}} o
 *   `room` = how many more the terrain may hold (the MAX_INSTANCES cap across sets)
 * @returns {Instance[]} the NEW instances only
 */
export function scatterInCircle(existing, o) {
	const r = o.radius;
	const density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, o.density));
	const target = Math.floor(density * Math.PI * r * r);
	const spacing = 0.7 / Math.sqrt(density);
	const reach = r + spacing;
	const near = existing.filter((p) => Math.hypot(p.x - o.cx, p.z - o.cz) <= reach);
	let inside = near.filter((p) => Math.hypot(p.x - o.cx, p.z - o.cz) <= r).length;
	let want = Math.min(target - inside, o.room ?? Infinity);
	/** @type {Instance[]} */
	const added = [];
	if (want <= 0) return added;
	const b = o.bounds;
	const lo = Math.min(o.scaleMin, o.scaleMax);
	const hi = Math.max(o.scaleMin, o.scaleMax);
	let attempts = want * 12;
	while (want > 0 && attempts-- > 0) {
		const a = o.rng() * TAU;
		const d = r * Math.sqrt(o.rng());
		const x = o.cx + Math.cos(a) * d;
		const z = o.cz + Math.sin(a) * d;
		if (x < b.minX || x > b.minX + b.sizeX || z < b.minZ || z > b.minZ + b.sizeZ) continue;
		let ok = true;
		for (const p of near) if (Math.hypot(p.x - x, p.z - z) < spacing) { ok = false; break; }
		if (ok) for (const p of added) if (Math.hypot(p.x - x, p.z - z) < spacing) { ok = false; break; }
		if (!ok) continue;
		added.push({
			x,
			z,
			yaw: o.randomRotation ? o.rng() * TAU : 0,
			scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, lo + (hi - lo) * o.rng()))
		});
		inside++;
		want--;
	}
	return added;
}

/** Remove every instance inside the circle. @param {Instance[]} list
 * @param {number} cx @param {number} cz @param {number} radius */
export function eraseInCircle(list, cx, cz, radius) {
	return list.filter((p) => Math.hypot(p.x - cx, p.z - cz) > radius);
}

/** a Library model hash / a pack path: what a source may name */
const HASH_RE = /^[0-9a-zA-Z_-]{1,128}$/;
const PATH_RE = /^(?:https?:\/\/)?[\w\-./%~:+@]{1,400}$/;

/** 51 E1: the short note a source row shows (a prefab / an object scattered as its LOOK only) */
const noteOf = (/** @type {any} */ s) => (typeof s.note === 'string' && s.note ? { note: s.note.slice(0, 160) } : {});
// 51 union: a prefab's LOOK remembers which prefab it came from, so "To objects" can bring the
// whole prefab back WITH its logic where that prefab is in the library (the user's 2026-10-21 rule)
const prefabOf = (/** @type {any} */ s) => (typeof s.prefab === 'string' && HASH_RE.test(s.prefab) ? { prefab: s.prefab } : {});

/** @param {any} s @returns {any} */
export function sourceOf(s) {
	if (!s || typeof s !== 'object') return null;
	if (s.kind === 'primitive' && SCATTER_PRIMITIVES.includes(s.type)) return { kind: 'primitive', type: s.type };
	if (s.kind === 'library' && typeof s.hash === 'string' && HASH_RE.test(s.hash))
		return { kind: 'library', hash: s.hash, name: typeof s.name === 'string' ? s.name.slice(0, 120) : '', ...noteOf(s), ...prefabOf(s) };
	// 51 E1: a pack item, by the same {pack, item, path} a placed kit piece's packRef carries — every
	// peer fetches it from the pack CDN, nothing travels but the path
	if (s.kind === 'pack' && typeof s.path === 'string' && PATH_RE.test(s.path) && !s.path.includes('..'))
		return {
			kind: 'pack',
			path: s.path,
			pack: typeof s.pack === 'string' ? s.pack.slice(0, 80) : '',
			item: typeof s.item === 'string' ? s.item.slice(0, 120) : '',
			...noteOf(s)
		};
	return null;
}

/** A stable key for "the same source" (the brush paints into the set that matches it). @param {any} s */
export function sourceKey(s) {
	const n = sourceOf(s);
	return !n ? '' : n.kind === 'primitive' ? 'p:' + n.type : n.kind === 'pack' ? 'k:' + n.path : 'l:' + n.hash;
}

/**
 * Validate a stored/wire block. Sets with a bad source or bytes are DROPPED (never
 * guessed at); empty sets are dropped too, so "erase everything" leaves `sets: []`.
 *
 * 51 — THE SET FORMAT. A set is PARAMS + SEED + OVERRIDES, plus the painted instances 1.38
 * already stored. Every 51 field is OPTIONAL and written only when it says something, so a
 * 1.38 set normalizes to exactly the object it did before (same keys, same order) and a scene
 * that uses none of them saves byte-identical:
 *   data      painted instances, the 1.38 8-byte records (the brush writes these)
 *   seed+gen  GENERATED instances: `gen` {count | density, scaleMin, scaleMax, rot, spacing}
 *             drawn from the seeded generator below — slot k is always the same instance on
 *             every peer and after a reload; nothing per instance travels
 *   ov        per-slot hand edits {[slot]: {x?, z?, yaw?, scale?, del?: 1}} — a re-roll (a new
 *             seed) keeps them, keyed by the slot
 *   sources   a MIXED set [{source, w}] (2..8, weights > 0); `source` stays sources[0]
 *   pick      one byte per PAINTED instance in a mixed set: which source it drew
 *   tint      0..1 colour variation, `sink` metres pushed into the ground (x the instance scale)
 *   host+box  51-surface: `host: 'mesh'` = the set lives on a NON-terrain mesh (any rock, sphere,
 *             house): its painted records are 16 bytes (scatterSurfaceCore — xyz over the stored
 *             `box` [minX, minY, minZ, sizeX, sizeY, sizeZ], a normal, yaw, scale) and its slots
 *             are placed on the mesh's own triangles. Absent on every terrain set.
 * @param {any} block @param {(b64: string) => Uint8Array | null} decode
 * @returns {{v: number, sets: ScatterSet[]} | null}
 */
export function normalizeScatter(block, decode) {
	if (!block || typeof block !== 'object' || !Array.isArray(block.sets)) return null;
	/** @type {ScatterSet[]} */
	const sets = [];
	let total = 0;
	for (const s of block.sets.slice(0, MAX_SETS)) {
		if (!s || typeof s !== 'object') continue;
		const sources = sourcesOf(s);
		const source = sources ? sources[0].source : sourceOf(s.source);
		if (!source) continue;
		const bytes = typeof s.data === 'string' && s.data ? decode(s.data) : null;
		// 51-surface: a mesh host's painted record is 16 bytes, and it cannot be read without its box
		const mesh = s.host === 'mesh';
		const rec = mesh ? 16 : 8;
		if (bytes && bytes.length % rec !== 0) continue;
		const count = bytes ? bytes.length / rec : 0;
		const box = mesh && count ? boxOf(s.box) : null;
		if (mesh && count && !box) continue;
		const gen = genOf(s.gen);
		if (!count && !gen) continue;
		if (total + count > MAX_INSTANCES) continue;
		total += count;
		const collider = scatterColliderOf(s.collider);
		/** @type {ScatterSet} */
		const set = {
			id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : sourceKey(source),
			source,
			align: !!s.align,
			data: count ? s.data : '',
			count,
			...(collider === 'none' ? {} : { collider }),
			...(mesh ? { host: 'mesh' } : {}),
			...(box ? { box } : {})
		};
		if (gen) {
			if (gen.count != null) {
				gen.count = Math.min(gen.count, MAX_INSTANCES - total);
				total += gen.count;
			}
			set.seed = (Number(s.seed) >>> 0) || 0;
			set.gen = gen;
			const ov = overridesOf(s.ov);
			if (ov) set.ov = ov;
		}
		if (sources) {
			set.sources = sources;
			const pick = count && typeof s.pick === 'string' ? decode(s.pick) : null;
			if (pick && pick.length === count) set.pick = s.pick;
		}
		const tint = clampNum(s.tint, 0, 1);
		if (tint) set.tint = tint;
		const sink = clampNum(s.sink, SINK_MIN, SINK_MAX);
		if (sink) set.sink = sink;
		sets.push(set);
	}
	return { v: blockVersion(sets), sets };
}

/** @typedef {{id: string, source: any, align: boolean, data: string, count: number, collider?: string,
 *   seed?: number, gen?: Gen, ov?: Record<string, Override>, sources?: {source: any, w: number}[],
 *   pick?: string, tint?: number, sink?: number, host?: 'mesh', box?: number[]}} ScatterSet */

/** 51-surface: a stored record box [minX, minY, minZ, sizeX, sizeY, sizeZ] (sizes > 0), else null
 * @param {any} box @returns {number[] | null} */
function boxOf(box) {
	if (!Array.isArray(box) || box.length !== 6) return null;
	const out = box.map(Number);
	return out.every((n) => Number.isFinite(n)) && out[3] > 0 && out[4] > 0 && out[5] > 0 ? out : null;
}
/** @typedef {{count?: number, density?: number, scaleMin: number, scaleMax: number, rot: boolean,
 *   spacing?: number}} Gen */
/** @typedef {{x?: number, y?: number, z?: number, yaw?: number, scale?: number, del?: 1}} Override */

/** 1 while every set is the 1.38 shape (so an untouched scene saves byte-identical), else 2
 * @param {ScatterSet[]} sets */
export function blockVersion(sets) {
	return sets.some((s) => s.gen || s.sources || s.tint || s.sink || s.host) ? 2 : SCATTER_VERSION;
}

export const SINK_MIN = -2;
export const SINK_MAX = 5;
export const SPACING_MAX = 50;

/** @param {any} v @param {number} lo @param {number} hi */
function clampNum(v, lo, hi) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

/** @param {any} g @returns {Gen | null} */
function genOf(g) {
	if (!g || typeof g !== 'object') return null;
	/** @type {Gen} */
	const out = {
		scaleMin: clampNum(g.scaleMin ?? 1, SCALE_MIN, SCALE_MAX),
		scaleMax: clampNum(g.scaleMax ?? 1, SCALE_MIN, SCALE_MAX),
		rot: g.rot !== false
	};
	if (Number.isFinite(Number(g.density)) && g.count == null) out.density = clampNum(g.density, DENSITY_MIN, DENSITY_MAX);
	else out.count = Math.floor(clampNum(g.count, 0, MAX_INSTANCES));
	const spacing = clampNum(g.spacing, 0, SPACING_MAX);
	if (spacing) out.spacing = spacing;
	// 51-surface's masks and modes ride here as further fields; carried through untouched
	for (const k of Object.keys(g))
		if (!(k in out) && !['count', 'density', 'scaleMin', 'scaleMax', 'rot', 'spacing'].includes(k) && isPlain(g[k])) /** @type {any} */ (out)[k] = g[k];
	return out;
}

/** JSON-safe and small: what a carried-through field may hold @param {any} v */
function isPlain(v) {
	try {
		const s = JSON.stringify(v);
		return typeof s === 'string' && s.length <= 2000;
	} catch {
		return false;
	}
}

/** @param {any} ov @returns {Record<string, Override> | null} */
function overridesOf(ov) {
	if (!ov || typeof ov !== 'object') return null;
	/** @type {Record<string, Override>} */
	const out = {};
	let n = 0;
	for (const key of Object.keys(ov)) {
		if (n >= MAX_INSTANCES) break;
		if (!/^\d{1,5}$/.test(key) || Number(key) >= MAX_INSTANCES) continue;
		const o = overrideOf(ov[key]);
		if (o) (out[key] = o), n++;
	}
	return n ? out : null;
}

/** @param {any} o @returns {Override | null} */
function overrideOf(o) {
	if (!o || typeof o !== 'object') return null;
	if (o.del) return { del: 1 };
	/** @type {Override} */
	const out = {};
	// `y`: 51-surface — a slot on a mesh host has a height of its own (a terrain slot's comes from the grid)
	for (const k of /** @type {const} */ (['x', 'y', 'z', 'yaw'])) if (Number.isFinite(o[k])) out[k] = o[k];
	if (Number.isFinite(o.scale)) out.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, o.scale));
	return Object.keys(out).length ? out : null;
}

/** @param {any} s @returns {{source: any, w: number}[] | null} 2..8 valid entries, else null */
function sourcesOf(s) {
	if (!Array.isArray(s.sources)) return null;
	const out = [];
	for (const e of s.sources.slice(0, MAX_MIX)) {
		const source = sourceOf(e?.source);
		const w = clampNum(e?.w, 0, 1000);
		if (source && w > 0) out.push({ source, w });
	}
	return out.length >= 2 ? out : null;
}

/** sources one mixed set may draw (one pick byte keeps the index) */
export const MAX_MIX = 8;

// ---- 51: the generator, the overrides, and the ONE instance list --------------------------
//
// SLOT k of a seeded set is drawn from its OWN stream (seed, k) — never from a stream shared
// with the slots before it — so raising the count adds instances without moving any, a mask
// that rejects slot 3 moves nothing else, and slot 7 is the same rock on every peer and after
// every reload. That is what makes a slot a stable ID that a hand edit can be keyed by.
// Spacing is judged on the RAW slots, before any override: deleting a rock must never make a
// rock it had crowded out appear beside it.
//
// IDS (strings, the JSON key shape): 'g<k>' = generated slot k (edits live in `ov`, a re-roll
// keeps them) · 'p<j>' = painted instance j, the j-th 8-byte record (an edit REWRITES the
// record, a delete drops it — so 'p' ids after j shift down by one; read the list again after
// a structural edit).

/** @typedef {{id: string, slot?: number, index?: number, x: number, z: number, yaw: number,
 *   scale: number, src: number, tint: number}} ScatterInstance */

/** A 32-bit mix of (seed, k): the seed of slot k's own stream. @param {number} seed @param {number} k */
export function slotSeed(seed, k) {
	let h = ((seed >>> 0) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Slot k's six draws, in a FIXED order (a placer for another surface reads u/v the same way):
 * u, v (where), yaw, scale, pick (which source), tint. @param {number} seed @param {number} k
 */
export function slotDraws(seed, k) {
	const r = rng32(slotSeed(seed, k));
	return { u: r(), v: r(), yaw: r(), scale: r(), pick: r(), tint: r() };
}

/** Which source a draw in [0, 1) picks, by weight. @param {{w: number}[] | undefined} sources @param {number} r */
export function pickSource(sources, r) {
	if (!sources || sources.length < 2) return 0;
	let sum = 0;
	for (const s of sources) sum += s.w;
	let at = r * sum;
	for (let i = 0; i < sources.length; i++) {
		at -= sources[i].w;
		if (at < 0) return i;
	}
	return sources.length - 1;
}

/** 51-surface: COUNT mode's attempt budget per wanted instance (scatterSurfaceCore keeps the same number) */
export const ATTEMPTS_PER_SLOT = 30;

/** How many slots a seeded set has on these bounds (`room` = what the terrain may still hold).
 * @param {ScatterSet} set @param {Bounds} b @param {number} [room] */
export function slotCount(set, b, room = MAX_INSTANCES) {
	const g = set.gen;
	if (!g) return 0;
	const n = g.count != null ? g.count : Math.floor((g.density ?? 0) * b.sizeX * b.sizeZ);
	return Math.max(0, Math.min(n, room, MAX_INSTANCES));
}

/**
 * The RAW generated instances (no overrides): one per slot that survives `accept` and spacing.
 * `place(u, v, k)` maps a slot's draw to local (x, z) — the terrain rectangle by default; another
 * surface passes its own (51-surface). `accept(x, z, k)` is a mask (slope, height, layer).
 * @param {ScatterSet} set @param {Bounds} b
 * @param {{room?: number, place?: (u: number, v: number, k: number) => {x: number, z: number} | null,
 *   accept?: (x: number, z: number, k: number) => boolean}} [opts]
 * @returns {ScatterInstance[]}
 */
export function generateSlots(set, b, opts = {}) {
	const g = set.gen;
	if (!g) return [];
	const n = slotCount(set, b, opts.room);
	const lo = Math.min(g.scaleMin, g.scaleMax);
	const hi = Math.max(g.scaleMin, g.scaleMax);
	const spacing = g.spacing ?? 0;
	/** @type {Map<string, ScatterInstance[]>} */
	const grid = new Map();
	const cell = (/** @type {number} */ x, /** @type {number} */ z) => Math.floor(x / spacing) + ',' + Math.floor(z / spacing);
	/** @type {ScatterInstance[]} */
	const out = [];
	// 51-surface: COUNT mode means count PLACED — while a mask or the spacing rejects slots, keep
	// drawing (k is still the slot id, so raising the count still adds without moving) up to
	// ATTEMPTS_PER_SLOT x count; DENSITY mode stays density x area draws, so a mask keeps the
	// density right where it passes
	const placing = g.count != null && (!!opts.accept || !!opts.place || spacing > 0);
	const attempts = placing ? n * ATTEMPTS_PER_SLOT : n;
	for (let k = 0; k < attempts && out.length < n; k++) {
		const d = slotDraws(set.seed ?? 0, k);
		const at = opts.place ? opts.place(d.u, d.v, k) : { x: b.minX + d.u * b.sizeX, z: b.minZ + d.v * b.sizeZ };
		if (!at) continue;
		if (opts.accept && !opts.accept(at.x, at.z, k)) continue;
		if (spacing) {
			const cx = Math.floor(at.x / spacing);
			const cz = Math.floor(at.z / spacing);
			let ok = true;
			for (let i = -1; i <= 1 && ok; i++)
				for (let j = -1; j <= 1 && ok; j++)
					for (const p of grid.get(cx + i + ',' + (cz + j)) ?? [])
						if (Math.hypot(p.x - at.x, p.z - at.z) < spacing) {
							ok = false;
							break;
						}
			if (!ok) continue;
		}
		const inst = {
			id: 'g' + k,
			slot: k,
			x: at.x,
			z: at.z,
			yaw: g.rot ? d.yaw * TAU : 0,
			scale: lo + (hi - lo) * d.scale,
			src: pickSource(set.sources, d.pick),
			tint: d.tint * 2 - 1
		};
		if (spacing) {
			const key = cell(at.x, at.z);
			const list = grid.get(key);
			if (list) list.push(inst);
			else grid.set(key, [inst]);
		}
		out.push(inst);
	}
	return out;
}

/** A painted record's tint draw: a hash of its quantized x/z (stable under erase, the same on every peer).
 * @param {DataView} view @param {number} o */
function paintedTint(view, o) {
	const h = slotSeed(view.getUint32(o, true), 0x51);
	return (h / 4294967296) * 2 - 1;
}

/**
 * EVERY instance a set draws: the generated slots with their hand edits applied (deleted ones
 * left out), then the painted records. The ONE list the renderer, the colliders and the edit
 * tools read. @param {ScatterSet} set @param {Bounds} b @param {(b64: string) => Uint8Array | null} decode
 * @param {{room?: number, place?: any, accept?: any}} [opts]
 * @returns {ScatterInstance[]}
 */
export function instancesOf(set, b, decode, opts = {}) {
	/** @type {ScatterInstance[]} */
	const out = [];
	for (const inst of generateSlots(set, b, opts)) {
		const o = set.ov?.[String(inst.slot)];
		if (o?.del) continue;
		out.push(o ? { ...inst, ...o } : inst);
	}
	const bytes = set.count && set.data ? decode(set.data) : null;
	if (bytes) {
		const pick = set.pick ? decode(set.pick) : null;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		decodeInstances(bytes, b).forEach((inst, j) => {
			out.push({ id: 'p' + j, index: j, ...inst, src: pick && set.sources ? Math.min(pick[j] ?? 0, set.sources.length - 1) : 0, tint: paintedTint(view, j * 8) });
		});
	}
	return out;
}

/** @param {string} id @returns {{kind: 'g' | 'p', n: number} | null} */
export function parseInstanceId(id) {
	const m = /^([gp])(\d{1,5})$/.exec(String(id));
	return m ? { kind: /** @type {'g' | 'p'} */ (m[1]), n: Number(m[2]) } : null;
}

/**
 * Apply hand edits. `patch` = {[id]: {x?, z?, yaw?, scale?, del?: true} | null}: a generated id
 * writes its override (null clears it, back to the seed's pose); a painted id rewrites its
 * record (null does nothing — a painted instance has no seed to fall back to; del drops it).
 * Returns a NEW set; the input is untouched.
 * @param {ScatterSet} set @param {Record<string, Partial<Override> & {del?: any} | null>} patch
 * 51-surface: a `host: 'mesh'` set's painted records are 16 bytes — `io.records` is their codec
 * (scatterSurfaceCore.surfaceRecords), and the re-encode writes the set's new `box` with them.
 * @param {{bounds: Bounds, decode: (b64: string) => Uint8Array | null, encode: (bytes: Uint8Array) => string,
 *   records?: {decode: (bytes: Uint8Array, set: any) => any[], encode: (list: any[]) => {bytes: Uint8Array, box: number[]}}}} io
 * @returns {ScatterSet}
 */
export function withOverrides(set, patch, io) {
	/** @type {ScatterSet} */
	const next = { ...set };
	/** @type {Record<string, Override>} */
	const ov = { ...(set.ov ?? {}) };
	/** @type {Map<number, any>} */
	const painted = new Map();
	for (const [id, edit] of Object.entries(patch ?? {})) {
		const p = parseInstanceId(id);
		if (!p) continue;
		if (p.kind === 'g') {
			if (!set.gen || p.n >= MAX_INSTANCES) continue;
			const key = String(p.n);
			if (edit === null) delete ov[key];
			else {
				const o = overrideOf(edit.del ? { del: 1 } : { ...(ov[key]?.del ? {} : ov[key]), ...edit });
				if (o) ov[key] = o;
			}
		} else if (edit) painted.set(p.n, edit);
	}
	if (set.gen) {
		if (Object.keys(ov).length) next.ov = ov;
		else delete next.ov;
	}
	if (painted.size && set.count) {
		const bytes = io.decode(set.data);
		const codec = set.host === 'mesh' ? io.records : null;
		if (bytes && (codec || set.host !== 'mesh')) {
			const list = codec ? codec.decode(bytes, set) : decodeInstances(bytes, io.bounds);
			const pick = set.pick ? io.decode(set.pick) : null;
			/** @type {Instance[]} */
			const kept = [];
			/** @type {number[]} */
			const keptPick = [];
			list.forEach((inst, j) => {
				const edit = painted.get(j);
				if (edit?.del) return;
				kept.push(edit ? { ...inst, ...pickPose(edit) } : inst);
				if (pick) keptPick.push(pick[j] ?? 0);
			});
			next.count = kept.length;
			if (codec) {
				const enc = codec.encode(kept);
				next.data = kept.length ? io.encode(enc.bytes) : '';
				if (kept.length) next.box = enc.box;
				else delete next.box;
			} else next.data = kept.length ? io.encode(encodeInstances(kept, io.bounds)) : '';
			if (pick) {
				if (kept.length) next.pick = io.encode(new Uint8Array(keptPick));
				else delete next.pick;
			}
		}
	}
	return next;
}

/** @param {any} e */
function pickPose(e) {
	/** @type {any} */
	const out = {};
	for (const k of ['x', 'y', 'z', 'yaw', 'scale']) if (Number.isFinite(e[k])) out[k] = e[k];
	if (out.scale != null) out.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, out.scale));
	return out;
}

/**
 * 51 E1: make a set MIXED by adding a source (weight `w`; a single-source set becomes a mix of
 * its own source at weight 1 and this one). Painted records keep drawing what they drew (pick
 * 0 = the original source). Refused (input returned) past MAX_MIX or for a source already in it.
 * @param {ScatterSet} set @param {any} source @param {number} w
 * @param {{decode: (b64: string) => Uint8Array | null, encode: (bytes: Uint8Array) => string}} io
 * @returns {ScatterSet}
 */
export function withSourceAdded(set, source, w, io) {
	const s = sourceOf(source);
	const list = set.sources ?? [{ source: set.source, w: 1 }];
	if (!s || list.length >= MAX_MIX || list.some((e) => sourceKey(e.source) === sourceKey(s))) return set;
	/** @type {ScatterSet} */
	const next = { ...set, sources: [...list, { source: s, w: Math.max(0.01, w || 1) }] };
	if (set.count && !set.pick) next.pick = io.encode(new Uint8Array(set.count));
	return next;
}

/**
 * 51 E1: drop source i from a mixed set. Its PAINTED records go with it (they were that model);
 * later picks shift down; a mix left with one source becomes a plain set again. Generated slots
 * simply re-pick among what is left (deterministic, the same on every peer).
 * @param {ScatterSet} set @param {number} i
 * 51-surface: a `host: 'mesh'` set's painted records go through `io.records` (as in withOverrides).
 * @param {{bounds: Bounds, decode: (b64: string) => Uint8Array | null, encode: (bytes: Uint8Array) => string,
 *   records?: {decode: (bytes: Uint8Array, set: any) => any[], encode: (list: any[]) => {bytes: Uint8Array, box: number[]}}}} io
 * @returns {ScatterSet}
 */
export function withSourceRemoved(set, i, io) {
	if (!set.sources || i < 0 || i >= set.sources.length) return set;
	const sources = set.sources.filter((_, k) => k !== i);
	/** @type {ScatterSet} */
	const next = { ...set, source: sources[0].source };
	if (set.count) {
		const bytes = io.decode(set.data);
		const pick = set.pick ? io.decode(set.pick) : new Uint8Array(set.count);
		const codec = set.host === 'mesh' ? io.records : null;
		if (bytes && pick && (codec || set.host !== 'mesh')) {
			const list = codec ? codec.decode(bytes, set) : decodeInstances(bytes, io.bounds);
			/** @type {Instance[]} */
			const kept = [];
			/** @type {number[]} */
			const keptPick = [];
			list.forEach((inst, j) => {
				const p = pick[j] ?? 0;
				if (p === i) return;
				kept.push(inst);
				keptPick.push(p > i ? p - 1 : p);
			});
			next.count = kept.length;
			if (codec) {
				const enc = codec.encode(kept);
				next.data = kept.length ? io.encode(enc.bytes) : '';
				if (kept.length) next.box = enc.box;
				else delete next.box;
			} else next.data = kept.length ? io.encode(encodeInstances(kept, io.bounds)) : '';
			if (sources.length > 1 && kept.length) next.pick = io.encode(new Uint8Array(keptPick));
			else delete next.pick;
		}
	}
	if (sources.length > 1) next.sources = sources;
	else {
		delete next.sources;
		delete next.pick;
	}
	return next;
}

/** The whole-set RE-ROLL: a new seed, every hand edit kept (keyed by slot). @param {ScatterSet} set @param {number} seed */
export function withSeed(set, seed) {
	return { ...set, seed: seed >>> 0 };
}

/** A fresh seed for a new set or a re-roll (Math.random is fine: the SEED is what travels). */
export function newSeed() {
	return (Math.random() * 4294967296) >>> 0;
}

// ---- heights: the terrain's regular grid, sampled exactly as it is triangulated --------

/**
 * Bin a terrain's (possibly non-indexed) positions into its (n+1)² grid of heights. The
 * grid size is the count of DISTINCT x values; a terrain only ever moves Y (sculpt, carve),
 * so the grid stays regular. Returns null when the positions do not form a full grid.
 * @param {ArrayLike<number>} pos xyz triples (local space)
 */
export function buildHeightGrid(pos) {
	const count = Math.floor(pos.length / 3);
	if (!count) return null;
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
	const xs = new Set();
	for (let i = 0; i < count; i++) {
		const x = pos[i * 3];
		const z = pos[i * 3 + 2];
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (z < minZ) minZ = z;
		if (z > maxZ) maxZ = z;
		xs.add(Math.round(x * 1e4));
	}
	const n = xs.size - 1;
	if (n < 1 || n > 1024 || !(maxX > minX) || !(maxZ > minZ)) return null;
	const sizeX = maxX - minX;
	const sizeZ = maxZ - minZ;
	const heights = new Float32Array((n + 1) * (n + 1)).fill(NaN);
	for (let i = 0; i < count; i++) {
		const ix = Math.round(((pos[i * 3] - minX) / sizeX) * n);
		const iz = Math.round(((pos[i * 3 + 2] - minZ) / sizeZ) * n);
		if (ix < 0 || ix > n || iz < 0 || iz > n) continue;
		heights[iz * (n + 1) + ix] = pos[i * 3 + 1];
	}
	for (let k = 0; k < heights.length; k++) if (Number.isNaN(heights[k])) return null;
	return { n, minX, minZ, sizeX, sizeZ, heights };
}

/**
 * Height + surface normal at a local (x, z), on the SAME two triangles per cell that a
 * PlaneGeometry builds (diagonal from (ix, iz+1) to (ix+1, iz)), so an instance sits on
 * the drawn surface, not on a bilinear approximation of it.
 * @param {NonNullable<ReturnType<typeof buildHeightGrid>>} g @param {number} x @param {number} z
 * @returns {{y: number, nx: number, ny: number, nz: number}}
 */
export function sampleHeight(g, x, z) {
	const { n } = g;
	const cw = g.sizeX / n;
	const ch = g.sizeZ / n;
	const gx = Math.min(n - 1e-9, Math.max(0, (x - g.minX) / cw));
	const gz = Math.min(n - 1e-9, Math.max(0, (z - g.minZ) / ch));
	const ix = Math.floor(gx);
	const iz = Math.floor(gz);
	const fx = gx - ix;
	const fz = gz - iz;
	const H = (/** @type {number} */ i, /** @type {number} */ j) => g.heights[j * (n + 1) + i];
	const ha = H(ix, iz);
	const hb = H(ix, iz + 1);
	const hc = H(ix + 1, iz + 1);
	const hd = H(ix + 1, iz);
	let y, dx, dz; // dx = dh/dx, dz = dh/dz (metres per metre)
	if (fx + fz <= 1) {
		y = ha + (hd - ha) * fx + (hb - ha) * fz;
		dx = (hd - ha) / cw;
		dz = (hb - ha) / ch;
	} else {
		y = hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
		dx = (hc - hb) / cw;
		dz = (hc - hd) / ch;
	}
	const len = Math.hypot(dx, 1, dz);
	return { y, nx: -dx / len, ny: 1 / len, nz: -dz / len };
}
