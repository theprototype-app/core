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

// ---- what a decal may go on ------------------------------------------------------------------

/**
 * Why this surface cannot take a decal in this version (null = it can). Facts the caller reads
 * off the hit object and its ancestors.
 * @param {{ skinned?: boolean, scattered?: boolean, instanced?: boolean, decal?: boolean, splat?: boolean, none?: boolean, tris?: number, animatedFile?: boolean }} facts
 * @returns {string | null}
 */
export function targetRefusal(facts) {
	if (facts.none) return 'Click a surface to put the decal on.';
	if (facts.decal) return 'A decal cannot go on another decal — click the surface under it.';
	if (facts.splat) return 'A decal cannot go on a Gaussian splat (it has no surface) — click a mesh.';
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
