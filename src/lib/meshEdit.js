import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, TControls, lockedObjects, isVRMode } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
// 15-F: session-scoped undo — editSession imports ONLY history (an edge we
// already have), so this closes no cycle
import { noteEditEnter, noteEditExit, sealEditHistorySession } from './editSession';
import {
	createFaceFromVerts,
	lookupEditable,
	commitMeshGeoSnapshot,
	meshEditWireframe,
	buildEditWireframe,
	readTriangles,
	trisToPositions,
	registerVertexSessionRefresher,
	registerVertexSelectionHistory,
	withSelectionHistory
} from './faceEdit';

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
/** 175: remember the last vertex selected per object, restored on re-entry
 * @type {{uuid: string|null, handle: number}} */
let stashedVert = { uuid: null, handle: -1 };
/** @type {number[] | null} */
let dragStartLocal = null;
let lastSent = 0;

// B2: the wireframe display toggle + shared overlay builder live in faceEdit
// (this module imports faceEdit; the reverse edge would close a TDZ cycle).
// Subscribed AFTER the `let overlay` declaration — the callback runs at
// module eval (the classic store-subscriber TDZ).
meshEditWireframe.subscribe((value) => {
	if (overlay) overlay.visible = value; // live toggle mid-session (vertex mode)
});

const HANDLE_COLOR = 0x2f81f7;
const HANDLE_SELECTED = 0xff4000;
const HANDLE_HOVER = 0xffa000; // ray hover (119): selected still wins
const HANDLE_MULTI = 0x22c55e; // 177: ctrl/shift multi-select for Create face

/** 177: handle indices ctrl/shift-selected for Create face */
let vertexSelection = new Set();
/** reactive size of the multi-selection (drives the Create face button) */
export const vertexSelectionSize = writable(0);
function syncVertexSelection() {
	vertexSelection = new Set([...vertexSelection].filter((i) => i < handles.length));
	vertexSelectionSize.set(vertexSelection.size);
	if (handleMesh) refreshHandleColors();
}

// ---- selection history ----------------------------------------------------
// Picks are undoable inside the session. The machinery lives in faceEdit (this
// module imports IT — the reverse edge would close a TDZ cycle), so hand it the
// two accessors it needs. Handle INDICES are the state; they only mean anything
// inside this session, which is exactly the scope the 15-F seal gives them.
registerVertexSelectionHistory({
	snapshot: () => (edited ? { uuid: edited.uuid, sel: [...vertexSelection] } : null),
	/** @param {number[]} sel */
	apply: (sel) => {
		if (!edited || !handles.length) return false;
		const live = sel.filter((i) => i >= 0 && i < handles.length);
		vertexSelection = new Set(live);
		setAnchor(live.length ? live[live.length - 1] : -1);
		syncVertexSelection();
		return true;
	}
});

// the selection COMMANDS, each wrapped so one press is one undo step

/** 177/183: toggle a vertex handle in the selection. @param {number} index */
export function toggleVertexSelection(index) {
	withSelectionHistory('vertices', () => toggleVertexSelectionInner(index));
}
/** 177: deselect all vertices (also parks the gizmo) */
export function clearVertexSelection() {
	withSelectionHistory('vertices', () => clearVertexSelectionInner());
}
/** Select every vertex handle — Ctrl+A in vertices mode. @returns {boolean} */
export function selectAllVerts() {
	return withSelectionHistory('vertices', () => selectAllVertsInner());
}
/** Invert the vertex selection — Ctrl+I in vertices mode. @returns {boolean} */
export function invertVertexSelection() {
	return withSelectionHistory('vertices', () => invertVertexSelectionInner());
}
/** plain click: the picked handle becomes the whole selection. @param {number} index */
export function selectHandle(index) {
	withSelectionHistory('vertices', () => selectHandleInner(index));
}
const tempMatrix = new THREE.Matrix4();
const tempVector = new THREE.Vector3();
/** ray-hovered handle index, or -1 (119) */
let hoveredHandle = -1;
/** last object world matrix we posed the handles against (119: follow moves) */
const lastObjectMatrix = new THREE.Matrix4();

