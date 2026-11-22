// @ts-nocheck — a frozen copy of the PRE-PORT triangle-soup operators (faceEdit.js at 99-edit-core
// 17d9a01b), kept as the parity reference for roadmap 99 K4 family 1. Do not edit: the kernel ports
// are measured against exactly this code.
import * as THREE from 'three';
/** rounded position key @param {number} x @param {number} y @param {number} z */
function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}
/** @param {any} tri @param {number=} mi @param {any=} uv */
function withSlot(tri, mi, uv) {
	tri.mi = mi || 0;
	if (uv) tri.uv = uv; // M1: per-corner [[u,v],[u,v],[u,v]], absent when untextured
	return tri;
}
/** M1: uv of a triangle corner, or [0,0] when the mesh is untextured.
 * @param {any} tri @param {number} corner */
function uvAt(tri, corner) {
	return tri?.uv ? tri.uv[corner] : [0, 0];
}

/** M1: linear blend of two uv pairs @param {number[]} a @param {number[]} b @param {number} t */
function uvLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** M1: the uv centroid of a triangle set — inset shrinks toward it in uv space
 * exactly as the positions shrink toward the spatial centroid.
 * @param {any[]} tris @param {number[]} triIndices */
function uvCentroidOf(tris, triIndices) {
	let u = 0;
	let v = 0;
	let n = 0;
	for (const ti of triIndices) {
		if (!tris[ti]?.uv) continue;
		for (const pair of tris[ti].uv) {
			u += pair[0];
			v += pair[1];
			n++;
		}
	}
	return n ? [u / n, v / n] : [0, 0];
}

/** @param {any[]} t triangle */
function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) =>
		withSlot(
			[t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			t.uv && t.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		)
	);
}

/** average vertex position of a triangle set @param {any[]} tris @param {number[]} triIndices */
function centroidOfTris(tris, triIndices) {
	const centroid = new THREE.Vector3();
	let count = 0;
	triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
	return centroid.divideScalar(count || 1);
}

/**
 * Split a target triangle set into CONNECTED COMPONENTS, welded by vertex
 * position. `opTargetFace` synthesizes ONE face for a multi-selection, so a
 * selection spanning two separate shells arrives as a single "face" whose
 * centroid sits in the empty space between them — any op that reasons about a
 * face's CENTRE has to work per component or it drags one shell toward the
 * other (15-G: two merged cubes, both top faces inset, slid together).
 * @param {any[]} tris @param {number[]} triIndices @returns {number[][]}
 */
export function componentsOfTris(tris, triIndices) {
	/** @type {Map<string, string>} */
	const parent = new Map();
	const find = (/** @type {string} */ key) => {
		let root = key;
		while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
		while (parent.get(key) !== root) {
			const next = /** @type {string} */ (parent.get(key));
			parent.set(key, root);
			key = next;
		}
		return root;
	};
	const keysOf = (/** @type {number} */ ti) =>
		tris[ti].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	for (const ti of triIndices) {
		const keys = keysOf(ti);
		for (const key of keys) if (!parent.has(key)) parent.set(key, key);
		for (let i = 1; i < keys.length; i++) parent.set(find(keys[0]), find(keys[i]));
	}
	/** @type {Map<string, number[]>} */
	const byRoot = new Map();
	for (const ti of triIndices) {
		const root = find(keysOf(ti)[0]);
		let list = byRoot.get(root);
		if (!list) byRoot.set(root, (list = []));
		list.push(ti);
	}
	return [...byRoot.values()];
}

/** boundary edges of a face group: directed edges appearing once (unordered)
 * within the group @param {any[]} tris @param {any} face */
function boundaryEdges(tris, face) {
	/** @type {any[]} */
	const dir = [];
	/** @type {Map<string, number>} */
	const count = new Map();
	face.triIndices.forEach((/** @type {number} */ ti) => {
		const t = tris[ti];
		for (let e = 0; e < 3; e++) {
			const p0 = t[e];
			const p1 = t[(e + 1) % 3];
			const ek = [keyOf(p0.x, p0.y, p0.z), keyOf(p1.x, p1.y, p1.z)].sort().join('|');
			count.set(ek, (count.get(ek) || 0) + 1);
			// `ti` = the triangle this directed edge belongs to, so a wall stitched
			// onto it can take that triangle's OWN normal + material slot (15-G);
			// `c0`/`c1` are the CORNER indices within that triangle, which is how a
			// stitched wall reads the edge's UVs (M1)
			dir.push({ ek, p0, p1, ti, c0: e, c1: (e + 1) % 3 });
		}
	});
	return dir.filter((d) => count.get(d.ek) === 1);
}

