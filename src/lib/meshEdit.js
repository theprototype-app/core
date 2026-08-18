import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import {
	globalScene,
	globalCamera,
	objectsGroup,
	TControls,
	lockedObjects,
	isVRMode,
	transformMode
} from '../stores/sceneStore';
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
	withSelectionHistory,
	editWireGeometry,
	registerVertexWireRebuild,
	meshGizmoEnabled,
	faceGizmoSpace,
	registerGizmoPrefListener,
	internalEdgeSet,
	edgeKeyOf,
	bevelVertices,
	deleteVertices,
	smoothVertices,
	beginOpAdjust
} from './faceEdit';
// 19-A P4: the proportional stores/falloff moved to a LEAF (faceEdit needs them
// too, and it cannot import this module — we import faceEdit above). Re-exported
// below so MeshEditPopup/MeshToolOptions/__stores.meshEdit.* stay byte-compatible.
import {
	proportionalEdit,
	proportionalRadius,
	falloffWeight,
	registerProportionalAnchor,
	beginProportionalWheel,
	endProportionalWheel
} from './proportional';
export { proportionalEdit, proportionalRadius, falloffWeight } from './proportional';
import { showProportionalRingAt, hideProportionalRing } from './proportionalRing';
// 19-A P7b: the vertex slide's clamp toggle — meshToolParams is a svelte/store
// leaf, so this closes no cycle
import { slideClamp } from './meshToolParams';
// the custom transform PIVOT (local pref). Another leaf: meshPivot imports THREE
// + the two stores + proportional, and nothing from here or faceEdit.
import {
	meshPivotLocal,
	hasMeshPivot,
	registerMeshPivotListener,
	refreshMeshPivotMarker,
	disposeMeshPivotMarker,
	cancelMeshPivotPick,
	escapeConsumedByPivotPick,
	meshPivotMoving,
	cancelMeshPivotMove,
	escapeConsumedByPivotMove,
	commitMeshPivotDrag,
	setMeshPivotPreview
} from './meshPivot';

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
/** 175: remember the vertex SELECTION per object, restored on re-entry. The whole SET is
 * stashed, not just the anchor: switching Vertices -> Faces -> Vertices kept only the
 * anchored handle, so a carefully built multi-selection vanished on the way through
 * another mode (reported). `count` is the geometry signature — a topology change
 * invalidates handle indices, so a stale set is dropped rather than lighting up whatever
 * happens to sit at those indices now.
 * @type {{uuid: string|null, handle: number, set: number[], count: number}} */
let stashedVert = { uuid: null, handle: -1, set: [], count: -1 };
/** @type {number[] | null} */
let dragStartLocal = null;
/**
 * The live gizmo gesture, or null when no drag is in progress. Everything a
 * rotate/scale needs is captured HERE, at drag start, and every frame writes
 * ABSOLUTELY from it — the documented rule for any "apply a delta to N things"
 * gesture, and the reason 20 small frames land exactly where one big one does.
 *
 * Declared UP HERE with the other session state, well above its readers: this
 * file's module-eval store subscribers have TDZ-crashed the SSR prerender three
 * times over a `let` declared further down.
 * @type {{mode: string, seat: any, pos: any, quat: any, scale: any, starts: any[]}|null}
 */
let proxyGesture = null;
let lastSent = 0;

// B2: the wireframe display toggle + shared overlay builder live in faceEdit
// (this module imports faceEdit; the reverse edge would close a TDZ cycle).
// Subscribed AFTER the `let overlay` declaration — the callback runs at
// module eval (the classic store-subscriber TDZ).
meshEditWireframe.subscribe((value) => {
	if (overlay) overlay.visible = value; // live toggle mid-session (vertex mode)
});
// quad view vs raw triangulation is a different EDGE SET, so it rebuilds
registerVertexWireRebuild(() => {
	if (!overlay || !edited) return;
	overlay.geometry.dispose();
	overlay.geometry = editWireGeometry(edited.geometry);
});

const HANDLE_COLOR = 0x2f81f7;
const HANDLE_SELECTED = 0xff4000;
const HANDLE_HOVER = 0xffa000; // ray hover (119): selected still wins
const HANDLE_MULTI = 0x22c55e; // 177: ctrl/shift multi-select for Create face

/** Vertex-handle size MULTIPLIER over the proportional base (see baseRadius). In adaptive mode it multiplies
 * the APPARENT pixel size instead. A local
 * pref, like every other look setting in the editor — it is about eyesight and screen
 * size, not about the scene, so it must not replicate.
 * @type {import('svelte/store').Writable<number>} */
export const vertexHandleScale = writable(
	typeof localStorage !== 'undefined'
		? Math.min(Math.max(parseFloat(localStorage.getItem('vertexHandleScale') ?? '') || 1, 0.1), 4)
		: 1
);
/** Screen-constant handle size (default ON — see refreshHandleMatrix). A local pref.
 * @type {import('svelte/store').Writable<boolean>} */
export const vertexHandleAdaptive = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('vertexHandleAdaptive') !== '0' : true
);
/** reused so the per-frame path allocates nothing */
const scaleVector = new THREE.Vector3();

/**
 * The world scale a handle at `worldPoint` needs to cover `APPARENT_PX` pixels.
 *
 * Perspective: apparent size is proportional to worldSize / distance, so the scale is
 * proportional to distance — one multiply per handle per frame. Orthographic has no
 * distance term at all; its apparent size follows the zoom instead.
 * @param {any} worldPoint @returns {number} multiplier over the built sphere radius
 */
function adaptiveScaleAt(worldPoint) {
	const camera = get(globalCamera);
	if (!camera) return 0;
	const base = baseRadius();
	if (base <= 0) return 0;
	const height = typeof window !== 'undefined' ? window.innerHeight : 800;
	const px = APPARENT_PX * get(vertexHandleScale);
	let world;
	if (camera.isOrthographicCamera) {
		world = ((camera.top - camera.bottom) / (camera.zoom || 1)) * (px / height);
	} else {
		const distance = camera.position.distanceTo(worldPoint);
		const fov = ((camera.fov ?? 50) * Math.PI) / 180;
		world = 2 * Math.tan(fov / 2) * distance * (px / height);
	}
	// `world` spans APPARENT_PX pixels, so it is a DIAMETER, while the sphere's parameter is
	// a RADIUS — skipping the halving drew every dot at twice the size asked for.
	return world / 2 / base;
}

