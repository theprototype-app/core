// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 57.1: VARIABLE-RADIUS tube builder. three's TubeGeometry sweeps ONE radius
// along a curve, so a spline whose thickness changes per control point has to
// generate its own BufferGeometry. Everything here is a pure function of the
// spline record — {points:[{pos,radius}], color, closed} — so every peer that
// holds the same `userData.spline` rebuilds byte-identical geometry (the
// deterministic sync model: the DATA replicates, never the vertex soup).
//
// Radius interpolation aligns with the curve's own control-point mapping:
// CatmullRomCurve3.getPoint(t) walks segments as `(n - (closed?0:1)) * t`, so
// radiusAt uses the SAME formula and each control point's radius lands exactly
// on that point. The vertex rings are arc-length spaced (like TubeGeometry), so
// every sample converts u -> t through getUtoTmapping first.

export const SPLINE_DEFAULTS = {
	radius: 0.05,
	color: '#ff4000',
	closed: false,
	radialSegments: 8,
	segmentsPerSpan: 12
};

/** hard caps: a spline is authored by hand, and the record rides toJSON/GLTF extras */
export const MAX_POINTS = 200;
export const MIN_RADIUS = 0.002;
export const MAX_RADIUS = 50;

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

/** @param {any} value @param {number} fallback */
function num(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce anything that claims to be spline data into the canonical record.
 * Applied on BOTH sides of the wire (a remote `splineedit`, a GLTF round-trip,
 * an AI/undo replay) so a malformed payload can never poison the builder.
 * @param {any} spline @returns {{points: {pos: number[], radius: number}[], color: string, closed: boolean, radialSegments: number, segmentsPerSpan: number}}
 */
export function normalizeSpline(spline) {
	const raw = Array.isArray(spline?.points) ? spline.points.slice(0, MAX_POINTS) : [];
	const points = raw.map((/** @type {any} */ point) => ({
		pos: [num(point?.pos?.[0]), num(point?.pos?.[1]), num(point?.pos?.[2])],
		radius: clamp(num(point?.radius, SPLINE_DEFAULTS.radius) || SPLINE_DEFAULTS.radius, MIN_RADIUS, MAX_RADIUS)
	}));
	return {
		points,
		color: typeof spline?.color === 'string' ? spline.color : SPLINE_DEFAULTS.color,
		closed: !!spline?.closed && points.length > 2,
		radialSegments: Math.round(clamp(num(spline?.radialSegments, SPLINE_DEFAULTS.radialSegments), 3, 32)),
		segmentsPerSpan: Math.round(clamp(num(spline?.segmentsPerSpan, SPLINE_DEFAULTS.segmentsPerSpan), 2, 64))
	};
}

/** Deep copy of a normalized record — history entries must not alias live data. @param {any} spline */
export function cloneSpline(spline) {
	const data = normalizeSpline(spline);
	return { ...data, points: data.points.map((p) => ({ pos: [...p.pos], radius: p.radius })) };
}

/**
 * Radius at curve parameter t, interpolated between the two control points the
 * SAME t falls between inside CatmullRomCurve3.getPoint.
 * @param {number[]} radii @param {number} t @param {boolean} closed
 */
export function radiusAt(radii, t, closed) {
	const n = radii.length;
	if (n === 0) return SPLINE_DEFAULTS.radius;
	if (n === 1) return radii[0];
	const p = (n - (closed ? 0 : 1)) * clamp(t, 0, 1);
	let index = Math.floor(p);
	let weight = p - index;
	if (!closed && index >= n - 1) {
		index = n - 2;
		weight = 1;
	}
	const a = radii[((index % n) + n) % n];
	const b = radii[(index + 1) % n];
	return a + (b - a) * weight;
}

/** The three.js curve for a normalized record (exported so callers can sample it). @param {any} spline */
export function splineCurve(spline) {
	const data = normalizeSpline(spline);
	if (data.points.length < 2) return null;
	const points = data.points.map((p) => new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]));
	return new THREE.CatmullRomCurve3(points, data.closed, 'centripetal', 0.5);
}

/** Tubular sample count for a record — kept in one place so tests can predict it. @param {any} spline */
export function tubularSegmentsFor(spline) {
	const data = normalizeSpline(spline);
	const spans = Math.max(data.closed ? data.points.length : data.points.length - 1, 1);
	return Math.round(clamp(spans * data.segmentsPerSpan, 8, 900));
}

