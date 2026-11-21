// 102 M3 — DECALS, the pure half (no three, no stores: unit-tested in node).
//
//   DECAL_DEFAULTS / normalizeDecal   the ONE record on a decal carrier (userData.decal)
//   isNewerDecalRecord                a record a newer build wrote (kept whole, one notice)
//   projectDecal                      the projection box maths: clip a target's triangles to
//                                     the unit box, uv from box x/y (three's DecalGeometry
//                                     algorithm, over plain arrays so it can be tested)
//   targetRefusal                     why a surface cannot take a decal in this version
//   admitStamp / expireStamps         the stamped-marks pool: a cap per scene, oldest out
//
// THE CARRIER IS A UNIT PROJECTOR BOX. Its local frame is the box [-0.5, 0.5]^3; +Z points
// out of the surface (the projector looks down -Z), so its SCALE is width x height x depth
// and the normal gizmo's scale handle sizes it. Its geometry is the clipped target surface IN
// THAT FRAME, so a target moving rigidly needs no rebuild (the carrier is its child), and a
// rebuild runs only when the box moves against the target (a transform end) or the target's
// own geometry changes. The geometry is never saved or sent: each peer builds it (the text
// object's rule, golden rule 8).

export const DECAL_VERSION = 1;

/** most triangles one decal keeps (a decal across a dense terrain) */
export const DECAL_MAX_TRIS = 20000;
/** most source triangles one build reads (a target past this is refused, not frozen) */
export const DECAL_MAX_SOURCE_TRIS = 400000;
/** the stamped-marks pool: the default and the hard ceiling per scene */
export const STAMP_CAP_DEFAULT = 64;
export const STAMP_CAP_MAX = 64;
/** a stamp lives this long by default (seconds); 0 = until the cap pushes it out or the run stops */
export const STAMP_LIFETIME_DEFAULT = 10;
export const STAMP_LIFETIME_MAX = 600;

/**
 * @typedef {{
 *   v: number,
 *   image: string,
 *   imageName: string,
 *   target: string,
 *   opacity: number,
 *   tint: string,
 *   roughness: number,
 *   angle: number,
 *   [k: string]: any
 * }} DecalRecord
 */

/** @type {Readonly<DecalRecord>} */
export const DECAL_DEFAULTS = Object.freeze({
	v: DECAL_VERSION,
	// an Explorer content hash (the shader-texture rule: 64 characters on the wire, the bytes once)
	image: '',
	imageName: '',
	// the uuid of the object it was placed on (informational: the PARENT is the target)
	target: '',
	opacity: 1,
	tint: '#ffffff',
	roughness: 0.8,
	// a face turned further than this from the projector is not wrapped (degrees)
	angle: 80
});

const HEX = /^#[0-9a-f]{6}$/i;
const HASH = /^[0-9a-f]{16,128}$/i;

