// 102 M6 — PAINT ON MESHES, the PURE half (imports NOTHING, so it is unit-testable with no browser, no GL and
// no scene, and every peer replaying a stroke runs the same arithmetic).
//
// The shipped painter (uvEditor.js UV3) paints the base-colour map in the UV editor's 2D canvas with a hard round
// line. This lane grows it, without a second painter:
//   - CHANNELS: colour, roughness, metalness, emission — one map each (the 72 LK1 map slots for the last three)
//   - BRUSH KINDS: hardness, flow, opacity, eraser, mirror X, an image stamp
//   - MODEL STROKES: painting on the model itself. A dab is a SPHERE in the object's own space, drawn into the
//     map through the UV layout of every triangle it touches (each triangle's own 3D -> UV affine map, clipped to
//     that triangle and padded a little), so a stroke crosses a UV seam the way it crosses the surface
//   - VERTEX COLOURS when there are no usable UVs (none, or overlapping), with the same brush
//
// THE STROKE MODEL, shared by the canvas and the vertex paths: dabs build up a STROKE LAYER whose alpha
// accumulates `L += a * (1 - L)` (source-over), a = falloff * flow; what shows is the base under the stroke
// blended toward the brush value by L * opacity. So flow is "how much each dab adds" and opacity is "the most the
// whole stroke can reach" — the usual painter's meaning of the two.

/** @typedef {{hardness: number, opacity: number, flow: number, erase: boolean, mirror: boolean, stamp: string}} Brush */

/** The channels a brush can paint. `map` is the material key; `gray` channels take a 0..1 value, the others a
 * colour; `erase` is what the eraser paints: the value that leaves the material's own setting showing (a map
 * MULTIPLIES its slider or colour, so white / 1 = "no map here" for colour, roughness and metalness, and black =
 * "no glow" for emission). */
export const CHANNELS = Object.freeze([
	Object.freeze({ key: 'color', map: 'map', label: 'Colour', gray: false, srgb: true, param: '', erase: '#ffffff' }),
	Object.freeze({ key: 'roughness', map: 'roughnessMap', label: 'Roughness', gray: true, srgb: false, param: 'roughness', erase: '#ffffff' }),
	Object.freeze({ key: 'metalness', map: 'metalnessMap', label: 'Metalness', gray: true, srgb: false, param: 'metalness', erase: '#ffffff' }),
	Object.freeze({ key: 'emissive', map: 'emissiveMap', label: 'Emission', gray: false, srgb: true, param: 'emissive', erase: '#000000' })
]);

/** @param {any} key */
export function channelOf(key) {
	return CHANNELS.find((c) => c.key === key) ?? CHANNELS[0];
}

/** @param {any} key */
export const isChannelKey = (key) => CHANNELS.some((c) => c.key === key);

export const BRUSH_DEFAULTS = Object.freeze({ hardness: 1, opacity: 1, flow: 1, erase: false, mirror: false, stamp: '' });

/** the sizes a NEW map is made at (the first stroke on a slot with no image) */
export const NEW_MAP_SIZES = Object.freeze([1024, 2048]);

