// Roadmap 85 G5/G6 — the PURE half of edit_mesh and create_mesh (imports nothing; the unit layer runs it).
//
// edit_mesh addresses parts of a mesh the way a person picks them, without a session: FACES are the units
// the face tools see (faceEdit's partition — a quad, a triangle, an authored n-gon), VERTICES are welded
// positions (the key faceEdit and meshEdit agree on). A selection is by index, by normal direction, by a
// box, or all; filters AND together. create_mesh turns vertex / face data into triangles with every index
// checked and the caps applied.

/** welded position key — faceEdit's keyOf (1e-4 grid) @param {{x: number, y: number, z: number}} v */
export const vertexKey = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;

/** how many faces / vertices a selection preview lists */
export const PREVIEW_MAX = 200;
/** create_mesh caps */
export const MESH_MAX_VERTICES = 20000;
export const MESH_MAX_FACES = 20000;
export const MESH_MAX_CORNERS = 32;
const COORD_MAX = 1000;

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/** @param {any} a @param {any} b @param {any} c @returns {number[]} the (unnormalized) normal, length = 2 × area */
function cross(a, b, c) {
	const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
	const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
	return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** @param {number[]} v */
function unit(v) {
	const l = Math.hypot(v[0], v[1], v[2]);
	return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/**
 * A direction as given: [x, y, z] or a word ('up', '+y', '-x', 'down', 'front' …).
 * @param {any} d @returns {number[] | null}
 */
export function directionOf(d) {
	if (Array.isArray(d) && d.length === 3 && d.every((n) => Number.isFinite(Number(n)))) {
		const u = unit(d.map(Number));
		return u[0] || u[1] || u[2] ? u : null;
	}
	const words = /** @type {Record<string, number[]>} */ ({
		up: [0, 1, 0], top: [0, 1, 0], '+y': [0, 1, 0], y: [0, 1, 0],
		down: [0, -1, 0], bottom: [0, -1, 0], '-y': [0, -1, 0],
		'+x': [1, 0, 0], x: [1, 0, 0], right: [1, 0, 0],
		'-x': [-1, 0, 0], left: [-1, 0, 0],
		'+z': [0, 0, 1], z: [0, 0, 1], front: [0, 0, 1],
		'-z': [0, 0, -1], back: [0, 0, -1]
	});
	return typeof d === 'string' ? (words[d.trim().toLowerCase()] ?? null) : null;
}

/** @param {any} box @returns {{min: number[], max: number[]} | null} */
function boxOf(box) {
	const ok = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
	if (!box || !ok(box.min) || !ok(box.max)) return null;
	/** @type {number[]} */
	const min = box.min.map(Number);
	/** @type {number[]} */
	const max = box.max.map(Number);
	return { min: min.map((m, i) => Math.min(m, max[i])), max: max.map((m, i) => Math.max(m, min[i])) };
}

/** @param {number[]} p @param {{min: number[], max: number[]}} b */
const inBox = (p, b) => p.every((v, i) => v >= b.min[i] - 1e-6 && v <= b.max[i] + 1e-6);

/**
 * Check a `select` object. @param {any} select
 * @returns {{all: boolean, indices: number[] | null, normal: number[] | null, cos: number, box: {min: number[], max: number[]} | null} | {error: string}}
 */
export function parseSelect(select) {
	if (!select || typeof select !== 'object' || Array.isArray(select))
		return { error: 'select: an object like {"normal": "up"}, {"indices": [0, 3]}, {"box": {"min": [..], "max": [..]}} or {"all": true}' };
	const all = select.all === true;
	let indices = null;
	if (select.indices !== undefined) {
		if (!Array.isArray(select.indices) || !select.indices.every((/** @type {any} */ i) => Number.isInteger(i) && i >= 0))
			return { error: 'select.indices: a list of whole numbers ≥ 0 (from a preview: ops: [])' };
		indices = select.indices.slice(0, 100000);
	}
	let normal = null;
	if (select.normal !== undefined) {
		normal = directionOf(select.normal);
		if (!normal) return { error: 'select.normal: [x, y, z] or a word: up, down, +x, -x, +z, -z' };
	}
	const angle = select.angle === undefined ? 30 : Number(select.angle);
	if (!Number.isFinite(angle) || angle < 0 || angle > 180) return { error: 'select.angle: degrees, 0-180 (default 30)' };
	let box = null;
	if (select.box !== undefined) {
		box = boxOf(select.box);
		if (!box) return { error: 'select.box: {"min": [x, y, z], "max": [x, y, z]} in the object\'s own (local) space' };
	}
	if (!all && !indices && !normal && !box) return { error: 'select: give indices, normal, box or all: true' };
	return { all, indices, normal, cos: Math.cos((angle * Math.PI) / 180), box };
}

/**
 * The faces of a partition with their normal and centroid (area-weighted).
 * @param {any[]} tris @param {number[][]} partition
 * @returns {{index: number, tris: number[], normal: number[], centroid: number[]}[]}
 */
export function facesOf(tris, partition) {
	return partition.map((triIndices, index) => {
		const n = [0, 0, 0];
		const c = [0, 0, 0];
		let w = 0;
		for (const ti of triIndices) {
			const t = tris[ti];
			if (!t) continue;
			const nn = cross(t[0], t[1], t[2]);
			const area = Math.hypot(nn[0], nn[1], nn[2]) / 2 || 1e-9;
			for (let k = 0; k < 3; k++) n[k] += nn[k];
			for (const v of t) {
				c[0] += (v.x * area) / 3;
				c[1] += (v.y * area) / 3;
				c[2] += (v.z * area) / 3;
			}
			w += area;
		}
		return { index, tris: triIndices, normal: unit(n), centroid: c.map((v) => v / (w || 1)) };
	});
}

/**
 * The welded vertices of a triangle soup, in order of first use, each with its normal: the mean of
 * the DISTINCT face directions around it (so a box corner leans equally into its three sides,
 * whatever the triangulation — an area or triangle-count weighting would tilt it toward the side
 * that happens to have two triangles there).
 * @param {any[]} tris @returns {{index: number, key: string, position: number[], normal: number[]}[]}
 */
export function verticesOf(tris) {
	/** @type {Map<string, {index: number, key: string, position: number[], n: number[], seen: Set<string>}>} */
	const byKey = new Map();
	for (const t of tris) {
		const nn = unit(cross(t[0], t[1], t[2]));
		const dir = nn.map((x) => Math.round(x * 100)).join(',');
		for (const v of t) {
			const key = vertexKey(v);
			let row = byKey.get(key);
			if (!row) byKey.set(key, (row = { index: byKey.size, key, position: [v.x, v.y, v.z], n: [0, 0, 0], seen: new Set() }));
			if (row.seen.has(dir)) continue;
			row.seen.add(dir);
			for (let k = 0; k < 3; k++) row.n[k] += nn[k];
		}
	}
	return [...byKey.values()].map((r) => ({ index: r.index, key: r.key, position: r.position, normal: unit(r.n) }));
}

/**
 * Apply a parsed selection to rows that have `index`, `normal` and a point (`centroid` / `position`).
 * @template {{index: number, normal: number[]}} T
 * @param {T[]} rows @param {any} sel parseSelect's result @param {(row: T) => number[]} pointOf
 * @returns {{picked: T[], outOfRange: number[]}}
 */
export function applySelect(rows, sel, pointOf) {
	const outOfRange = sel.indices ? sel.indices.filter((/** @type {number} */ i) => i >= rows.length) : [];
	const wanted = sel.indices ? new Set(sel.indices) : null;
	const picked = rows.filter((row) => {
		if (wanted && !wanted.has(row.index)) return false;
		if (sel.normal) {
			const d = row.normal[0] * sel.normal[0] + row.normal[1] * sel.normal[1] + row.normal[2] * sel.normal[2];
			if (d < sel.cos - 1e-9) return false;
		}
		if (sel.box && !inBox(pointOf(row), sel.box)) return false;
		return true;
	});
	return { picked, outOfRange };
}

/**
 * What edit_mesh with no ops answers: the faces and vertices (selected ones when a selection is
 * given), capped at PREVIEW_MAX each, rounded.
 * @param {any[]} faces facesOf rows @param {any[]} vertices verticesOf rows
 */
export function previewOf(faces, vertices) {
	return {
		faceCount: faces.length,
		vertexCount: vertices.length,
		faces: faces.slice(0, PREVIEW_MAX).map((f) => ({ index: f.index, normal: f.normal.map(r3), centroid: f.centroid.map(r3), triangles: f.tris.length })),
		vertices: vertices.slice(0, PREVIEW_MAX).map((v) => ({ index: v.index, position: v.position.map(r3) })),
		...(faces.length > PREVIEW_MAX || vertices.length > PREVIEW_MAX ? { truncated: 'lists show the first ' + PREVIEW_MAX + '; narrow with select' } : {})
	};
}

/**
 * create_mesh's data → triangles. Faces are polygons of 3-32 corners (fan-triangulated: give convex
 * polygons, or triangles); every index is checked. `uvs` is one [u, v] per vertex.
 * @param {any} args
 * @returns {{positions: number[], uvs: number[] | null, partition: number[][], triangles: number} | {error: string}}
 */
export function meshFromData(args) {
	const vertices = args?.vertices;
	const faces = args?.faces;
	if (!Array.isArray(vertices) || vertices.length < 3) return { error: 'vertices: at least 3 points [x, y, z]' };
	if (vertices.length > MESH_MAX_VERTICES) return { error: 'vertices: at most ' + MESH_MAX_VERTICES + ' (got ' + vertices.length + ')' };
	/** @type {number[][]} */
	const verts = [];
	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
			return { error: 'vertices[' + i + ']: [x, y, z] numbers' };
		if (v.some((n) => Math.abs(n) > COORD_MAX)) return { error: 'vertices[' + i + ']: coordinates within ±' + COORD_MAX + ' m' };
		verts.push(v);
	}
	if (!Array.isArray(faces) || !faces.length) return { error: 'faces: at least one face, e.g. [[0, 1, 2]] (indices into vertices)' };
	if (faces.length > MESH_MAX_FACES) return { error: 'faces: at most ' + MESH_MAX_FACES + ' (got ' + faces.length + ')' };
	let uvs = null;
	if (args.uvs !== undefined) {
		if (!Array.isArray(args.uvs) || args.uvs.length !== verts.length)
			return { error: 'uvs: one [u, v] per vertex (' + verts.length + '), or leave it out' };
		for (let i = 0; i < args.uvs.length; i++) {
			const uv = args.uvs[i];
			if (!Array.isArray(uv) || uv.length !== 2 || !uv.every((n) => typeof n === 'number' && Number.isFinite(n)))
				return { error: 'uvs[' + i + ']: [u, v] numbers' };
		}
		uvs = /** @type {number[][]} */ (args.uvs);
	}
	/** @type {number[]} */
	const positions = [];
	/** @type {number[]} */
	const uvOut = [];
	/** @type {number[][]} */
	const partition = [];
	let tri = 0;
	for (let f = 0; f < faces.length; f++) {
		const face = faces[f];
		if (!Array.isArray(face) || face.length < 3 || face.length > MESH_MAX_CORNERS)
			return { error: 'faces[' + f + ']: 3-' + MESH_MAX_CORNERS + ' vertex indices' };
		for (const i of face)
			if (!Number.isInteger(i) || i < 0 || i >= verts.length)
				return { error: 'faces[' + f + ']: index ' + JSON.stringify(i) + ' is not a vertex (0-' + (verts.length - 1) + ')' };
		if (new Set(face).size !== face.length) return { error: 'faces[' + f + ']: a corner is repeated' };
		/** @type {number[]} */
		const own = [];
		for (let k = 1; k + 1 < face.length; k++) {
			for (const i of [face[0], face[k], face[k + 1]]) {
				positions.push(verts[i][0], verts[i][1], verts[i][2]);
				if (uvs) uvOut.push(uvs[i][0], uvs[i][1]);
			}
			own.push(tri++);
		}
		partition.push(own);
	}
	if (tri > MESH_MAX_FACES * 2) return { error: 'faces: ' + tri + ' triangles after splitting polygons; the cap is ' + MESH_MAX_FACES * 2 };
	return { positions, uvs: uvs ? uvOut : null, partition, triangles: tri };
}
