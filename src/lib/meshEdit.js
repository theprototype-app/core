import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, TControls, lockedObjects } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';

// Vertex edit mode: one object at a time, drag vertex handles with the
// regular gizmo. Handles that share a position (e.g. the 24 position entries
// of a cube's 8 corners) move together so the mesh never tears. Every change
// replicates via the `verts` message; the object is locked for peers while
// edited (no concurrent vertex merging).

/** @type {import('svelte/store').Writable<string|null>} uuid of the object in edit mode */
export const editingObject = writable(null);

/** @type {any} */ let edited = null; // the THREE.Mesh being edited
/** @type {{indices: number[], position: THREE.Vector3}[]} */ let handles = [];
/** @type {any} */ let handleMesh = null; // InstancedMesh of vertex handles
/** @type {any} */ let overlay = null; // wireframe overlay child
/** @type {any} */ let proxy = null; // gizmo target for the selected handle
let selectedHandle = -1;
let dragStartLocal = null;
let lastSent = 0;

const HANDLE_COLOR = 0x2f81f7;
const HANDLE_SELECTED = 0xff4000;
const tempMatrix = new THREE.Matrix4();
const tempVector = new THREE.Vector3();

/** Group position-attribute indices by (rounded) location @param {any} geometry */
function buildHandles(geometry) {
	const position = geometry.attributes.position;
	/** @type {Map<string, {indices: number[], position: THREE.Vector3}>} */
	const map = new Map();
	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
		const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
		if (!map.has(key)) map.set(key, { indices: [], position: new THREE.Vector3(x, y, z) });
		map.get(key).indices.push(i);
	}
	return [...map.values()];
}

function handleWorldPosition(index, target) {
	return edited.localToWorld(target.copy(handles[index].position));
}

function refreshHandleMatrix(index) {
	handleWorldPosition(index, tempVector);
	tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z);
	handleMesh.setMatrixAt(index, tempMatrix);
	handleMesh.instanceMatrix.needsUpdate = true;
}

function refreshHandleColors() {
	for (let i = 0; i < handles.length; i++)
		handleMesh.setColorAt(i, new THREE.Color(i === selectedHandle ? HANDLE_SELECTED : HANDLE_COLOR));
	if (handleMesh.instanceColor) handleMesh.instanceColor.needsUpdate = true;
}

/** @param {string} uuid */
export function enterEditMode(uuid) {
	if (get(editingObject)) exitEditMode();
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.geometry?.attributes?.position) {
		showToast('Only meshes can be edited');
		return;
	}
	if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return;
	}
	const scene = get(globalScene);
	/** @type {any} */
	const controls = get(TControls);
	if (!scene || !controls) return;

	edited = object;
	handles = buildHandles(object.geometry);

	// vertex handles as one instanced mesh (cheap for thousands of vertices)
	const box = new THREE.Box3().setFromObject(object);
	const size = THREE.MathUtils.clamp(box.getSize(tempVector).length() * 0.012, 0.02, 0.2);
	handleMesh = new THREE.InstancedMesh(
		new THREE.SphereGeometry(size, 8, 8),
		new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }),
		handles.length
	);
	handleMesh.renderOrder = 999;
	handleMesh.name = 'vertex-handles';
	for (let i = 0; i < handles.length; i++) refreshHandleMatrix(i);
	refreshHandleColors();
	scene.add(handleMesh);

	// wireframe overlay as a child so it follows the object's transform
	overlay = new THREE.LineSegments(
		new THREE.WireframeGeometry(object.geometry),
		new THREE.LineBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.5 })
	);
	overlay.name = 'edit-overlay';
	object.add(overlay);

	proxy = new THREE.Object3D();
	proxy.userData.isVertexProxy = true;
	scene.add(proxy);

	controls.detach();
	selectedHandle = -1;

	// peers must not edit/select it meanwhile
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid: uuid, peerId: peer.peer.id });

	editingObject.set(uuid);
	showToast('Editing ' + (object.name || 'mesh') + ' — drag the vertex handles, Esc to finish');
	window.addEventListener('keydown', onKeydown);
}

export function exitEditMode() {
	if (!edited) return;
	const scene = get(globalScene);
	/** @type {any} */
	const controls = get(TControls);
	if (handleMesh) {
		scene?.remove(handleMesh);
		handleMesh.geometry.dispose();
		handleMesh.material.dispose();
	}
	if (overlay) {
		edited.remove(overlay);
		overlay.geometry.dispose();
		overlay.material.dispose();
	}
	if (proxy) {
		if (controls && controls.object === proxy) controls.detach();
		scene?.remove(proxy);
	}
	window.removeEventListener('keydown', onKeydown);
	edited = null;
	handles = [];
	handleMesh = null;
	overlay = null;
	proxy = null;
	selectedHandle = -1;
	editingObject.set(null);
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key === 'Escape') exitEditMode();
}