/** @param {any} v @param {number} lo @param {number} hi @param {number} fallback */
function clampNum(v, lo, hi, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** A content hash or library id: short, no markup. @param {any} v */
function cleanStamp(v) {
	return typeof v === 'string' && v.length <= 128 && /^[A-Za-z0-9_:.-]*$/.test(v) ? v : '';
}

/**
 * Every brush that reaches a canvas or the wire goes through here, so a hostile or older value cannot ask for a
 * negative flow or a 10 MB stamp id. @param {any} raw @returns {Brush}
 */
export function normalizeBrush(raw) {
	const b = raw && typeof raw === 'object' ? raw : {};
	return {
		hardness: clampNum(b.hardness, 0, 1, 1),
		opacity: clampNum(b.opacity, 0.01, 1, 1),
		flow: clampNum(b.flow, 0.01, 1, 1),
		erase: b.erase === true,
		mirror: b.mirror === true,
		stamp: cleanStamp(b.stamp)
	};
}

/** Is this the shipped brush (hard, full, no eraser, no mirror, no stamp)? Strokes with it stay on the old wire.
 * @param {any} raw */
export function isDefaultBrush(raw) {
	const b = normalizeBrush(raw);
	return b.hardness === 1 && b.opacity === 1 && b.flow === 1 && !b.erase && !b.mirror && !b.stamp;
}

/** The brush on the wire: only the fields that differ from the default (rule 6: absent when it does not apply).
 * @param {any} raw */
export function brushWire(raw) {
	const b = normalizeBrush(raw);
	/** @type {Record<string, any>} */
	const out = {};
	if (b.hardness !== 1) out.h = round3(b.hardness);
	if (b.opacity !== 1) out.o = round3(b.opacity);
	if (b.flow !== 1) out.f = round3(b.flow);
	if (b.erase) out.e = 1;
	if (b.mirror) out.m = 1;
	if (b.stamp) out.s = b.stamp;
	return out;
}

/** @param {any} w @returns {Brush} */
export function brushFromWire(w) {
	const x = w && typeof w === 'object' ? w : {};
	return normalizeBrush({ hardness: x.h, opacity: x.o, flow: x.f, erase: x.e === 1, mirror: x.m === 1, stamp: x.s });
}

/** @param {number} n */
export function round3(n) {
	return Math.round(n * 1000) / 1000;
}

/** A 0..1 value as a grey `#rrggbb`. @param {number} v */
export function grayHex(v) {
	const c = Math.round(clampNum(v, 0, 1, 0) * 255);
	const h = c.toString(16).padStart(2, '0');
	return '#' + h + h + h;
}

/** A `#rrggbb` as three 0..1 numbers (sRGB, as written). Anything else is white. @param {any} hex */
export function hexToRgb(hex) {
	const m = typeof hex === 'string' ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null;
	if (!m) return [1, 1, 1];
	const n = parseInt(m[1], 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** @param {number[]} rgb 0..1 */
export function rgbToHex(rgb) {
	return '#' + rgb.map((c) => Math.round(clampNum(c, 0, 1, 0) * 255).toString(16).padStart(2, '0')).join('');
}

/** What a stroke paints: the eraser's value, else the brush colour (colour / emission) or the grey of the value.
 * @param {string} channel @param {string} color @param {number} value @param {boolean} erase */
export function paintStyle(channel, color, value, erase) {
	const ch = channelOf(channel);
	if (erase) return ch.erase;
	return ch.gray ? grayHex(value) : /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#ffffff';
}

// ---- falloff and dab spacing ---------------------------------------------------------------------------------

/**
 * How much a dab covers at `t` = distance / radius: 1 inside the hard core, a smoothstep down to 0 at the rim.
 * Hardness 1 is the shipped hard edge. @param {number} t @param {number} hardness
 */
export function falloff(t, hardness) {
	if (!(t >= 0) || t > 1) return 0;
	const h = clampNum(hardness, 0, 1, 1);
	if (t <= h) return 1;
	if (h >= 1) return 1;
	const s = (t - h) / (1 - h);
	return 1 - s * s * (3 - 2 * s);
}

/** The falloff as radial-gradient stops ([offset 0..1, alpha 0..1]) — the canvas draws the same curve the
 * vertex path evaluates. @param {number} hardness */
export function falloffStops(hardness) {
	const h = clampNum(hardness, 0, 1, 1);
	if (h >= 1) return [[0, 1], [1, 1]];
	/** @type {number[][]} */
	const stops = [[0, 1], [h, 1]];
	for (let i = 1; i <= 6; i++) {
		const t = h + ((1 - h) * i) / 6;
		stops.push([round3(t), round3(falloff(t, h))]);
	}
	return stops;
}

/** dabs per diameter: 0.2 is the usual painter's spacing (no visible beads, not wasteful) */
export const DAB_SPACING = 0.2;

/**
 * The dabs along one segment, spaced `step` apart along its length, carrying the leftover distance into the next
 * segment so a stroke made of many short moves spaces like one long one. Points are `[...coords, w]` with the
 * pressure `w` last; it is interpolated. The FIRST point of a stroke is a dab of its own (call with
 * `carry = step` to get it); after that a dab lands every `step`.
 * @param {number[]} from @param {number[]} to @param {number} dim how many coordinates (2 or 3)
 * @param {number} step @param {number} carry distance travelled since the last dab
 * @returns {{dabs: number[][], carry: number}}
 */
export function dabsAlong(from, to, dim, step, carry) {
	/** @type {number[][]} */
	const dabs = [];
	const s = step > 1e-9 ? step : 1e-9;
	let len = 0;
	for (let k = 0; k < dim; k++) len += (to[k] - from[k]) ** 2;
	len = Math.sqrt(len);
	const wa = Number.isFinite(from[dim]) ? from[dim] : 1;
	const wb = Number.isFinite(to[dim]) ? to[dim] : 1;
	let travelled = carry;
	// the first dab sits `s - carry` along the segment
	let at = s - carry;
	if (at < 0) at = 0;
	let guard = 0;
	while (at <= len + 1e-9 && guard++ < 100000) {
		const t = len > 0 ? at / len : 0;
		const p = [];
		for (let k = 0; k < dim; k++) p.push(from[k] + (to[k] - from[k]) * t);
		p.push(wa + (wb - wa) * t);
		dabs.push(p);
		at += s;
	}
	travelled = len - (at - s);
	if (!dabs.length) travelled = carry + len;
	return { dabs, carry: travelled };
}

// ---- the triangle frame: a dab sphere seen through one triangle's UV layout ------------------------------------

/** @param {number[]} a @param {number[]} b */
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b */
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} a @param {number[]} b */
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a */
const len3 = (a) => Math.sqrt(dot3(a, a));

/**
 * One triangle's plane frame and its plane -> UV affine map.
 * `q` are the corners in plane coordinates (corner 0 at the origin, edge 0-1 along +x); `M` maps a plane offset
 * to a UV offset (2x2, row-major [m00, m01, m10, m11]) so uv = uv0 + M q. Null for a degenerate triangle in 3D
 * or in UV space (nothing to paint through).
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2
 * @param {number[]} uv0 @param {number[]} uv1 @param {number[]} uv2
 */
export function triFrame(p0, p1, p2, uv0, uv1, uv2) {
	const a = sub3(p1, p0);
	const b = sub3(p2, p0);
	const la = len3(a);
	const nRaw = cross3(a, b);
	const area2 = len3(nRaw);
	if (la < 1e-12 || area2 < 1e-12) return null;
	const e1 = [a[0] / la, a[1] / la, a[2] / la];
	const n = [nRaw[0] / area2, nRaw[1] / area2, nRaw[2] / area2];
	const e2 = cross3(n, e1);
	const q1 = [la, 0];
	const q2 = [dot3(b, e1), dot3(b, e2)];
	// Dq = [q1 q2] as columns; Duv = [uv1-uv0, uv2-uv0] as columns; M = Duv * Dq^-1
	const det = q1[0] * q2[1] - q2[0] * q1[1];
	if (Math.abs(det) < 1e-18) return null;
	const du1 = uv1[0] - uv0[0];
	const dv1 = uv1[1] - uv0[1];
	const du2 = uv2[0] - uv0[0];
	const dv2 = uv2[1] - uv0[1];
	const uvArea2 = Math.abs(du1 * dv2 - du2 * dv1);
	if (uvArea2 < 1e-14) return null;
	// inverse of [[q1x, q2x], [q1y, q2y]]
	const i00 = q2[1] / det;
	const i01 = -q2[0] / det;
	const i10 = -q1[1] / det;
	const i11 = q1[0] / det;
	const M = [du1 * i00 + du2 * i10, du1 * i01 + du2 * i11, dv1 * i00 + dv2 * i10, dv1 * i01 + dv2 * i11];
	return { o: p0, e1, e2, n, q: [[0, 0], q1, q2], uv: [uv0, uv1, uv2], M, area: area2 / 2, uvArea: uvArea2 / 2 };
}

/**
 * Where a dab sphere (centre `c`, radius `r`) cuts one triangle's plane: the circle's centre in plane
 * coordinates and its radius, or null when the sphere misses the plane or the triangle's neighbourhood.
 * @param {any} frame triFrame's result @param {number[]} c @param {number} r
 * @returns {{qc: number[], r: number} | null}
 */
export function dabOnTri(frame, c, r) {
	const d = sub3(c, frame.o);
	const h = dot3(d, frame.n);
	if (Math.abs(h) >= r) return null;
	const rr = Math.sqrt(r * r - h * h);
	const qc = [dot3(d, frame.e1), dot3(d, frame.e2)];
	// quick reject: the circle must come within rr of the triangle's plane-space bounding box
	const q = frame.q;
	const minX = Math.min(q[0][0], q[1][0], q[2][0]);
	const maxX = Math.max(q[0][0], q[1][0], q[2][0]);
	const minY = Math.min(q[0][1], q[1][1], q[2][1]);
	const maxY = Math.max(q[0][1], q[1][1], q[2][1]);
	if (qc[0] < minX - rr || qc[0] > maxX + rr || qc[1] < minY - rr || qc[1] > maxY + rr) return null;
	return { qc, r: rr };
}

/** The UV of a plane point. @param {any} frame @param {number[]} qp */
export function planeToUv(frame, qp) {
	const M = frame.M;
	return [frame.uv[0][0] + M[0] * qp[0] + M[1] * qp[1], frame.uv[0][1] + M[2] * qp[0] + M[3] * qp[1]];
}

/**
 * The canvas transform (setTransform's a, b, c, d, e, f) that takes plane coordinates of `frame` to canvas
 * pixels of a W x H map. `flipY` is the texture's: true (three's default) puts v = 1 at the image top.
 * @param {any} frame @param {number} W @param {number} H @param {boolean} flipY
 */
export function planeToCanvas(frame, W, H, flipY) {
	const M = frame.M;
	const [u0, v0] = frame.uv[0];
	const sy = flipY ? -H : H;
	return [W * M[0], sy * M[2], W * M[1], sy * M[3], W * u0, flipY ? H - H * v0 : H * v0];
}

/** A UV point in canvas pixels. @param {number[]} uv @param {number} W @param {number} H @param {boolean} flipY */
export function uvToCanvas(uv, W, H, flipY) {
	return [uv[0] * W, (flipY ? 1 - uv[1] : uv[1]) * H];
}

/**
 * A triangle grown by about `pad` pixels (seam PADDING: bilinear and mip sampling at an island's edge read a
 * pixel or two outside it, so paint has to reach a little past the edge or the seam shows a hairline). Grown
 * about the incentre; the growth is capped so a sliver cannot balloon over its neighbours.
 * @param {number[][]} pts three [x, y] @param {number} pad
 */
export function padTri(pts, pad) {
	const [a, b, c] = pts;
	const la = Math.hypot(b[0] - c[0], b[1] - c[1]);
	const lb = Math.hypot(a[0] - c[0], a[1] - c[1]);
	const lc = Math.hypot(a[0] - b[0], a[1] - b[1]);
	const per = la + lb + lc;
	if (per < 1e-9 || pad <= 0) return pts.map((p) => [p[0], p[1]]);
	const ix = (la * a[0] + lb * b[0] + lc * c[0]) / per;
	const iy = (la * a[1] + lb * b[1] + lc * c[1]) / per;
	const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
	const inr = (2 * area) / per;
	const k = inr > 1e-9 ? Math.min((inr + pad) / inr, 4) : 1;
	return pts.map((p) => [ix + (p[0] - ix) * k, iy + (p[1] - iy) * k]);
}

/**
 * Texture pixels per unit of the object's own space on one triangle — what turns the brush size (texture px,
 * the UV editor's unit) into a model-space radius, so a stroke on the model is as wide as the same stroke on the
 * map. @param {any} frame @param {number} W @param {number} H
 */
export function texelDensity(frame, W, H) {
	if (!frame || frame.area <= 0) return 0;
	return Math.sqrt((frame.uvArea * W * H) / frame.area);
}

// ---- finding the triangles a dab touches: a uniform grid over the object's own space ---------------------------

/**
 * Bucket triangles by the grid cells their bounding boxes cover. `positions` is a flat triangle soup
 * (9 floats per triangle, object space). @param {ArrayLike<number>} positions @param {number} cell
 */
export function buildTriGrid(positions, cell) {
	const size = cell > 1e-9 ? cell : 1;
	/** @type {Map<string, number[]>} */
	const cells = new Map();
	const n = Math.floor(positions.length / 9);
	for (let t = 0; t < n; t++) {
		const o = t * 9;
		let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
		for (let k = 0; k < 3; k++) {
			const x = positions[o + k * 3], y = positions[o + k * 3 + 1], z = positions[o + k * 3 + 2];
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			if (z < z0) z0 = z;
			if (z > z1) z1 = z;
		}
		if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) continue;
		const ax = Math.floor(x0 / size), bx = Math.floor(x1 / size);
		const ay = Math.floor(y0 / size), by = Math.floor(y1 / size);
		const az = Math.floor(z0 / size), bz = Math.floor(z1 / size);
		// a huge triangle in a fine grid would fill thousands of cells; such a mesh gets a coarser grid instead
		if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 4096) return buildTriGrid(positions, size * 4);
		for (let x = ax; x <= bx; x++)
			for (let y = ay; y <= by; y++)
				for (let z = az; z <= bz; z++) {
					const key = x + ',' + y + ',' + z;
					const list = cells.get(key);
					if (list) list.push(t);
					else cells.set(key, [t]);
				}
	}
	return { cell: size, cells };
}

