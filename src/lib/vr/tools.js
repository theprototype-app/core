// VR controls — Edit tools driven by the controllers: box select, stretch (+ its sliders).
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	objectsGroup,
	globalScene,
	vrStretchObject,
	vrStretchAxis,
	vrStretchFactors,
	vrToolMode
} from '../../stores/sceneStore';
import {
	stretchPositions,
	commitMeshGeoSnapshot,
	readTriangles,
	trisToPositions,
	applyMeshGeo
} from '../faceEdit';
import { applySelectionSet } from '../objectActions';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { vrEditGroup } from './panels.js';
import { controllerRay } from './pointer.js';

// ---- 214: Box Select — a 3D drag-box marquee. Trigger-press anchors a corner,
// the controller drags the opposite corner, release selects every top-level
// object whose world origin falls inside. The visual is a scene-root mesh
// (translucent blue faces + dashed edges) that NEVER parents into objectsGroup
// (it would leak into GLTF sync, like the selection shell). ----
/** @type {{index: number, anchor: any} | null} */
export let boxSelect = null;
/** @type {any} scene-root visual group */
let boxSelectVisual = null;

/** @param {number} index */
function controllerWorldPos(index) {
	return renderer.xr.getController(index).getWorldPosition(new THREE.Vector3());
}

function ensureBoxVisual() {
	if (boxSelectVisual) return boxSelectVisual;
	const scene = get(globalScene);
	if (!scene) return null;
	const grp = new THREE.Group();
	grp.name = 'vr-box-select';
	const faces = new THREE.Mesh(
		new THREE.BoxGeometry(1, 1, 1),
		new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.14, depthTest: false, side: THREE.DoubleSide })
	);
	faces.name = 'vr-box-select-faces';
	faces.renderOrder = 998;
	const edges = new THREE.LineSegments(
		new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
		new THREE.LineDashedMaterial({ color: 0x8ec5ff, dashSize: 0.03, gapSize: 0.02, depthTest: false })
	);
	edges.name = 'vr-box-select-edges';
	edges.computeLineDistances();
	edges.renderOrder = 999;
	grp.add(faces, edges);
	scene.add(grp);
	boxSelectVisual = grp;
	return grp;
}

/** Position/scale the visual to span anchor..current (min size so it stays visible).
 * @param {any} anchor @param {any} current */
function updateBoxVisual(anchor, current) {
	const grp = ensureBoxVisual();
	if (!grp) return;
	grp.position.copy(anchor.clone().add(current).multiplyScalar(0.5));
	grp.scale.set(
		Math.max(Math.abs(current.x - anchor.x), 1e-3),
		Math.max(Math.abs(current.y - anchor.y), 1e-3),
		Math.max(Math.abs(current.z - anchor.z), 1e-3)
	);
}

/** Trigger press starts the marquee (no-op unless tool = 'box'). @param {number} index */
export function boxSelectStart(index) {
	if (get(vrToolMode) !== 'box' || !renderer?.xr?.isPresenting) return false;
	boxSelect = { index, anchor: controllerWorldPos(index) };
	updateBoxVisual(boxSelect.anchor, boxSelect.anchor);
	hapticPulse(0.3, 30);
	return true;
}

/** Per-frame: grow the box to the controller. */
export function updateBoxSelect() {
	if (!boxSelect) return;
	updateBoxVisual(boxSelect.anchor, controllerWorldPos(boxSelect.index));
}

/** Select every top-level object whose world origin is inside the AABB. Testable:
 * pass two world corners, applies the replicated multi-selection.
 * @param {number[]} a @param {number[]} b @returns {string[]} selected uuids */
export function selectObjectsInBox(a, b) {
	const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
	const max = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
	const root = get(objectsGroup);
	if (!root) return [];
	const p = new THREE.Vector3();
	/** @type {string[]} */
	const hits = [];
	root.children.forEach((/** @type {any} */ child) => {
		child.getWorldPosition(p);
		if (p.x >= min[0] && p.x <= max[0] && p.y >= min[1] && p.y <= max[1] && p.z >= min[2] && p.z <= max[2])
			hits.push(child.uuid);
	});
	if (hits.length) applySelectionSet(hits);
	return hits;
}

/** Trigger release finalizes (or cancels) the marquee. @param {boolean=} cancel @returns {string[]|null} */
export function boxSelectEnd(cancel = false) {
	if (!boxSelect) return null;
	const anchor = boxSelect.anchor;
	const current = controllerWorldPos(boxSelect.index);
	boxSelect = null;
	if (boxSelectVisual) {
		boxSelectVisual.parent?.remove(boxSelectVisual);
		boxSelectVisual.traverse((/** @type {any} */ o) => {
			o.geometry?.dispose?.();
			o.material?.dispose?.();
		});
		boxSelectVisual = null;
	}
	if (cancel) return null;
	const uuids = selectObjectsInBox(anchor.toArray(), current.toArray());
	hapticPulse(0.4, 40);
	return uuids;
}

