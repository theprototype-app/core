// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, TControls, lockedObjects } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';

// Face editing core (118, pulled forward from pending/25 and scoped to VR
// blockout). Desktop-agnostic geometry math: read a BufferGeometry into a flat
// list of triangles, group coplanar+adjacent triangles into logical faces (a
// cube face is ONE face, not two tris), and rebuild the geometry for the four
// ops that cover ~90% of prototyping — extrude, inset, move-along-normal,
// delete. Topology changes can't ride the per-vertex `verts` channel, so every
// commit ships a full `meshgeo` snapshot (positions array + uuid, size-capped);
// receivers swap the geometry wholesale. History kind 'meshgeo' is undoable.

/** VR face cap — denser meshes are unwieldy to blockout with controllers */
export const VR_FACE_CAP = 300;
/** hard ceiling on a snapshot message (floats) — ~5k tris */
const MAX_SNAPSHOT = 45000;

/** rounded position key @param {number} x @param {number} y @param {number} z */
function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

/**
 * Read a geometry into triangles [[Vector3,Vector3,Vector3], ...] (index
 * expanded). @param {any} geometry
 */
export function readTriangles(geometry) {
	const pos = geometry.attributes.position;
	const index = geometry.index;
	const count = index ? index.count : pos.count;
	const tris = [];
	for (let i = 0; i < count; i += 3) {
		const vert = (/** @type {number} */ o) => {
			const j = index ? index.getX(i + o) : i + o;
			return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
		};
		tris.push([vert(0), vert(1), vert(2)]);
	}
	return tris;
}

/** @param {any[]} t triangle */
function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

/**
 * Group triangles into logical faces: union triangles that share an edge AND
 * are coplanar (near-parallel normals). Returns [{triIndices, normal,
 * centroid}]. @param {any[]} tris
 */
export function groupFaces(tris) {
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
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > 0.999) union(list[0], list[i]);
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

function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) => [t[0].clone(), t[1].clone(), t[2].clone()]);
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
			dir.push({ ek, p0, p1 });
		}
	});
	return dir.filter((d) => count.get(d.ek) === 1);
}

/**
 * Add a quad (a,b,c,d) as two triangles, winding it so its normal aligns with
 * wantDir — otherwise the wall/ring backface-culls to invisible (121 fix).
 * @param {any[]} out @param {any} a @param {any} b @param {any} c @param {any} d @param {any} wantDir
 */
function pushQuad(out, a, b, c, d, wantDir) {
	let t1 = [a, b, c];
	let t2 = [a, c, d];
	if (triNormal(t1).dot(wantDir) < 0) {
		t1 = [a, c, b];
		t2 = [a, d, c];
	}
	out.push(t1, t2);
}

/** radial-outward direction at a wall midpoint (perpendicular to the face
 * normal) — the visible side of an extrude wall @param {any} mid @param {any} face */
function radialOut(mid, face) {
	const r = mid.clone().sub(face.centroid);
	r.addScaledVector(face.normal, -r.dot(face.normal)); // drop the normal component
	if (r.lengthSq() < 1e-9) r.copy(face.normal);
	return r.normalize();
}

