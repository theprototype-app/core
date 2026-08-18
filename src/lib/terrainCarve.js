import * as THREE from 'three';
import { splineCurve, normalizeSpline } from './splineTube.js';
// (the .js is deliberate: it keeps this leaf importable straight from node, which
// is what makes the maths testable with no vite, no GL and no scene.)

// 21-C3: flatten a road bed into a terrain along a spline.
//
// This module is a LEAF on purpose (THREE + splineTube, nothing else) and
// `carveAlongSpline` is PURE: it reads a terrain's positions and returns a new
// Float32Array, and the CALLER commits. That is the uvUnwrap backend shape, and
// it is what makes the op property-testable with no GL context and no scene —
// which matters here, because every interesting claim about a carve is geometric
// ("inside the road lands on the curve", "outside the shoulder is untouched")
// rather than visual.
//
// REPLICATION: none of its own. A terrain is objectsGroup content and the commit
// is a `meshgeo` snapshot, so golden rule 6 covers it verbatim. The vertex COUNT
// never changes (only Y moves), so `commitMeshGeoSnapshot` is the right commit —
// groups and uvs carry over, and commitMeshGeoTriple is for count-changing ops.

/** @type {{width: number, shoulder: number, mode: 'flatten'|'lower'|'raise', bankToCurve: boolean, clearance: number}} */
export const CARVE_DEFAULTS = {
	width: 6,
	shoulder: 3,
	mode: 'flatten',
	bankToCurve: false,
	clearance: 0
};

/** @param {any} value @param {number} fallback */
const num = (value, fallback) => {
	const parsed = parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

/** the same smoothstep the noise uses, so a road's shoulder blends like the
 * terrain it sits in @param {number} edge0 @param {number} edge1 @param {number} x */
function smoothstep(edge0, edge1, x) {
	if (edge1 <= edge0) return x < edge0 ? 0 : 1;
	const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
	return t * t * (3 - 2 * t);
}

/**
 * The (x, z) lattice PITCH of a terrain: read from its own params rather than
 * searched for, and derived from the mesh only if the stamp is missing.
 * @param {any} terrain @param {any} position
 */
function latticePitch(terrain, position) {
	const params = terrain?.userData?.geometryParams?.params;
	const size = num(params?.size, 0);
	const segments = Math.round(num(params?.segments, 0));
	if (size > 0 && segments > 0) return size / segments;
	// no stamp: fall back to the bounding box over the grid side
	let minX = Infinity;
	let maxX = -Infinity;
	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
	}
	const side = Math.max(Math.round(Math.sqrt(position.count)) - 1, 1);
	return maxX > minX ? (maxX - minX) / side : 1;
}

/**
 * Move a spline RECORD into another object's local frame. The record's points
 * are in the spline mesh's own local space (finishSpline re-seats them around
 * the centroid), and a terrain has its own transform, so a carve that skipped
 * this would flatten the wrong strip — silently, and plausibly, since the shape
 * would still look like a road.
 * @param {any} splineObject the mesh carrying userData.spline
 * @param {any} targetObject the terrain
 * @returns {any | null} a spline record in the target's local frame
 */
export function splineInFrameOf(splineObject, targetObject) {
	const record = splineObject?.userData?.spline;
	if (!record?.points?.length || !targetObject) return null;
	splineObject.updateMatrixWorld(true);
	targetObject.updateMatrixWorld(true);
	const point = new THREE.Vector3();
	return normalizeSpline({
		...record,
		points: record.points.map((/** @type {any} */ p) => {
			point.set(p.pos[0], p.pos[1], p.pos[2]);
			splineObject.localToWorld(point);
			targetObject.worldToLocal(point);
			return { pos: [point.x, point.y, point.z], radius: p.radius };
		})
	});
}

/**
 * Flatten / lower / raise a terrain's vertices toward a spline's height along it.
 *
 * `spline` must already be in the TERRAIN's local frame — use `splineInFrameOf`.
 * Returns a NEW Float32Array of positions (never mutates), or null when there is
 * nothing to carve.
 *
 * @param {any} terrain a Mesh whose geometry has a position attribute
 * @param {any} spline a spline record (points in the terrain's local frame)
 * @param {{width?: number, shoulder?: number, mode?: 'flatten'|'lower'|'raise',
 *   bankToCurve?: boolean, clearance?: number}=} options
 * @returns {Float32Array | null}
 */
