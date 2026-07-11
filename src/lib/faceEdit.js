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

/** Extrude a face by dist along its normal, stitching side walls @param {any[]} tris @param {any} face @param {number} dist */
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
		out.push([a, b, b2]);
		out.push([a, b2, a2]);
	});
	return out;
}

/** Push/pull a face's triangles along its normal (no walls) @param {any[]} tris @param {any} face @param {number} dist */
export function moveFaceAlongNormal(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const faceSet = new Set(face.triIndices);
	out.forEach((t, ti) => {
		if (faceSet.has(ti)) t.forEach((v) => v.add(offset));
	});
	return out;
}

/** Inset: move a face's vertices toward its centroid (0..0.95) @param {any[]} tris @param {any} face @param {number} amount */
export function insetFace(tris, face, amount) {
	const out = cloneTris(tris);
	const faceSet = new Set(face.triIndices);
	const t = Math.min(Math.max(amount, 0), 0.95);
	out.forEach((tri, ti) => {
		if (faceSet.has(ti)) tri.forEach((v) => v.lerp(face.centroid, t));
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
	if (faceEdited === object) refreshFaceOverlay();
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
	showToast('Editing faces of ' + (object.name || 'mesh') + ' — point at a face, trigger to pick');
}

export function exitFaceEdit() {
	if (!faceEdited) return;
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
 * index and highlight it. @param {number} triangleIndex
 */
export function highlightFaceByTriangle(triangleIndex) {
	const fi = faces.findIndex((f) => f.triIndices.includes(triangleIndex));
	faceEditHighlight.set(fi);
	refreshFaceOverlay();
	return fi;
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

// undo/redo replays meshgeo snapshots through the same apply + broadcast path
registerHistoryKind('meshgeo', (entry, state) => {
	applyMeshGeo(entry.uuid, state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'meshgeo', uuid: entry.uuid, positions: state });
	return true;
});
