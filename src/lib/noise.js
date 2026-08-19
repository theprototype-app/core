// 21-C1: value-noise fBm — a PURE leaf (imports nothing), the dungeonPlay /
// uvUnwrap "pure math, node-testable" shape.
//
// WHY VALUE NOISE AND NOT SIMPLEX: every number below comes out of
// `+ - * / Math.floor Math.imul` and integer bit ops, with a smoothstep
// polynomial `t*t*(3-2t)` for the interpolation. There is NO transcendental
// anywhere — no sin, no cos, no exp, no pow — because IEEE-754 does not pin
// those across JS engines, so two peers on different browsers can legitimately
// disagree in the last bits. That is the same rule dungeon-realms follows (its
// ellipse scatter uses rejection sampling for exactly this reason), and it is
// what makes a terrain built from {seed, params} bit-exact on every peer with no
// geometry on the wire (golden rule 8: determinism IS the netcode).
//
// The float divisions here are by powers of two (2^32), which is exact, and
// Math.imul is defined as a 32-bit integer multiply, so it is exact too.

/**
 * Integer hash -> a float in [0, 1). Deterministic on every engine: 32-bit
 * integer mixing only (the finalizer is murmur3's, whose constants are chosen
 * to avalanche well; any bias here shows up as visible grid artefacts).
 * @param {number} x @param {number} y @param {number=} seed
 */
export function hash2i(x, y, seed = 0) {
	let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
	h = Math.imul(h ^ (h >>> 15), 0x2545f491);
	h ^= h >>> 13;
	h = Math.imul(h, 0x27d4eb2d);
	h ^= h >>> 16;
	// >>> 0 first: the bit ops above leave a SIGNED 32-bit int, and a negative
	// one would map to a negative "noise" value that silently mirrors the field
	return (h >>> 0) / 4294967296;
}

/** the smoothstep polynomial — first derivative zero at both ends, so adjacent
 * cells meet without a crease. Multiplication and subtraction only.
 * @param {number} t */
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * One octave of value noise: hash the four lattice corners of the cell (x, y)
 * falls in and interpolate them smoothly. Output in [0, 1].
 * @param {number} x @param {number} y @param {number=} seed
 */
export function valueNoise2(x, y, seed = 0) {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const tx = smooth(x - xi);
	const ty = smooth(y - yi);
	const a = hash2i(xi, yi, seed);
	const b = hash2i(xi + 1, yi, seed);
	const c = hash2i(xi, yi + 1, seed);
	const d = hash2i(xi + 1, yi + 1, seed);
	const top = a + (b - a) * tx;
	const bottom = c + (d - c) * tx;
	return top + (bottom - top) * ty;
}

/**
 * Fractal Brownian motion: octaves of `valueNoise2` at rising frequency and
 * falling amplitude, normalised by the amplitude sum so the result stays in
 * [0, 1] whatever the octave count — otherwise changing `octaves` alone would
 * change the terrain's HEIGHT as well as its detail.
 *
 * `ridged` folds each octave through `1 - |2v - 1|`, which turns the smooth
 * hills into creased ridges (the fold's peak is where the smooth field crosses
 * its midpoint). Each octave takes its own seed offset, so octave 2 is not a
 * scaled copy of octave 1.
 *
 * @param {number} x @param {number} z
 * @param {{seed?: number, octaves?: number, lacunarity?: number, gain?: number,
 *   frequency?: number, ridged?: boolean}=} options
 */
export function fbm2(x, z, options = {}) {
	const {
		seed = 0,
		octaves = 4,
		lacunarity = 2,
		gain = 0.5,
		frequency = 1,
		ridged = false
	} = options;
	const count = Math.min(Math.max(Math.round(octaves), 1), 8);
	let sum = 0;
	let norm = 0;
	let amp = 1;
	let freq = frequency;
	for (let i = 0; i < count; i++) {
		let v = valueNoise2(x * freq, z * freq, (seed | 0) + i * 1013);
		if (ridged) v = 1 - Math.abs(v * 2 - 1);
		sum += v * amp;
		norm += amp;
		amp *= gain;
		freq *= lacunarity;
	}
	return norm > 0 ? sum / norm : 0;
}