/** The triangles whose cells a sphere overlaps, ascending (a deterministic order: two peers draw the same dab in
 * the same triangle order, so overlapping pads blend identically). @param {any} grid @param {number[]} c @param {number} r */
export function trisNear(grid, c, r) {
	const s = grid.cell;
	/** @type {Set<number>} */
	const out = new Set();
	const ax = Math.floor((c[0] - r) / s), bx = Math.floor((c[0] + r) / s);
	const ay = Math.floor((c[1] - r) / s), by = Math.floor((c[1] + r) / s);
	const az = Math.floor((c[2] - r) / s), bz = Math.floor((c[2] + r) / s);
	if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 32768) {
		for (const list of grid.cells.values()) for (const t of list) out.add(t);
	} else
		for (let x = ax; x <= bx; x++)
			for (let y = ay; y <= by; y++)
				for (let z = az; z <= bz; z++) {
					const list = grid.cells.get(x + ',' + y + ',' + z);
					if (list) for (const t of list) out.add(t);
				}
	return [...out].sort((a, b) => a - b);
}

// ---- are the UVs usable? -----------------------------------------------------------------------------------------

/**
 * How much of the UV layout is painted twice: rasterise every UV triangle into a `res` x `res` grid and count
 * cells covered more than once, as a share of the covered cells. 0 for a clean unwrap; a mirrored model whose
 * halves share one island reads ~0.5; a primitive whose six sides share one square reads ~0.8. UVs outside 0..1
 * (tiling) are clamped to the square, so a tiled mesh reads as overlapping, which it is for a painter.
 * @param {ArrayLike<number>} uvs flat, 6 per triangle @param {number} [res]
 * @returns {{covered: number, overlap: number, ratio: number, empty: boolean}}
 */