/** Extrude a face by dist along its normal, stitching visible side walls @param {any[]} tris @param {any} face @param {number} dist */
export function extrudeFace(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const faceSet = new Set(face.triIndices);
	const boundary = boundaryEdges(tris, face);
	out.forEach((t, ti) => {
		if (faceSet.has(ti)) t.forEach((v) => v.add(offset));
	});
	boundary.forEach(({ p0, p1 }) => {
		const a = p0.clone();
		const b = p1.clone();
		const a2 = p0.clone().add(offset);
		const b2 = p1.clone().add(offset);
		const mid = a.clone().add(b).add(b2).add(a2).multiplyScalar(0.25);
		pushQuad(out, a, b, b2, a2, radialOut(mid, face));
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
	out.forEach((t) => t.forEach((v) => { if (keys.has(keyOf(v.x, v.y, v.z))) v.add(offset); }));
	return out;
}

/** Inset: shrink a face toward its centroid + stitch a visible frame ring so
 * the gap doesn't read as a hole (121). @param {any[]} tris @param {any} face @param {number} amount */
export function insetFace(tris, face, amount) {
	const out = cloneTris(tris);
	const faceSet = new Set(face.triIndices);
	const t = Math.min(Math.max(amount, 0), 0.95);
	const boundary = boundaryEdges(tris, face);
	out.forEach((tri, ti) => {
		if (faceSet.has(ti)) tri.forEach((v) => v.lerp(face.centroid, t));
	});
	// frame ring: original boundary edge → its inset counterpart, facing outward
	// like the face did (normal ≈ the face normal)
	boundary.forEach(({ p0, p1 }) => {
		const a = p0.clone();
		const b = p1.clone();
		const b2 = p1.clone().lerp(face.centroid, t);
		const a2 = p0.clone().lerp(face.centroid, t);
		pushQuad(out, a, b, b2, a2, face.normal);
	});
	return out;
}

/** Remove a face's triangles @param {any[]} tris @param {any} face */
export function deleteFaceTris(tris, face) {
	const faceSet = new Set(face.triIndices);
	return cloneTris(tris.filter((_, ti) => !faceSet.has(ti)));
}

/** Triangles → a fresh non-indexed BufferGeometry with recomputed normals @param {any[]} tris */
export function trisToGeometry(tris) {
	const positions = new Float32Array(tris.length * 9);
	tris.forEach((t, i) => {
		for (let k = 0; k < 3; k++) {
			positions[i * 9 + k * 3] = t[k].x;
			positions[i * 9 + k * 3 + 1] = t[k].y;
			positions[i * 9 + k * 3 + 2] = t[k].z;
		}
	});
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	return geometry;
}

/** flat positions array for a snapshot message @param {any[]} tris */
export function trisToPositions(tris) {
	/** @type {number[]} */
	const positions = [];
	tris.forEach((t) => t.forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z)));
	return positions;
}

/**
 * Scale one axis of a flat xyz positions array about its centroid on that axis
 * (161 stretch). Pure. @param {number[]} positions @param {number} axis 0|1|2
 * @param {number} factor @returns {number[]}
 */
export function stretchPositions(positions, axis, factor) {
	const out = positions.slice();
	const count = out.length / 3;
	if (!count) return out;
	let sum = 0;
	for (let i = axis; i < out.length; i += 3) sum += out[i];
	const center = sum / count;
	for (let i = axis; i < out.length; i += 3) out[i] = center + (out[i] - center) * factor;
	return out;
}

/**
 * Swap an object's geometry to a positions snapshot (remote msg / undo replay).
 * @param {string} uuid @param {number[]} positions
 */
export function applyMeshGeo(uuid, positions) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	object.geometry?.dispose?.();
	object.geometry = geometry;
	object.userData.faceEdited = true; // parametric Geometry rows disable (like vertexEdited)
	// if we're editing this object, re-derive working tris + faces (a remote
	// change or undo swapped the geometry out from under the session, 122)
	if (faceEdited === object) {
		rebuildFaces();
		refreshFaceOverlay();
	}
	objectsGroup.update((v) => v);
}

/** Is this object simple enough to face-edit in VR? @param {any} object */
export function vrFaceEditable(object) {
	const pos = object?.geometry?.attributes?.position;
	if (!pos) return false;
	const tris = (object.geometry.index ? object.geometry.index.count : pos.count) / 3;
	return tris > 0 && tris <= VR_FACE_CAP;
}

// ---- face edit MODE (VR + desktop-parity hook) ----

/** @type {import('svelte/store').Writable<string|null>} uuid in face-edit mode */
export const faceEditObject = writable(null);
/** highlighted face index (ray/selection), or -1 @type {import('svelte/store').Writable<number>} */
export const faceEditHighlight = writable(-1);
/** armed op for the next commit @type {import('svelte/store').Writable<'extrude'|'inset'|'move'|'delete'>} */
export const faceEditOp = writable('extrude');
/** live op amount, stick-driven @type {import('svelte/store').Writable<number>} */
export const faceEditAmount = writable(0.3);
/** 176: desktop auto-apply the active extrude/inset op on face click */
export const faceAutoApply = writable(true);

