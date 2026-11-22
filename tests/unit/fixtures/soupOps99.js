// @ts-nocheck — a frozen copy of the PRE-PORT triangle-soup operators (faceEdit.js at 99-edit-core
// 17d9a01b), kept as the parity reference for roadmap 99 K4 family 1. Do not edit: the kernel ports
// are measured against exactly this code.
import * as THREE from 'three';
import { appendedQuads } from '$lib/meshTopology.js';
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

// ---- family 2 (99 K4): the face bevel core, verbatim from faceEdit.js at 17d9a01b ----
export function bevelFacesCore(tris, face, options = {}) {
	const n = options.segments ?? 1;
	const total = options.width ?? 0.15;
	const profile = Math.min(Math.max(options.profile ?? 1, -1), 1);
	// P7a: the sign picks WHICH curve the schedule blends toward, the magnitude
	// how far from the straight ramp it goes
	const concave = profile < 0;
	const curve = Math.abs(profile);
	const depth = (options.direction === 'in' ? -1 : 1) * total;
	// the cap keeps its triangle INDICES through inset (it shrinks in place) and through
	// the welded move, so one descriptor drives every step
	const cap = {
		triIndices: [...face.triIndices],
		normal: face.normal.clone(),
		centroid: face.centroid.clone()
	};
	let out = cloneTris(tris);
	/** @type {number[][]} */
	const authored = [];
	for (let k = 1; k <= n; k++) {
		const from = ((k - 1) / n) * (Math.PI / 2);
		const to = (k / n) * (Math.PI / 2);
		// THE STEP SCHEDULE. Linear = equal shares, a straight ramp. The CONVEX
		// quarter circle (profile > 0) tracks sin with the insets and cos with the
		// pushes: the border runs inward first and the cap rises late, so the
		// chamfer leaves the surrounding surface tangentially and turns up into
		// the cap. The CONCAVE quarter circle (P7a, profile < 0) is the same arc
		// with the two trig roles SWAPPED — cos drives the insets and sin the
		// pushes — so it rises first and runs inward late, curving the other side
		// of the ramp. `curve` = |profile| blends linear -> the chosen curve.
		//
		// EVERY column here sums to exactly 1 over the n steps, which is what keeps
		// the total reach profile-independent (the suite asserts it): the linear
		// column is n copies of 1/n; sin(to)-sin(from) telescopes to
		// sin(pi/2) - sin(0) = 1; cos(from)-cos(to) telescopes to
		// cos(0) - cos(pi/2) = 1. A blend of columns that each sum to 1 sums to 1.
		const arcSin = Math.sin(to) - Math.sin(from);
		const arcCos = Math.cos(from) - Math.cos(to);
		const curveInset = concave ? arcCos : arcSin;
		const curvePush = concave ? arcSin : arcCos;
		const insetShare = ((1 - curve) * 1) / n + curve * curveInset;
		const pushShare = ((1 - curve) * 1) / n + curve * curvePush;
		const worldStep = insetShare * total;
		if (worldStep > 1e-9) {
			// convert per component: a multi-piece cap insets each piece toward its
			// OWN centre by the SAME world distance
			for (const component of componentsOfTris(out, cap.triIndices)) {
				const t = insetDistanceToFraction(out, component, worldStep);
				const startLength = out.length;
				out = insetFace(out, { triIndices: component }, t);
				// the appended ring is consecutive pushQuad pairs — the same authoring
				// shape every append-only op uses
				for (const quad of appendedQuads(startLength, out.length)) authored.push(quad);
			}
		}
		const pushStep = pushShare * depth;
		if (pushStep) {
			// re-read the cap's live centroid: it moved with the previous step
			cap.centroid = centroidOfTris(out, cap.triIndices);
			out = moveFaceAlongNormal(out, cap, pushStep);
		}
	}
	return { tris: out, authored, capTriIndices: cap.triIndices };
}

// ---- family 2 (99 K4): the vertex bevel, verbatim from faceEdit.js at 17d9a01b ----
const FACE_COPLANAR = 0.999;
/**
 * Group triangles into logical faces: union triangles that share an edge AND
 * are coplanar (near-parallel normals). Returns [{triIndices, normal,
 * centroid}]. @param {any[]} tris
 */
function groupFaces(tris) {
	const n = tris.length;
	const parent = [...Array(n).keys()];
	const find = (/** @type {number} */ a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		parent[find(a)] = find(b);
	};
	const normals = tris.map(triNormal);
	/** @type {Map<string, number[]>} */
	const edgeMap = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k1 = keyOf(t[e].x, t[e].y, t[e].z);
			const k2 = keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z);
			const ek = [k1, k2].sort().join('|');
			if (!edgeMap.has(ek)) edgeMap.set(ek, []);
			/** @type {number[]} */ (edgeMap.get(ek)).push(ti);
		}
	});
	for (const list of edgeMap.values()) {
		for (let i = 1; i < list.length; i++)
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > FACE_COPLANAR) union(list[0], list[i]);
	}
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		/** @type {number[]} */ (groups.get(r)).push(i);
	}
	return [...groups.values()].map((triIndices) => {
		const normal = normals[triIndices[0]].clone();
		const centroid = new THREE.Vector3();
		let count = 0;
		triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
		centroid.divideScalar(count || 1);
		return { triIndices, normal, centroid };
	});
}