/** True while a box-select drag is active (Scene guards the click-select). */
export function boxSelectActive() {
	return !!boxSelect;
}

// ---- 161: VR Stretch mode — non-uniform axis scale, baked as a meshgeo ----
/** @type {any} { uuid, base: number[], factors: [x,y,z] } */
export let stretch = null;

/** Positions with the current per-axis factors applied to the base. */
function stretchedPositions() {
	let p = stretch.base;
	for (let a = 0; a < 3; a++) if (stretch.factors[a] !== 1) p = stretchPositions(p, a, stretch.factors[a]);
	return p;
}

/** Live preview: swap the object's geometry to the stretched positions (local). */
function applyStretchPreview() {
	if (!stretch) return;
	applyMeshGeo(stretch.uuid, stretchedPositions());
}

/** Enter stretch on an object (captures its base geometry, expanded/non-indexed). @param {string} uuid */
export function beginStretch(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object?.geometry) return false;
	// expand through the index like the face ops so applyMeshGeo (non-indexed) matches
	stretch = { uuid, base: trisToPositions(readTriangles(object.geometry)), factors: [1, 1, 1] };
	vrStretchObject.set(uuid);
	vrStretchAxis.set(0);
	vrStretchFactors.set([1, 1, 1]);
	return true;
}

/** Set one axis' extent factor (absolute) + preview. @param {number} axis @param {number} factor */
export function setStretch(axis, factor) {
	if (!stretch) return;
	stretch.factors[axis] = Math.min(Math.max(factor, 0.05), 20);
	vrStretchAxis.set(axis);
	vrStretchFactors.set([...stretch.factors]);
	applyStretchPreview();
}

/** Joystick tick: nudge the ACTIVE axis' factor by a fraction. @param {number} delta */
export function nudgeStretch(delta) {
	if (!stretch) return;
	const axis = get(vrStretchAxis);
	setStretch(axis, stretch.factors[axis] * (1 + delta));
}

/** Bake the stretch into ONE meshgeo (replicated + undoable). @returns {boolean} */
export function commitStretch() {
	if (!stretch) return false;
	const { uuid, base, factors } = stretch;
	const after = stretchedPositions();
	const changed = factors.some((/** @type {number} */ f) => f !== 1);
	stretch = null;
	vrStretchObject.set(null);
	if (changed) commitMeshGeoSnapshot(uuid, base, after);
	return changed;
}

/** Abandon the stretch, restoring the base geometry. */
export function cancelStretch() {
	if (!stretch) return;
	const { uuid, base } = stretch;
	stretch = null;
	vrStretchObject.set(null);
	applyMeshGeo(uuid, base);
}

/** Stretch session for tests (161) @returns {any} */
export function stretchState() {
	return stretch ? { uuid: stretch.uuid, factors: [...stretch.factors], axis: get(vrStretchAxis) } : null;
}

// ---- 193: per-axis infinite sliders in the Edit>Stretch menu ----
/** @type {{axis:number, index:number, lastX:number}|null} */
export let stretchSliderDrag = null;

/** current stretch factors [w,h,d] for the slider labels @returns {number[]} */
export function stretchFactors() {
	return stretch ? [...stretch.factors] : [1, 1, 1];
}
/** raycast the 3 W/H/D stretch slider handles in the edit menu -> axis 0/1/2 or -1
 * @param {number} index */
export function raycastStretchSlider(index) {
	const panel = get(vrEditGroup);
	if (!panel || !get(vrStretchObject)) return -1;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrstretch-'));
	return control ? parseInt(control.object.name.slice('vrstretch-'.length)) : -1;
}
/** grab the hovered slider on trigger-down; true if a slider was grabbed @param {number} index */
export function beginStretchSliderDrag(index) {
	if (!stretch) return false;
	const axis = raycastStretchSlider(index);
	if (axis < 0) return false;
	const x = renderer.xr.getController(index).getWorldPosition(new THREE.Vector3()).x;
	stretchSliderDrag = { axis, index, lastX: x };
	hapticPulse(0.2, 20);
	return true;
}
/** while held, horizontal controller motion scales the grabbed axis (infinite slider) */
export function updateStretchSliderDrag() {
	if (!stretchSliderDrag || !stretch) return;
	const cx = renderer.xr.getController(stretchSliderDrag.index).getWorldPosition(new THREE.Vector3()).x;
	const dx = cx - stretchSliderDrag.lastX;
	if (Math.abs(dx) > 0.0004) {
		const axis = stretchSliderDrag.axis;
		setStretch(axis, stretch.factors[axis] * (1 + dx * 4));
		stretchSliderDrag.lastX = cx;
	}
}
export function endStretchSliderDrag() {
	stretchSliderDrag = null;
}
/** the axis currently being slider-dragged, or -1 (193 test hook) */
export function stretchSliderAxis() {
	return stretchSliderDrag ? stretchSliderDrag.axis : -1;
}