export function uvOverlap(uvs, res = 128) {
	const R = Math.max(8, Math.min(512, Math.floor(res)));
	const count = new Uint8Array(R * R);
	const n = Math.floor(uvs.length / 6);
	let anyArea = false;
	for (let t = 0; t < n; t++) {
		const o = t * 6;
		const ax = uvs[o] * R, ay = uvs[o + 1] * R;
		const bx = uvs[o + 2] * R, by = uvs[o + 3] * R;
		const cx = uvs[o + 4] * R, cy = uvs[o + 5] * R;
		const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
		if (!Number.isFinite(area) || Math.abs(area) < 1e-9) continue;
		anyArea = true;
		const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
		const x1 = Math.min(R - 1, Math.ceil(Math.max(ax, bx, cx)));
		const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
		const y1 = Math.min(R - 1, Math.ceil(Math.max(ay, by, cy)));
		for (let y = y0; y <= y1; y++)
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5, py = y + 0.5;
				const w0 = (bx - px) * (cy - py) - (cx - px) * (by - py);
				const w1 = (cx - px) * (ay - py) - (ax - px) * (cy - py);
				const w2 = (ax - px) * (by - py) - (bx - px) * (ay - py);
				const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
				if (inside && count[y * R + x] < 255) count[y * R + x]++;
			}
	}
	let covered = 0;
	let overlap = 0;
	for (let i = 0; i < count.length; i++) {
		if (count[i] > 0) covered++;
		if (count[i] > 1) overlap++;
	}
	return { covered, overlap, ratio: covered ? overlap / covered : 0, empty: !anyArea || !covered };
}