/** Ordered boundary LOOP of a tri set: its directed boundary edges walked
 * p1 -> next p0. Null unless the boundary is ONE closed loop. (E10: exported
 * for faceSelectionInfo's live edge counts.)
 * @param {any[]} tris @param {number[]} triIndices @returns {any[] | null} */
function boundaryLoop(tris, triIndices) {
	const dir = boundaryEdges(tris, { triIndices });
	if (dir.length < 3) return null;
	/** @type {Map<string, any>} */
	const byStart = new Map();
	for (const e of dir) byStart.set(keyOf(e.p0.x, e.p0.y, e.p0.z), e);
	const startKey = keyOf(dir[0].p0.x, dir[0].p0.y, dir[0].p0.z);
	/** @type {any[]} */
	const loop = [];
	let edge = dir[0];
	do {
		loop.push(edge.p0.clone());
		edge = byStart.get(keyOf(edge.p1.x, edge.p1.y, edge.p1.z));
		if (!edge) return null;
	} while (keyOf(edge.p0.x, edge.p0.y, edge.p0.z) !== startKey && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/** Clamp so two bevels on one edge can never cross and no bevel can swallow a whole edge —
 * Blender calls this "clamp overlap" and has it on by default for the same reason.
 * @param {number} width @param {number} edgeLength @returns {number} */
function clampedBevelWidth(width, edgeLength) {
	return Math.min(Math.max(width, 1e-4), edgeLength * 0.45);
}

/** corner key -> {pos, uv} for one face's triangles, so a rebuilt polygon keeps its mapping
 * @param {any[]} tris @param {number[]} triIndices */
function cornerData(tris, triIndices) {
	/** @type {Map<string, {pos: any, uv: number[]}>} */
	const map = new Map();
	for (const ti of triIndices)
		tris[ti]?.forEach((/** @type {any} */ v, /** @type {number} */ c) => {
			const key = keyOf(v.x, v.y, v.z);
			if (!map.has(key)) map.set(key, { pos: v, uv: uvAt(tris[ti], c) });
		});
	return map;
}

/**
 * Fan a polygon into triangles wound to `normal`, starting the fan at `startAt`.
 * @param {any[]} out appended to @param {{pos: any, uv: number[]}[]} ring ordered corners
 * @param {any} normal @param {any} mi @param {boolean} textured @param {number} startAt
 * @returns {number[]} the out indices appended
 */
function fanPolygon(out, ring, normal, mi, textured, startAt = 0) {
	/** @type {number[]} */
	const added = [];
	const n = ring.length;
	if (n < 3) return added;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		const tri = [a.pos.clone(), b.pos.clone(), c.pos.clone()];
		const uv = textured ? [a.uv, b.uv, c.uv] : undefined;
		added.push(out.length);
		if (triNormal(tri).dot(normal) < 0)
			out.push(withSlot([tri[0], tri[2], tri[1]], mi, uv && [uv[0], uv[2], uv[1]]));
		else out.push(withSlot(tri, mi, uv));
	}
	return added;
}

/** E9: pick the world axis least aligned with n (deterministic tangent seed)
 * @param {any} n */
function axisLeastAlignedWith(n) {
	const ax = Math.abs(n.x),
		ay = Math.abs(n.y),
		az = Math.abs(n.z);
	if (ax <= ay && ax <= az) return new THREE.Vector3(1, 0, 0);
	if (ay <= az) return new THREE.Vector3(0, 1, 0);
	return new THREE.Vector3(0, 0, 1);
}

/**
 * Bevel ONE vertex: cut the corner off, rebuild every face around it, cap the hole.
 * @param {any[]} tris @param {string} vertexKey @param {number} width
 * @param {number} profile -1 dished .. 0 flat .. +1 domed
 * @param {number} [segments] 19-A P7c: concentric rings in the cap (1 = the single fan /
 *   cone it always was, byte for byte)
 * @returns {{tris: any[], capKeys: string[]}|null} null when the corner cannot be bevelled
 */
function bevelOneVertex(tris, vertexKey, width, profile, segments = 1) {
	const atVertex = groupFaces(tris).filter((face) =>
		face.triIndices.some((/** @type {number} */ ti) =>
			tris[ti].some((/** @type {any} */ v) => keyOf(v.x, v.y, v.z) === vertexKey)
		)
	);
	// a corner needs three faces to have anything to cut off; fewer means an open border,
	// where the right answer is a different operation
	if (atVertex.length < 3) return null;
	/** @type {Map<string, any>} neighbour key -> the offset point ON THAT EDGE, shared by
	 * the two faces meeting there, which is what keeps the result watertight */
	const offsets = new Map();
	/** @type {any[]} */
	const plan = [];
	for (const face of atVertex) {
		const loop = boundaryLoop(tris, face.triIndices);
		if (!loop) return null; // a face with a hole or a split boundary is not this case
		const corners = cornerData(tris, face.triIndices);
		const index = loop.findIndex((/** @type {any} */ p) => keyOf(p.x, p.y, p.z) === vertexKey);
		if (index < 0) return null;
		const n = loop.length;
		const vertex = loop[index];
		const vertexUv = corners.get(vertexKey)?.uv ?? [0, 0];
		/** @param {any} neighbour */
		const offsetTo = (neighbour) => {
			const key = keyOf(neighbour.x, neighbour.y, neighbour.z);
			const span = neighbour.clone().sub(vertex);
			const length = span.length();
			const w = clampedBevelWidth(width, length);
			if (!offsets.has(key))
				offsets.set(key, vertex.clone().addScaledVector(span.clone().normalize(), w));
			// the uv travels the same fraction along the edge, so the mapping does not shear
			return {
				key,
				uv: uvLerp(vertexUv, corners.get(key)?.uv ?? vertexUv, length > 1e-9 ? w / length : 0)
			};
		};
		plan.push({
			face,
			loop,
			corners,
			index,
			a: offsetTo(loop[(index - 1 + n) % n]),
			b: offsetTo(loop[(index + 1) % n])
		});
	}
	if (offsets.size < 3) return null;
	/** @type {any[]} */
	const out = [];
	/** @type {Set<number>} */
	const replaced = new Set();
	for (const entry of plan) for (const ti of entry.face.triIndices) replaced.add(ti);
	// every untouched triangle carries through unchanged
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (!replaced.has(ti))
			out.push(withSlot([t[0].clone(), t[1].clone(), t[2].clone()], t.mi, t.uv));
	});
	// rebuild each face: its boundary with the corner replaced by the two offset points
	for (const entry of plan) {
		const { face, loop, corners, index, a, b } = entry;
		const n = loop.length;
		const mi = tris[face.triIndices[0]].mi;
		const textured = !!tris[face.triIndices[0]].uv;
		/** @type {{pos: any, uv: number[]}[]} */
		const ring = [];
		for (let i = 1; i < n; i++) {
			const point = loop[(index + i) % n];
			const key = keyOf(point.x, point.y, point.z);
			ring.push({ pos: point.clone(), uv: corners.get(key)?.uv ?? [0, 0] });
		}
		// boundary order is ... previous, VERTEX, next ...; the two new corners take its
		// place, so the ring reads Pnext, next, ..., previous, Pprevious
		ring.unshift({ pos: offsets.get(b.key).clone(), uv: b.uv });
		ring.push({ pos: offsets.get(a.key).clone(), uv: a.uv });
		fanPolygon(out, ring, face.normal, mi, textured, 1);
	}
	// CAP the hole. Order the offset points by angle around the corner's average normal: a
	// corner this op accepts is convex, so the angular order IS the ring order.
	const normal = new THREE.Vector3();
	for (const entry of plan) normal.add(entry.face.normal);
	if (normal.lengthSq() < 1e-12) return null;
	normal.normalize();
	const points = [...offsets.values()];
	const centre = new THREE.Vector3();
	for (const point of points) centre.add(point);
	centre.multiplyScalar(1 / points.length);
	const uAxis = new THREE.Vector3().crossVectors(axisLeastAlignedWith(normal), normal).normalize();
	const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
	const ordered = points
		.map((point) => {
			const d = point.clone().sub(centre);
			return { point, angle: Math.atan2(d.dot(vAxis), d.dot(uAxis)) };
		})
		.sort((x, y) => x.angle - y.angle)
		.map((entry) => entry.point);
	const capMi = tris[plan[0].face.triIndices[0]].mi;
	const capTextured = !!tris[plan[0].face.triIndices[0]].uv;
	// the cap is new surface with no mapping to inherit; the offset points' own uvs come
	// from different faces and would tear, so it takes one small patch value
	const capUv = plan[0].a.uv;
	const ring = ordered.map((point) => ({ pos: point, uv: capUv }));
	const capStart = out.length;
	if (segments > 1) {
		// 19-A P7c SEGMENTS: the cap becomes concentric rings between its border and its
		// centre. Ring j sits at u = j/segments of the way in, lifted along the corner
		// normal by profile * width * sin(u * PI/2) — the SAME apex height the one-segment
		// dome reaches (u = 1), but on a curve that leaves the border at an angle and
		// flattens toward the top: a rounded corner instead of a cone. Profile 0 gives a
		// flat cap, just subdivided. The border ring is untouched, so the faces around
		// the corner meet it exactly as before (watertight by construction).
		const lift = (/** @type {number} */ u) => profile * width * Math.sin((u * Math.PI) / 2);
		/** @type {any[][]} */
		const rings = [ordered.map((p) => p.clone())];
		for (let j = 1; j < segments; j++) {
			const u = j / segments;
			rings.push(ordered.map((p) => p.clone().lerp(centre, u).addScaledVector(normal, lift(u))));
		}
		const top = centre.clone().addScaledVector(normal, lift(1));
		const n = ordered.length;
		for (let j = 0; j + 1 < rings.length; j++)
			for (let i = 0; i < n; i++)
				pushQuad(
					out,
					rings[j][i].clone(),
					rings[j][(i + 1) % n].clone(),
					rings[j + 1][(i + 1) % n].clone(),
					rings[j + 1][i].clone(),
					normal,
					capMi,
					capTextured ? [capUv, capUv, capUv, capUv] : undefined
				);
		const last = rings[rings.length - 1];
		for (let i = 0; i < n; i++)
			fanPolygon(
				out,
				[
					{ pos: top, uv: capUv },
					{ pos: last[i], uv: capUv },
					{ pos: last[(i + 1) % n], uv: capUv }
				],
				normal,
				capMi,
				capTextured,
				0
			);
	} else if (Math.abs(profile) < 1e-3) {
		fanPolygon(out, ring, normal, capMi, capTextured, 0);
	} else {
		// DOMED (+) or DISHED (-): fan from an apex pushed along the corner normal. Flat is
		// only one of the three looks a chamfer is asked for, and this is the in/out control.
		const apex = { pos: centre.clone().addScaledVector(normal, profile * width), uv: capUv };
		for (let i = 0; i < ring.length; i++)
			fanPolygon(out, [apex, ring[i], ring[(i + 1) % ring.length]], normal, capMi, capTextured, 0);
	}
	// the cap's keys = its border + (P7c) every inner ring point and the top, so the
	// authoring pass claims ALL of the cap's triangles as one face
	/** @type {Set<string>} */
	const capKeys = new Set(ordered.map((p) => keyOf(p.x, p.y, p.z)));
	// (one segment keeps its pre-P7c authoring exactly: border keys only)
	if (segments > 1)
		for (let ti = capStart; ti < out.length; ti++)
			for (const v of out[ti]) capKeys.add(keyOf(v.x, v.y, v.z));
	return { tris: out, capKeys: [...capKeys] };
}