/** Group position-attribute indices by (rounded) location @param {any} geometry */
function buildHandles(geometry) {
	const position = geometry.attributes.position;
	/** @type {Map<string, {indices: number[], position: THREE.Vector3}>} */
	const map = new Map();
	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
		const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
		if (!map.has(key)) map.set(key, { indices: [], position: new THREE.Vector3(x, y, z) });
		/** @type {any} */ (map.get(key)).indices.push(i);
	}
	return [...map.values()];
}

/** Build the vertex-handle InstancedMesh for the current `handles` (one
 * instanced mesh — cheap for thousands of vertices). @param {any} scene */
function buildHandleMesh(scene) {
	const box = new THREE.Box3().setFromObject(edited);
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
}

/**
 * D1: rebuild the session's handles + visuals from the LIVE geometry after a
 * meshgeo swap (undo, remote commit) WITHOUT exit/enter — no re-lock, no
 * selection-stash churn. applyMeshGeo calls this via dynamic import whenever a
 * snapshot lands on the object being vertex-edited (only face mode rebuilt
 * before, so undo mid-session left stale handles pointing at freed geometry).
 */
export function refreshVertexEditSession() {
	if (!edited || !handleMesh) return;
	const scene = get(globalScene);
	if (!scene) return;
	scene.remove(handleMesh);
	handleMesh.geometry.dispose();
	handleMesh.material.dispose();
	handles = buildHandles(edited.geometry);
	hoveredHandle = -1;
	// clamp the selection state to the new handle count
	if (selectedHandle >= handles.length) {
		selectedHandle = -1;
		/** @type {any} */
		const controls = get(TControls);
		if (controls && proxy && controls.object === proxy) controls.detach();
	}
	edited.updateMatrixWorld();
	lastObjectMatrix.copy(edited.matrixWorld);
	buildHandleMesh(scene);
	syncVertexSelection(); // drops out-of-range multi-picks + repaints
	// re-seat the gizmo proxy on the surviving selected handle
	if (selectedHandle >= 0 && proxy) {
		handleWorldPosition(selectedHandle, tempVector);
		proxy.position.copy(tempVector);
	}
	// the overlay wraps the NEW geometry
	if (overlay) {
		overlay.geometry.dispose();
		overlay.geometry = new THREE.WireframeGeometry(edited.geometry);
	}
}
// applyMeshGeo calls back through this whenever a snapshot lands on the object
// being vertex-edited (weld's own exit->commit->enter dance is unaffected:
// `edited` is null during its commit)
registerVertexSessionRefresher((uuid) => {
	if (edited && edited.uuid === uuid) refreshVertexEditSession();
});

/** @param {number} index @param {any} target */
function handleWorldPosition(index, target) {
	return edited.localToWorld(target.copy(handles[index].position));
}

/** @param {number} index */
function refreshHandleMatrix(index) {
	handleWorldPosition(index, tempVector);
	tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z);
	handleMesh.setMatrixAt(index, tempMatrix);
	handleMesh.instanceMatrix.needsUpdate = true;
	// D2 (roadmap 13): three caches an InstancedMesh boundingSphere for its
	// raycast pre-check — never invalidated by setMatrixAt, so handles moved
	// outside the initial bounds (object moved / vertex dragged far) became
	// unpickable. Null it so the next raycast lazily recomputes.
	handleMesh.boundingSphere = null;
	handleMesh.boundingBox = null;
}

function refreshHandleColors() {
	for (let i = 0; i < handles.length; i++) {
		const color =
			i === selectedHandle
				? HANDLE_SELECTED
				: vertexSelection.has(i)
					? HANDLE_MULTI
					: i === hoveredHandle
						? HANDLE_HOVER
						: HANDLE_COLOR;
		handleMesh.setColorAt(i, new THREE.Color(color));
	}
	if (handleMesh.instanceColor) handleMesh.instanceColor.needsUpdate = true;
}

/**
 * Ray hover highlight (119): tint a handle under the pointer ray. Returns true
 * when the hover changed (so the caller can pulse a haptic tick). @param {number} index
 */
export function setHoveredHandle(index) {
	if (index === hoveredHandle) return false;
	hoveredHandle = index;
	if (handleMesh) refreshHandleColors();
	return true;
}