/** 176: on a desktop face click, apply the active extrude/inset op if auto-apply
 * is on and a face is highlighted. Returns TRUE if it committed. */
export function autoApplyFaceOp() {
	if (!get(faceAutoApply)) return false;
	const op = get(faceEditOp);
	if (op !== 'extrude' && op !== 'inset') return false;
	if (get(faceEditHighlight) < 0) return false;
	return commitFaceOp(op, get(faceEditAmount));
}

/** Arm an op (from the Faces sub-ring) @param {'extrude'|'inset'|'move'|'delete'} op */
export function setFaceOp(op) {
	faceEditOp.set(op);
	// inset lives in 0..0.9; the others are signed distances
	faceEditAmount.set(op === 'inset' ? 0.2 : 0.3);
}

/** Nudge the live amount (grab-hand stick) @param {number} delta */
export function adjustFaceAmount(delta) {
	faceEditAmount.update((a) => {
		const op = get(faceEditOp);
		if (op === 'inset') return Math.min(Math.max(a + delta, 0.02), 0.9);
		return Math.min(Math.max(a + delta, -5), 5);
	});
}

/** Commit the armed op at the live amount on the highlighted face (VR trigger) */
export function commitArmedFaceOp() {
	const op = get(faceEditOp);
	return commitFaceOp(op, get(faceEditAmount));
}

/** @type {any} */ let faceEdited = null;
/** 175: remember the last face selected per object, restored on re-entry
 * @type {{uuid: string|null, fi: number}} */
let stashedFace = { uuid: null, fi: -1 };
/** @type {any[]} */ let workingTris = [];
/** @type {any[]} */ let faces = [];
/** @type {any} */ let overlay = null; // highlighted-face tint at the scene root

/** rebuild the working triangles + face groups from the live geometry */
function rebuildFaces() {
	if (!faceEdited) return;
	workingTris = readTriangles(faceEdited.geometry);
	faces = groupFaces(workingTris);
}

export function faceCount() {
	return faces.length;
}
/** exposed for tests/preview: the current face groups */
export function currentFaces() {
	return faces;
}

/** @param {string} uuid */
export function enterFaceEdit(uuid) {
	if (get(faceEditObject)) exitFaceEdit();
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.geometry?.attributes?.position) {
		showToast('Only meshes can be face-edited');
		return;
	}
	if (!vrFaceEditable(object)) {
		showToast('Too dense for VR face editing (max ' + VR_FACE_CAP + ' triangles)');
		return;
	}
	if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return;
	}
	faceEdited = object;
	rebuildFaces();
	faceEditHighlight.set(-1);
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach?.();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid: uuid, peerId: peer.peer.id });
	faceEditObject.set(uuid);
	if (typeof window !== 'undefined') window.addEventListener('keydown', onFaceKeydown);
	// 175: restore the face selected last time in this object (per-mode memory)
	if (stashedFace.uuid === uuid && stashedFace.fi >= 0 && faces[stashedFace.fi]) {
		faceEditHighlight.set(stashedFace.fi);
		refreshFaceOverlay();
		attachFaceGizmo();
	}
}

/** @param {KeyboardEvent} event */
function onFaceKeydown(event) {
	if (event.key === 'Escape') exitFaceEdit();
}

export function exitFaceEdit() {
	if (!faceEdited) return;
	if (get(faceEditHighlight) >= 0) stashedFace = { uuid: faceEdited.uuid, fi: get(faceEditHighlight) };
	detachFaceGizmo(); // 163: drop the desktop gizmo + its proxy
	// revert an uncommitted gesture's live preview before tearing down (122)
	const pendingBefore = faceGrab?.before ?? faceAdjust?.before ?? null;
	faceGrab = null;
	faceAdjust = null;
	if (pendingBefore) applyGeometrySnapshot(pendingBefore);
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onFaceKeydown);
	if (overlay) {
		overlay.parent?.remove(overlay);
		overlay.geometry?.dispose?.();
		overlay.material?.dispose?.();
		overlay = null;
	}
	faceEdited = null;
	workingTris = [];
	faces = [];
	faceEditHighlight.set(-1);
	faceEditObject.set(null);
}