/**
 * P1 (19-A): the PURE core of the VERTEX bevel — the per-key corner surgery
 * loop, triangles in, triangles out, no session or scene reads. Each vertex is
 * processed against the CURRENT triangles (two selected corners of one face
 * both land correctly), with the width clamped per edge inside `bevelOneVertex`
 * (`clampedBevelWidth`) so two bevels sharing an edge can never cross.
 * @param {any[]} tris @param {string[]} vertexKeys welded position keys
 * @param {{width?: number, profile?: number, segments?: number}} [options] width/profile
 *   already clamped; P7c segments 1..8 (clamped here)
 * @returns {{tris: any[], caps: string[][], done: number, skipped: number}}
 *   caps = each bevelled corner's cap ring keys, for the wrapper's authoring
 */
export function bevelVerticesCore(tris, vertexKeys, options = {}) {
	const width = options.width ?? 0.2;
	const profile = options.profile ?? 0;
	const segments = Math.max(1, Math.min(Math.round(options.segments ?? 1) || 1, 8));
	let out = tris;
	/** @type {string[][]} each bevelled corner's cap ring, to author its face */
	const caps = [];
	let done = 0;
	let skipped = 0;
	for (const key of vertexKeys) {
		const result = bevelOneVertex(out, key, width, profile, segments);
		if (!result) {
			skipped++;
			continue;
		}
		out = result.tris;
		caps.push(result.capKeys);
		done++;
	}
	return { tris: out, caps, done, skipped };
}