/** @param {any} v @param {number} min @param {number} max @param {number} fallback */
function clamp(v, min, max, fallback) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * The ONE boundary for a decal record (the write path, the wire, a load). Unknown fields a
 * NEWER build wrote are kept, so saving here does not strip them (the text record's TX4 rule).
 * @param {any} raw @returns {DecalRecord}
 */
export function normalizeDecal(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	/** @type {DecalRecord} */
	const out = { ...r, ...DECAL_DEFAULTS };
	out.v = Number.isInteger(r.v) && r.v > 0 ? r.v : DECAL_VERSION;
	out.image = typeof r.image === 'string' && HASH.test(r.image) ? r.image.toLowerCase() : '';
	out.imageName = typeof r.imageName === 'string' ? r.imageName.slice(0, 120) : '';
	out.target = typeof r.target === 'string' ? r.target.slice(0, 64) : '';
	out.opacity = clamp(r.opacity, 0, 1, DECAL_DEFAULTS.opacity);
	out.tint = typeof r.tint === 'string' && HEX.test(r.tint) ? r.tint.toLowerCase() : DECAL_DEFAULTS.tint;
	out.roughness = clamp(r.roughness, 0, 1, DECAL_DEFAULTS.roughness);
	out.angle = clamp(r.angle, 5, 89, DECAL_DEFAULTS.angle);
	return out;
}

/** @param {any} raw */
export const isNewerDecalRecord = (raw) => !!raw && typeof raw === 'object' && Number(raw.v) > DECAL_VERSION;

/** @param {any} o a scene object */
export const isDecalObject = (o) => !!o?.userData?.decal && typeof o.userData.decal === 'object';

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

// ---- what a decal may go on ------------------------------------------------------------------

/**
 * Why this surface cannot take a decal in this version (null = it can). Facts the caller reads
 * off the hit object and its ancestors.
 * @param {{ skinned?: boolean, scattered?: boolean, instanced?: boolean, decal?: boolean, none?: boolean, tris?: number, animatedFile?: boolean }} facts
 * @returns {string | null}
 */
export function targetRefusal(facts) {
	if (facts.none) return 'Click a surface to put the decal on.';
	if (facts.decal) return 'A decal cannot go on another decal — click the surface under it.';
	if (facts.skinned) return 'Decals cannot go on animated characters (skinned meshes) in this version.';
	// an animated import travels and saves as its original file, which cannot carry a decal
	if (facts.animatedFile) return 'Decals cannot go on animated imported models in this version.';
	if (facts.scattered || facts.instanced) return 'Decals cannot go on scattered copies in this version — place it on a single object.';
	if ((facts.tris ?? 0) > DECAL_MAX_SOURCE_TRIS)
		return 'That object is too detailed for a decal (' + Math.round((facts.tris ?? 0) / 1000) + 'k triangles, at most ' + DECAL_MAX_SOURCE_TRIS / 1000 + 'k).';
	return null;
}

// ---- the stamped-marks pool ------------------------------------------------------------------

/**
 * @typedef {{ id: string, at: number, life: number, [k: string]: any }} Stamp at = ms (the
 *   synced clock), life = seconds (0 = no expiry)
 */

/** @param {any} v the authored cap */
export const stampCap = (v) => Math.round(clamp(v, 1, STAMP_CAP_MAX, STAMP_CAP_DEFAULT));
/** @param {any} v the authored lifetime (seconds) */
export const stampLifetime = (v) => clamp(v, 0, STAMP_LIFETIME_MAX, STAMP_LIFETIME_DEFAULT);

/**
 * Add a stamp to the pool (oldest first): a repeat id replaces nothing (a resent message), and
 * past the cap the OLDEST go.
 * @param {Stamp[]} list @param {Stamp} stamp @param {number} cap
 * @returns {{ list: Stamp[], added: boolean, evicted: Stamp[] }}
 */
export function admitStamp(list, stamp, cap = STAMP_CAP_DEFAULT) {
	if (list.some((s) => s.id === stamp.id)) return { list, added: false, evicted: [] };
	const next = [...list, stamp].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const limit = stampCap(cap);
	const evicted = next.length > limit ? next.splice(0, next.length - limit) : [];
	return { list: next, added: !evicted.includes(stamp), evicted };
}

/**
 * The stamps whose lifetime is over at `now` (ms, the synced clock), and the rest.
 * @param {Stamp[]} list @param {number} now
 * @returns {{ list: Stamp[], expired: Stamp[] }}
 */
export function expireStamps(list, now) {
	/** @type {Stamp[]} */ const keep = [];
	/** @type {Stamp[]} */ const expired = [];
	for (const s of list) (s.life > 0 && now - s.at >= s.life * 1000 ? expired : keep).push(s);
	return { list: keep, expired };
}

/**
 * The fade of a stamp in its last second (1 = solid), so a mark does not pop out.
 * @param {Stamp} s @param {number} now
 */
export function stampFade(s, now) {
	if (!(s.life > 0)) return 1;
	const left = s.life * 1000 - (now - s.at);
	return Math.max(0, Math.min(1, left / 1000));
}

/**
 * The carrier pose for a stamp or a click: a box centred on `point`, +Z along `normal`, turned
 * `spin` radians about it. Returns a column-major 4x4 with `size` (w, h, depth) as its scale.
 * The "up" reference is world +Y (world +Z on a floor/ceiling), so a sign on a wall stands
 * upright and a mark on the floor faces the same way on every peer.
 * @param {number[]} point @param {number[]} normal @param {number[]} size @param {number} [spin]
 */
export function decalPoseMatrix(point, normal, size, spin = 0) {
	let nx = normal[0], ny = normal[1], nz = normal[2];
	const nl = Math.hypot(nx, ny, nz) || 1;
	nx /= nl;
	ny /= nl;
	nz /= nl;
	// up reference: world Y unless the normal is (nearly) vertical
	let ux = 0, uy = 1, uz = 0;
	if (Math.abs(ny) > 0.95) {
		ux = 0;
		uy = 0;
		uz = ny > 0 ? -1 : 1;
	}
	// x = up × n, y = n × x
	let xx = uy * nz - uz * ny, xy = uz * nx - ux * nz, xz = ux * ny - uy * nx;
	const xl = Math.hypot(xx, xy, xz) || 1;
	xx /= xl;
	xy /= xl;
	xz /= xl;
	let yx = ny * xz - nz * xy, yy = nz * xx - nx * xz, yz = nx * xy - ny * xx;
	if (spin) {
		const c = Math.cos(spin), s = Math.sin(spin);
		const rx = [c * xx + s * yx, c * xy + s * yy, c * xz + s * yz];
		const ry = [-s * xx + c * yx, -s * xy + c * yy, -s * xz + c * yz];
		[xx, xy, xz] = rx;
		[yx, yy, yz] = ry;
	}
	const [sx, sy, sz] = size;
	return [xx * sx, xy * sx, xz * sx, 0, yx * sy, yy * sy, yz * sy, 0, nx * sz, ny * sz, nz * sz, 0, point[0], point[1], point[2], 1];
}
