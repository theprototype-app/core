// 85 N5 — Wind Sway and Flowing Water, the PURE half (imports nothing): parameter clamps, the
// wind's gust curve and the uv scroll, so the three half (swayNodes.js) only moves numbers into
// uniforms. Everything is a function of the shared clock: two peers see the same gust.

/** @param {any} v @param {number} fallback @param {number} lo @param {number} hi */
export function clampNum(v, fallback, lo, hi) {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return n < lo ? lo : n > hi ? hi : n;
}

export const SWAY_DEFAULTS = Object.freeze({
	mode: 'plant',
	anchor: 'bottom',
	strength: 0.15,
	frequency: 0.6,
	gust: 0.5,
	direction: 0,
	wavelength: 1,
	flutter: 0.3
});

export const WATER_DEFAULTS = Object.freeze({
	speed: 0.1,
	direction: 0,
	swell: 0.03,
	swellSize: 2,
	ripples: true
});

/** the anchor faces, as (axis index, sign): bottom = -y … front = +z */
export const ANCHORS = /** @type {Record<string, [number, number]>} */ ({
	bottom: [1, -1],
	top: [1, 1],
	left: [0, -1],
	right: [0, 1],
	back: [2, -1],
	front: [2, 1]
});

/**
 * The gust envelope (0.4..1.6 around 1) at `time`: two slow incommensurate sines so it never
 * visibly repeats; `gust` 0 = a steady breeze. Pure of the clock (every peer the same gust).
 * @param {number} time @param {number} gust
 */
export function gustAt(time, gust) {
	const g = Math.max(0, Math.min(1, gust));
	const w = 0.6 * Math.sin(time * 0.31 * 2 * Math.PI) + 0.4 * Math.sin(time * 0.137 * 2 * Math.PI + 1.7);
	return 1 + g * 0.6 * w;
}

/**
 * The wind sway's uniforms for one object: the anchor axis and range along it from local bounds,
 * the bend direction in the object's frame, and the per-frame drive. `windLocal` = the wind's
 * heading already turned into the object's frame by the caller (a unit 3-vector).
 * @param {any} data @param {{min: number[], max: number[]}} box @param {number[]} windLocal @param {number} time
 */
export function swayParams(data, box, windLocal, time) {
	const d = SWAY_DEFAULTS;
	const mode = data?.mode === 'flag' ? 'flag' : 'plant';
	const anchor = ANCHORS[data?.anchor] ? data.anchor : mode === 'flag' ? 'left' : 'bottom';
	const [ai, sign] = ANCHORS[anchor];
	// the axis runs FROM the anchor face outwards
	const axis = [0, 0, 0];
	axis[ai] = -sign;
	const lo = box.min[ai];
	const hi = box.max[ai];
	const len = Math.max(1e-3, hi - lo);
	// the base along `axis`: the anchor face's coordinate in that signed axis
	const base = sign < 0 ? lo : -hi;
	// flag: it flaps along its THINNEST axis (a flag cloth), never the anchor axis
	const ext = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
	let thin = 0;
	for (let i = 1; i < 3; i++) if (i !== ai && (thin === ai || ext[i] < ext[thin])) thin = i;
	if (thin === ai) thin = (ai + 1) % 3;
	const side = [0, 0, 0];
	side[thin] = 1;
	const strength = clampNum(data?.strength, d.strength, 0, 5);
	const frequency = clampNum(data?.frequency, d.frequency, 0, 10);
	const flutter = clampNum(data?.flutter, d.flutter, 0, 1);
	const k = 1 / clampNum(data?.wavelength, d.wavelength, 0.05, 50);
	const g = gustAt(time, clampNum(data?.gust, d.gust, 0, 1));
	// the bend direction: a plant bends WITH the wind (perpendicular to its axis); a flag waves on its side
	let bend = side;
	if (mode === 'plant') {
		const along = windLocal[0] * axis[0] + windLocal[1] * axis[1] + windLocal[2] * axis[2];
		const b = [windLocal[0] - along * axis[0], windLocal[1] - along * axis[1], windLocal[2] - along * axis[2]];
		const l = Math.hypot(b[0], b[1], b[2]);
		bend = l > 1e-4 ? b.map((x) => x / l) : side;
	}
	// phase wraps on the shared clock so float precision holds on a large session time
	const phase = (time * frequency) % 1000;
	return { mode: mode === 'flag' ? 1 : 0, axis, base, len, bend, strength: strength * g, k, phase, flutter };
}

/**
 * Flowing Water's uv offset at `time` for a map with `repeat` — the scroll wraps at one tile so
 * the number stays small; `speed` in tiles per second.
 * @param {any} data @param {number} time @returns {[number, number]}
 */
export function flowOffset(data, time) {
	const speed = clampNum(data?.speed, WATER_DEFAULTS.speed, -10, 10);
	const dir = (clampNum(data?.direction, 0, -360, 360) * Math.PI) / 180;
	const s = time * speed;
	const u = (((s * Math.cos(dir)) % 1) + 1) % 1;
	const v = (((s * Math.sin(dir)) % 1) + 1) % 1;
	return [u, v];
}
