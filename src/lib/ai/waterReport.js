// Roadmap 104 A2 + A5 — WHAT AN AGENT IS TOLD ABOUT A BODY OF WATER. Pure over three objects (imports the pure
// water maths only), so list_scene, effects {water} and the screenshot frame text read one answer:
//   waterFacts(object)        → the row's `water {preset, shallowColor, deepColor, level (how full, 0-1), surface (world
//                               height of the still water), shape, waves {height}}` (A5)
//   waveBand(object, grounds) → ground lying inside the wave band over the water's footprint (A2)
// The ocean preset's waves are 0.45 m for the first of six components, which add up to 1.2 m above AND below the
// still surface; a terrain whose skirt sits just under the surface is uncovered by every trough (the owner's
// "green patches in the sea") and a low beach is washed over by every crest.
import { normalizeWater, localBounds } from '$lib/water/volumes.js';
import { waveComponents } from '$lib/water/waves.js';
import { resolveLook } from '$lib/water/presets.js';

/** ground inside the band over less than this (m²) is a shoreline, not a problem */
export const BAND_WARN_AREA = 16;

const r3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/** @param {any} object */
export const isWater = (object) => !!object?.userData?.water && typeof object.userData.water === 'object' && !Array.isArray(object.userData.water);

/**
 * How far the surface rises and falls around its still level (m): the sum of the component amplitudes, which is
 * the crest when they line up. 0 = still water. @param {any} spec a normalized water blob
 */
export function waveHeight(spec) {
	if (resolveLook(spec).frozen) return 0;
	return waveComponents(spec?.waves).reduce((sum, c) => sum + Math.abs(c.a), 0);
}

/**
 * The world height of the still surface of a water object (its `level`, else the top of its box), at its centre.
 * @param {any} object @returns {number}
 */
export function surfaceY(object) {
	const spec = normalizeWater(object.userData.water);
	const b = localBounds(object);
	const level = spec.level ?? b[4];
	object.updateWorldMatrix?.(true, false);
	const e = object.matrixWorld.elements;
	const x = (b[0] + b[3]) / 2;
	const z = (b[2] + b[5]) / 2;
	return e[1] * x + e[5] * level + e[9] * z + e[13];
}

/** how full a water object is, 0-1 (its level within its own box; no level = full) @param {any} object */
export function fillOf(object) {
	const spec = normalizeWater(object.userData.water);
	const b = localBounds(object);
	const h = b[4] - b[1];
	if (spec.level === null || !(h > 0)) return 1;
	return Math.min(1, Math.max(0, (spec.level - b[1]) / h));
}

/** the local Y level for a fill fraction 0-1 @param {any} object @param {number} fill */
export function fillToLevel(object, fill) {
	const b = localBounds(object);
	return b[1] + Math.min(1, Math.max(0, fill)) * (b[4] - b[1]);
}

/**
 * A5: the water half of a list_scene row — the look the person sees, not the box's own material colour.
 * @param {any} object @returns {{preset: string, shallowColor: string, deepColor: string, level: number, surface: number, shape: string, waves?: {height: number}} | null}
 */
export function waterFacts(object) {
	if (!isWater(object)) return null;
	const spec = normalizeWater(object.userData.water);
	const look = resolveLook(spec);
	const height = waveHeight(spec);
	return {
		preset: spec.preset || 'custom',
		shallowColor: String(look.shallowColor),
		deepColor: String(look.deepColor),
		level: r3(fillOf(object)),
		surface: r3(surfaceY(object)),
		shape: spec.shape,
		...(height > 0 ? { waves: { height: r3(height) } } : {})
	};
}

/**
 * A2: how much of the given ground (terrains) lies inside the wave band over the water's footprint, measured on
 * the ground's own vertex grid (each welded column counts its cell). Null = still water, or nothing in the band.
 * @param {any} water @param {any[]} grounds terrain objects
 * @returns {{height: number, surface: number, band: [number, number], area: number, below: number, above: number, on: string[]} | null}
 */
export function waveBand(water, grounds) {
	if (!isWater(water)) return null;
	const spec = normalizeWater(water.userData.water);
	const height = waveHeight(spec);
	if (!(height > 0)) return null;
	const surface = surfaceY(water);
	const lo = surface - height;
	const hi = surface + height;
	// the water's world footprint (x/z), from its own box corners
	const b = localBounds(water);
	const we = water.matrixWorld.elements;
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (let k = 0; k < 8; k++) {
		const x = k & 1 ? b[3] : b[0], y = k & 2 ? b[4] : b[1], z = k & 4 ? b[5] : b[2];
		const wx = we[0] * x + we[4] * y + we[8] * z + we[12];
		const wz = we[2] * x + we[6] * y + we[10] * z + we[14];
		minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
	}
	let area = 0;
	let below = 0;
	let above = 0;
	/** @type {string[]} */
	const on = [];
	for (const g of grounds) {
		const pos = g?.geometry?.attributes?.position;
		if (!pos || g === water) continue;
		g.updateWorldMatrix?.(true, false);
		const e = g.matrixWorld.elements;
		/** @type {Map<string, number>} welded columns (a sculpted terrain is un-indexed: six copies per column) */
		const cols = new Map();
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
			const key = Math.round(x * 1e3) + '|' + Math.round(z * 1e3);
			if (!cols.has(key)) cols.set(key, i);
		}
		if (cols.size < 4) continue;
		g.geometry.computeBoundingBox?.();
		const bb = g.geometry.boundingBox;
		const side = Math.max(1, Math.round(Math.sqrt(cols.size)) - 1);
		const sx = Math.hypot(e[0], e[1], e[2]);
		const sz = Math.hypot(e[8], e[9], e[10]);
		const cell = bb ? (((bb.max.x - bb.min.x) * sx) / side) * (((bb.max.z - bb.min.z) * sz) / side) : 0;
		let hit = 0;
		for (const i of cols.values()) {
			const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
			const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
			const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
			const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
			if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
			if (wy <= lo || wy >= hi) continue;
			hit++;
			if (wy < surface) below += cell;
			else above += cell;
		}
		if (hit) {
			area += hit * cell;
			on.push(g.name || g.uuid);
		}
	}
	if (!(area > 0)) return null;
	return { height: r3(height), surface: r3(surface), band: [r3(lo), r3(hi)], area: Math.round(area), below: Math.round(below), above: Math.round(above), on };
}

/**
 * A2: the warning sentence for a band, or null when the ground in it is only a shoreline.
 * @param {ReturnType<typeof waveBand>} band @returns {string | null}
 */
export function waveBandWarning(band) {
	if (!band || band.area < BAND_WARN_AREA) return null;
	const where = band.on.slice(0, 3).join(', ');
	return (
		'waves rise and fall ' + band.height + ' m around the surface at ' + band.surface + ' m, and about ' + band.area + ' m² of ' + where +
		' lies inside that band (' + band.band[0] + ' to ' + band.band[1] + ' m): troughs uncover the ground just under the surface (' + band.below +
		' m²) and crests wash over the low ground above it (' + band.above + ' m²). Sink the ground below ' + band.band[0] +
		' m (terrain rim), raise it above ' + band.band[1] + ' m, or calm the waves (waves {amplitude})'
	);
}