/**
 * Per-frame (119): if the edited object's world transform changed (peer move,
 * world-rig grab, animation), re-pose every handle so the dots track it.
 * Handles live at the scene root in WORLD space, so they don't follow for free.
 */
export function tickMeshEdit() {
	if (!edited || !handleMesh) return;
	edited.updateMatrixWorld();
	if (lastObjectMatrix.equals(edited.matrixWorld)) return;
	lastObjectMatrix.copy(edited.matrixWorld);
	for (let i = 0; i < handles.length; i++) refreshHandleMatrix(i);
}

/** @param {string} uuid */
export function enterEditMode(uuid) {
	if (get(editingObject)) exitEditMode();
	const object = lookupEditable(uuid); // A8: also accepts the collider proxy
	if (!object || !object.geometry?.attributes?.position) {
		// D7: a multi-mesh GROUP is the common blocker for imports — say so
		if (object?.type === 'Group')
			showToast('A group can’t be mesh-edited — Ungroup it first, then edit each mesh');
		else showToast('Only meshes can be edited');
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
	hoveredHandle = -1;
	object.updateMatrixWorld();
	lastObjectMatrix.copy(object.matrixWorld);
	buildHandleMesh(scene);

	// wireframe overlay as a child so it follows the object's transform (B2:
	// shared builder, raycast stubbed per D8, honors the display toggle)
	overlay = buildEditWireframe(object);
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
	noteEditEnter('vertex', uuid); // 15-F: opens (or continues) the undo barrier
	window.addEventListener('keydown', onKeydown);

	// 175: restore the vertex selected last time in this object (per-mode memory)
	if (stashedVert.uuid === uuid && stashedVert.handle >= 0 && stashedVert.handle < handles.length) {
		selectHandleInner(stashedVert.handle);
	}
}

/** the selected vertex handle index, or -1 (175 test hook) */
export function selectedVertexHandle() {
	return selectedHandle;
}

export function exitEditMode() {
	if (!edited) return;
	if (selectedHandle >= 0) stashedVert = { uuid: edited.uuid, handle: selectedHandle };
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
	hoveredHandle = -1;
	vertexSelection.clear();
	vertexSelectionSize.set(0);
	editingObject.set(null);
	noteEditExit('vertex'); // 15-F: deferred seal unless another mode re-enters
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key === 'Escape') {
		exitEditMode();
		sealEditHistorySession(); // 15-F: Escape = Done, sealed synchronously
	}
}

/**
 * Raycast the vertex handles; select the hit one and attach the gizmo.
 * @param {THREE.Raycaster} raycaster @returns {boolean} whether a handle was hit
 */
/** @param {any} raycaster @param {boolean} [additive] ctrl/shift adds to the create-face multi-selection */
export function raycastHandles(raycaster, additive = false) {
	if (!handleMesh) return false;
	const hits = raycaster.intersectObject(handleMesh);
	if (hits.length === 0) return false;
	const idx = /** @type {number} */ (hits[0].instanceId);
	if (additive) {
		toggleVertexSelection(idx);
		return true;
	}
	// a plain click starts a fresh single selection (the set IS the selection)
	selectHandle(idx);
	return true;
}

/**
 * D5 (user report): ONE selection model. selectedHandle is the ANCHOR — it is
 * always a member of vertexSelection, carries the gizmo, and a gizmo drag
 * moves the WHOLE selection rigidly. Before this, plain-click (gizmo) and
 * ctrl-click (weld/create-face set) were two parallel models: the counter
 * read "0 sel" with a vertex visibly selected, and weld ignored it.
 * @param {number} index the new anchor, or -1 to drop it (detaches the gizmo)
 */
function setAnchor(index) {
	selectedHandle = index;
	/** @type {any} */
	const controls = get(TControls);
	if (!proxy || !controls) return;
	// the desktop gizmo never seats in VR (its helper would render in-headset;
	// VR drags handles directly via vrBeginHandleDrag)
	if (index >= 0 && !get(isVRMode)) {
		handleWorldPosition(index, tempVector);
		proxy.position.copy(tempVector);
		controls.setMode('translate');
		controls.attach(proxy);
	} else if (controls.object === proxy) controls.detach();
}