/** three's own default for Curve.getUtoTmapping's second argument: 'derive the
 * arc length from u'. three types that parameter as REQUIRED (its JSDoc says
 * {?number}, which the checker reads as plain number), so one argument is a type
 * error and a literal null is not assignable either. A typed sentinel keeps the
 * call site honest and the behaviour byte-identical.
 * @type {any} */
const NO_DISTANCE = null;

/**
 * Sweep a circle of VARYING radius along the spline. Mirrors TubeGeometry's
 * vertex/index layout (so uvs and shading match a regular tube) and adds flat
 * end caps on open splines — a variable-radius tube shows straight through its
 * open ends, which reads as a hole rather than a stroke.
 * @param {any} spline @returns {any | null} BufferGeometry, or null for < 2 points
 */
export function buildSplineGeometry(spline) {
	const data = normalizeSpline(spline);
	const curve = splineCurve(data);
	if (!curve) return null;
	const radii = data.points.map((p) => p.radius);
	const closed = data.closed;
	const tubular = tubularSegmentsFor(data);
	const radial = data.radialSegments;
	const frames = curve.computeFrenetFrames(tubular, closed);

	/** @type {number[]} */ const positions = [];
	/** @type {number[]} */ const normals = [];
	/** @type {number[]} */ const uvs = [];
	/** @type {number[]} */ const indices = [];
	const center = new THREE.Vector3();
	const normal = new THREE.Vector3();

	for (let i = 0; i <= tubular; i++) {
		const u = i / tubular;
		// arc-length sample -> curve parameter, so the radius lands on its point
		const t = curve.getUtoTmapping(u, NO_DISTANCE);
		curve.getPoint(t, center);
		const radius = radiusAt(radii, t, closed);
		const N = frames.normals[i];
		const B = frames.binormals[i];
		for (let j = 0; j <= radial; j++) {
			const v = (j / radial) * Math.PI * 2;
			const sin = Math.sin(v);
			const cos = -Math.cos(v);
			normal.set(
				cos * N.x + sin * B.x,
				cos * N.y + sin * B.y,
				cos * N.z + sin * B.z
			).normalize();
			positions.push(
				center.x + radius * normal.x,
				center.y + radius * normal.y,
				center.z + radius * normal.z
			);
			normals.push(normal.x, normal.y, normal.z);
			uvs.push(u, j / radial);
		}
	}
	for (let j = 1; j <= tubular; j++) {
		for (let i = 1; i <= radial; i++) {
			const a = (radial + 1) * (j - 1) + (i - 1);
			const b = (radial + 1) * j + (i - 1);
			const c = (radial + 1) * j + i;
			const d = (radial + 1) * (j - 1) + i;
			indices.push(a, b, d, b, c, d);
		}
	}

	if (!closed) {
		appendCap(positions, normals, uvs, indices, radial, 0, curve, frames, false);
		appendCap(positions, normals, uvs, indices, radial, tubular, curve, frames, true);
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(indices);
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
	geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
	geometry.computeBoundingSphere();
	geometry.computeBoundingBox();
	return geometry;
}

/**
 * Flat triangle fan closing one end of an open tube. The fan winding is decided
 * NUMERICALLY against the end's tangent (the ring's own winding depends on the
 * Frenet frame, so a hardcoded order faces inward on one of the two caps).
 * @param {number[]} positions @param {number[]} normals @param {number[]} uvs
 * @param {number[]} indices @param {number} radial @param {number} ring
 * @param {any} curve @param {any} frames @param {boolean} isEnd
 */
function appendCap(positions, normals, uvs, indices, radial, ring, curve, frames, isEnd) {
	const base = (radial + 1) * ring; // first vertex of that ring
	const tangent = frames.tangents[ring];
	const outward = isEnd ? tangent.clone() : tangent.clone().negate();
	const centerIndex = positions.length / 3;
	// the ring's own center: average the ring vertices (exact for a circle)
	let cx = 0, cy = 0, cz = 0;
	for (let j = 0; j < radial; j++) {
		cx += positions[(base + j) * 3];
		cy += positions[(base + j) * 3 + 1];
		cz += positions[(base + j) * 3 + 2];
	}
	cx /= radial;
	cy /= radial;
	cz /= radial;
	positions.push(cx, cy, cz);
	normals.push(outward.x, outward.y, outward.z);
	uvs.push(isEnd ? 1 : 0, 0.5);
	// duplicate the rim with the CAP normal (a shared vertex would smear the
	// tube's side normal across the cap and light it as a dome)
	const rimStart = positions.length / 3;
	for (let j = 0; j <= radial; j++) {
		const from = (base + j) * 3;
		positions.push(positions[from], positions[from + 1], positions[from + 2]);
		normals.push(outward.x, outward.y, outward.z);
		uvs.push(isEnd ? 1 : 0, j / radial);
	}
	// winding test on the first wedge
	const ax = positions[rimStart * 3] - cx;
	const ay = positions[rimStart * 3 + 1] - cy;
	const az = positions[rimStart * 3 + 2] - cz;
	const bx = positions[(rimStart + 1) * 3] - cx;
	const by = positions[(rimStart + 1) * 3 + 1] - cy;
	const bz = positions[(rimStart + 1) * 3 + 2] - cz;
	const nx = ay * bz - az * by;
	const ny = az * bx - ax * bz;
	const nz = ax * by - ay * bx;
	const flip = nx * outward.x + ny * outward.y + nz * outward.z < 0;
	for (let j = 0; j < radial; j++) {
		const a = rimStart + j;
		const b = rimStart + j + 1;
		if (flip) indices.push(centerIndex, b, a);
		else indices.push(centerIndex, a, b);
	}
}

/** Is this object a spline mesh (has an authored record)? @param {any} object */
export function isSplineObject(object) {
	return !!object?.userData?.spline?.points?.length;
}

/** Centroid of a record's control points. @param {any} spline */
export function splineCentroid(spline) {
	const data = normalizeSpline(spline);
	const center = new THREE.Vector3();
	if (!data.points.length) return center;
	data.points.forEach((p) => center.add(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2])));
	return center.multiplyScalar(1 / data.points.length);
}