/**
 * Map a raycast hit (three.js faceIndex = TRIANGLE index) to a logical face
 * index and highlight it. Returns TRUE only when the highlight changed, so the
 * caller ticks a haptic once and the overlay rebuilds once (121). A negative
 * triangleIndex clears the highlight. @param {number} triangleIndex
 */
export function highlightFaceByTriangle(triangleIndex) {
	const fi = triangleIndex < 0 ? -1 : faces.findIndex((f) => f.triIndices.includes(triangleIndex));
	if (fi === get(faceEditHighlight)) return false;
	faceEditHighlight.set(fi);
	refreshFaceOverlay();
	return true;
}

/** Clear the face highlight (ray left the mesh) — returns TRUE if it changed */
export function clearFaceHighlight() {
	return highlightFaceByTriangle(-1);
}

/** logical face index for a triangle index, or -1 (no highlight side-effect) @param {number} triangleIndex */
export function faceIndexForTriangle(triangleIndex) {
	return triangleIndex < 0 ? -1 : faces.findIndex((f) => f.triIndices.includes(triangleIndex));
}

/** the highlighted face's world-space centroid + normal (for ghost/preview) */
export function highlightedFaceInfo() {
	const fi = get(faceEditHighlight);
	if (fi < 0 || !faces[fi] || !faceEdited) return null;
	faceEdited.updateMatrixWorld(true);
	return {
		index: fi,
		centroid: faceEdited.localToWorld(faces[fi].centroid.clone()),
		normal: faces[fi].normal.clone().transformDirection(faceEdited.matrixWorld).normalize()
	};
}

/** tint the highlighted face with a scene-root overlay triangle set */
function refreshFaceOverlay() {
	const scene = get(globalScene);
	if (!scene || !faceEdited) return;
	const fi = get(faceEditHighlight);
	if (overlay) {
		overlay.parent?.remove(overlay);
		overlay.geometry?.dispose?.();
		overlay = null;
	}
	if (fi < 0 || !faces[fi]) return;
	/** @type {number[]} */
	const positions = [];
	faces[fi].triIndices.forEach((/** @type {number} */ ti) =>
		workingTris[ti].forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z))
	);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	overlay = new THREE.Mesh(
		geometry,
		new THREE.MeshBasicMaterial({
			color: 0xff7a1a,
			transparent: true,
			opacity: 0.4,
			depthTest: false,
			side: THREE.DoubleSide
		})
	);
	overlay.renderOrder = 999;
	overlay.name = 'face-edit-overlay';
	faceEdited.updateMatrixWorld(true);
	overlay.applyMatrix4(faceEdited.matrixWorld);
	scene.add(overlay);
}

/**
 * Run an op on the highlighted face and commit: rebuild geometry, replicate
 * the snapshot, record history. @param {'extrude'|'inset'|'move'|'delete'} op
 * @param {number} amount
 */
export function commitFaceOp(op, amount) {
	const fi = get(faceEditHighlight);
	if (!faceEdited || fi < 0 || !faces[fi]) return false;
	const before = trisToPositions(workingTris);
	const face = faces[fi];
	let next;
	if (op === 'extrude') next = extrudeFace(workingTris, face, amount);
	else if (op === 'inset') next = insetFace(workingTris, face, amount);
	else if (op === 'move') next = moveFaceAlongNormal(workingTris, face, amount);
	else if (op === 'delete') next = deleteFaceTris(workingTris, face);
	else return false;
	const positions = trisToPositions(next);
	if (positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	applyGeometrySnapshot(positions);
	broadcastMeshGeo(faceEdited.uuid, positions);
	recordEntry({ kind: 'meshgeo', uuid: faceEdited.uuid, before, after: positions });
	// delete drops the face; keep the highlight only if it still exists
	if (op === 'delete') faceEditHighlight.set(-1);
	return true;
}

/** swap the LIVE edited object's geometry + re-derive faces + overlay @param {number[]} positions */
function applyGeometrySnapshot(positions) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	faceEdited.geometry?.dispose?.();
	faceEdited.geometry = geometry;
	faceEdited.userData.faceEdited = true;
	rebuildFaces();
	refreshFaceOverlay();
	objectsGroup.update((v) => v);
}

