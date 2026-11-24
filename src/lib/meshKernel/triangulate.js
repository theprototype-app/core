// Roadmap 99 K1: n-gon triangulation, OUTPUT only (the kernel stores faces, never triangles).
//
// Ear clipping in the plane of the polygon's Newell normal. Triangles keep the polygon's winding,
// so a face that faces +n gives triangles that face +n. A polygon too folded to clip (a self-
// intersecting loop, a zero-area sliver) falls back to a fan from corner 0: always n - 2 triangles,
// always the right winding order, never a hole in the output.

/**
 * @param {ArrayLike<number>} coords x,y,z per corner
 * @param {number} n corner count
 * @returns {number[]} 3 local corner indices per triangle (n - 2 triangles)
 */
export function triangulatePolygon(coords, n) {
	if (n < 3) return [];
	if (n === 3) return [0, 1, 2];
	// Newell normal
	let nx = 0;
	let ny = 0;
	let nz = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const ax = coords[i * 3];
		const ay = coords[i * 3 + 1];
		const az = coords[i * 3 + 2];
		const bx = coords[j * 3];
		const by = coords[j * 3 + 1];
		const bz = coords[j * 3 + 2];
		nx += (ay - by) * (az + bz);
		ny += (az - bz) * (ax + bx);
		nz += (ax - bx) * (ay + by);
	}
	const anx = Math.abs(nx);
	const any = Math.abs(ny);
	const anz = Math.abs(nz);
	if (anx + any + anz === 0) return fan(n);
	// drop the dominant axis; keep orientation so a CCW polygon (seen from +normal) stays CCW in 2D
	/** @type {number} */ let u;
	/** @type {number} */ let v;
	let flip;
	if (anx >= any && anx >= anz) {
		u = 1;
		v = 2;
		flip = nx < 0;
	} else if (any >= anz) {
		u = 2;
		v = 0;
		flip = ny < 0;
	} else {
		u = 0;
		v = 1;
		flip = nz < 0;
	}
	const px = new Float64Array(n);
	const py = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		px[i] = coords[i * 3 + u];
		py[i] = flip ? -coords[i * 3 + v] : coords[i * 3 + v];
	}
	if (n === 4) return quad(px, py);
	return earClip(px, py, n) ?? fan(n);
}

/** @param {number} n */
function fan(n) {
	/** @type {number[]} */
	const out = [];
	for (let i = 1; i < n - 1; i++) out.push(0, i, i + 1);
	return out;
}

/** twice the signed area of a,b,c @param {Float64Array} px @param {Float64Array} py @param {number} a @param {number} b @param {number} c */
function cross(px, py, a, b, c) {
	return (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
}

/** A quad: split along the diagonal that keeps both halves convex, shorter diagonal on a tie
 * (the same choice a modeller makes; a concave quad has exactly one valid diagonal).
 * @param {Float64Array} px @param {Float64Array} py */
function quad(px, py) {
	const a = cross(px, py, 0, 1, 2) > 0 && cross(px, py, 0, 2, 3) > 0;
	const b = cross(px, py, 1, 2, 3) > 0 && cross(px, py, 1, 3, 0) > 0;
	if (a && b) {
		const d02 = (px[0] - px[2]) ** 2 + (py[0] - py[2]) ** 2;
		const d13 = (px[1] - px[3]) ** 2 + (py[1] - py[3]) ** 2;
		return d13 < d02 ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
	}
	if (b) return [1, 2, 3, 1, 3, 0];
	return [0, 1, 2, 0, 2, 3];
}

/**
 * @param {Float64Array} px @param {Float64Array} py @param {number} n
 * @returns {number[]|null} null when no ear can be found (a folded loop)
 */
function earClip(px, py, n) {
	// orientation of the projected loop; ears are convex in THAT orientation
	let area = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += px[i] * py[j] - px[j] * py[i];
	}
	const sign = area >= 0 ? 1 : -1;
	const prev = new Int32Array(n);
	const next = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		prev[i] = (i + n - 1) % n;
		next[i] = (i + 1) % n;
	}
	/** @type {number[]} */
	const out = [];
	let left = n;
	let i = 0;
	let stall = 0;
	while (left > 3) {
		const a = prev[i];
		const c = next[i];
		if (isEar(px, py, a, i, c, next, sign)) {
			out.push(a, i, c);
			next[a] = c;
			prev[c] = a;
			left--;
			stall = 0;
			i = c;
			continue;
		}
		i = c;
		if (++stall > left) return null;
	}
	out.push(prev[i], i, next[i]);
	return out;
}

/** @param {Float64Array} px @param {Float64Array} py @param {number} a @param {number} b @param {number} c @param {Int32Array} next @param {number} sign */
function isEar(px, py, a, b, c, next, sign) {
	if (cross(px, py, a, b, c) * sign <= 0) return false; // reflex or flat
	for (let p = next[c]; p !== a; p = next[p]) {
		if (p === a || p === b || p === c) continue;
		const d1 = cross(px, py, a, b, p) * sign;
		const d2 = cross(px, py, b, c, p) * sign;
		const d3 = cross(px, py, c, a, p) * sign;
		if (d1 >= 0 && d2 >= 0 && d3 >= 0) return false; // a corner inside (or on) the ear
	}
	return true;
}