/**
 * A new control point on the span AFTER `index`, seated on the curve itself
 * (the midpoint of a curved span is NOT the midpoint of its chord) with the
 * radius interpolated the same way the surface is. Returns a NEW record.
 * @param {any} spline @param {number} index @returns {any}
 */
export function insertSplinePoint(spline, index) {
	const data = cloneSpline(spline);
	const n = data.points.length;
	if (n < 2 || index < 0) return data;
	if (!data.closed && index >= n - 1) return data;
	if (data.points.length >= MAX_POINTS) return data;
	const curve = splineCurve(data);
	if (!curve) return data;
	const spans = data.closed ? n : n - 1;
	const t = (index + 0.5) / spans;
	const point = curve.getPoint(t);
	const radius = radiusAt(
		data.points.map((p) => p.radius),
		t,
		data.closed
	);
	data.points.splice(index + 1, 0, {
		pos: [point.x, point.y, point.z],
		radius: clamp(radius, MIN_RADIUS, MAX_RADIUS)
	});
	return data;
}

/**
 * Drop a control point. A spline needs 2 — refuses below that so a stray
 * right-click can never leave an un-buildable record behind.
 * @param {any} spline @param {number} index @returns {any | null} null = refused
 */
export function removeSplinePoint(spline, index) {
	const data = cloneSpline(spline);
	if (data.points.length <= 2 || index < 0 || index >= data.points.length) return null;
	data.points.splice(index, 1);
	if (data.points.length < 3) data.closed = false;
	return data;
}

/**
 * Multiplicative radius response for a drag — scale-free, so the same gesture
 * feels the same on a 0.01 and a 5 unit tube. `delta` is "up is positive" in
 * whatever unit the caller measures (screen pixels desktop, meters in VR) and
 * `gain` converts it. Pure: the headless tests drive this directly.
 * @param {number} radius0 @param {number} delta @param {number} gain
 */
export function radiusFromDrag(radius0, delta, gain) {
	return clamp(radius0 * Math.exp(delta * gain), MIN_RADIUS, MAX_RADIUS);
}

/** desktop: screen pixels · VR: meters */
export const RADIUS_GAIN_PIXELS = 0.01;
export const RADIUS_GAIN_METERS = 4;