/** @param {string} uuid @param {number[]} positions */
function broadcastMeshGeo(uuid, positions) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'meshgeo', uuid: uuid, positions: positions });
}

/**
 * Commit a full geometry snapshot for ANY object (161 stretch, 162/163 face
 * transforms): swap locally, replicate, record ONE undoable meshgeo. Size-
 * capped like the face ops. @param {string} uuid @param {number[]} before
 * @param {number[]} after @returns {boolean}
 */
export function commitMeshGeoSnapshot(uuid, before, after) {
	if (after.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	applyMeshGeo(uuid, after);
	broadcastMeshGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before, after });
	return true;
}

/** Order 4 coplanar-ish points into a convex ring around their centroid, so a
 * fan triangulation is non-self-intersecting. @param {THREE.Vector3[]} v */
function orderQuad(v) {
	const c = new THREE.Vector3();
	v.forEach((p) => c.add(p));
	c.multiplyScalar(1 / v.length);
	const n = new THREE.Vector3()
		.subVectors(v[1], v[0])
		.cross(new THREE.Vector3().subVectors(v[2], v[0]))
		.normalize();
	const u = new THREE.Vector3().subVectors(v[0], c).normalize();
	const w = new THREE.Vector3().crossVectors(n, u).normalize();
	const ang = (/** @type {THREE.Vector3} */ p) => {
		const d = new THREE.Vector3().subVectors(p, c);
		return Math.atan2(d.dot(w), d.dot(u));
	};
	return [...v].sort((a, b) => ang(a) - ang(b));
}

/** 177/183: create a triangle (3) or quad (4) face from OBJECT-LOCAL vertex
 * positions and commit it as a meshgeo snapshot (replicated + undoable). Winds
 * the new face outward (normal away from the mesh centre). Shared by the desktop
 * vertices toolbar and VR. @param {string} uuid @param {{x:number,y:number,z:number}[]} verts
 * @param {any} [viewerPos] world-space viewer position; when given, the face is wound to FACE
 * the viewer (191: in VR the face you look at must be the visible side) */
export function createFaceFromVerts(uuid, verts, viewerPos = null) {
	if (!verts || verts.length < 3 || verts.length > 4) return false;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.geometry?.attributes?.position) return false;
	let poly = verts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
	// reject degenerate selections (duplicate/collinear points)
	for (let i = 0; i < poly.length; i++)
		for (let j = i + 1; j < poly.length; j++) if (poly[i].distanceTo(poly[j]) < 1e-6) return false;
	if (poly.length === 4) poly = orderQuad(poly);
	// outward winding: flip if the face normal points toward the mesh centre
	const meshCenter = new THREE.Box3()
		.setFromBufferAttribute(object.geometry.attributes.position)
		.getCenter(new THREE.Vector3());
	const faceCenter = new THREE.Vector3();
	poly.forEach((p) => faceCenter.add(p));
	faceCenter.multiplyScalar(1 / poly.length);
	const normal = new THREE.Vector3()
		.subVectors(poly[1], poly[0])
		.cross(new THREE.Vector3().subVectors(poly[2], poly[0]));
	let flip;
	if (viewerPos) {
		// 191: wind so the normal points AT the viewer (the side they look from)
		const localViewer = object.worldToLocal(viewerPos.clone());
		flip = normal.dot(new THREE.Vector3().subVectors(localViewer, faceCenter)) < 0;
	} else {
		// outward winding: flip if the face normal points toward the mesh centre
		flip = normal.dot(new THREE.Vector3().subVectors(faceCenter, meshCenter)) < 0;
	}
	// fan-triangulate the ordered polygon
	const appended = [];
	for (let i = 1; i < poly.length - 1; i++) {
		const tri = [poly[0], poly[i], poly[i + 1]];
		const ordered = flip ? [tri[0], tri[2], tri[1]] : tri;
		for (const p of ordered) appended.push(p.x, p.y, p.z);
	}
	const before = trisToPositions(readTriangles(object.geometry));
	const after = before.concat(appended);
	return commitMeshGeoSnapshot(uuid, before, after);
}