/** 177/183: toggle a vertex handle in the selection (ctrl-click on desktop,
 * trigger-tap in VR). The anchor rides the toggles: last-added handle takes
 * the gizmo; removing the anchor promotes another member; empty detaches.
 * @param {number} index */
function toggleVertexSelectionInner(index) {
	if (index < 0 || index >= handles.length) return;
	if (vertexSelection.has(index)) {
		vertexSelection.delete(index);
		if (selectedHandle === index)
			setAnchor(vertexSelection.size ? [...vertexSelection][vertexSelection.size - 1] : -1);
	} else {
		vertexSelection.add(index);
		setAnchor(index);
	}
	syncVertexSelection();
}

/** 177: deselect all vertices (also parks the gizmo) */
function clearVertexSelectionInner() {
	vertexSelection.clear();
	if (proxy) setAnchor(-1);
	else selectedHandle = -1;
	syncVertexSelection();
}

/** Select every vertex handle — Ctrl+A in vertices mode. The selection commands
 * used to exist for FACES only, so Ctrl+A did nothing in the other two modes.
 * @returns {boolean} */
function selectAllVertsInner() {
	if (!handles.length) return false;
	vertexSelection = new Set(handles.map((/** @type {any} */ _, /** @type {number} */ i) => i));
	setAnchor(handles.length - 1);
	syncVertexSelection();
	return true;
}

/** Invert the vertex selection — Ctrl+I in vertices mode. @returns {boolean} */
function invertVertexSelectionInner() {
	if (!handles.length) return false;
	const previous = vertexSelection;
	vertexSelection = new Set(
		handles
			.map((/** @type {any} */ _, /** @type {number} */ i) => i)
			.filter((i) => !previous.has(i))
	);
	const members = [...vertexSelection];
	setAnchor(members.length ? members[members.length - 1] : -1);
	syncVertexSelection();
	return true;
}

/**
 * B4: WELD the selected vertices (>=2 handles) to their shared centroid —
 * replicated + ONE undo entry. Committed as a meshgeo snapshot (a 'verts'
 * entry holds one position for all indices, so it cannot undo per-handle
 * befores). The commit's session refresher regroups the merged handles and
 * rebuilds the wireframe overlay in place.
 * @returns {boolean}
 */
export function weldSelectedVerts() {
	if (!edited || vertexSelection.size < 2) return false;
	const uuid = edited.uuid;
	const position = edited.geometry.attributes.position;
	// D1: snapshot INDEX-EXPANDED positions — applyMeshGeo rebuilds a NON-indexed
	// geometry, so snapshotting the raw attribute of an INDEXED mesh (a fresh
	// Box: 24 positions / 36 indices) reinterpreted the 24 triples as 8 arbitrary
	// triangles ("weld mangles the mesh"), and undo replayed the same wrong
	// representation. Both snapshots below are in applyMeshGeo's representation.
	const before = trisToPositions(readTriangles(edited.geometry));
	// raw attribute copy so a FAILED commit (size cap) can revert the in-place
	// centroid write — without it the attribute silently diverged from what
	// peers and the GPU see (needsUpdate was never set on that path)
	const rawBefore = Array.from(position.array);
	const centroid = new THREE.Vector3();
	const picked = [...vertexSelection];
	picked.forEach((i) => centroid.add(handles[i].position));
	centroid.multiplyScalar(1 / picked.length);
	picked.forEach((i) =>
		handles[i].indices.forEach((/** @type {number} */ idx) =>
			position.setXYZ(idx, centroid.x, centroid.y, centroid.z)
		)
	);
	const after = trisToPositions(readTriangles(edited.geometry));
	if (JSON.stringify(before) === JSON.stringify(after)) return false; // already coincident
	// NO exit/enter dance (a pre-D1 relic): commitMeshGeoSnapshot swaps the
	// geometry and applyMeshGeo's session refresher rebuilds handles, wireframe
	// overlay and selection IN PLACE — the same path undo and remote commits
	// take, so the overlay can never diverge from the welded mesh (the dance
	// left it stale whenever re-entry took any early-out).
	const ok = commitMeshGeoSnapshot(uuid, before, after);
	if (ok) clearVertexSelection(); // the weld consumed the multi-pick
	else {
		position.array.set(rawBefore);
		position.needsUpdate = true;
	}
	return ok;
}

