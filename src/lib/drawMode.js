import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordObjectPresence } from './history';

// Drawing mode: freehand 3D strokes on surfaces (desktop drag) or in the air
// (VR trigger). While drawing, thinned points feed a local-only preview line;
// on release the points become a CatmullRom TubeGeometry mesh added to
// objectsGroup — from there the EXISTING object pipeline makes it selectable,
// movable, undoable, autosaved and replicated (one toJSON message per stroke).

export const drawMode = writable(false);
export const drawColor = writable('#ff4000');
export const drawSize = writable(0.04);

/** @type {any} */ let scene = null;
/** @type {THREE.Vector3[]} */ let points = [];
/** @type {any} */ let preview = null;

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

/** @param {any} s */
export function setDrawScene(s) {
	scene = s;
}

export function toggleDrawMode() {
	drawMode.update((on) => {
		if (on) endStroke();
		else showToast('Draw mode: drag on surfaces to draw (VR: hold the trigger). Esc or Done to finish.');
		return !on;
	});
}

/** Surface under the pointer: objects first, ground plane as canvas fallback @param {any} raycaster */
export function strokePointFromRay(raycaster) {
	const group = get(objectsGroup);
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	const size = get(drawSize);
	if (hits[0]) {
		const hit = hits[0];
		const normal = hit.face
			? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
			: new THREE.Vector3(0, 1, 0);
		addStrokePoint(hit.point.clone().addScaledVector(normal, size * 1.2));
		return;
	}
	if (raycaster.ray.intersectPlane(groundPlane, planeHit))
		addStrokePoint(planeHit.clone().setY(planeHit.y + size));
}

/** Append a world-space point (thinned) — VR feeds controller tips here @param {THREE.Vector3 | null} point */
export function addStrokePoint(point) {
	if (!point) return;
	const last = points[points.length - 1];
	if (last && last.distanceTo(point) < get(drawSize) * 1.5) return;
	points.push(point);
	updatePreview();
}

function updatePreview() {
	if (!scene) return;
	if (!preview) {
		preview = new THREE.Line(
			new THREE.BufferGeometry(),
			new THREE.LineBasicMaterial({ color: get(drawColor) })
		);
		preview.name = 'draw-preview';
		scene.add(preview);
	}
	preview.geometry.dispose();
	preview.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

export function isDrawing() {
	return points.length > 0;
}

/** Finish the stroke: tube mesh into objectsGroup + replicate + undo entry */
export function endStroke() {
	const stroke = points;
	points = [];
	if (preview) {
		scene?.remove(preview);
		preview.geometry.dispose();
		preview = null;
	}
	if (stroke.length < 2) return;

	const size = get(drawSize);
	const curve = new THREE.CatmullRomCurve3(stroke);
	const geometry = new THREE.TubeGeometry(
		curve,
		Math.min(Math.max(stroke.length * 4, 8), 240),
		size,
		6,
		false
	);
	const mesh = new THREE.Mesh(
		geometry,
		new THREE.MeshBasicMaterial({ color: get(drawColor) })
	);
	mesh.name = 'Stroke';

	const group = get(objectsGroup);
	if (!group) return;
	group.add(mesh);
	objectsGroup.update((value) => value);
	recordObjectPresence('create', mesh);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: mesh.toJSON() });
}
