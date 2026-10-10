// 37 R5 — the starter set's PROCEDURAL maps (wood grain, stone), generated on each device.
//
// Why procedural and not shipped images: a starter preset is never stored or broadcast (every
// peer has the same seven), so its maps cost nothing on the wire only if they cost nothing in
// the bundle either. The height fields are pure functions of fixed seeds and TILE (the lattice
// wraps at the map edge), so a repeat across a big floor shows no seam. The image an apply
// sends over the wire is the encoded data-URL, exactly as a user-picked texture travels — a
// peer never has to regenerate anything to agree.
//
// The colour map is a LUMINANCE map (0.62..1.0): the preset's colour tints it, so recolouring
// wood in the Inspector gives a different wood instead of a brown multiply on a brown image.

/** the map resolution — 256² tiles cleanly and encodes to ~20-40 KB of webp */
export const MAP_SIZE = 256;

/** tileable value noise: the lattice wraps at px × py cells
 * @param {number} x @param {number} y @param {number} px @param {number} py @param {number} seed */
function tileNoise(x, y, px, py, seed) {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const tx = x - xi;
	const ty = y - yi;
	const sx = tx * tx * (3 - 2 * tx);
	const sy = ty * ty * (3 - 2 * ty);
	const wx = (/** @type {number} */ i) => ((i % px) + px) % px;
	const wy = (/** @type {number} */ i) => ((i % py) + py) % py;
	const a = hash(wx(xi), wy(yi), seed);
	const b = hash(wx(xi + 1), wy(yi), seed);
	const c = hash(wx(xi), wy(yi + 1), seed);
	const d = hash(wx(xi + 1), wy(yi + 1), seed);
	const top = a + (b - a) * sx;
	const bottom = c + (d - c) * sx;
	return top + (bottom - top) * sy;
}

/** integer hash → [0, 1) (the noise.js avalanche, inlined so this leaf imports nothing) */
function hash(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ seed) {
	let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
	h = Math.imul(h ^ (h >>> 15), 0x2545f491);
	h ^= h >>> 13;
	h = Math.imul(h, 0x27d4eb2d);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

/** tileable fBm over [0,1)², `cu` × `cv` base cells (integers, so every octave wraps)
 * @param {number} u @param {number} v @param {number} cu @param {number} cv @param {number} octaves @param {number} seed */
function tileFbm(u, v, cu, cv, octaves, seed) {
	let sum = 0;
	let norm = 0;
	let amp = 1;
	let pu = cu;
	let pv = cv;
	for (let i = 0; i < octaves; i++) {
		sum += tileNoise(u * pu, v * pv, pu, pv, seed + i * 1013) * amp;
		norm += amp;
		amp *= 0.5;
		pu *= 2;
		pv *= 2;
	}
	return sum / norm;
}

// 40 F16: FISH SCALES — overlapping rounded scales in offset rows, each hanging DOWN from its
// centre like a shingle, the lower row in front. SCALE_ROWS rows × SCALE_COLS columns per tile
// (integers, and odd rows shift half a scale, so an even row count keeps the tile seamless).
const SCALE_ROWS = 10;
const SCALE_COLS = 8;

/**
 * The height of the scale pattern at (u, v) in [0, 1]: a domed scale (highest near its free
 * edge's middle, a crisp drop at its rim) over whatever scale lies behind it.
 * @param {number} u @param {number} v
 */
export function scaleHeight(u, v) {
	const rowH = 1 / SCALE_ROWS;
	const colW = 1 / SCALE_COLS;
	const R = colW * 0.62;
	const row0 = Math.floor(v * SCALE_ROWS);
	// front to back: the row whose centres sit just above this pixel hangs over it first
	for (let dr = 0; dr <= 2; dr++) {
		const row = row0 - dr;
		const cy = row * rowH;
		const shift = ((row % 2) + 2) % 2 ? 0.5 : 0;
		const c0 = Math.floor(u * SCALE_COLS - shift);
		for (let dc = -1; dc <= 1; dc++) {
			const cx = (c0 + dc + 0.5 + shift) * colW;
			let dx = u - cx;
			dx -= Math.round(dx); // wrap across the tile edge
			let dy = v - cy;
			dy -= Math.round(dy);
			if (dy <= 0) continue; // a scale hangs below its centre only (strict: v = 0 and v = 1 are one row)
			const d = Math.hypot(dx, dy * (colW / rowH) * 0.9) / R;
			if (d >= 1) continue;
			// a soft dome with a raised rim: the light catches each scale's edge
			const dome = Math.sqrt(1 - d * d);
			const rim = d > 0.82 ? (d - 0.82) * 2.2 : 0;
			return Math.min(1, 0.35 + dome * 0.5 + rim);
		}
	}
	return 0.25;
}

/**
 * The height field of a kind, size×size in [0, 1], tileable in both directions.
 * @param {'wood'|'stone'|'scales'} kind @param {number} [size]
 * @returns {Float32Array}
 */
export function heightField(kind, size = MAP_SIZE) {
	const out = new Float32Array(size * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = x / size;
			const v = y / size;
			let h;
			if (kind === 'wood') {
				// planks of grain running along u: rings are a sine of v warped by low-frequency
				// noise, plus fine streaks — all periodic in u and v so the tile wraps
				const warp = tileFbm(u, v, 2, 2, 3, 11) * 6;
				const rings = 0.5 + 0.5 * Math.sin((v * 9 + warp) * Math.PI * 2);
				const streak = tileFbm(u, v, 6, 64, 2, 23); // long along u, fine across v
				const board = Math.floor(v * 4) % 2 ? 0.04 : 0; // alternate planks a touch
				h = rings * 0.55 + streak * 0.4 + board;
				// a thin dark seam between planks
				const seam = Math.abs(((v * 4) % 1) - 0.5) > 0.485 ? 0.35 : 0;
				h = Math.max(0, h - seam);
			} else if (kind === 'scales') {
				h = scaleHeight(u, v);
			} else {
				// stone: broad blotches, a crisp mid band and grit
				const broad = tileFbm(u, v, 3, 3, 4, 41);
				const grit = tileFbm(u, v, 48, 48, 2, 59);
				const cracks = 1 - Math.min(1, Math.abs(tileFbm(u, v, 6, 6, 3, 71) - 0.5) * 14);
				h = broad * 0.65 + grit * 0.35 - cracks * 0.25;
			}
			out[y * size + x] = Math.min(1, Math.max(0, h));
		}
	}
	return out;
}