/** 177: build a face from the 3-4 multi-selected vertices (replicated + undoable).
 * 191: viewerPos (world) winds the face to face the viewer in VR. @param {any} [viewerPos] */
export function createSelectedFace(viewerPos = null) {
	if (!edited || vertexSelection.size < 3 || vertexSelection.size > 4) return false;
	const uuid = edited.uuid;
	const verts = [...vertexSelection].map((i) => handles[i].position.clone());
	const ok = createFaceFromVerts(uuid, verts, viewerPos);
	// the commit's applyMeshGeo already rebuilt the session in place (D1
	// refresher) — same no-dance rule as weldSelectedVerts
	if (ok) clearVertexSelection();
	return ok;
}

/** Select exactly this handle (fresh single selection + anchor/gizmo).
 * @param {number} index */
function selectHandleInner(index) {
	vertexSelection = new Set(index >= 0 ? [index] : []);
	setAnchor(index);
	syncVertexSelection();
}

/** World-space focus target {center,radius} for the selected vertex, or null (173). */
export function focusTargetVertex() {
	if (!edited || selectedHandle < 0 || !handles[selectedHandle]) return null;
	const center = handleWorldPosition(selectedHandle, new THREE.Vector3()).clone();
	const box = new THREE.Box3().setFromObject(edited);
	const objR = box.getSize(new THREE.Vector3()).length() / 2;
	return { center, radius: Math.max(objR * 0.2, 0.25) };
}

// dedicated vector for the write path: refreshHandleMatrix reuses tempVector,
// so returning/aliasing tempVector here corrupted broadcasts with WORLD
// coordinates whenever the object was not at the origin
const writeVector = new THREE.Vector3();

/**
 * Commit a LOCAL position to every index of the selected handle + refresh the
 * handle matrix and wireframe overlay. Shared by the desktop gizmo and the VR
 * grab. @param {THREE.Vector3} local @returns {number[]} the LOCAL position
 */
function commitSelectedLocal(local) {
	const handle = handles[selectedHandle];
	handle.position.copy(local);
	// capture before refreshHandleMatrix runs — it mutates shared temp vectors
	const result = [local.x, local.y, local.z];
	const position = edited.geometry.attributes.position;
	handle.indices.forEach((/** @type {number} */ i) => position.setXYZ(i, result[0], result[1], result[2]));
	position.needsUpdate = true;
	edited.geometry.computeVertexNormals();
	edited.geometry.computeBoundingSphere();
	refreshHandleMatrix(selectedHandle);
	if (overlay) {
		overlay.geometry.dispose();
		overlay.geometry = new THREE.WireframeGeometry(edited.geometry);
	}
	return result;
}

/**
 * Write the (world-space) proxy position through to every index of the selected handle.
 * @returns {number[]} the resulting LOCAL position, safe to keep (plain array)
 */
function writeSelectedHandle() {
	return commitSelectedLocal(edited.worldToLocal(writeVector.copy(proxy.position)));
}

// D5: a multi-selection drags rigidly — every member moves by the anchor's
// local-space delta. Dedicated vector (never the shared temps: the loop below
// calls refreshHandleMatrix, which mutates tempVector).
const deltaVector = new THREE.Vector3();
/** @type {number[]|null} index-expanded snapshot at multi-drag start (ONE meshgeo undo) */
let dragStartExpanded = null;

/** Move every NON-anchor selected handle by delta (local space) + write through
 * to the attribute. The anchor itself commits via writeSelectedHandle (which
 * also recomputes normals/bounds/overlay for the whole geometry — call LAST).
 * @param {THREE.Vector3} delta */
function applySelectionDelta(delta) {
	if (delta.lengthSq() === 0) return;
	const position = edited.geometry.attributes.position;
	for (const i of vertexSelection) {
		if (i === selectedHandle) continue;
		const p = handles[i].position.add(delta);
		handles[i].indices.forEach((/** @type {number} */ idx) => position.setXYZ(idx, p.x, p.y, p.z));
		refreshHandleMatrix(i);
	}
}