export function carveAlongSpline(terrain, spline, options = {}) {
	const position = terrain?.geometry?.attributes?.position;
	if (!position) return null;
	const curve = splineCurve(spline);
	if (!curve) return null;

	const width = Math.max(num(options.width, CARVE_DEFAULTS.width), 0.01);
	const shoulder = Math.max(num(options.shoulder, CARVE_DEFAULTS.shoulder), 0);
	const clearance = num(options.clearance, CARVE_DEFAULTS.clearance);
	const mode = options.mode === 'lower' || options.mode === 'raise' ? options.mode : 'flatten';
	const bank = !!options.bankToCurve;
	const half = width / 2;
	const reach = half + shoulder;

	// ARC-LENGTH spaced samples, so the projection step is uniform along the road
	// (getPoint would bunch them up wherever the control points are close). Two
	// samples per lattice cell, and never coarser than half the reach — if the
	// spacing were larger than the reach, a vertex could sit between two samples
	// and its "distance to the nearest sample" would overstate its distance to the
	// CURVE, leaving unflattened bites out of the road.
	const pitch = latticePitch(terrain, position);
	const length = curve.getLength();
	const wanted = Math.max(Math.ceil((length / Math.max(pitch, 1e-4)) * 2), Math.ceil(length / (reach / 2)), 2);
	const count = Math.min(wanted, 4000);
	const samples = curve.getSpacedPoints(count);

	// XZ hash grid, cell = the reach, so a vertex only ever tests the samples in
	// its own cell and the eight around it: O(1) per vertex instead of O(samples)
	const cell = reach;
	/** @type {Map<string, number[]>} */
	const buckets = new Map();
	const keyOf = (/** @type {number} */ x, /** @type {number} */ z) =>
		Math.floor(x / cell) + ',' + Math.floor(z / cell);
	samples.forEach((sample, index) => {
		const key = keyOf(sample.x, sample.z);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(index);
		else buckets.set(key, [index]);
	});

	const out = new Float32Array(position.array.length);
	out.set(position.array);

	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		const z = position.getZ(i);
		const cx = Math.floor(x / cell);
		const cz = Math.floor(z / cell);
		let best = -1;
		let bestDistSq = Infinity;
		for (let ox = -1; ox <= 1; ox++)
			for (let oz = -1; oz <= 1; oz++) {
				const bucket = buckets.get(cx + ox + ',' + (cz + oz));
				if (!bucket) continue;
				for (const index of bucket) {
					const sample = samples[index];
					const dx = sample.x - x;
					const dz = sample.z - z;
					const distSq = dx * dx + dz * dz;
					if (distSq < bestDistSq) {
						bestDistSq = distSq;
						best = index;
					}
				}
			}
		if (best < 0) continue; // nothing within reach: this vertex is not road

		const distance = Math.sqrt(bestDistSq);
		const weight = 1 - smoothstep(half, reach, distance);
		if (weight <= 0) continue;

		const sample = samples[best];
		let target = sample.y - clearance;

		if (bank && distance > 1e-6) {
			// Bank the bed across its width: tilt by the SIGNED lateral offset times
			// the local turn rate, so the outside of a bend rides higher. The turn
			// rate comes from the two neighbouring samples (a discrete curvature),
			// and the tilt is clamped to a quarter of the width so a hairpin cannot
			// stand the road on its edge.
			const previous = samples[Math.max(best - 1, 0)];
			const next = samples[Math.min(best + 1, samples.length - 1)];
			const tx = next.x - previous.x;
			const tz = next.z - previous.z;
			const tangentLength = Math.hypot(tx, tz);
			if (tangentLength > 1e-6) {
				// signed side: the 2D cross product of the tangent with the offset
				const side = (tx * (z - sample.z) - tz * (x - sample.x)) / tangentLength;
				const turn =
					(tx * (next.z - 2 * sample.z + previous.z) - tz * (next.x - 2 * sample.x + previous.x)) /
					(tangentLength * tangentLength * tangentLength);
				target += Math.min(Math.max(side * turn * width, -width / 4), width / 4);
			}
		}

		const current = out[i * 3 + 1];
		// 'lower' only cuts and 'raise' only fills, so a road can be dug through a
		// hill without also building a causeway across the valley beyond it
		if (mode === 'lower') target = Math.min(current, target);
		else if (mode === 'raise') target = Math.max(current, target);
		out[i * 3 + 1] = current + (target - current) * weight;
	}
	return out;
}