/**
 * RGBA bytes for the luminance colour map and the tangent-space normal map of a height field.
 * The normal comes from central differences that WRAP, so it tiles like the height does.
 * @param {Float32Array} height @param {number} size @param {number} strength
 */
export function mapBytes(height, size, strength = 3) {
	const color = new Uint8ClampedArray(size * size * 4);
	const normal = new Uint8ClampedArray(size * size * 4);
	const at = (/** @type {number} */ x, /** @type {number} */ y) =>
		height[((y + size) % size) * size + ((x + size) % size)];
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			const lum = Math.round((0.62 + height[y * size + x] * 0.38) * 255);
			color[i] = color[i + 1] = color[i + 2] = lum;
			color[i + 3] = 255;
			const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
			const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
			const len = Math.hypot(dx, dy, 1);
			normal[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
			// canvas y runs down while uv v runs up (flipY), so the green channel is flipped
			normal[i + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
			normal[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
			normal[i + 3] = 255;
		}
	}
	return { color, normal };
}

/** @type {Map<string, {map: string, normalMap: string}>} */
const cache = new Map();

/**
 * The encoded maps of a procedural kind (browser only; null elsewhere). Cached per session,
 * so swatches, applies and the active-swatch compare all see the same strings.
 * @param {'wood'|'stone'|'scales'} kind
 * @returns {{map: string, normalMap: string} | null}
 */
export function proceduralMaps(kind) {
	const hit = cache.get(kind);
	if (hit) return hit;
	if (typeof document === 'undefined') return null;
	try {
		const size = MAP_SIZE;
		const { color, normal } = mapBytes(heightField(kind, size), size, kind === 'wood' ? 2.5 : kind === 'scales' ? 3 : 4);
		const encode = (/** @type {Uint8ClampedArray} */ bytes, /** @type {boolean} */ hq) => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = size;
			const ctx = canvas.getContext('2d');
			if (!ctx) return '';
			ctx.putImageData(new ImageData(/** @type {any} */ (bytes), size, size), 0, 0);
			// a normal map is DATA, so it is encoded at a higher quality than the colour map
			const webp = canvas.toDataURL('image/webp', hq ? 0.95 : 0.85);
			return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88);
		};
		const maps = { map: encode(color, false), normalMap: encode(normal, true) };
		if (!maps.map || !maps.normalMap) return null;
		cache.set(kind, maps);
		return maps;
	} catch {
		return null;
	}
}