/**
 * Add a quad (a,b,c,d) as two triangles, winding it so its normal aligns with
 * wantDir — otherwise the wall/ring backface-culls to invisible (121 fix).
 * @param {any[]} out @param {any} a @param {any} b @param {any} c @param {any} d @param {any} wantDir
 * @param {number=} mi material slot the new geometry belongs to (15-G)
 * @param {any[]=} uvs M1: the four corners' [u,v] in a,b,c,d order — the uv
 *   permutation follows the winding flip, or the texture would shear
 */
function pushQuad(out, a, b, c, d, wantDir, mi, uvs) {
	let t1 = [a, b, c];
	let t2 = [a, c, d];
	let uv1 = uvs && [uvs[0], uvs[1], uvs[2]];
	let uv2 = uvs && [uvs[0], uvs[2], uvs[3]];
	if (triNormal(t1).dot(wantDir) < 0) {
		t1 = [a, c, b];
		t2 = [a, d, c];
		uv1 = uvs && [uvs[0], uvs[2], uvs[1]];
		uv2 = uvs && [uvs[0], uvs[3], uvs[2]];
	}
	out.push(withSlot(t1, mi, uv1), withSlot(t2, mi, uv2));
}

/**
 * Outward direction of the wall stitched onto a boundary edge — the side that
 * must face the viewer, or the wall backface-culls to invisible.
 *
 * Derived LOCALLY from the edge itself: boundary edges inherit their direction
 * from the triangles' winding, and a face is wound counter-clockwise seen from
 * +normal, so `edge x normal` points away from the face interior. It used to be
 * measured from the face CENTROID instead, which is only right for a single
 * convex face: with two shells multi-selected the synthetic centroid lands in
 * the gap between them, so the two walls FACING EACH OTHER were wound inward
 * and vanished (15-G — extruding both top faces of two merged cubes). Concave
 * faces and faces with holes were wrong for the same reason.
 * @param {any} p0 @param {any} p1 @param {any} normal
 */
function edgeOutward(p0, p1, normal) {
	const out = new THREE.Vector3().subVectors(p1, p0).cross(normal);
	// an edge always lies in its own face plane, so this is only ever degenerate
	// for a zero-area triangle
	if (out.lengthSq() < 1e-12) return normal.clone();
	return out.normalize();
}

/** Extrude a face by dist along its normal, stitching visible side walls @param {any[]} tris @param {any} face @param {number} dist */
export function extrudeFace(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const faceSet = new Set(face.triIndices);
	const boundary = boundaryEdges(tris, face);
	out.forEach((t, ti) => {
		if (faceSet.has(ti)) t.forEach((/** @type {any} */ v) => v.add(offset));
	});
	boundary.forEach(({ p0, p1, ti, c0, c1 }) => {
		const a = p0.clone();
		const b = p1.clone();
		const a2 = p0.clone().add(offset);
		const b2 = p1.clone().add(offset);
		// The wall's uv runs ALONG the extrusion, at the base edge's own texel
		// density. The first M1 pass gave the offset copies their base corner's
		// uv, which collapsed the wall's v range to zero and smeared a single
		// texel line up the whole side — the "second extrude breaks the texture"
		// report. Advancing perpendicular in uv space by (world distance x uv
		// units per world unit) keeps the aspect ratio, so repeated extrudes
		// stack bands of consistent scale.
		const uvA = uvAt(tris[ti], c0);
		const uvB = uvAt(tris[ti], c1);
		const along = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
		const uvLen = Math.hypot(along[0], along[1]);
		const worldLen = p0.distanceTo(p1);
		const step = uvLen > 1e-9 && worldLen > 1e-9 ? (uvLen / worldLen) * dist : dist;
		const perp =
			uvLen > 1e-9 ? [(-along[1] / uvLen) * step, (along[0] / uvLen) * step] : [0, step];
		const uvA2 = [uvA[0] + perp[0], uvA[1] + perp[1]];
		const uvB2 = [uvB[0] + perp[0], uvB[1] + perp[1]];
		// each wall takes its OWN triangle's normal + slot: a multi-selection can
		// span shells (and, in a mixed selection, differently-facing faces)
		pushQuad(
			out,
			a,
			b,
			b2,
			a2,
			edgeOutward(p0, p1, triNormal(tris[ti])),
			tris[ti].mi,
			tris[ti].uv ? [uvA, uvB, uvB2, uvA2] : undefined
		);
	});
	return out;
}