/** above this share of twice-painted texels a mesh's UVs are "overlapping" for a painter */
export const OVERLAP_LIMIT = 0.05;

/**
 * Where a model stroke should go: 'map' (paint the texture), or 'vertex' with the reason in words.
 * @param {{hasUvs: boolean, overlap?: {ratio: number, empty: boolean} | null}} facts
 * @returns {{mode: 'map' | 'vertex', reason: string}}
 */
export function paintTarget(facts) {
	if (!facts.hasUvs) return { mode: 'vertex', reason: 'This mesh has no UV map, so the brush paints its vertex colours.' };
	const o = facts.overlap;
	if (o?.empty) return { mode: 'vertex', reason: 'This mesh’s UV map is empty, so the brush paints its vertex colours.' };
	if (o && o.ratio > OVERLAP_LIMIT)
		return {
			mode: 'vertex',
			reason: 'Parts of this mesh share the same place on its UV map, so paint would show up twice. The brush paints vertex colours instead (or unwrap it in the UV editor first).'
		};
	return { mode: 'map', reason: '' };
}

// ---- vertex colours -----------------------------------------------------------------------------------------------

/**
 * One dab on per-vertex data: every vertex within `r` of `c` gets its stroke-layer alpha raised by
 * falloff * flow (source-over). `acc` is the stroke layer (one float per vertex, 0 at the stroke's start).
 * Returns the vertex indices it touched, ascending. @param {ArrayLike<number>} positions 3 per vertex
 * @param {number[]} c @param {number} r @param {number} hardness @param {number} flow @param {Float32Array} acc
 */