// ---- family 2 (99 K4): the edge bevel, verbatim from faceEdit.js at 17d9a01b ----
const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
/**
 * Fan an ordered ring into triangles IN RING ORDER — (r0, ri, ri+1) — with no
 * normal test: the ring's own order carries the winding (see the section note).
 * @param {any[]} out appended to @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {number} [startAt]
 * @returns {number[]} the out indices appended
 */
function fanLoop(out, ring, mi, textured, startAt = 0) {
	/** @type {number[]} */
	const added = [];
	const n = ring.length;
	if (n < 3) return added;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		added.push(out.length);
		out.push(
			withSlot([a.pos.clone(), b.pos.clone(), c.pos.clone()], mi, textured ? [a.uv, b.uv, c.uv] : undefined)
		);
	}
	return added;
}

/**
 * Fan a ring from its BEST corner. A dissolved region is rarely a convex planar
 * polygon: a 2x2 grid's centre leaves an octagon whose edge midpoints are
 * collinear with its corners (a corner start emits zero-area slivers), and a box
 * corner leaves a hexagon whose far corners are joined by the NEIGHBOURING faces'
 * diagonals (a spoke along one gives that edge four faces — non-manifold). So
 * every start is scored: a spoke may not duplicate an edge in `avoid` (the
 * surviving mesh's edges), and the start whose smallest triangle is largest wins;
 * ties prefer a corner outside `preferNot` (the removed vertex's neighbours — the
 * dissolve re-appearance rule), then the lowest index. With no valid start the
 * ring is fanned from its centroid instead, whose spokes are new by construction.
 * @param {any[]} out @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {Set<string>} avoid welded edge keys
 * @param {Set<string>} [preferNot] welded vertex keys
 * @returns {number[]} the out indices appended
 */