/** position keys of a face's vertices (138: weld set for a move) @param {any[]} tris @param {any} face */
function faceVertexKeys(tris, face) {
	const keys = new Set();
	face.triIndices.forEach((/** @type {number} */ ti) =>
		tris[ti].forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)))
	);
	return keys;
}

/**
 * Push/pull a face along its normal, WELDED (138): every vertex sharing the
 * face's corner positions moves too, so adjacent faces stretch with it instead
 * of the face detaching and tearing a hole. @param {any[]} tris @param {any} face @param {number} dist
 */
export function moveFaceAlongNormal(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const keys = faceVertexKeys(tris, face);
	out.forEach((t) => t.forEach((/** @type {any} */ v) => { if (keys.has(keyOf(v.x, v.y, v.z))) v.add(offset); }));
	return out;
}

/** Inset: shrink a face toward its centroid + stitch a visible frame ring so
 * the gap doesn't read as a hole (121).
 *
 * 15-G: each CONNECTED COMPONENT shrinks toward its OWN centre. A multi-select
 * spanning two shells arrives as one synthetic face whose centroid sits between
 * them, so shrinking toward it slid both faces sideways into the gap instead of
 * insetting either of them in place.
 * @param {any[]} tris @param {any} face @param {number} amount */
export function insetFace(tris, face, amount) {
	const out = cloneTris(tris);
	const t = Math.min(Math.max(amount, 0), 0.95);
	for (const component of componentsOfTris(tris, face.triIndices)) {
		const centroid = centroidOfTris(tris, component);
		// M1: the cap shrinks in UV space by the same factor it shrinks in
		// space, so the texture stays put on the smaller face instead of
		// stretching across it
		const uvCentroid = uvCentroidOf(tris, component);
		const componentSet = new Set(component);
		out.forEach((tri, ti) => {
			if (!componentSet.has(ti)) return;
			tri.forEach((/** @type {any} */ v) => v.lerp(centroid, t));
			if (tri.uv) tri.uv = tri.uv.map((/** @type {number[]} */ p) => uvLerp(p, uvCentroid, t));
		});
		// frame ring: original boundary edge → its inset counterpart, facing outward
		// like the face did (normal ≈ the face normal)
		boundaryEdges(tris, { triIndices: component }).forEach(({ p0, p1, ti, c0, c1 }) => {
			const a = p0.clone();
			const b = p1.clone();
			const b2 = p1.clone().lerp(centroid, t);
			const a2 = p0.clone().lerp(centroid, t);
			const uvA = uvAt(tris[ti], c0);
			const uvB = uvAt(tris[ti], c1);
			pushQuad(out, a, b, b2, a2, triNormal(tris[ti]), tris[ti].mi, tris[ti].uv && [
				uvA,
				uvB,
				uvLerp(uvB, uvCentroid, t),
				uvLerp(uvA, uvCentroid, t)
			]);
		});
	}
	return out;
}

/** Remove a face's triangles @param {any[]} tris @param {any} face */
export function deleteFaceTris(tris, face) {
	const faceSet = new Set(face.triIndices);
	return cloneTris(tris.filter((_, ti) => !faceSet.has(ti)));
}

/**
 * 19-A P3: convert a WORLD inset distance to the FRACTION `insetFace` lerps by,
 * for ONE connected component. The face bevel takes its width in world units
 * now, like the edge and vertex bevels always did — the same number used to
 * mean two different sizes depending on which bevel you were in.
 *
 * A boundary vertex lerped by `t` travels `t * dist(v, centroid)`, so dividing
 * the wanted world distance by the MEAN boundary radius makes the border travel
 * ≈ `width` world units (exact on a symmetric face, approximate on an
 * irregular one — the vertices farther out travel proportionally farther,
 * which is also what keeps the inset similar in shape). Clamped to 0.95 like
 * every inset, so an oversized width collapses toward the centre instead of
 * overshooting past it.
 * @param {any[]} tris @param {number[]} componentTriIndices ONE welded component
 * @param {number} width world distance @returns {number} lerp fraction 0..0.95
 */
