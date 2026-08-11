// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// UV UNWRAP (PR #110). Turns 3D positions into UV coordinates.
//
// Deliberately a REGISTRY, not a single algorithm: `unwrap(faces, options)` returns
// `{uvs, islands}` and backends register under a key. The built-ins are projections
// plus a shelf packer — pure JS, deterministic, no dependency, and the same maths
// every DCC calls "projection unwrap". A heavier automatic unwrapper (xatlas, LSCM)
// arrives later as a hot-loadable MODULE registering through `registerUnwrapBackend`,
// so the core stays light and projections remain available either way.
//
// Nothing here touches the scene: a backend is a pure function from triangles to
// UVs, so the caller owns the commit (uvEditor's snapshot-diff path) and this file
// stays trivially testable.

/**
 * @typedef {{ corners: THREE.Vector3[], tri: number }} UnwrapFace
 * a triangle in OBJECT space plus its index, as `readTriangles` order
 * @typedef {{ uvs: number[][][], islands: number[][] }} UnwrapResult
 *   `uvs[i]` = the three [u,v] corners for face i; `islands` = groups of face indices
 * @typedef {(faces: UnwrapFace[], options?: any) => UnwrapResult} UnwrapBackend
 */

/** @type {Map<string, {label: string, run: UnwrapBackend}>} */
const backends = new Map();

/**
 * Register an unwrap backend. A module can add one at runtime; a later registration
 * under an existing key REPLACES it, so a module can also upgrade a built-in.
 * @param {string} key @param {string} label @param {UnwrapBackend} run
 */
export function registerUnwrapBackend(key, label, run) {
	backends.set(key, { label, run });
}

/** the backends currently available, for the UI to list
 * @returns {{key: string, label: string}[]} */
export function unwrapBackends() {
	return [...backends.entries()].map(([key, value]) => ({ key, label: value.label }));
}

/**
 * Run a backend. @param {string} key @param {UnwrapFace[]} faces @param {any} [options]
 * @returns {UnwrapResult|null}
 */
export function unwrap(key, faces, options = {}) {
	const backend = backends.get(key);
	if (!backend || !faces?.length) return null;
	return backend.run(faces, options);
}

// ---- helpers ---------------------------------------------------------------

/** @param {UnwrapFace} face */
function faceNormal(face) {
	const [a, b, c] = face.corners;
	return new THREE.Vector3()
		.subVectors(b, a)
		.cross(new THREE.Vector3().subVectors(c, a))
		.normalize();
}

/** the bounding box of every corner, used to normalise a projection into 0..1
 * @param {UnwrapFace[]} faces */
function boundsOf(faces) {
	const box = new THREE.Box3();
	for (const face of faces) for (const corner of face.corners) box.expandByPoint(corner);
	return box;
}

/** normalise raw planar coordinates into 0..1, preserving ASPECT so the texture is
 * not sheared (a per-axis stretch is the classic ugly-unwrap mistake)
 * @param {number[][][]} raw @param {number} [margin] */
function normalizeAspect(raw, margin = 0) {
	let uMin = Infinity;
	let vMin = Infinity;
	let uMax = -Infinity;
	let vMax = -Infinity;
	for (const face of raw)
		for (const [u, v] of face) {
			uMin = Math.min(uMin, u);
			uMax = Math.max(uMax, u);
			vMin = Math.min(vMin, v);
			vMax = Math.max(vMax, v);
		}
	const span = Math.max(uMax - uMin, vMax - vMin) || 1;
	const scale = (1 - margin * 2) / span;
	return raw.map((face) =>
		face.map(([u, v]) => [margin + (u - uMin) * scale, margin + (v - vMin) * scale])
	);
}

/** the two axes to keep when projecting along `axis` (0=x, 1=y, 2=z). Chosen so the
 * result is not mirrored when seen from the +axis side. @param {number} axis */
function planeAxes(axis) {
	if (axis === 0) return [2, 1]; // looking down +X: Z right, Y up
	if (axis === 1) return [0, 2]; // looking down +Y: X right, Z forward
	return [0, 1]; // looking down +Z: X right, Y up
}

// ---- built-in backends -----------------------------------------------------

/**
 * PLANAR: project every face down one axis. One island — this is the "decal" unwrap,
 * and it deliberately overlaps back faces, which is what makes it useful for flat
 * geometry and wrong for closed shapes.
 * @type {UnwrapBackend}
 */
function planarUnwrap(faces, options = {}) {
	const axis = options.axis ?? 1;
	const [ai, bi] = planeAxes(axis);
	const keys = ['x', 'y', 'z'];
	const raw = faces.map((face) =>
		face.corners.map((corner) => [
			/** @type {any} */ (corner)[keys[ai]],
			/** @type {any} */ (corner)[keys[bi]]
		])
	);
	return { uvs: normalizeAspect(raw, options.margin ?? 0), islands: [faces.map((_, i) => i)] };
}

/**
 * BOX: project each face down whichever axis its NORMAL points along most, giving six
 * islands that are then packed. The default for a cube — and the fix for "all six
 * sides share one UV square", which is what a primitive ships with.
 * @type {UnwrapBackend}
 */
function boxUnwrap(faces, options = {}) {
	const keys = ['x', 'y', 'z'];
	/** @type {Map<number, number[]>} side key -> face indices */
	const sides = new Map();
	const raw = faces.map((face, i) => {
		const normal = faceNormal(face);
		const abs = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
		const axis = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
		const sign = /** @type {any} */ (normal)[keys[axis]] < 0 ? -1 : 1;
		const side = axis * 2 + (sign < 0 ? 1 : 0);
		let list = sides.get(side);
		if (!list) sides.set(side, (list = []));
		list.push(i);
		const [ai, bi] = planeAxes(axis);
		// flip one axis on the back side so the projection is not mirrored
		return face.corners.map((corner) => [
			/** @type {any} */ (corner)[keys[ai]] * sign,
			/** @type {any} */ (corner)[keys[bi]]
		]);
	});
	const islands = [...sides.values()];
	return packIslands(raw, islands, options);
}