// ---- VR face grab + live extrude/inset (122): a pending edit applied live,
// committed as ONE meshgeo on release/confirm ----

let lastFaceBroadcast = 0;
/** @type {any} rigid face-grab state */
let faceGrab = null;
/** @type {any} live extrude/inset adjust state */
let faceAdjust = null;

/** Live geometry swap from the CURRENT workingTris WITHOUT re-grouping faces
 * (indices stay stable through a gesture); broadcasts a preview ~5/s. */
function liveGeometryUpdate() {
	const positions = trisToPositions(workingTris);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	faceEdited.geometry?.dispose?.();
	faceEdited.geometry = geometry;
	faceEdited.userData.faceEdited = true;
	refreshFaceOverlay();
	objectsGroup.update((v) => v);
	const now = Date.now();
	if (now - lastFaceBroadcast > 200) {
		lastFaceBroadcast = now;
		broadcastMeshGeo(faceEdited.uuid, positions);
	}
}

/** True while a face grab or extrude/inset adjust is in progress (122) */
export function faceGesturePending() {
	return !!faceGrab || !!faceAdjust;
}

/** Begin a rigid grab of a face (grip). Captures the pre-edit snapshot + the
 * face's original local vertices. @param {number} index */
export function beginFaceGrab(index) {
	if (!faceEdited || index < 0 || !faces[index] || faceGesturePending()) return false;
	const face = faces[index];
	// weld-neighbour set (138): verts OUTSIDE the face sharing its corner
	// positions — the TRANSLATION carries them so the mesh stretches, not tears
	const faceSet = new Set(face.triIndices);
	const keys = faceVertexKeys(workingTris, face);
	/** @type {any[]} */
	const neighbours = [];
	workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (faceSet.has(ti)) return;
		t.forEach((/** @type {any} */ v, /** @type {number} */ k) => {
			if (keys.has(keyOf(v.x, v.y, v.z))) neighbours.push({ ti, k, orig: v.clone() });
		});
	});
	faceGrab = {
		index,
		before: trisToPositions(workingTris),
		originals: face.triIndices.map((/** @type {number} */ ti) =>
			workingTris[ti].map((/** @type {any} */ v) => v.clone())
		),
		neighbours,
		centroid: face.centroid.clone(),
		normal: face.normal.clone()
	};
	faceEditHighlight.set(index);
	return true;
}

/**
 * Apply a LOCAL-space rigid transform to the grabbed face around its centroid
 * (rebuilt from the snapshot each call — no drift). Pure + testable.
 * @param {{dPos?: any, dQuat?: any, push?: number, scale?: number}} t
 */
export function applyFaceGrab(t) {
	if (!faceGrab || !faceEdited) return;
	const face = faces[faceGrab.index];
	const pivot = faceGrab.centroid;
	const dPos = t.dPos || new THREE.Vector3();
	const dQuat = t.dQuat || new THREE.Quaternion();
	const scale = t.scale ?? 1;
	const pushVec = faceGrab.normal.clone().multiplyScalar(t.push || 0);
	// the ONE rigid transform (about the face centroid) applied to a base vertex
	const xf = (/** @type {any} */ v) =>
		v.clone().sub(pivot).multiplyScalar(scale).applyQuaternion(dQuat).add(pivot).add(dPos).add(pushVec);
	face.triIndices.forEach((/** @type {number} */ ti, /** @type {number} */ k) => {
		workingTris[ti] = faceGrab.originals[k].map(xf);
	});
	// 162: the welded neighbours sit at the face's CORNER positions, so they get
	// the SAME rigid transform — shared corners stay welded under rotate + scale
	// too (138 moved them by translation only, which tore the edge when the
	// controller rotated). Their far verts aren't in the set, so adjacent faces
	// stretch instead of moving rigidly.
	faceGrab.neighbours.forEach((/** @type {any} */ n) => {
		workingTris[n.ti][n.k] = xf(n.orig);
	});
	liveGeometryUpdate();
}

