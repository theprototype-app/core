// 102 M3 — the decal PROJECTION MATHS (pure, no three): clip a target's triangles to the unit
// projector box, uv from the box, the bake uv carried through, the surface pushed toward the
// projector. Split from decalCore so the boot (which reads records) never carries it: only the
// lazy decal runtime imports this file.

import { DECAL_MAX_TRIS, DECAL_DEFAULTS } from './decalCore.js';

// ---- the projection box maths --------------------------------------------------------------

/**
 * @param {ArrayLike<number>} m column-major 4x4 (three's Matrix4.elements)
 * @param {number} x @param {number} y @param {number} z @param {number[]} out @param {number} o
 */
function applyPoint(m, x, y, z, out, o) {
	const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
	out[o] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
	out[o + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
	out[o + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
}

/** a 4x4 product a*b, column-major @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function mul4(a, b) {
	const out = new Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
			out[c * 4 + r] = s;
		}
	return out;
}

/**
 * The inverse-transpose 3x3 of a 4x4 (normals mesh -> world), row-major 9.
 * @param {ArrayLike<number>} m
 */
function normalMatrixOf(m) {
	const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
	const det = a * A + b * B + c * C;
	const k = det ? 1 / det : 0;
	// inverse (column-major 3x3) transposed = cofactor / det, laid out row-major for apply
	return [
		A * k, B * k, C * k,
		-(b * i - c * h) * k, (a * i - c * g) * k, -(a * h - b * g) * k,
		(b * f - c * e) * k, -(a * f - c * d) * k, (a * e - b * d) * k
	];
}

/**
 * Clip a convex polygon (flat vertex rows of `stride` numbers, position first) by one plane of
 * the unit box: keep `sign * p[axis] <= 0.5`. Attributes after the position interpolate.
 * @param {number[][]} poly @param {number} axis 0|1|2 @param {number} sign 1|-1
 * @returns {number[][]}
 */
export function clipPolygon(poly, axis, sign) {
	/** @type {number[][]} */
	const out = [];
	const n = poly.length;
	if (!n) return out;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		const da = sign * a[axis] - 0.5;
		const db = sign * b[axis] - 0.5;
		const aIn = da <= 0;
		const bIn = db <= 0;
		if (aIn) out.push(a);
		if (aIn !== bIn) {
			const t = da / (da - db);
			out.push(a.map((v, k) => v + (b[k] - v) * t));
		}
	}
	return out;
}

/**
 * @typedef {{
 *   positions: ArrayLike<number>,
 *   index?: ArrayLike<number> | null,
 *   normals?: ArrayLike<number> | null,
 *   uv2?: ArrayLike<number> | null,
 *   meshToWorld: ArrayLike<number>
 * }} DecalSource one mesh under the target (its geometry in its own space, and where it is)
 */

/**
 * THE PROJECTION. Every source triangle facing the projector (within `angle` degrees) is taken
 * into box space, clipped to the unit box and kept as a fan. Out: positions in BOX space (the
 * carrier's local frame) pushed `push` along +Z (box units) so raycasts land on the decal first,
 * uv = box x/y + 0.5, normals given so the carrier's normal matrix turns them back into the
 * target's world normals (n_box = M^T n_world with M the box-to-world 3x3), and the target's bake
 * uv (`uv2`) carried through, so a baked light map lines up.
 *
 * @param {DecalSource[]} sources
 * @param {ArrayLike<number>} worldToBox the carrier's inverse world matrix
 * @param {ArrayLike<number>} boxToWorld the carrier's world matrix
 * @param {{ angle?: number, push?: number, maxTris?: number }} [opts]
 * @returns {{ position: Float32Array, normal: Float32Array, uv: Float32Array, uv2: Float32Array | null, tris: number, capped: boolean }}
 */
export function projectDecal(sources, worldToBox, boxToWorld, opts = {}) {
	const maxTris = opts.maxTris ?? DECAL_MAX_TRIS;
	const cosMax = Math.cos(((opts.angle ?? DECAL_DEFAULTS.angle) * Math.PI) / 180);
	const push = opts.push ?? 0;
	// the projector's direction in world space (+Z of the box), normalized
	const zx = boxToWorld[8], zy = boxToWorld[9], zz = boxToWorld[10];
	const zl = Math.hypot(zx, zy, zz) || 1;
	const ax = zx / zl, ay = zy / zl, az = zz / zl;
	const B = boxToWorld;
	/** @type {number[]} */ const pos = [];
	/** @type {number[]} */ const nrm = [];
	/** @type {number[]} */ const uvs = [];
	/** @type {number[]} */ const uv2s = [];
	const withUv2 = sources.length > 0 && sources.every((s) => !!s.uv2);
	let tris = 0;
	let capped = false;
	const w = [0, 0, 0];
	for (const src of sources) {
		if (capped) break;
		const P = src.positions;
		const count = Math.floor(P.length / 3);
		const meshToBox = mul4(worldToBox, src.meshToWorld);
		const nm = normalMatrixOf(src.meshToWorld);
		// every vertex once: box-space position, world position, world normal
		const boxP = new Float64Array(count * 3);
		const worldP = new Float64Array(count * 3);
		const tmp = [0, 0, 0];
		for (let i = 0; i < count; i++) {
			applyPoint(meshToBox, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], tmp, 0);
			boxP[i * 3] = tmp[0];
			boxP[i * 3 + 1] = tmp[1];
			boxP[i * 3 + 2] = tmp[2];
			applyPoint(src.meshToWorld, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], tmp, 0);
			worldP[i * 3] = tmp[0];
			worldP[i * 3 + 1] = tmp[1];
			worldP[i * 3 + 2] = tmp[2];
		}
		const index = src.index;
		const triCount = index ? Math.floor(index.length / 3) : Math.floor(count / 3);
		const N = src.normals;
		const U = src.uv2;
		for (let t = 0; t < triCount; t++) {
			const i0 = index ? index[t * 3] : t * 3;
			const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
			const i2 = index ? index[t * 3 + 2] : t * 3 + 2;
			// quick reject: all three corners outside the same face of the box
			let out = false;
			for (let k = 0; k < 3 && !out; k++) {
				const a = boxP[i0 * 3 + k], b = boxP[i1 * 3 + k], c = boxP[i2 * 3 + k];
				if ((a > 0.5 && b > 0.5 && c > 0.5) || (a < -0.5 && b < -0.5 && c < -0.5)) out = true;
			}
			if (out) continue;
			// the face's world normal against the projector (back faces and grazing faces stay bare)
			const e1x = worldP[i1 * 3] - worldP[i0 * 3], e1y = worldP[i1 * 3 + 1] - worldP[i0 * 3 + 1], e1z = worldP[i1 * 3 + 2] - worldP[i0 * 3 + 2];
			const e2x = worldP[i2 * 3] - worldP[i0 * 3], e2y = worldP[i2 * 3 + 1] - worldP[i0 * 3 + 1], e2z = worldP[i2 * 3 + 2] - worldP[i0 * 3 + 2];
			let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
			const fl = Math.hypot(fx, fy, fz);
			if (!fl) continue;
			fx /= fl;
			fy /= fl;
			fz /= fl;
			if (fx * ax + fy * ay + fz * az < cosMax) continue;
			/** @type {number[][]} */
			let poly = [i0, i1, i2].map((i) => {
				// the world normal: the mesh's own (smooth) one when it has them, else the face's
				let nx = fx, ny = fy, nz = fz;
				if (N) {
					const x = N[i * 3], y = N[i * 3 + 1], z = N[i * 3 + 2];
					nx = nm[0] * x + nm[1] * y + nm[2] * z;
					ny = nm[3] * x + nm[4] * y + nm[5] * z;
					nz = nm[6] * x + nm[7] * y + nm[8] * z;
				}
				const row = [boxP[i * 3], boxP[i * 3 + 1], boxP[i * 3 + 2], nx, ny, nz];
				if (withUv2 && U) row.push(U[i * 2], U[i * 2 + 1]);
				return row;
			});
			for (let axis = 0; axis < 3 && poly.length; axis++) {
				poly = clipPolygon(poly, axis, 1);
				poly = clipPolygon(poly, axis, -1);
			}
			if (poly.length < 3) continue;
			for (let k = 1; k + 1 < poly.length; k++) {
				if (tris >= maxTris) {
					capped = true;
					break;
				}
				for (const v of [poly[0], poly[k], poly[k + 1]]) {
					pos.push(v[0], v[1], v[2] + push);
					uvs.push(v[0] + 0.5, v[1] + 0.5);
					// n_box = M^T n_world (the carrier's normal matrix then gives n_world back)
					w[0] = v[3];
					w[1] = v[4];
					w[2] = v[5];
					nrm.push(
						B[0] * w[0] + B[1] * w[1] + B[2] * w[2],
						B[4] * w[0] + B[5] * w[1] + B[6] * w[2],
						B[8] * w[0] + B[9] * w[1] + B[10] * w[2]
					);
					if (withUv2) uv2s.push(v[6], v[7]);
				}
				tris++;
			}
		}
	}
	return {
		position: new Float32Array(pos),
		normal: new Float32Array(nrm),
		uv: new Float32Array(uvs),
		uv2: withUv2 ? new Float32Array(uv2s) : null,
		tris,
		capped
	};
}