/** Called from Scene.svelte's gizmo onchange when the vertex proxy moves */
export function onProxyMoved() {
	if (!edited || selectedHandle < 0) return;
	// attaching the gizmo fires a change event without an actual move — ignore it
	const local = edited.worldToLocal(writeVector.copy(proxy.position));
	if (local.distanceToSquared(handles[selectedHandle].position) < 1e-12) return;
	// members first, anchor last (writeSelectedHandle recomputes normals/overlay)
	if (vertexSelection.size > 1)
		applySelectionDelta(deltaVector.copy(local).sub(handles[selectedHandle].position));
	const result = writeSelectedHandle();
	const now = Date.now();
	if (now - lastSent < 80) return;
	lastSent = now;
	broadcastSelected(result);
	if (vertexSelection.size > 1)
		for (const i of vertexSelection) if (i !== selectedHandle) broadcastHandle(i);
}

/** Broadcast one handle's current LOCAL position over the `verts` channel
 * @param {number} index */
function broadcastHandle(index) {
	/** @type {any} */
	const peer = get(peers);
	if (peer && edited)
		peer.send({
			type: 'verts',
			uuid: edited.uuid,
			indices: handles[index].indices,
			position: handles[index].position.toArray()
		});
}

/** @param {number[]} positionArray - LOCAL coordinates of the anchor */
function broadcastSelected(positionArray) {
	/** @type {any} */
	const peer = get(peers);
	if (peer && edited)
		peer.send({
			type: 'verts',
			uuid: edited.uuid,
			indices: handles[selectedHandle].indices,
			position: positionArray
		});
}

/** Called from Scene.svelte on dragging-changed for the proxy @param {boolean} dragging */
export function onProxyDragChanged(dragging) {
	if (!edited || selectedHandle < 0) return;
	if (dragging) {
		dragStartLocal = handles[selectedHandle].position.toArray();
		// D5: a multi-drag undoes as ONE meshgeo snapshot (a 'verts' entry holds
		// one position for all its indices — it cannot carry per-handle befores;
		// same reasoning as weld). Index-expanded per the D1 representation rule.
		dragStartExpanded =
			vertexSelection.size > 1 ? trisToPositions(readTriangles(edited.geometry)) : null;
	} else if (dragStartLocal) {
		// catch any tail movement since the last change event, members first
		const local = edited.worldToLocal(writeVector.copy(proxy.position));
		if (vertexSelection.size > 1)
			applySelectionDelta(deltaVector.copy(local).sub(handles[selectedHandle].position));
		const after = writeSelectedHandle();
		broadcastSelected(after); // final unthrottled state
		if (vertexSelection.size > 1) {
			for (const i of vertexSelection) if (i !== selectedHandle) broadcastHandle(i);
			const afterExpanded = trisToPositions(readTriangles(edited.geometry));
			if (dragStartExpanded && JSON.stringify(dragStartExpanded) !== JSON.stringify(afterExpanded))
				recordEntry({
					kind: 'meshgeo',
					uuid: edited.uuid,
					before: dragStartExpanded,
					after: afterExpanded
				});
		} else if (JSON.stringify(dragStartLocal) !== JSON.stringify(after)) {
			recordEntry({
				kind: 'verts',
				uuid: edited.uuid,
				indices: [...handles[selectedHandle].indices],
				before: dragStartLocal,
				after: after
			});
		}
		dragStartLocal = null;
		dragStartExpanded = null;
	}
}

/**
 * Apply a vertex change (remote message, or undo/redo replay).
 * @param {string} uuid @param {number[]} indices @param {number[]} positionArray
 */