/** Commit the grab: finalize geometry, replicate, one undo entry. */
export function commitFaceGrab() {
	if (!faceGrab || !faceEdited) return false;
	const positions = trisToPositions(workingTris);
	const before = faceGrab.before;
	faceGrab = null;
	applyGeometrySnapshot(positions);
	broadcastMeshGeo(faceEdited.uuid, positions);
	recordEntry({ kind: 'meshgeo', uuid: faceEdited.uuid, before, after: positions });
	return true;
}

/** Drop a grab without committing — restore the pre-grab geometry. */
export function cancelFaceGrab() {
	if (!faceGrab || !faceEdited) return;
	const before = faceGrab.before;
	faceGrab = null;
	applyGeometrySnapshot(before);
}

// ---- 163: desktop face transform gizmo (a scene-root proxy driving the 162
// rigid grab). The proxy lives at the SCENE ROOT (not under the object) so it
// never leaks into GLTF sync / raycasts, like the vertex proxy. ----
/** @type {any} */ let faceProxy = null;
/** @type {any} */ let faceProxyStart = null;

function ensureFaceProxy() {
	if (faceProxy) return faceProxy;
	const scene = get(globalScene);
	if (!scene) return null;
	faceProxy = new THREE.Object3D();
	faceProxy.userData.isFaceProxy = true;
	scene.add(faceProxy);
	return faceProxy;
}

/** World-space focus target {center,radius} for the selected face, or null (173). */
export function focusTargetFace() {
	if (!faceEdited) return null;
	const fi = get(faceEditHighlight);
	if (fi < 0 || !faces[fi]) return null;
	faceEdited.updateMatrixWorld(true);
	const center = faceEdited.localToWorld(faces[fi].centroid.clone());
	const box = new THREE.Box3().setFromObject(faceEdited);
	const objR = box.getSize(new THREE.Vector3()).length() / 2;
	return { center, radius: Math.max(objR * 0.3, 0.3) };
}

/** Attach the transform gizmo to the CURRENTLY highlighted face (desktop). */
export function attachFaceGizmo() {
	if (typeof window === 'undefined' || !faceEdited) return;
	/** @type {any} */
	const controls = get(TControls);
	const fi = get(faceEditHighlight);
	if (fi < 0 || !faces[fi] || !controls) {
		detachFaceGizmo();
		return;
	}
	const proxy = ensureFaceProxy();
	if (!proxy) return;
	faceEdited.updateMatrixWorld(true);
	proxy.position.copy(faceEdited.localToWorld(faces[fi].centroid.clone()));
	proxy.quaternion.copy(faceEdited.getWorldQuaternion(new THREE.Quaternion()));
	proxy.scale.setScalar(1);
	controls.setSpace?.('local');
	controls.attach(proxy);
}

/** Detach + remove the face gizmo proxy. */
export function detachFaceGizmo() {
	/** @type {any} */
	const controls = get(TControls);
	if (faceProxy) {
		if (controls && controls.object === faceProxy) controls.detach();
		faceProxy.parent?.remove(faceProxy);
		faceProxy = null;
	}
	faceProxyStart = null;
}

/** Gizmo dragging-changed for the face proxy (163). @param {boolean} dragging */
export function onFaceGizmoDragChanged(dragging) {
	if (!faceEdited || !faceProxy) return;
	if (dragging) {
		if (beginFaceGrab(get(faceEditHighlight)))
			faceProxyStart = { pos: faceProxy.position.clone(), quat: faceProxy.quaternion.clone() };
	} else if (faceProxyStart) {
		faceProxyStart = null;
		commitFaceGrab(); // ONE meshgeo + undo; rebuilds the face cache
		attachFaceGizmo(); // re-seat on the rebuilt face
	}
}

