import { splineCurve, normalizeSpline } from './splineTube.js';
// (the .js is deliberate: it keeps this leaf importable straight from node, which
// is what makes the maths testable with no vite, no GL and no scene.)

// 21-C4: checkpoints DERIVED from a road, never authored as loose data.
//
// The road IS a Spline object in objectsGroup carrying userData.spline — already
// replicated by toJSON, already saved in a .tpscene, already editable by any peer
// and normalizeSpline'd on both sides of the wire. So every peer computes the
// identical gate list from the same data with ZERO messages: determinism is the
// netcode, the same reasoning as the dungeon raster. Move a control point and the
// gates follow, because there is nothing to keep in sync.
//
// A LEAF (splineTube only, and no THREE of its own — the curve does the vector
// work), so the lap logic is testable in node with no scene and no GL.

/** @param {any} value @param {number} fallback */
const num = (value, fallback) => {
	const parsed = parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Per-point radius at an ARC-LENGTH fraction u.
 *
 * splineTube's own `radiusAt` takes the CURVE parameter t, and u is not t on
 * anything but a uniformly spaced spline — so a gate on a bunched span would read
 * the wrong width if it reused that. Here the mapping is deliberately in u.
 * @param {number[]} radii @param {number} u @param {boolean} closed
 */
function radiusAtU(radii, u, closed) {
	const n = radii.length;
	if (n === 0) return 1;
	if (n === 1) return radii[0];
	const span = (n - (closed ? 0 : 1)) * Math.min(Math.max(u, 0), 1);
	const index = Math.min(Math.floor(span), n - 1);
	const weight = span - index;
	const a = radii[index % n];
	const b = radii[(index + 1) % n];
	return a + (b - a) * weight;
}

/**
 * `count` gates evenly spaced ALONG THE TARMAC.
 *
 * `getPointAt` is arc-length parameterised, which is the whole point: `getPoint`
 * spaces by control-point index, so gates would crowd wherever the points do.
 * Gate 0 sits at the start (the finish line on a closed loop); the last gate stops
 * short of the wrap, so a closed road does not get two gates in the same place.
 *
 * @param {any} roadObject the spline mesh (record read in ITS OWN local frame)
 * @param {number} count
 * @returns {{index: number, u: number, position: number[], tangent: number[], width: number}[]}
 */
export function checkpointsFor(roadObject, count) {
	const record = roadObject?.userData?.spline;
	const curve = splineCurve(record);
	const total = Math.max(Math.round(num(count, 0)), 0);
	if (!curve || total < 1) return [];
	const data = normalizeSpline(record);
	const radii = data.points.map((/** @type {any} */ p) => p.radius);
	// an OPEN road ends at u = 1 and should get a gate there; a CLOSED one wraps,
	// so u = 1 is u = 0 and the spacing has to divide the loop instead
	const divisor = data.closed ? total : Math.max(total - 1, 1);
	const out = [];
	for (let i = 0; i < total; i++) {
		const u = total === 1 ? 0 : Math.min(i / divisor, 1);
		const point = curve.getPointAt(u);
		const tangent = curve.getTangentAt(u);
		out.push({
			index: i,
			u,
			position: [point.x, point.y, point.z],
			// gates face ALONG the road; the caller turns this into a rotation
			tangent: [tangent.x, tangent.y, tangent.z],
			// the gate spans the road, so its width is the tube's DIAMETER there
			width: radiusAtU(radii, u, data.closed) * 2
		});
	}
	return out;
}

/**
 * Where a car is along the road: arc-length fraction, lateral distance, and which
 * quarter of the lap it is in. PURE and stateless — the caller keeps the flags
 * between frames.
 *
 * This exists because GATES ALONE CANNOT COUNT A LAP correctly. A driver reversing
 * back and forth over the finish line would farm laps off gate crossings, and the
 * naive interval between two positions is the part NOT travelled once the
 * parameter wraps (the animation loop-wrap lesson, one domain over). So progress
 * is the authority and the gates are the visible, wireable half.
 *
 * @param {any} roadObject @param {number[]} xz [x, z] in the ROAD's local frame
 * @param {number=} samples projection resolution
 * @returns {{u: number, distance: number, quadrant: number} | null}
 */
export function progressAlong(roadObject, xz, samples = 240) {
	const curve = splineCurve(roadObject?.userData?.spline);
	if (!curve) return null;
	const count = Math.min(Math.max(Math.round(num(samples, 240)), 8), 4000);
	const points = curve.getSpacedPoints(count);
	let best = 0;
	let bestDistSq = Infinity;
	for (let i = 0; i < points.length; i++) {
		const dx = points[i].x - num(xz?.[0], 0);
		const dz = points[i].z - num(xz?.[1], 0);
		const distSq = dx * dx + dz * dz;
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			best = i;
		}
	}
	const u = Math.min(best / count, 1);
	return { u, distance: Math.sqrt(bestDistSq), quadrant: Math.min(Math.floor(u * 4), 3) };
}

/** a fresh lap tracker. Plain data so a module can keep it in its own state and a
 * test can drive it without a scene. @param {number=} laps */
export function newLapState(laps = 0) {
	return { laps, quadrants: [false, false, false, false], lastU: 0, lastQuadrant: -1 };
}

/**
 * Feed one sample into a lap tracker. A lap counts only when the playhead wraps
 * from the last quarter back to the first AND all four quadrant flags are set —
 * which is what stops both cheats: reversing over the line (never sets the middle
 * flags) and sitting on the line (the wrap needs quadrant 3 first).
 *
 * @param {any} state from `newLapState`
 * @param {{u: number, quadrant: number}} progress from `progressAlong`
 * @returns {{lapped: boolean, laps: number, quadrants: boolean[]}}
 */
export function trackLap(state, progress) {
	if (!state || !progress) return { lapped: false, laps: state?.laps ?? 0, quadrants: state?.quadrants ?? [] };
	const { u, quadrant } = progress;
	state.quadrants[quadrant] = true;
	// the WRAP is the only place a lap can complete: u fell a long way, which is a
	// jump from near-1 to near-0 rather than driving backwards a little
	const wrapped = state.lastU > 0.75 && u < 0.25;
	const complete = wrapped && state.quadrants.every(Boolean);
	if (complete) {
		state.laps += 1;
		state.quadrants = [false, false, false, false];
		state.quadrants[quadrant] = true;
	}
	state.lastU = u;
	state.lastQuadrant = quadrant;
	return { lapped: complete, laps: state.laps, quadrants: state.quadrants.slice() };
}