export function insetDistanceToFraction(tris, componentTriIndices, width) {
	const centroid = centroidOfTris(tris, componentTriIndices);
	/** @type {Set<string>} */
	const seen = new Set();
	let sum = 0;
	let count = 0;
	for (const edge of boundaryEdges(tris, { triIndices: componentTriIndices })) {
		for (const p of [edge.p0, edge.p1]) {
			const key = keyOf(p.x, p.y, p.z);
			if (seen.has(key)) continue;
			seen.add(key);
			sum += p.distanceTo(centroid);
			count++;
		}
	}
	const mean = count ? sum / count : 0;
	if (mean < 1e-9) return 0.95; // a degenerate/closed component: fully collapsed
	return Math.min(Math.max(width / mean, 0), 0.95);
}

/** averaged (unit) normal of a triangle subset — the per-piece direction the
 * individual ops move along @param {any[]} tris @param {number[]} triIndices */
function averagedNormal(tris, triIndices) {
	const normal = new THREE.Vector3();
	for (const ti of triIndices) normal.add(triNormal(tris[ti]));
	if (normal.lengthSq() < 1e-9) normal.copy(triNormal(tris[triIndices[0]]));
	return normal.normalize();
}

/**
 * 19-A P3: EXTRUDE INDIVIDUAL — split the target into its connected pieces
 * (componentsOfTris) and extrude each along its OWN averaged normal, instead
 * of the one direction the synthesized target face averages across all of
 * them. Pure: it just loops `extrudeFace` per component, which appends its
 * walls after the survivors, so the component indices stay valid throughout
 * and `appendedQuads(origLen, out.length)` still authors every wall.
 * @param {any[]} tris @param {any} face the op target ({triIndices})
 * @param {number} dist @returns {any[]}
 */
export function extrudeFacesIndividual(tris, face, dist) {
	let out = tris;
	for (const component of componentsOfTris(tris, face.triIndices)) {
		// the normal comes from the INPUT triangles: components are disjoint, so
		// no earlier component's move has touched this one's triangles
		out = extrudeFace(out, { triIndices: component, normal: averagedNormal(tris, component) }, dist);
	}
	return out;
}

/**
 * 19-A P3: INSET, extended — `insetFace` stays as the {amount} fast path (VR,
 * commitFaceOp and every replayed message go through it unchanged).
 *
 * `individual` insets each face UNIT separately, one ring apiece. The units are
 * the granularity units the selection was built from, captured by the engine
 * onto `face.units` (per QUAD at the default granularity — per connected
 * component alone would make Individual a no-op on the common case, since
 * several coplanar quads on one surface are ONE component). A caller without
 * captured units falls back to components, which is still correct across
 * shells.
 *
 * `depth` then pushes the resulting cap along its normal (world units), per
 * connected component of the CAP so a multi-piece target rises along each
 * piece's own direction — via the welded `moveFaceAlongNormal`, so the ring
 * stretches with it.
 * @param {any[]} tris @param {any} face the op target ({triIndices, units?})
 * @param {{amount?: number, depth?: number, individual?: boolean}} [options]
 * @returns {any[]}
 */
export function insetFaceEx(tris, face, options = {}) {
	const amount = options.amount ?? 0.2;
	const depth = options.depth ?? 0;
	let out = tris;
	if (options.individual) {
		const units =
			face.units?.length ? face.units : componentsOfTris(tris, face.triIndices);
		// insetFace appends each ring after the survivors, so unit indices stay valid
		for (const unit of units) out = insetFace(out, { triIndices: unit }, amount);
	} else {
		out = insetFace(out, face, amount);
	}
	if (depth) {
		for (const component of componentsOfTris(out, face.triIndices)) {
			out = moveFaceAlongNormal(
				out,
				{ triIndices: component, normal: averagedNormal(out, component) },
				depth
			);
		}
	}
	return out;
}