/** Gizmo onchange for the face proxy — apply the rigid transform (163/162). */
export function onFaceGizmoMoved() {
	if (!faceEdited || !faceProxy || !faceProxyStart) return;
	const dPos = faceEdited
		.worldToLocal(faceProxy.position.clone())
		.sub(faceEdited.worldToLocal(faceProxyStart.pos.clone()));
	const dQuat = faceProxyStart.quat.clone().invert().multiply(faceProxy.quaternion);
	applyFaceGrab({ dPos, dQuat, scale: faceProxy.scale.x });
}

/**
 * Begin a live extrude/inset adjust (trigger): applies the op at a default
 * amount immediately (visible), then depth/scale sticks reshape it until a
 * second trigger commits. @param {number} index @param {'extrude'|'inset'} op @param {number} defaultAmount
 */
export function beginFaceAdjust(index, op, defaultAmount) {
	if (!faceEdited || index < 0 || !faces[index] || faceGesturePending()) return false;
	const face = faces[index];
	faceAdjust = {
		op,
		before: trisToPositions(workingTris),
		originalTris: cloneTris(workingTris),
		originalFace: {
			triIndices: [...face.triIndices],
			normal: face.normal.clone(),
			centroid: face.centroid.clone()
		},
		amount: defaultAmount,
		scale: 1
	};
	reapplyFaceAdjust();
	return true;
}

function reapplyFaceAdjust() {
	const a = faceAdjust;
	let next =
		a.op === 'inset'
			? insetFace(a.originalTris, a.originalFace, a.amount)
			: extrudeFace(a.originalTris, a.originalFace, a.amount);
	// scale the cap (the original face tris, moved in place) around its centroid
	if (a.scale !== 1) {
		const capCentroid =
			a.op === 'inset'
				? a.originalFace.centroid.clone()
				: a.originalFace.centroid.clone().add(a.originalFace.normal.clone().multiplyScalar(a.amount));
		a.originalFace.triIndices.forEach((/** @type {number} */ ti) => {
			next[ti] = next[ti].map((/** @type {any} */ v) =>
				v.clone().sub(capCentroid).multiplyScalar(a.scale).add(capCentroid)
			);
		});
	}
	workingTris = next;
	liveGeometryUpdate();
}

/** Stick reshapes the pending adjust @param {number} dAmount depth @param {number} dScale cap scale */
export function adjustFaceGesture(dAmount, dScale) {
	if (!faceAdjust) return;
	if (dAmount) {
		// 192: inset must stay in 0.02..0.9 — clamping to [-5,5] like extrude let
		// controller motion drive the inset to ~0/negative, collapsing it (it
		// looked like the second-trigger confirm had CANCELLED the operation)
		const min = faceAdjust.op === 'inset' ? 0.02 : -5;
		const max = faceAdjust.op === 'inset' ? 0.9 : 5;
		faceAdjust.amount = Math.min(Math.max(faceAdjust.amount + dAmount, min), max);
	}
	if (dScale) faceAdjust.scale = Math.min(Math.max(faceAdjust.scale + dScale, 0.05), 5);
	reapplyFaceAdjust();
}

/** the live extrude/inset adjust amount, or null (192 test hook) */
export function faceAdjustAmount() {
	return faceAdjust ? faceAdjust.amount : null;
}

/** Second trigger: commit the pending extrude/inset — rebuild, replicate, undo. */
export function commitFaceAdjust() {
	if (!faceAdjust || !faceEdited) return false;
	const positions = trisToPositions(workingTris);
	const before = faceAdjust.before;
	faceAdjust = null;
	applyGeometrySnapshot(positions);
	broadcastMeshGeo(faceEdited.uuid, positions);
	recordEntry({ kind: 'meshgeo', uuid: faceEdited.uuid, before, after: positions });
	return true;
}

/** Back/hub reverts a pending adjust to the pre-op geometry. */
export function cancelFaceAdjust() {
	if (!faceAdjust || !faceEdited) return;
	const before = faceAdjust.before;
	faceAdjust = null;
	applyGeometrySnapshot(before);
}

// undo/redo replays meshgeo snapshots through the same apply + broadcast path
registerHistoryKind('meshgeo', (entry, state) => {
	applyMeshGeo(entry.uuid, state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'meshgeo', uuid: entry.uuid, positions: state });
	return true;
});