function fanBest(out, ring, mi, textured, avoid, preferNot = new Set()) {
	const n = ring.length;
	if (n < 3) return [];
	const keys = ring.map((c) => keyOf(c.pos.x, c.pos.y, c.pos.z));
	let best = -1;
	let bestArea = -1;
	let bestPreferred = false;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (avoid.has(edgeKey(keys[s], keys[(s + i) % n]))) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = ring[s].pos;
			const b = ring[(s + i) % n].pos;
			const c = ring[(s + i + 1) % n].pos;
			const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length();
			minArea = Math.min(minArea, area);
		}
		const preferred = !preferNot.has(keys[s]);
		const better =
			minArea > bestArea * (1 + 1e-9) + 1e-12 ||
			(Math.abs(minArea - bestArea) <= bestArea * 1e-9 + 1e-12 && preferred && !bestPreferred);
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
			bestPreferred = preferred;
		}
	}
	if (best >= 0 && bestArea > 1e-12) return fanLoop(out, ring, mi, textured, best);
	const hub = { pos: new THREE.Vector3(), uv: [0, 0] };
	for (const c of ring) {
		hub.pos.add(c.pos);
		hub.uv[0] += c.uv[0] / n;
		hub.uv[1] += c.uv[1] / n;
	}
	hub.pos.multiplyScalar(1 / n);
	/** @type {number[]} */
	const added = [];
	for (let i = 0; i < n; i++) added.push(...fanLoop(out, [hub, ring[i], ring[(i + 1) % n]], mi, textured, 0));
	return added;
}

/** every welded edge of the triangles NOT in `drop` — what a new fan must not
 * duplicate @param {any[]} tris @param {Set<number>} drop */
function survivingEdges(tris, drop) {
	/** @type {Set<string>} */
	const edges = new Set();
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (drop.has(ti)) return;
		for (let e = 0; e < 3; e++)
			edges.add(edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)));
	});
	return edges;
}

/**
 * One edge. Returns the new triangles + the strip's vertex keys, `'valence'` when an
 * endpoint has too many faces for an unambiguous answer, or null when it cannot be done.
 * @param {any[]} tris @param {string} edgeKeyString @param {number} width
 * @param {number} segments @param {number} profile
 * @returns {{tris: any[]}|'valence'|null}
 */