/** apparent DIAMETER of a handle at scale 1x, in CSS pixels. 9 reads as a clickable dot
 * without hiding the vertex under it; the scale slider multiplies it. */
const APPARENT_PX = 9;

vertexHandleAdaptive.subscribe((value) => {
	if (typeof localStorage !== 'undefined')
		localStorage.setItem('vertexHandleAdaptive', value ? '1' : '0');
	if (!handleMesh || !edited) return;
	// re-pose every handle: the matrices carry the scale, so switching modes is a rewrite
	for (let i = 0; i < handles.length; i++) refreshHandleMatrix(i);
});

vertexHandleScale.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('vertexHandleScale', String(value));
	// live, and cheap: the size lives in the instance MATRICES, so nothing is rebuilt and
	// no handle index moves — the selection survives a size change
	if (!handleMesh || !edited) return;
	for (let i = 0; i < handles.length; i++) refreshHandleMatrix(i);
});

/** 177: handle indices ctrl/shift-selected for Create face */
let vertexSelection = new Set();
/** reactive size of the multi-selection (drives the Create face button) */
export const vertexSelectionSize = writable(0);
function syncVertexSelection() {
	vertexSelection = new Set([...vertexSelection].filter((i) => i < handles.length));
	vertexSelectionSize.set(vertexSelection.size);
	if (handleMesh) refreshHandleColors();
	// the gizmo sits at the selection's CENTRE, so ANY change to the set moves it —
	// including the removals that never went through setAnchor (dropping a non-anchor
	// member left the gizmo where the old centroid used to be). Never mid-gesture:
	// re-seating the proxy under a live drag would fight the pointer.
	if (selectedHandle >= 0 && proxy && !proxyGesture) seatProxy();
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
const lastCameraPosition = new THREE.Vector3(NaN, NaN, NaN);
let lastCameraZoom = NaN;

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

/**
 * D-final: handle size, in two parts.
 *
 * `baseRadius` is PROPORTIONAL to the object (1.2% of its bounding diagonal) so a chair
 * and a terrain both get usable dots with no per-object setting. The user preference is
 * then an instance SCALE on top, never baked into the geometry — which is what lets the
 * same slider mean "x times bigger" in fixed mode and "x times more pixels" in adaptive
 * mode. (Baking it into the sphere made the slider cancel itself out in adaptive mode:
 * both the numerator and the denominator scaled.)
 * @returns {number} */
function baseRadius() {
	const box = new THREE.Box3().setFromObject(edited);
	return THREE.MathUtils.clamp(box.getSize(tempVector).length() * 0.012, 0.002, 0.4);
}

/** Build the vertex-handle InstancedMesh for the current `handles` (one
 * instanced mesh — cheap for thousands of vertices). @param {any} scene */
function buildHandleMesh(scene) {
	const size = baseRadius();
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
	// re-seat the gizmo proxy (the seat is the pivot / selection centre / handle,
	// all of which the geometry swap may have moved)
	if (selectedHandle >= 0 && proxy) setAnchor(selectedHandle);
	refreshMeshPivotMarker(edited);
	// the overlay wraps the NEW geometry
	if (overlay) {
		overlay.geometry.dispose();
		overlay.geometry = editWireGeometry(edited.geometry);
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
	// ADAPTIVE size: scale each handle by its distance to the camera so it covers a
	// constant number of PIXELS. A world-size dot is wrong at both ends of the zoom — it
	// disappears on a large mesh seen from far away and swallows the geometry up close —
	// which is why every DCC tool draws vertices at a fixed pixel size.
	const scale = get(vertexHandleAdaptive)
		? adaptiveScaleAt(tempVector)
		: get(vertexHandleScale);
	if (scale > 0) tempMatrix.scale(scaleVector.setScalar(scale));
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
	const moved = !lastObjectMatrix.equals(edited.matrixWorld);
	// ADAPTIVE mode also has to follow the CAMERA: the handles keep a constant pixel size,
	// so an orbit or a zoom changes every one of them even though the object never moved.
	// Compared against the last pose (and zoom, for ortho) so a still camera costs nothing.
	const camera = get(vertexHandleAdaptive) ? get(globalCamera) : null;
	const zoom = camera?.zoom ?? 1;
	const cameraMoved = !!camera && (!lastCameraPosition.equals(camera.position) || lastCameraZoom !== zoom);
	if (!moved && !cameraMoved) return;
	if (moved) lastObjectMatrix.copy(edited.matrixWorld);
	if (camera) {
		lastCameraPosition.copy(camera.position);
		lastCameraZoom = zoom;
	}
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
	refreshMeshPivotMarker(object); // a saved pivot comes back with the session

	// 175: restore the selection this object had last time (per-mode memory). The whole
	// SET comes back, and only when the handle count still matches — a topology change
	// makes the stashed indices meaningless.
	if (stashedVert.uuid === uuid && stashedVert.count === handles.length) {
		const live = stashedVert.set.filter((index) => index >= 0 && index < handles.length);
		const anchor =
			stashedVert.handle >= 0 && stashedVert.handle < handles.length
				? stashedVert.handle
				: live.length
					? live[live.length - 1]
					: -1;
		if (anchor >= 0) {
			// the anchor is always a member of the set (the D5 invariant), and setAnchor
			// is the one place the gizmo seats
			vertexSelection = new Set(live.length ? live : [anchor]);
			vertexSelection.add(anchor);
			setAnchor(anchor);
			syncVertexSelection();
		}
	}
}

/** the selected vertex handle index, or -1 (175 test hook) */
export function selectedVertexHandle() {
	return selectedHandle;
}

/**
 * 17-D: the WORLD point of the current vertex selection — the centroid of a
 * multi-selection, else the single anchored handle. This is the "hinge point":
 * pick the two verts of a door edge (or one corner) and snap the object's origin
 * there, so Spin and a revolute joint both turn about the hinge.
 * @returns {THREE.Vector3|null} null when nothing is selected
 */
export function vertexSelectionWorldPoint() {
	if (!edited || !handles.length) return null;
	const indices = vertexSelection.size
		? [...vertexSelection]
		: selectedHandle >= 0
			? [selectedHandle]
			: [];
	if (!indices.length) return null;
	const sum = new THREE.Vector3();
	const point = new THREE.Vector3();
	let n = 0;
	for (const index of indices) {
		if (index < 0 || index >= handles.length) continue;
		handleWorldPosition(index, point);
		sum.add(point);
		n++;
	}
	return n ? sum.divideScalar(n) : null;
}

export function exitEditMode() {
	if (!edited) return;
	// stash the SELECTION (set + anchor) so a trip through Faces/Edges does not lose it
	if (selectedHandle >= 0 || vertexSelection.size)
		stashedVert = {
			uuid: edited.uuid,
			handle: selectedHandle,
			set: [...vertexSelection],
			count: handles.length
		};
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
	slideEdge = null;
	slideStart = null;
	vertexSlide.set(false); // an armed tool never survives the session
	proportionalEdit.set(false);
	falloffStart = null;
	falloffWeights = null;
	hideProportionalRing();
	endProportionalWheel(); // P7b
	hideSlideMarker(); // P7b
	vertexSelection.clear();
	vertexSelectionSize.set(0);
	proxyGesture = null;
	cancelMeshPivotPick(); // an armed pick never outlives the session
	cancelMeshPivotMove(); // ...nor an armed move (it also puts the gizmo mode back)
	disposeMeshPivotMarker(); // ...and neither does its viewport helper
	editingObject.set(null);
	noteEditExit('vertex'); // 15-F: deferred seal unless another mode re-enters
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key === 'Escape') {
		// an armed pivot pick eats the FIRST Escape (the knife rule — the verdict
		// rides the event, because faceEdit has a second Escape handler)
		if (escapeConsumedByPivotPick(event)) return;
		if (escapeConsumedByPivotMove(event)) return; // ...then an armed pivot MOVE
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
 * The LOCAL point the vertex gizmo seats at — and, for rotate/scale, the CENTRE
 * those turn around. Three cases, in priority order:
 *
 *  1. a CUSTOM pivot placed for this object (local pref, meshPivot.js);
 *  2. the CENTROID of a multi-selection — the reported defect was that there was
 *     no case 2 at all, so ctrl-picking five vertices left the gizmo on the last
 *     one clicked and a scale about it dragged the whole set sideways;
 *  3. the single anchored handle, which is cases 1+2 degenerating and therefore
 *     byte-identical to the old behaviour for a one-vertex pick.
 * @returns {any} a fresh Vector3, or null when nothing is selected
 */
function gizmoSeatLocal() {
	if (!edited || !handles.length) return null;
	const custom = meshPivotLocal(edited.uuid);
	if (custom) return custom;
	const indices = vertexSelection.size
		? [...vertexSelection]
		: selectedHandle >= 0
			? [selectedHandle]
			: [];
	if (!indices.length) return null;
	const sum = new THREE.Vector3();
	let n = 0;
	for (const index of indices) {
		if (!handles[index]) continue;
		sum.add(handles[index].position);
		n++;
	}
	return n ? sum.divideScalar(n) : null;
}

/** Park the proxy at the seat point with a NEUTRAL pose. The reset matters: a
 * rotate/scale drag leaves the proxy turned/stretched, and the next gesture
 * measures its delta from whatever pose it finds. */
function seatProxy() {
	const seat = gizmoSeatLocal();
	if (!seat || !proxy || !edited) return;
	edited.updateMatrixWorld();
	proxy.position.copy(edited.localToWorld(seat));
	proxy.quaternion.identity();
	proxy.scale.setScalar(1);
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
	// VR drags handles directly via vrBeginHandleDrag), and never when the user has
	// switched the gizmo off (meshGizmoEnabled covers all three element modes)
	if (index >= 0 && index < handles.length && !get(isVRMode) && get(meshGizmoEnabled)) {
		seatProxy();
		// HONOUR the app's transform mode. This used to be a hardwired
		// setMode('translate') that ran on every re-seat, so vertex mode never
		// offered rotate or scale at ALL: 1/2/3 reach the proxy through
		// setTransformMode, and the very next selection change put it back.
		controls.setMode(get(transformMode));
		// vertex mode used to ignore the space pref entirely, so Local/World in the
		// toolbox only affected faces — the gizmo is one control, it should mean one thing
		controls.setSpace?.(get(faceGizmoSpace));
		controls.attach(proxy);
	} else if (controls.object === proxy) controls.detach();
}

// live: flipping either gizmo pref re-seats (or drops) the VERTEX proxy too
registerGizmoPrefListener(() => {
	if (edited && selectedHandle >= 0) setAnchor(selectedHandle);
});

// ...and so does placing / clearing the custom pivot (plus its marker)
registerMeshPivotListener(() => {
	if (!edited) return;
	if (selectedHandle >= 0) setAnchor(selectedHandle);
	refreshMeshPivotMarker(edited);
});

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

/**
 * #20: BOX SELECT for vertex handles — every handle whose screen position falls inside
 * `rect` joins the selection.
 *
 * The gap the user reported: a Shift/Ctrl drag has always marquee-selected OBJECTS, and
 * inside a mesh session there was no drag-select of any kind, so several elements could
 * only ever be picked one click at a time.
 *
 * SCREEN space, not world: the box is drawn on the screen, so the test belongs where it
 * was drawn. Handles behind the camera are dropped rather than mirrored into the frustum,
 * which is what a naive `project()` test does with them.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect CSS pixels, any corner order
 * @param {any} camera @param {{width:number,height:number}} size the canvas' CSS size
 * @param {boolean} [additive] add to the current pick instead of replacing it
 * @returns {number} how many handles are selected afterwards
 */
function selectVerticesInRectInner(rect, camera, size, additive = false) {
	if (!edited || !handles.length || !camera || !size?.width || !size?.height) return 0;
	const minX = Math.min(rect.x1, rect.x2);
	const maxX = Math.max(rect.x1, rect.x2);
	const minY = Math.min(rect.y1, rect.y2);
	const maxY = Math.max(rect.y1, rect.y2);
	const next = additive ? new Set(vertexSelection) : new Set();
	let last = -1;
	for (let i = 0; i < handles.length; i++) {
		handleWorldPosition(i, tempVector);
		tempVector.project(camera);
		// behind the camera: project() mirrors such a point back into the frustum, so a
		// vertex behind your head would otherwise land inside the box
		if (tempVector.z > 1) continue;
		const sx = ((tempVector.x + 1) / 2) * size.width;
		const sy = ((1 - tempVector.y) / 2) * size.height;
		if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
		next.add(i);
		last = i;
	}
	// an empty box REPLACING the pick would make a stray drag wipe the work; an empty
	// additive box is simply a no-op
	if (!next.size) return vertexSelection.size;
	vertexSelection = next;
	if (last >= 0) setAnchor(last);
	syncVertexSelection();
	return vertexSelection.size;
}

/** One undo step per box, like every other selection command.
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {any} camera @param {{width:number,height:number}} size @param {boolean} [additive] */
export function selectVerticesInRect(rect, camera, size, additive = false) {
	return withSelectionHistory('vertices', () =>
		selectVerticesInRectInner(rect, camera, size, additive)
	);
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
	// Inner, deliberately: this is the OP tidying up after itself, not a pick the
	// user made. Recording it would put a selection entry ON TOP of the weld's
	// meshgeo, so the next Ctrl+Z would undo the housekeeping instead of the weld.
	if (ok) clearVertexSelectionInner();
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
	if (ok) clearVertexSelectionInner(); // op housekeeping, not a user pick
	return ok;
}

/** Select exactly this handle (fresh single selection + anchor/gizmo).
 * @param {number} index */
function selectHandleInner(index) {
	vertexSelection = new Set(index >= 0 ? [index] : []);
	setAnchor(index);
	syncVertexSelection();
}

/**
 * The vertex SELECTION as welded position KEYS — the ctrl-picked set, or the single
 * anchored handle when nothing was added to it (meshEdit has TWO selection notions and a
 * plain click only sets the anchor).
 *
 * Every vertex OPERATOR crosses the same boundary: this module owns the handles, faceEdit
 * owns the triangle soup, and a welded key is the only thing both agree on.
 * @returns {string[]}
 */
function selectedVertexKeys() {
	const indices = vertexSelection.size
		? [...vertexSelection]
		: selectedHandle >= 0
			? [selectedHandle]
			: [];
	return indices
		.filter((index) => handles[index])
		.map((index) => {
			const p = handles[index].position;
			return `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
		});
}

/**
 * M5b: bevel the selected vertices — the corner is cut off and capped. Any number of
 * vertices at once; the geometry work lives in faceEdit (it owns the triangle soup and the
 * commit path), this only translates the SELECTION into welded position keys.
 * @param {number} width @param {number} profile -1 dished .. 0 flat .. +1 domed
 * @returns {boolean}
 */
export function bevelSelectedVerts(width = 0.2, profile = 0) {
	if (!edited || !handles.length) return false;
	const keys = selectedVertexKeys();
	if (!keys.length) {
		showToast('Select a vertex first, then Bevel');
		return false;
	}
	const uuid = edited.uuid;
	const ok = bevelVertices(uuid, keys, { width, profile });
	// the bevel replaced the corner, so the handle list is stale in every sense — rebuild
	// the session from the new geometry and drop a selection that no longer means anything
	if (ok) {
		vertexSelection.clear();
		syncVertexSelection();
		setAnchor(-1);
		refreshVertexEditSession();
	}
	return ok;
}

/**
 * 19-A P2: the vertex bevel through the ADJUST ENGINE — applies immediately and
 * leaves the width/profile scrubbable in the options pane. Same selection
 * translation as `bevelSelectedVerts` (which stays as the one-shot path); the
 * engine owns the commit, the history entry and the selection housekeeping.
 * @param {number} width @param {number} profile @returns {boolean}
 */
export function beginVertexBevelAdjust(width = 0.2, profile = 0) {
	if (!edited || !handles.length) return false;
	const keys = selectedVertexKeys();
	if (!keys.length) {
		showToast('Select a vertex first, then Bevel');
		return false;
	}
	return beginOpAdjust(
		'bevel',
		{ width, profile },
		{ kind: 'vertices', uuid: edited.uuid, vertexKeys: keys }
	);
}

/**
 * 19-A P5a: DELETE the selected vertices — every face that uses one of them goes away,
 * leaving a hole. The destructive counterpart of Weld: weld pulls the picks together and
 * keeps the surface, delete opens it up.
 *
 * Same split as the vertex bevel: the selection becomes welded keys here, and faceEdit
 * does the triangle work and owns the commit (one `meshgeo` entry, replicated).
 * @returns {boolean}
 */
export function deleteSelectedVerts() {
	if (!edited || !handles.length) return false;
	const keys = selectedVertexKeys();
	if (!keys.length) {
		showToast('Select a vertex first, then Delete');
		return false;
	}
	const ok = deleteVertices(edited.uuid, keys);
	if (ok) {
		// the triangles those handles belonged to are gone, so the handle list is stale in
		// every sense — rebuild the session and drop a selection that no longer means
		// anything. Inner/direct, deliberately: a selection entry recorded ON TOP of the
		// delete would make the next Ctrl+Z undo the housekeeping instead of the delete.
		vertexSelection.clear();
		syncVertexSelection();
		setAnchor(-1);
		refreshVertexEditSession();
	}
	return ok;
}

/**
 * 19-A P5b: SMOOTH / RELAX the selected vertices — the meshEdit-shell -> faceEdit-work
 * split of `deleteSelectedVerts`/`bevelSelectedVerts`: this module owns the handles,
 * faceEdit owns the triangle soup and the commit, and welded position keys cross the
 * boundary. One commit per click (a positions-only meshgeo snapshot — counts never
 * change, so groups/uvs/topology all carry; see smoothVertices).
 *
 * The selection deliberately SURVIVES: counts are unchanged, so applyMeshGeo's session
 * refresher rebuilds the handles at the same indices and a second Apply keeps relaxing
 * the same picks — the natural way to use an iterative tool.
 * @param {number} [factor] 0..1 lerp toward the neighbour average
 * @param {number} [iterations] 1..10 passes @returns {boolean}
 */
export function smoothSelectedVerts(factor = 0.5, iterations = 1) {
	if (!edited || !handles.length) return false;
	const keys = selectedVertexKeys();
	if (!keys.length) {
		showToast('Select a vertex first, then Smooth');
		return false;
	}
	return smoothVertices(edited.uuid, keys, { factor, iterations });
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
	const result = writeHandle(selectedHandle, local);
	refreshGeometryAfterWrite();
	return result;
}

/**
 * Write ONE handle's LOCAL position through to every attribute index it owns.
 * Cheap and repeatable: the caller runs `refreshGeometryAfterWrite` ONCE after
 * the whole set, because recomputing normals per handle is O(n) each time.
 * @param {number} index @param {any} local @returns {number[]} the LOCAL position
 */
function writeHandle(index, local) {
	const handle = handles[index];
	if (!handle) return [0, 0, 0];
	handle.position.copy(local);
	// read back off the handle, never off `local`: refreshHandleMatrix mutates the
	// shared temp vectors and `local` is frequently one of them
	const x = handle.position.x;
	const y = handle.position.y;
	const z = handle.position.z;
	const position = edited.geometry.attributes.position;
	handle.indices.forEach((/** @type {number} */ i) => position.setXYZ(i, x, y, z));
	refreshHandleMatrix(index);
	return [x, y, z];
}

/** Normals, bounds, the wireframe overlay and the upload flag — once per frame
 * of a gesture, after every handle it moved has been written. */
function refreshGeometryAfterWrite() {
	if (!edited) return;
	edited.geometry.attributes.position.needsUpdate = true;
	edited.geometry.computeVertexNormals();
	edited.geometry.computeBoundingSphere();
	if (overlay) {
		overlay.geometry.dispose();
		overlay.geometry = editWireGeometry(edited.geometry);
	}
}


/**
 * M9 VERTEX SLIDE: constrain the drag to one of the vertex's own edges.
 *
 * Sliding a vertex ALONG an edge is how you adjust a profile without changing the
 * surface it lies in — a free drag pulls the vertex off both adjacent faces and dents
 * the silhouette. Armed like a tool: while `vertexSlide` is on, a single-vertex drag
 * follows the incident edge that best matches the direction you started dragging, and
 * clamps to that edge's ENDS so the vertex can never leave it.
 * @type {import('svelte/store').Writable<boolean>} */
export const vertexSlide = writable(false);
/** the edge chosen for the live slide: local-space endpoints @type {any} */
let slideEdge = null;
/** local-space position at drag start (the origin for the direction vote) @type {any} */
let slideStart = null;
/** the live slide's parameter along its edge (0 = start, 1 = far end) — kept
 * for the landing marker + tests @type {number} */
let lastSlideT = 0;
/** 19-A P7b: scene-root LANDING MARKER — shown while an UNCLAMPED slide sits
 * outside the edge's own span (t < 0 or t > 1), at the point the vertex will
 * land. The proportional-ring recipe: scene root (never objectsGroup — GLTF
 * sync), raycast stubbed, hidden the moment the drag ends. @type {any} */
let slideMarker = null;

/** @param {number} t @param {any} landedLocal the constrained LOCAL position */
function updateSlideMarker(t, landedLocal) {
	const outside = t < 0 || t > 1;
	if (!outside) {
		if (slideMarker) slideMarker.visible = false;
		return;
	}
	const scene = get(globalScene);
	if (!scene || !edited) return;
	if (!slideMarker) {
		slideMarker = new THREE.Mesh(
			new THREE.SphereGeometry(1, 12, 12),
			new THREE.MeshBasicMaterial({
				color: 0xffc21a,
				transparent: true,
				opacity: 0.85,
				depthTest: false
			})
		);
		slideMarker.name = 'slide-landing-marker';
		slideMarker.renderOrder = 998;
		slideMarker.raycast = () => {}; // a viewport helper must never be a pick target
	}
	if (!slideMarker.parent) scene.add(slideMarker);
	slideMarker.visible = true;
	edited.updateMatrixWorld();
	slideMarker.position.copy(edited.localToWorld(landedLocal.clone()));
	// a touch larger than a vertex dot so it reads as "the landing", not a handle
	slideMarker.scale.setScalar(baseRadius() * 1.6);
}

function hideSlideMarker() {
	if (slideMarker) slideMarker.visible = false;
}

/** the LOCAL positions a handle shares an edge with, deduped by welded key
 * @param {number} index @returns {any[]} */
function incidentEdgeEnds(index) {
	if (!edited || !handles[index]) return [];
	const anchor = handles[index].position;
	const keyOf = (/** @type {any} */ v) =>
		`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
	const anchorKey = keyOf(anchor);
	/** @type {Map<string, any>} */
	const ends = new Map();
	// a quad DIAGONAL is a triangulation artifact, not an edge of the model, so it is not a
	// direction anyone means to slide along — the same rule pickEdgeAt and dissolve follow
	const internal = internalEdgeSet(edited.geometry);
	for (const tri of readTriangles(edited.geometry))
		for (let c = 0; c < 3; c++) {
			if (keyOf(tri[c]) !== anchorKey) continue;
			for (const other of [tri[(c + 1) % 3], tri[(c + 2) % 3]]) {
				const key = keyOf(other);
				if (key === anchorKey || ends.has(key)) continue;
				if (internal.has(edgeKeyOf(tri[c], other))) continue;
				ends.set(key, other.clone());
			}
		}
	return [...ends.values()];
}

/**
 * The proxy's LOCAL position, constrained by the slide if one is armed. Every write path
 * reads the proxy through here, so the constraint applies to the live drag, the final
 * commit, the broadcast and the undo snapshot with no extra plumbing.
 * @returns {any} */
function proxyLocal() {
	const local = edited.worldToLocal(writeVector.copy(proxy.position));
	// the slide projects the PROXY's position onto one of the vertex's own edges,
	// which only means anything while the proxy IS the vertex — a custom pivot
	// seats it somewhere else entirely, so the constraint stands down there
	if (!get(vertexSlide) || !slideStart || vertexSelection.size > 1 || hasMeshPivot(edited.uuid))
		return local;
	if (!slideEdge) {
		// choose on the first REAL movement: the incident edge whose direction best
		// matches how the user started dragging (a tiny jitter must not decide it)
		const drag = local.clone().sub(slideStart);
		if (drag.lengthSq() < 1e-8) return local.copy(slideStart);
		let best = null;
		let bestDot = -Infinity;
		for (const end of incidentEdgeEnds(selectedHandle)) {
			const direction = end.clone().sub(slideStart);
			if (direction.lengthSq() < 1e-12) continue;
			const dot = drag.clone().normalize().dot(direction.clone().normalize());
			if (dot > bestDot) {
				bestDot = dot;
				best = end;
			}
		}
		if (!best) return local;
		slideEdge = { a: slideStart.clone(), b: best.clone() };
	}
	// project onto the segment. CLAMPED (the default) the vertex stays on its
	// edge, ends included; with the P7b clamp toggle OFF the parameter
	// EXTRAPOLATES past either end, continuing the edge's direction — and a
	// landing marker shows where the vertex will go whenever it is off the edge.
	const span = slideEdge.b.clone().sub(slideEdge.a);
	let t = local.clone().sub(slideEdge.a).dot(span) / span.lengthSq();
	if (get(slideClamp)) t = Math.min(Math.max(t, 0), 1);
	lastSlideT = t;
	const landed = local.copy(slideEdge.a).addScaledVector(span, t);
	updateSlideMarker(t, landed);
	return landed;
}

/** the live slide's edge (+ its current parameter), for tests/UI @returns {any} */
export function slideEdgeDebug() {
	return slideEdge ? { a: slideEdge.a.toArray(), b: slideEdge.b.toArray(), t: lastSlideT } : null;
}

// ---- M8: PROPORTIONAL EDITING ---------------------------------------------
// Dragging one vertex normally leaves a dent: its neighbours stay put and the surface
// creases. Proportional editing drags the neighbourhood WITH it, weighted by distance, which
// is how a smooth bulge or a soft dip gets made.
//
// Two rules make it behave: weights come from the positions AT DRAG START (recomputing them
// mid-drag makes the falloff chase the vertex), and the move is written ABSOLUTELY
// (start + total * weight) rather than accumulated per frame, so a long drag cannot drift.
//
// P4: the stores + the smoothstep live in ./proportional now (faceEdit shares them for
// edge/face grabs; re-exported at the top of this file), and the radius shows as a
// scene-root RING during the drag (./proportionalRing).

/** handle positions captured at drag start, for the absolute write @type {any[]|null} */
let falloffStart = null;
/** per-handle weight for this drag, 0 for anything out of range @type {number[]|null} */
let falloffWeights = null;

/** WORLD-space averaged vertex normal of the anchor handle, or null (no anchor /
 * no normal attribute / degenerate sum). @returns {any} */
function anchorVertexNormalWorld() {
	if (!edited || selectedHandle < 0) return null;
	const normalAttr = edited.geometry?.attributes?.normal;
	if (!normalAttr) return null;
	const sum = new THREE.Vector3();
	const one = new THREE.Vector3();
	handles[selectedHandle].indices.forEach((/** @type {number} */ idx) => {
		sum.add(one.fromBufferAttribute(normalAttr, idx));
	});
	if (sum.lengthSq() < 1e-9) return null;
	return sum.transformDirection(edited.matrixWorld);
}

/** camera-facing fallback normal for the ring (a vertex on a crease can have a
 * meaningless average) @param {any} point @returns {any} */
function cameraFacingNormal(point) {
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera) return new THREE.Vector3(0, 1, 0);
	const toCamera = camera.getWorldPosition(new THREE.Vector3()).sub(point);
	return toCamera.lengthSq() > 1e-9 ? toCamera.normalize() : new THREE.Vector3(0, 1, 0);
}

// P4: the radius ring's VERTICES anchor provider — the registration seam (a
// static import of this module from proportionalRing would be a cycle, and a
// primed dynamic import risks the HMR dual-instance trap). Registering is a
// plain registry push, so module-eval order is safe.
registerProportionalAnchor('vertices', () => {
	const point = vertexSelectionWorldPoint();
	if (!point || !edited) return null;
	return { point, normal: anchorVertexNormalWorld() ?? cameraFacingNormal(point), object: edited };
});

/** Capture the neighbourhood this drag will carry. Called at drag start, so the weights
 * cannot chase the vertex as it moves. */
function beginFalloff() {
	falloffStart = null;
	falloffWeights = null;
	if (!get(proportionalEdit) || !edited || selectedHandle < 0) return;
	const radius = Math.max(get(proportionalRadius), 1e-4);
	const anchor = handles[selectedHandle].position.clone();
	falloffStart = handles.map((handle) => handle.position.clone());
	falloffWeights = handles.map((handle, index) => {
		if (index === selectedHandle || vertexSelection.has(index)) return 1; // the selection moves fully
		return falloffWeight(handle.position.distanceTo(anchor) / radius);
	});
	// P4: show the falloff radius for the duration of the drag (hidden at drag end)
	const anchorWorld = handleWorldPosition(selectedHandle, new THREE.Vector3());
	showProportionalRingAt({
		point: anchorWorld,
		normal: anchorVertexNormalWorld() ?? cameraFacingNormal(anchorWorld),
		object: edited
	});
}

/** the anchor's position when the drag started — the origin every weighted move measures
 * from. Only ever called behind `falloffActive()`. @returns {any} */
function falloffOrigin() {
	return falloffStart?.[selectedHandle] ?? handles[selectedHandle].position;
}

/**
 * 19-A P7b: re-derive the falloff weights from the CURRENT radius — the
 * mid-drag wheel's recapture. Distances are measured against the drag-START
 * positions (`falloffStart`), the same rule as `beginFalloff`: the falloff must
 * never chase the vertex. A handle that fell OUT of the shrunken radius is
 * written back to its start (applyFalloff skips w = 0, so it would otherwise
 * stay stranded where the old weight had carried it), then the whole
 * neighbourhood re-applies absolutely at the current drag delta.
 */
function recaptureVertexFalloff() {
	if (!edited || selectedHandle < 0 || !falloffStart) return;
	const radius = Math.max(get(proportionalRadius), 1e-4);
	const anchor = falloffStart[selectedHandle];
	const previous = falloffWeights;
	falloffWeights = falloffStart.map((p, index) => {
		if (index === selectedHandle || vertexSelection.has(index)) return 1;
		return falloffWeight(p.distanceTo(anchor) / radius);
	});
	const position = edited.geometry.attributes.position;
	for (let i = 0; i < handles.length; i++) {
		if (i === selectedHandle || vertexSelection.has(i)) continue;
		if ((previous?.[i] ?? 0) > 0 && falloffWeights[i] <= 0) {
			const p = handles[i].position.copy(falloffStart[i]);
			handles[i].indices.forEach((/** @type {number} */ idx) => position.setXYZ(idx, p.x, p.y, p.z));
			refreshHandleMatrix(i);
		}
	}
	// members first, anchor last — the tail commitSelectedLocal refreshes
	// normals/bounds/overlay and sets needsUpdate (the onProxyMoved shape)
	applyFalloff(deltaVector.copy(handles[selectedHandle].position).sub(falloffOrigin()));
	commitSelectedLocal(handles[selectedHandle].position.clone());
}

/** Is a falloff drag live, i.e. is anything beyond the selection moving? */
function falloffActive() {
	return !!falloffWeights && falloffWeights.some((w, i) => w > 0 && i !== selectedHandle && !vertexSelection.has(i));
}

/**
 * Write the whole weighted neighbourhood for a total drag delta. Absolute from
 * the drag start (see the note above), so it covers the selected members at
 * w = 1 and needs no second pass on top.
 * @param {any} total local-space delta from the drag's start
 */
function applyFalloff(total) {
	if (!falloffStart || !falloffWeights) return;
	const position = edited.geometry.attributes.position;
	for (let i = 0; i < handles.length; i++) {
		const weight = falloffWeights[i];
		if (weight <= 0 || i === selectedHandle) continue;
		const p = handles[i].position.copy(falloffStart[i]).addScaledVector(total, weight);
		handles[i].indices.forEach((/** @type {number} */ idx) => position.setXYZ(idx, p.x, p.y, p.z));
		refreshHandleMatrix(i);
	}
}


// D5: a multi-selection drags rigidly — every member moves by the gesture's
// local-space delta, written ABSOLUTELY from the drag-start snapshot. Dedicated
// vector (never the shared temps: the write loop calls refreshHandleMatrix,
// which mutates tempVector).
const deltaVector = new THREE.Vector3();
/** @type {number[]|null} index-expanded snapshot at multi-drag start (ONE meshgeo undo) */
let dragStartExpanded = null;

/** The handles a gizmo gesture moves: the multi-selection, else the anchor
 * alone. (The falloff neighbourhood is deliberately NOT in here — see
 * `applyPivotTransform`.) @returns {number[]} */
function gestureIndices() {
	const set = new Set(vertexSelection);
	if (selectedHandle >= 0) set.add(selectedHandle);
	return [...set].filter((i) => handles[i]);
}

/** The gesture's total TRANSLATION in local space, measured from the seat the
 * proxy started at. `proxyLocal()` applies the armed slide constraint, so the
 * constraint reaches the live drag, the commit, the broadcast and the undo
 * snapshot through this one read. @returns {any} */
function translateDelta() {
	return deltaVector.copy(proxyLocal()).sub(/** @type {any} */ (proxyGesture).seat);
}

/** Write the whole gesture as a pure TRANSLATION (absolute from the drag start).
 * @param {any} delta local-space total */
function applyTranslate(delta) {
	const g = /** @type {any} */ (proxyGesture);
	// M8: the weighted neighbourhood is written ABSOLUTELY from the drag start and
	// already covers the selected members at w = 1, so it replaces the plain pass
	if (falloffActive()) applyFalloff(delta);
	for (const index of gestureIndices()) {
		if (falloffActive() && index !== selectedHandle) continue; // applyFalloff did it
		writeHandle(index, tempVector.copy(g.starts[index]).add(delta));
	}
}

/**
 * ROTATE / SCALE the selected vertices about the PIVOT — the half of the gizmo
 * vertex mode never had (it hardwired setMode('translate'), so 1/2/3 could not
 * reach it). Same shape as `applyFaceGrab`: rebuilt from the drag-start snapshot
 * on every call, so a long drag cannot drift, and conjugated out of the proxy
 * frame into object-local before it touches a vertex.
 *
 * DELIBERATE: proportional falloff is a TRANSLATE tool and is left alone here.
 * Only the selected set turns/scales; the neighbourhood keeps its positions. A
 * weighted partial rotation is a different (and much less obvious) operation,
 * and silently inventing one would be worse than not offering it.
 */
function applyPivotTransform() {
	const g = /** @type {any} */ (proxyGesture);
	const pivot = g.seat;
	edited.updateMatrixWorld();
	const objQuat = edited.getWorldQuaternion(new THREE.Quaternion());
	// R maps the PROXY frame into object-local; the proxy is seated with an
	// identity pose, so this is the object's own inverse world rotation
	const R = objQuat.clone().invert().multiply(g.quat);
	const Rinv = R.clone().invert();
	const dQuatProxy = g.quat.clone().invert().multiply(proxy.quaternion);
	const dQuat = R.clone().multiply(dQuatProxy).multiply(Rinv);
	// TransformControls scales from the pose it was attached at, and seatProxy
	// resets that to 1 — the divide keeps it honest if it ever is not
	const scale = proxy.scale.clone().divide(g.scale);
	const point = new THREE.Vector3();
	for (const index of gestureIndices()) {
		if (!g.starts[index]) continue;
		point
			.copy(g.starts[index])
			.sub(pivot)
			.applyQuaternion(Rinv)
			.multiply(scale)
			.applyQuaternion(R)
			.applyQuaternion(dQuat)
			.add(pivot);
		writeHandle(index, point);
	}
}

/** Apply whichever transform the gesture is (translate / rotate / scale). */
function applyProxyGesture() {
	if (/** @type {any} */ (proxyGesture).mode === 'translate') applyTranslate(translateDelta());
	else applyPivotTransform();
	refreshGeometryAfterWrite();
}

/** Called from Scene.svelte's gizmo onchange when the vertex proxy moves */
export function onProxyMoved() {
	// MOVE PIVOT armed: the gizmo carries the PIVOT, so the only thing that
	// follows it is the marker — the geometry must not move at all. Checked
	// FIRST, above every gesture read (there is no `proxyGesture` in this mode,
	// and there must never be one).
	if (get(meshPivotMoving)) {
		if (edited && proxy) setMeshPivotPreview(proxy.position.clone());
		return;
	}
	// no live gesture = the 'change' TransformControls fires on attach and on
	// hover, which must never write geometry (this used to be a distance test
	// against the anchor, which the centroid seat no longer sits on)
	if (!edited || selectedHandle < 0 || !proxyGesture) return;
	applyProxyGesture();
	const now = Date.now();
	if (now - lastSent < 80) return;
	lastSent = now;
	broadcastGesture();
}

/** Stream every handle this gesture moved over the `verts` channel. */
function broadcastGesture() {
	broadcastSelected(handles[selectedHandle].position.toArray());
	for (const index of gestureIndices()) if (index !== selectedHandle) broadcastHandle(index);
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
	if (!edited || !proxy) return;
	// MOVE PIVOT armed: the drag re-points the pivot and touches nothing else.
	// Diverted HERE, BEFORE the gesture machinery below, so the drag can never
	// open a `proxyGesture` (or a falloff capture, or a meshgeo snapshot) that
	// would then have to be unwound — the 17-D `pivotOnly` shape. Drag end writes
	// the pivot: no geometry, no history entry, no `verts` message.
	if (get(meshPivotMoving)) {
		if (dragging) setMeshPivotPreview(proxy.position.clone());
		else commitMeshPivotDrag(edited, proxy.position);
		return;
	}
	if (selectedHandle < 0) return;
	if (dragging) {
		dragStartLocal = handles[selectedHandle].position.toArray();
		// M9: the slide picks its edge on the first real movement, from HERE
		slideStart = handles[selectedHandle].position.clone();
		slideEdge = null;
		// D5: a multi-drag undoes as ONE meshgeo snapshot (a 'verts' entry holds
		// one position for all its indices — it cannot carry per-handle befores;
		// same reasoning as weld). Index-expanded per the D1 representation rule.
		beginFalloff();
		// P7b: while the proportional drag lives, the wheel resizes the radius and
		// the weights recapture (disarmed at drag end / session exit)
		if (falloffStart) beginProportionalWheel(recaptureVertexFalloff);
		const mode = get(transformMode);
		proxyGesture = {
			mode,
			seat: gizmoSeatLocal() ?? handles[selectedHandle].position.clone(),
			pos: proxy.position.clone(),
			quat: proxy.quaternion.clone(),
			scale: proxy.scale.clone(),
			starts: handles.map((/** @type {any} */ handle) => handle.position.clone())
		};
		// a falloff drag moves many handles, so it undoes as ONE meshgeo snapshot for the same
		// reason a multi-drag does (a `verts` entry holds one position for all its indices).
		// P7b: captured whenever falloff COULD engage (`falloffStart`, i.e. the tool is on),
		// not only when a neighbour is in range NOW — the wheel can grow the radius mid-drag,
		// and a bare 'verts' entry could not undo the neighbours that pulls in.
		// A rotate/scale joins them: even a single handle turning about a placed pivot
		// is easier to reason about as one geometry snapshot than as a 'verts' delta.
		dragStartExpanded =
			vertexSelection.size > 1 || !!falloffStart || mode !== 'translate'
				? trisToPositions(readTriangles(edited.geometry))
				: null;
	} else if (dragStartLocal && proxyGesture) {
		const mode = proxyGesture.mode;
		// catch any tail movement since the last change event
		applyProxyGesture();
		const after = handles[selectedHandle].position.toArray();
		broadcastGesture(); // final unthrottled state, every moved handle
		if (vertexSelection.size > 1 || falloffActive() || mode !== 'translate') {
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
		falloffStart = null;
		falloffWeights = null;
		hideProportionalRing(); // P4: the radius ring lives for the drag only
		endProportionalWheel(); // P7b: the wheel belongs to the live drag only
		hideSlideMarker(); // P7b: the landing marker too
		dragStartLocal = null;
		slideEdge = null;
		slideStart = null;
		proxyGesture = null;
		// put the gizmo back on its seat with a NEUTRAL pose: a constrained drag ends
		// with the proxy away from the committed point (that is the whole point of a
		// constraint), and a rotate/scale ends with it turned or stretched — either way
		// the next gesture would read the leftover as its own starting delta
		setAnchor(selectedHandle);
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
			overlay.geometry = editWireGeometry(object.geometry);
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
