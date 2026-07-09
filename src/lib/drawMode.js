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
// stream the stroke to peers while drawing (temp line, replaced by the mesh)
export const liveStreaming = writable(true);

/** @type {any} */ let scene = null;
/** @type {THREE.Vector3[]} */ let points = [];
/** @type {any} */ let preview = null;
/** @type {string | null} */ let strokeId = null;
let streamedCount = 0;
let lastStreamSent = 0;

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
	if (points.length === 0) {
		strokeId = crypto.randomUUID();
		streamedCount = 0;
	}
	points.push(point);
	updatePreview();
	streamProgress();
}

/** ~15/s: send only the points peers have not seen yet */
function streamProgress(force = false) {
	if (!get(liveStreaming) || !strokeId) return;
	const now = performance.now();
	if (!force && now - lastStreamSent < 66) return;
	if (streamedCount >= points.length) return;
	lastStreamSent = now;
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	peer.send({
		type: 'drawlive',
		id: strokeId,
		color: get(drawColor),
		points: points.slice(streamedCount).map((p) => [p.x, p.y, p.z])
	});
	streamedCount = points.length;
}

// --- receive side: temp lines for strokes peers are drawing right now ---
/** @type {Map<string, {line: any, points: THREE.Vector3[], at: number}>} */
const liveStrokes = new Map();

/** @param {any} data */
export function applyDrawLive(data) {
	if (!scene) return;
	let entry = liveStrokes.get(data.id);
	if (!entry) {
		const line = new THREE.Line(
			new THREE.BufferGeometry(),
			new THREE.LineBasicMaterial({ color: data.color ?? '#ff4000' })
		);
		line.name = 'draw-live';
		scene.add(line);
		entry = { line, points: [], at: 0 };
		liveStrokes.set(data.id, entry);
	}
	(data.points ?? []).forEach((p) => entry.points.push(new THREE.Vector3(p[0], p[1], p[2])));
	entry.at = Date.now();
	entry.line.geometry.dispose();
	entry.line.geometry = new THREE.BufferGeometry().setFromPoints(entry.points);
}

/** @param {any} data */
export function applyDrawEnd(data) {
	const entry = liveStrokes.get(data.id);
	if (!entry) return;
	scene?.remove(entry.line);
	entry.line.geometry.dispose();
	liveStrokes.delete(data.id);
}

// a peer disappearing mid-stroke must not leave its line behind
if (typeof window !== 'undefined') {
	setInterval(() => {
		const cutoff = Date.now() - 5000;
		[...liveStrokes.entries()].forEach(([id, entry]) => {
			if (entry.at < cutoff) applyDrawEnd({ id });
		});
	}, 2500);
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
	if (strokeId) {
		/** @type {any} */
		const peer = get(peers);
		if (peer && get(liveStreaming)) peer.send({ type: 'drawend', id: strokeId });
		strokeId = null;
	}
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