/**
 * CYLINDRICAL: angle around `axis` becomes u, height becomes v. The seam sits where
 * the angle wraps; faces straddling it are shifted to the nearer side so they do not
 * smear the whole texture across themselves.
 * @type {UnwrapBackend}
 */
function cylindricalUnwrap(faces, options = {}) {
	const axis = options.axis ?? 1;
	const keys = ['x', 'y', 'z'];
	const [ai, bi] = planeAxes(axis);
	const box = boundsOf(faces);
	const centre = box.getCenter(new THREE.Vector3());
	const min = /** @type {any} */ (box.min)[keys[axis]];
	const height = /** @type {any} */ (box.max)[keys[axis]] - min || 1;
	const raw = faces.map((face) => {
		const corners = face.corners.map((corner) => {
			const a = /** @type {any} */ (corner)[keys[ai]] - /** @type {any} */ (centre)[keys[ai]];
			const b = /** @type {any} */ (corner)[keys[bi]] - /** @type {any} */ (centre)[keys[bi]];
			const u = (Math.atan2(b, a) / (Math.PI * 2) + 0.5) % 1;
			const v = (/** @type {any} */ (corner)[keys[axis]] - min) / height;
			return [u, v];
		});
		return unwrapSeam(corners);
	});
	return { uvs: raw, islands: [faces.map((_, i) => i)] };
}

/**
 * SPHERICAL: longitude -> u, latitude -> v. Same seam treatment as cylindrical, and
 * the poles pinch by definition (every spherical map does).
 * @type {UnwrapBackend}
 */
function sphericalUnwrap(faces, options = {}) {
	const box = boundsOf(faces);
	const centre = box.getCenter(new THREE.Vector3());
	const raw = faces.map((face) => {
		const corners = face.corners.map((corner) => {
			const d = new THREE.Vector3().subVectors(corner, centre).normalize();
			const u = (Math.atan2(d.z, d.x) / (Math.PI * 2) + 0.5) % 1;
			const v = 1 - Math.acos(THREE.MathUtils.clamp(d.y, -1, 1)) / Math.PI;
			return [u, v];
		});
		return unwrapSeam(corners);
	});
	return { uvs: raw, islands: [faces.map((_, i) => i)] };
}

/**
 * A triangle whose corners land on opposite sides of the u=0/1 wrap would stretch
 * right across the texture. Shift the outliers past the seam so the triangle stays
 * contiguous (u may leave 0..1, which is correct and why RepeatWrapping matters).
 * @param {number[][]} corners
 */
function unwrapSeam(corners) {
	const us = corners.map((c) => c[0]);
	if (Math.max(...us) - Math.min(...us) <= 0.5) return corners;
	return corners.map(([u, v]) => [u < 0.5 ? u + 1 : u, v]);
}

// ---- packing ---------------------------------------------------------------

/**
 * Lay islands out side by side without overlap: a SHELF packer (sort by height, fill
 * a row, start a new row when full). Not optimal — optimal rectangle packing is
 * NP-hard — but deterministic, fast, and it never overlaps, which is the property
 * that actually matters for texturing.
 * @param {number[][][]} raw @param {number[][]} islands @param {any} [options]
 * @returns {UnwrapResult}
 */
export function packIslands(raw, islands, options = {}) {
	const margin = options.margin ?? 0.01;
	/** measure each island in its own local space */
	const boxes = islands.map((faceIndices) => {
		let uMin = Infinity;
		let vMin = Infinity;
		let uMax = -Infinity;
		let vMax = -Infinity;
		for (const fi of faceIndices)
			for (const [u, v] of raw[fi]) {
				uMin = Math.min(uMin, u);
				uMax = Math.max(uMax, u);
				vMin = Math.min(vMin, v);
				vMax = Math.max(vMax, v);
			}
		return { uMin, vMin, w: uMax - uMin || 1e-6, h: vMax - vMin || 1e-6 };
	});
	// normalise every island to the same SCALE first, so a big face does not dwarf a
	// small one in texel density (uniform texel density is the point of packing)
	const longest = Math.max(...boxes.map((b) => Math.max(b.w, b.h))) || 1;
	const order = islands.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h);
	// a square-ish grid of shelves: sqrt(count) columns is a good enough first cut
	const target = Math.ceil(Math.sqrt(islands.length));
	const cell = (1 - margin) / target;
	/** @type {number[][][]} */
	const out = raw.map((face) => face.map((c) => [...c]));
	let col = 0;
	let row = 0;
	for (const islandIndex of order) {
		const box = boxes[islandIndex];
		const scale = (cell - margin) / (Math.max(box.w, box.h) / longest) / longest;
		const ox = margin + col * cell;
		const oy = margin + row * cell;
		for (const fi of islands[islandIndex])
			out[fi] = out[fi].map(([u, v]) => [
				ox + (u - box.uMin) * scale,
				oy + (v - box.vMin) * scale
			]);
		col++;
		if (col >= target) {
			col = 0;
			row++;
		}
	}
	return { uvs: out, islands };
}

registerUnwrapBackend('box', 'Box projection', boxUnwrap);
registerUnwrapBackend('planar', 'Planar projection', planarUnwrap);
registerUnwrapBackend('cylindrical', 'Cylindrical', cylindricalUnwrap);
registerUnwrapBackend('spherical', 'Spherical', sphericalUnwrap);