export function vertexDab(positions, c, r, hardness, flow, acc) {
	/** @type {number[]} */
	const touched = [];
	if (!(r > 0)) return touched;
	const n = Math.floor(positions.length / 3);
	const r2 = r * r;
	for (let i = 0; i < n; i++) {
		const dx = positions[i * 3] - c[0];
		const dy = positions[i * 3 + 1] - c[1];
		const dz = positions[i * 3 + 2] - c[2];
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > r2) continue;
		const a = falloff(Math.sqrt(d2) / r, hardness) * flow;
		if (a <= 0) continue;
		acc[i] = acc[i] + a * (1 - acc[i]);
		touched.push(i);
	}
	return touched;
}

/**
 * The colours a stroke shows: base blended toward `target` by layer alpha * opacity, for the given vertices.
 * All three colour arrays are 3 floats per vertex (linear). @param {Float32Array} base @param {number[]} target
 * @param {Float32Array} acc @param {number} opacity @param {Float32Array} out @param {Iterable<number>} indices
 */
export function blendVertexColors(base, target, acc, opacity, out, indices) {
	for (const i of indices) {
		const a = Math.min(1, Math.max(0, acc[i] * opacity));
		for (let k = 0; k < 3; k++) out[i * 3 + k] = base[i * 3 + k] + (target[k] - base[i * 3 + k]) * a;
	}
}

/** Mirror X in the object's own space. @param {number[]} p */
export function mirrorX(p) {
	return [-p[0], p[1], p[2], ...p.slice(3)];
}

/** Is this point on (or within eps of) the mirror plane? A dab there is painted once, not twice.
 * @param {number[]} p @param {number} r */
export function onMirrorPlane(p, r) {
	return Math.abs(p[0]) < Math.max(r * 0.05, 1e-6);
}

/** sRGB 0..1 -> linear 0..1 (three's vertex colours are linear) @param {number} c */
export function srgbToLinear(c) {
	return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** A tiny stable hash of a byte array (FNV-1a 32), for the suites' "same pixels on both peers".
 * @param {ArrayLike<number>} bytes */
export function hashBytes(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i] & 255;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