export function applyVerts(uuid, indices, positionArray) {
	const object = lookupEditable(uuid); // A8: also finds the collider-edit proxy
	const position = object?.geometry?.attributes?.position;
	if (!position) return;
	indices.forEach((i) => position.setXYZ(i, positionArray[0], positionArray[1], positionArray[2]));
	position.needsUpdate = true;
	object.userData.vertexEdited = true; // geometry-param rebuilds warn first (78)
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

// ---- VR vertex editing (113): drive a handle from a controller, no gizmo ----

/** Default VR vertex cap — D7 (roadmap 13): raised from 500 so the default
 * sphere (561 position entries) edits out of the box; the LIVE limit is the
 * user-editable `vrVertexCap` setting below */
export const VR_VERTEX_CAP = 800;
/** D7: user-editable vertex-edit limit (Settings ▸ VR, local pref)
 * @type {import('svelte/store').Writable<number>} */
export const vrVertexCap = writable(
	typeof localStorage !== 'undefined'
		? parseInt(localStorage.getItem('vrVertexCap') ?? '') || VR_VERTEX_CAP
		: VR_VERTEX_CAP
);
if (typeof localStorage !== 'undefined')
	vrVertexCap.subscribe((value) => localStorage.setItem('vrVertexCap', String(value)));

/** Vertex (position entry) count of an object's geometry @param {any} object */
export function vertexCount(object) {
	return object?.geometry?.attributes?.position?.count ?? 0;
}

/** Is this object simple enough to vertex-edit in VR? D7: capped by the
 * user-editable vrVertexCap setting. @param {any} object */
export function vrVertexEditable(object) {
	const count = vertexCount(object);
	return count > 0 && count <= get(vrVertexCap);
}

/** vertices of the mesh currently in edit mode (0 if none) */
export function editedVertexCount() {
	return edited?.geometry?.attributes?.position?.count ?? 0;
}

/** D8: the live vertex-handle InstancedMesh (scene root), or null — the VR
 * beam terminates on handles while vertex-editing (they are NOT in
 * objectsGroup, so beamTarget must ask for them explicitly) */
export function vertexHandleMesh() {
	return handleMesh;
}

/** Raycast the handles from a controller ray @param {THREE.Raycaster} raycaster @returns {number} handle index or -1 */
export function vrRaycastHandle(raycaster) {
	if (!handleMesh) return -1;
	const hits = raycaster.intersectObject(handleMesh);
	return hits.length ? /** @type {number} */ (hits[0].instanceId) : -1;
}

/**
 * Begin a VR drag on a handle (selects it, no gizmo). Returns its current
 * WORLD position so the caller can capture a grab offset, or null.
 * @param {number} index
 */
export function vrBeginHandleDrag(index) {
	if (!edited || index < 0 || index >= handles.length) return null;
	selectedHandle = index;
	refreshHandleColors();
	dragStartLocal = handles[index].position.toArray();
	return handleWorldPosition(index, new THREE.Vector3());
}

/**
 * Set the selected handle to a WORLD position (throttled stream). Optional
 * snapStep rounds the LOCAL position to a grid. @param {any} worldPos @param {number=} snapStep
 */
export function vrDragHandleTo(worldPos, snapStep = 0) {
	if (!edited || selectedHandle < 0) return;
	const local = edited.worldToLocal(writeVector.copy(worldPos));
	if (snapStep > 0) {
		local.x = Math.round(local.x / snapStep) * snapStep;
		local.y = Math.round(local.y / snapStep) * snapStep;
		local.z = Math.round(local.z / snapStep) * snapStep;
	}
	const result = commitSelectedLocal(local);
	const now = Date.now();
	if (now - lastSent < 80) return;
	lastSent = now;
	broadcastSelected(result);
}

/** End a VR handle drag: final broadcast + one undo entry. */
export function vrEndHandleDrag() {
	if (edited && selectedHandle >= 0 && dragStartLocal) {
		const after = commitSelectedLocal(handles[selectedHandle].position.clone());
		broadcastSelected(after);
		if (JSON.stringify(dragStartLocal) !== JSON.stringify(after))
			recordEntry({
				kind: 'verts',
				uuid: edited.uuid,
				indices: [...handles[selectedHandle].indices],
				before: dragStartLocal,
				after: after
			});
	}
	dragStartLocal = null;
	selectedHandle = -1;
	if (handleMesh) refreshHandleColors();
}

// undo/redo replays vertex entries through the same apply + broadcast path
registerHistoryKind('verts', (entry, state) => {
	applyVerts(entry.uuid, entry.indices, state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'verts', uuid: entry.uuid, indices: entry.indices, position: state });
	return true;
});
