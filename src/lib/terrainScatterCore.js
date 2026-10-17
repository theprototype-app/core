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

/** @param {any} s */
function sourceOf(s) {
	if (!s || typeof s !== 'object') return null;
	if (s.kind === 'primitive' && SCATTER_PRIMITIVES.includes(s.type)) return { kind: 'primitive', type: s.type };
	if (s.kind === 'library' && typeof s.hash === 'string' && /^[0-9a-zA-Z_-]{1,128}$/.test(s.hash))
		return { kind: 'library', hash: s.hash, name: typeof s.name === 'string' ? s.name.slice(0, 120) : '' };
	return null;
}

/** A stable key for "the same source" (the brush paints into the set that matches it). @param {any} s */
export function sourceKey(s) {
	const n = sourceOf(s);
	return !n ? '' : n.kind === 'primitive' ? 'p:' + n.type : 'l:' + n.hash;
}

/**
 * Validate a stored/wire block. Sets with a bad source or bytes are DROPPED (never
 * guessed at); empty sets are dropped too, so "erase everything" leaves `sets: []`.
 * @param {any} block @param {(b64: string) => Uint8Array | null} decode
 * @returns {{v: number, sets: {id: string, source: any, align: boolean, data: string, count: number, collider?: string}[]} | null}
 */
export function normalizeScatter(block, decode) {
	if (!block || typeof block !== 'object' || !Array.isArray(block.sets)) return null;
	const sets = [];
	let total = 0;
	for (const s of block.sets.slice(0, MAX_SETS)) {
		if (!s || typeof s !== 'object') continue;
		const source = sourceOf(s.source);
		const bytes = typeof s.data === 'string' ? decode(s.data) : null;
		if (!source || !bytes || bytes.length % 8 !== 0 || !bytes.length) continue;
		const count = bytes.length / 8;
		if (total + count > MAX_INSTANCES) continue;
		total += count;
		const collider = scatterColliderOf(s.collider);
		sets.push({
			id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : sourceKey(source),
			source,
			align: !!s.align,
			data: s.data,
			count,
			...(collider === 'none' ? {} : { collider })
		});
	}
	return { v: SCATTER_VERSION, sets };
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