function bevelOneEdge(tris, edgeKeyString, width, segments, profile) {
	const [ka, kb] = edgeKeyString.split('|');
	const faces = groupFaces(tris);
	const hasEdge = (/** @type {any} */ face) => {
		const loop = boundaryLoop(tris, face.triIndices);
		if (!loop) return null;
		const keys = loop.map((/** @type {any} */ p) => keyOf(p.x, p.y, p.z));
		const ia = keys.indexOf(ka);
		const ib = keys.indexOf(kb);
		if (ia < 0 || ib < 0) return null;
		const adjacent = Math.abs(ia - ib) === 1 || Math.abs(ia - ib) === keys.length - 1;
		return adjacent ? { loop, keys } : null;
	};
	/** the two faces the bevelled edge belongs to, each gaining its own offset endpoints
	 * @type {{face: any, loop: any[], keys: string[], a?: any, b?: any}[]} */
	const sides = [];
	for (const face of faces) {
		const hit = hasEdge(face);
		if (hit) sides.push({ face, ...hit });
	}
	if (sides.length !== 2) return null;
	const pointOf = (/** @type {string} */ key) => {
		for (const t of tris) for (const v of t) if (keyOf(v.x, v.y, v.z) === key) return v;
		return null;
	};
	const pa = pointOf(ka);
	const pb = pointOf(kb);
	if (!pa || !pb) return null;
	const along = pb.clone().sub(pa);
	if (along.lengthSq() < 1e-12) return null;
	const w = clampedBevelWidth(width, along.length());
	along.normalize();
	// each side folds INTO its own face: perpendicular to the edge, in the face plane
	for (const side of sides) {
		const inward = side.face.centroid.clone().sub(pa);
		inward.addScaledVector(along, -inward.dot(along));
		if (inward.lengthSq() < 1e-12) return null;
		inward.normalize().multiplyScalar(w);
		side.a = pa.clone().add(inward);
		side.b = pb.clone().add(inward);
	}
	/** every face at an endpoint that is NOT one of the two sides */
	const others = (/** @type {string} */ key) =>
		faces.filter(
			(face) =>
				!sides.some((side) => side.face === face) &&
				face.triIndices.some((/** @type {number} */ ti) =>
					tris[ti].some((/** @type {any} */ v) => keyOf(v.x, v.y, v.z) === key)
				)
		);
	const otherAtA = others(ka);
	const otherAtB = others(kb);
	// exactly one other face per endpoint = valence 3, the case with an exact answer
	// (the chain rule below). 19-A P7c: two or more = the MITERED corner. None = the
	// edge just continues straight into a flat region, which has nothing to fold.
	if (!otherAtA.length || !otherAtB.length) return 'valence';
	// 19-A P7c: at a VALENCE-3 end the side point slides ALONG the side face's other edge
	// there (Blender's offset rule) instead of sitting at the perpendicular offset: the
	// third face is bounded by exactly that edge, so it stays planar and the chamfer
	// stays inside the solid. On a box the two points coincide (the edges meet at 90°);
	// at a pyramid's base corner the perpendicular one dipped BELOW the base. The
	// distance keeps the strip's perpendicular width (w / sin of the corner angle),
	// clamped like every bevel width so two bevels on one edge can never cross.
	for (const side of sides)
		for (const [endKey, farKey, others, pick] of /** @type {const} */ ([
			[ka, kb, otherAtA, 'a'],
			[kb, ka, otherAtB, 'b']
		])) {
			if (others.length !== 1) continue;
			const n = side.keys.length;
			const i = side.keys.indexOf(endKey);
			const prev = side.keys[(i - 1 + n) % n];
			const j = prev === farKey ? (i + 1) % n : (i - 1 + n) % n;
			const end = side.loop[i];
			const span = side.loop[j].clone().sub(end);
			const length = span.length();
			if (length < 1e-9) continue;
			span.multiplyScalar(1 / length);
			const sin = new THREE.Vector3().crossVectors(along, span).length();
			if (sin < 1e-3) continue; // a near-straight corner: keep the perpendicular point
			side[pick] = end.clone().addScaledVector(span, Math.min(w / sin, length * 0.45));
		}

	// The CHAMFER STRIP's rings first: both kinds of endpoint have to meet its side chain.
	// `profile` bulges the interior rings along the average normal — out for a round, in
	// for a hollow.
	const outward = sides[0].face.normal.clone().add(sides[1].face.normal);
	if (outward.lengthSq() < 1e-12) return null;
	outward.normalize();
	/** ring k of the strip: the pair of points at t = k / segments
	 * @type {{a: any, b: any}[]} */
	const rings = [];
	for (let k = 0; k <= segments; k++) {
		const t = k / segments;
		const bulge = Math.sin(Math.PI * t) * profile * width;
		rings.push({
			a: sides[0].a.clone().lerp(sides[1].a, t).addScaledVector(outward, bulge),
			b: sides[0].b.clone().lerp(sides[1].b, t).addScaledVector(outward, bulge)
		});
	}

	/**
	 * 19-A P7c THE MITERED CORNER — the vertex-bevel cap at the junction. At an endpoint
	 * with 2+ other faces no single face can take the strip's side chain, so the endpoint
	 * is bevelled like a vertex: every OTHER edge at it gets ONE offset point at the
	 * bevel width (keyed by the far vertex, so the two faces sharing that edge use the
	 * identical point — the vertex bevel's watertightness rule), every face around it
	 * swaps the vertex for its two replacements (a side face: its strip side point and
	 * the offset on its other edge), and a CAP closes the hole. The cap is walked from
	 * the faces' own new edges, each taken the other way round, which runs from one
	 * strip side point to the other; the strip's WHOLE side chain closes it back (the
	 * multi-segment endpoint rule — every chain point, or a T-junction at 2+ segments).
	 * @param {string} vk the endpoint @param {string} wk the edge's other end
	 * @param {any[]} otherFaces @param {boolean} atA
	 */
	const miterPlan = (vk, wk, otherFaces, atA) => {
		const V = pointOf(vk);
		if (!V) return null;
		/** @type {Map<string, any>} far-vertex key -> the edge's offset point */
		const offsetOn = new Map();
		const plan = [];
		for (const face of [...sides.map((side) => side.face), ...otherFaces]) {
			const loop = boundaryLoop(tris, face.triIndices);
			if (!loop) return null;
			const keys = loop.map((/** @type {any} */ p) => keyOf(p.x, p.y, p.z));
			const i = keys.indexOf(vk);
			if (i < 0) return null;
			const n = keys.length;
			const corners = cornerData(tris, face.triIndices);
			const vUv = corners.get(vk)?.uv ?? [0, 0];
			const side = sides.find((sd) => sd.face === face);
			/** @param {number} j loop index of the neighbour */
			const replacement = (j) => {
				const x = keys[j];
				if (x === wk) return side ? { pos: atA ? side.a : side.b, uv: vUv } : null;
				const span = loop[j].clone().sub(V);
				const length = span.length();
				if (length < 1e-9) return null;
				const w = clampedBevelWidth(width, length);
				let q = offsetOn.get(x);
				if (!q) offsetOn.set(x, (q = V.clone().addScaledVector(span.normalize(), w)));
				return { pos: q, uv: uvLerp(vUv, corners.get(x)?.uv ?? vUv, w / length) };
			};
			const before = replacement((i - 1 + n) % n);
			const after = replacement((i + 1) % n);
			if (!before || !after) return null;
			plan.push({ face, loop, keys, i, before, after, corners });
		}
		// the cap: each face's new edge before -> after, taken after -> before
		/** @type {Map<string, any>} */
		const next = new Map();
		/** @type {Set<string>} */
		const incoming = new Set();
		for (const entry of plan) {
			const from = keyOf(entry.after.pos.x, entry.after.pos.y, entry.after.pos.z);
			const to = keyOf(entry.before.pos.x, entry.before.pos.y, entry.before.pos.z);
			if (next.has(from)) return null; // two faces leave one point: not a disc
			next.set(from, entry.before.pos);
			incoming.add(to);
		}
		const startKey = [...next.keys()].find((k) => !incoming.has(k));
		if (!startKey) return null;
		const chainKey = (/** @type {number} */ k) => {
			const p = atA ? rings[k].a : rings[k].b;
			return keyOf(p.x, p.y, p.z);
		};
		/** @type {any[]} */
		const path = [];
		let at = startKey;
		let guard = 0;
		/** @type {any} */
		let atPos = plan.find((e) => keyOf(e.after.pos.x, e.after.pos.y, e.after.pos.z) === startKey)?.after.pos;
		while (atPos && guard++ <= plan.length) {
			path.push(atPos);
			const to = next.get(at);
			if (!to) break;
			atPos = to;
			at = keyOf(to.x, to.y, to.z);
		}
		if (path.length !== plan.length + 1) return null; // every face's edge, one chain
		const first = keyOf(path[0].x, path[0].y, path[0].z);
		const last = keyOf(path[path.length - 1].x, path[path.length - 1].y, path[path.length - 1].z);
		/** @type {number[]} chain indices back from `last` to `first`, exclusive */
		let chain;
		if (last === chainKey(segments) && first === chainKey(0)) {
			chain = [];
			for (let k = segments - 1; k >= 1; k--) chain.push(k);
		} else if (last === chainKey(0) && first === chainKey(segments)) {
			chain = [];
			for (let k = 1; k <= segments - 1; k++) chain.push(k);
		} else return null;
		const capRing = [...path, ...chain.map((k) => (atA ? rings[k].a : rings[k].b))];
		return { plan, capRing };
	};
	const miterA = otherAtA.length >= 2 ? miterPlan(ka, kb, otherAtA, true) : null;
	const miterB = otherAtB.length >= 2 ? miterPlan(kb, ka, otherAtB, false) : null;
	if ((otherAtA.length >= 2 && !miterA) || (otherAtB.length >= 2 && !miterB)) return null;

	/** @type {any[]} */
	const out = [];
	/** @type {Set<number>} */
	const replaced = new Set();
	for (const face of [...sides.map((s) => s.face), ...otherAtA, ...otherAtB])
		for (const ti of face.triIndices) replaced.add(ti);
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (!replaced.has(ti))
			out.push(withSlot([t[0].clone(), t[1].clone(), t[2].clone()], t.mi, t.uv));
	});
	const avoid = survivingEdges(tris, replaced);
	/** a mitered endpoint's replacement pair for `face`, or null when it is not one
	 * @param {any} miter @param {any} face */
	const miterPair = (miter, face) => miter?.plan.find((/** @type {any} */ e) => e.face === face) ?? null;
	// the two side faces keep their corner COUNT at a valence-3 end (the corner just moves
	// to its own offset); at a mitered end it becomes two corners, the side point and the
	// offset on the face's other edge there
	for (const side of sides) {
		const corners = cornerData(tris, side.face.triIndices);
		const mi = tris[side.face.triIndices[0]].mi;
		const textured = !!tris[side.face.triIndices[0]].uv;
		const pairA = miterPair(miterA, side.face);
		const pairB = miterPair(miterB, side.face);
		const ring = side.loop.flatMap((/** @type {any} */ point) => {
			const key = keyOf(point.x, point.y, point.z);
			const uv = corners.get(key)?.uv ?? [0, 0];
			const pair = key === ka ? pairA : key === kb ? pairB : null;
			if (pair)
				return [
					{ pos: pair.before.pos.clone(), uv: pair.before.uv },
					{ pos: pair.after.pos.clone(), uv: pair.after.uv }
				];
			if (key === ka) return [{ pos: side.a.clone(), uv }];
			if (key === kb) return [{ pos: side.b.clone(), uv }];
			return [{ pos: point.clone(), uv }];
		});
		if (pairA || pairB) fanBest(out, ring, mi, textured, avoid);
		else fanPolygon(out, ring, side.face.normal, mi, textured, 0);
	}
	const stripMi = tris[sides[0].face.triIndices[0]].mi;
	const stripTextured = !!tris[sides[0].face.triIndices[0]].uv;
	for (let k = 0; k < segments; k++) {
		pushQuad(
			out,
			rings[k].a,
			rings[k].b,
			rings[k + 1].b,
			rings[k + 1].a,
			outward,
			stripMi,
			stripTextured
				? [
						[k / segments, 0],
						[k / segments, 1],
						[(k + 1) / segments, 1],
						[(k + 1) / segments, 0]
					]
				: undefined
		);
	}

	// MITERED ends: every other face swaps the vertex for its two offsets, then the cap
	for (const miter of [miterA, miterB]) {
		if (!miter) continue;
		for (const entry of miter.plan) {
			if (sides.some((side) => side.face === entry.face)) continue; // rebuilt above
			const n = entry.keys.length;
			/** @type {any[]} */
			const ring = [];
			for (let k = 0; k < n; k++) {
				if (k === entry.i) {
					ring.push({ pos: entry.before.pos.clone(), uv: entry.before.uv });
					ring.push({ pos: entry.after.pos.clone(), uv: entry.after.uv });
				} else
					ring.push({
						pos: entry.loop[k].clone(),
						uv: entry.corners.get(entry.keys[k])?.uv ?? [0, 0]
					});
			}
			const mi = tris[entry.face.triIndices[0]].mi;
			fanBest(out, ring, mi, !!tris[entry.face.triIndices[0]].uv, avoid);
		}
		// the cap is new surface: one small patch of mapping, the vertex bevel's rule
		const capUv = miter.plan[0].before.uv;
		fanBest(
			out,
			miter.capRing.map((/** @type {any} */ p) => ({ pos: p.clone(), uv: capUv })),
			stripMi,
			stripTextured,
			avoid
		);
	}

	// VALENCE-3 ends: the third face at the endpoint gains corners: its vertex is
	// replaced by the WHOLE chain of strip side points, not just the two ends. With one
	// segment that is the two offsets; with more, the chain has interior points too —
	// feeding only the ends left a T-junction against the strip and the mesh was
	// non-manifold at 2+ segments (measured: 6 odd edges at 2 segments, 8 at 3, exactly
	// two per extra segment).
	/** @type {{key: string, face: any}[]} */
	const endpoints = [
		...(miterA ? [] : [{ key: ka, face: otherAtA[0] }]),
		...(miterB ? [] : [{ key: kb, face: otherAtB[0] }])
	];
	for (const { key, face } of endpoints) {
		const loop = boundaryLoop(tris, face.triIndices);
		if (!loop) return null;
		const corners = cornerData(tris, face.triIndices);
		const keys = loop.map((/** @type {any} */ p) => keyOf(p.x, p.y, p.z));
		const index = keys.indexOf(key);
		if (index < 0) return null;
		const count = keys.length;
		const previousKey = keys[(index - 1 + count) % count];
		// which side does the PREVIOUS boundary edge belong to? that side ends the chain
		const previousSide =
			sides.find((side) => side.keys.includes(previousKey) && side.keys.includes(key)) ?? sides[0];
		const forward = previousSide === sides[0]; // the chain runs t: 0 -> 1
		const mi = tris[face.triIndices[0]].mi;
		const textured = !!tris[face.triIndices[0]].uv;
		const uv = corners.get(key)?.uv ?? [0, 0];
		const sidePoint = (/** @type {number} */ k) => (key === ka ? rings[k].a : rings[k].b);
		/** @type {any[]} */
		const ring = [];
		for (let i = 1; i < count; i++) {
			const pointKey = keys[(index + i) % count];
			ring.push({ pos: loop[(index + i) % count].clone(), uv: corners.get(pointKey)?.uv ?? [0, 0] });
		}
		// the boundary reads: Pnext, next, ..., previous, Pprevious, <chain back to Pnext>
		ring.unshift({ pos: sidePoint(forward ? segments : 0).clone(), uv });
		for (let k = 0; k <= segments; k++) {
			const at = forward ? k : segments - k;
			if (at === (forward ? segments : 0)) continue; // Pnext is already at the front
			ring.push({ pos: sidePoint(at).clone(), uv });
		}
		// in RING order (the face's own winding), never by a per-triangle normal test: a
		// bulged chain leaves the face plane, and the normal test flipped fan triangles
		// there (measured: 6 reversed edges at 5 segments, profile 0.5). Same start, so
		// wherever the old test did not flip, the triangles are identical.
		fanLoop(out, ring, mi, textured, 1);
	}

	return { tris: out };
}