/**
 * Raycast the vertex handles; select the hit one and attach the gizmo.
 * @param {THREE.Raycaster} raycaster @returns {boolean} whether a handle was hit
 */
export function raycastHandles(raycaster) {
	if (!handleMesh) return false;
	const hits = raycaster.intersectObject(handleMesh);
	if (hits.length === 0) return false;
	selectHandle(hits[0].instanceId);
	return true;
}

/** @param {number} index */
export function selectHandle(index) {
	selectedHandle = index;
	refreshHandleColors();
	handleWorldPosition(index, tempVector);
	proxy.position.copy(tempVector);
	/** @type {any} */
	const controls = get(TControls);
	controls.setMode('translate');
	controls.attach(proxy);
}

/** Write the (world-space) proxy position through to every index of the selected handle */
function writeSelectedHandle() {
	const handle = handles[selectedHandle];
	const local = edited.worldToLocal(tempVector.copy(proxy.position));
	handle.position.copy(local);
	const position = edited.geometry.attributes.position;
	handle.indices.forEach((/** @type {number} */ i) => position.setXYZ(i, local.x, local.y, local.z));
	position.needsUpdate = true;
	edited.geometry.computeVertexNormals();
	edited.geometry.computeBoundingSphere();
	refreshHandleMatrix(selectedHandle);
	if (overlay) {
		overlay.geometry.dispose();
		overlay.geometry = new THREE.WireframeGeometry(edited.geometry);
	}
	return local;
}

/** Called from Scene.svelte's gizmo onchange when the vertex proxy moves */
export function onProxyMoved() {
	if (!edited || selectedHandle < 0) return;
	const local = writeSelectedHandle();
	const now = Date.now();
	if (now - lastSent < 80) return;
	lastSent = now;
	broadcastSelected(local);
}

function broadcastSelected(local) {
	/** @type {any} */
	const peer = get(peers);
	if (peer && edited)
		peer.send({
			type: 'verts',
			uuid: edited.uuid,
			indices: handles[selectedHandle].indices,
			position: [local.x, local.y, local.z]
		});
}

/** Called from Scene.svelte on dragging-changed for the proxy @param {boolean} dragging */
export function onProxyDragChanged(dragging) {
	if (!edited || selectedHandle < 0) return;
	if (dragging) {
		dragStartLocal = handles[selectedHandle].position.toArray();
	} else if (dragStartLocal) {
		const local = writeSelectedHandle();
		broadcastSelected(local); // final unthrottled state
		const after = [local.x, local.y, local.z];
		if (JSON.stringify(dragStartLocal) !== JSON.stringify(after)) {
			recordEntry({
				kind: 'verts',
				uuid: edited.uuid,
				indices: [...handles[selectedHandle].indices],
				before: dragStartLocal,
				after: after
			});
		}
		dragStartLocal = null;
	}
}

/**
 * Apply a vertex change (remote message, or undo/redo replay).
 * @param {string} uuid @param {number[]} indices @param {number[]} positionArray
 */
export function applyVerts(uuid, indices, positionArray) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	const position = object?.geometry?.attributes?.position;
	if (!position) return;
	indices.forEach((i) => position.setXYZ(i, positionArray[0], positionArray[1], positionArray[2]));
	position.needsUpdate = true;
	object.geometry.computeVertexNormals();
	object.geometry.computeBoundingSphere();
	// if we are editing this object right now, keep the handles in sync
	if (edited === object) {
		const handleIndex = handles.findIndex((h) => h.indices.includes(indices[0]));
		if (handleIndex >= 0) {
			handles[handleIndex].position.fromArray(positionArray);
			refreshHandleMatrix(handleIndex);
		}
		if (overlay) {
			overlay.geometry.dispose();
			overlay.geometry = new THREE.WireframeGeometry(object.geometry);
		}
	}
	objectsGroup.update((value) => value);
}

// undo/redo replays vertex entries through the same apply + broadcast path
registerHistoryKind('verts', (entry, state) => {
	applyVerts(entry.uuid, entry.indices, state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'verts', uuid: entry.uuid, indices: entry.indices, position: state });
	return true;
});
