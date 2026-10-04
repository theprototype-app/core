// 36-water — Gerstner wave maths shared by the GPU surface (waterShader) and the CPU
// query (volumes.js → buoyancy in 36-sim). Pure: imports NOTHING, so it runs in the unit
// layer and in a worker. One `waves` blob (userData.water.waves) expands into the SAME
// component list on every peer and on both sides of the CPU/GPU line — that is the whole
// determinism story: the inputs are replicated params + the synced clock, never vertices.
//
// Units: world metres and seconds. Waves are evaluated on WORLD x/z, so two pools side by
// side with the same params ripple in step and the query needs no per-volume frame.

/** Most components a surface evaluates (shader uniform arrays are sized to this). */
export const MAX_WAVES = 8;
const G = 9.81;

/** @type {any} */
export const WAVE_DEFAULTS = {
	count: 4, // components (0 = flat)
	amplitude: 0, // m, the first component; later ones shrink (0 = still; presets set it)
	wavelength: 4, // m, the first component; later ones shorten
	speed: 1, // × deep-water phase speed
	direction: 0, // degrees, 0 = +X, 90 = +Z
	choppiness: 0.5 // 0 = sine swell, 1 = sharp crests (Gerstner Q)
};

/** @param {any} v @param {number} d */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Full wave params (defaults filled, clamped). @param {any} waves */
export function normalizeWaves(waves) {
	const w = { ...WAVE_DEFAULTS, ...(waves && typeof waves === 'object' ? waves : {}) };
	return {
		count: Math.max(0, Math.min(MAX_WAVES, Math.round(num(w.count, WAVE_DEFAULTS.count)))),
		amplitude: Math.max(0, num(w.amplitude, WAVE_DEFAULTS.amplitude)),
		wavelength: Math.max(0.05, num(w.wavelength, WAVE_DEFAULTS.wavelength)),
		speed: num(w.speed, WAVE_DEFAULTS.speed),
		direction: num(w.direction, WAVE_DEFAULTS.direction),
		choppiness: Math.max(0, Math.min(1, num(w.choppiness, WAVE_DEFAULTS.choppiness)))
	};
}

// fixed spread pattern (no RNG — identical everywhere): direction offsets in degrees and
// the per-component wavelength / amplitude falloff
const SPREAD = [0, 31, -23, 57, -49, 13, -71, 83];
const LEN = [1, 0.62, 0.41, 0.29, 0.21, 0.155, 0.12, 0.09];

/**
 * Expand a waves blob into components: unit direction (dx, dz), wavenumber k, angular
 * speed w, amplitude a and steepness q (Gerstner Q, pre-divided so the sum stays loop-free).
 * @param {any} waves
 * @returns {{dx:number,dz:number,k:number,w:number,a:number,q:number}[]}
 */
export function waveComponents(waves) {
	const p = normalizeWaves(waves);
	/** @type {{dx:number,dz:number,k:number,w:number,a:number,q:number}[]} */
	const out = [];
	if (!p.count || !p.amplitude) return out;
	for (let i = 0; i < p.count; i++) {
		const deg = p.direction + SPREAD[i];
		const rad = (deg * Math.PI) / 180;
		const L = p.wavelength * LEN[i];
		const k = (2 * Math.PI) / L;
		const a = p.amplitude * LEN[i];
		const w = Math.sqrt(G * k) * p.speed;
		// Q·k·A·N ≤ 1 keeps crests from looping over themselves
		const q = p.choppiness / Math.max(1e-6, k * a * p.count);
		out.push({ dx: Math.cos(rad), dz: Math.sin(rad), k, w, a, q });
	}
	return out;
}

/**
 * Gerstner displacement of the rest point (x, z) at time t.
 * @param {ReturnType<typeof waveComponents>} comps @param {number} x @param {number} z @param {number} t
 * @returns {[number, number, number]} [dx, dy, dz]
 */
export function gerstnerOffset(comps, x, z, t) {
	let ox = 0;
	let oy = 0;
	let oz = 0;
	for (const c of comps) {
		const ph = c.k * (c.dx * x + c.dz * z) - c.w * t;
		const cs = Math.cos(ph);
		ox += c.q * c.a * c.dx * cs;
		oz += c.q * c.a * c.dz * cs;
		oy += c.a * Math.sin(ph);
	}
	return [ox, oy, oz];
}

/**
 * Surface height offset (m, relative to the still level) ABOVE the world point (x, z).
 * Gerstner moves points sideways, so the vertex over (x, z) started elsewhere: eight
 * fixed-point steps find it (sub-millimetre up to choppiness 0.8 — unit-tested; the
 * sharpest crests converge slower, which a buoyant body never notices).
 * @param {ReturnType<typeof waveComponents>} comps @param {number} x @param {number} z @param {number} t
 */
export function waveHeightAt(comps, x, z, t) {
	if (!comps.length) return 0;
	let px = x;
	let pz = z;
	for (let i = 0; i < 8; i++) {
		const o = gerstnerOffset(comps, px, pz, t);
		px = x - o[0];
		pz = z - o[2];
	}
	return gerstnerOffset(comps, px, pz, t)[1];
}