/**
 * P1 (19-A): the PURE core of the EDGE bevel — the per-edge chamfer loop,
 * triangles in, triangles out, no session reads. One edge at a time, each
 * against the CURRENT triangles: bevelling two edges that share a face has to
 * see the first result, and the shared-vertex case is refused inside
 * `bevelOneEdge` anyway (which also clamps the width per edge —
 * `clampedBevelWidth` — so two bevels on one edge can never cross).
 * @param {any[]} tris @param {string[]} edgeKeys canonical welded edge keys
 * @param {{width?: number, segments?: number, profile?: number}} [options]
 *   segments already clamped (and bumped to 2 for a bulge) by the caller
 * @returns {{tris: any[], done: number, refusedValence: number, refusedBorder: number}}
 */
export function bevelEdgesCore(tris, edgeKeys, options = {}) {
	const width = options.width ?? 0.1;
	const segments = options.segments ?? 1;
	const profile = options.profile ?? 0;
	let out = cloneTris(tris);
	let done = 0;
	let refusedValence = 0;
	let refusedBorder = 0;
	for (const key of edgeKeys) {
		const result = bevelOneEdge(out, key, width, segments, profile);
		if (result === 'valence') {
			refusedValence++;
			continue;
		}
		if (!result) {
			refusedBorder++;
			continue;
		}
		out = result.tris;
		done++;
	}
	return { tris: out, done, refusedValence, refusedBorder };
}

