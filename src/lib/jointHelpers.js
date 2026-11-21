// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject, selectedObjects } from '../stores/sceneStore';
import { sceneJoints } from './joints';
import { showColliders } from './colliderHelpers';
import { wireframeActive } from './viewMode';
import { helpersHidden } from './helperLayer';
import { jointGizmoSegments } from './jointGizmo';

// 102b row 2: joint gizmos — where each joint holds, which way it turns or slides, and how far it
// may go. The colliderHelpers pattern: ONE LineSegments at the SCENE ROOT (never in objectsGroup, so
// never in a save or on the wire), rebuilt per frame from the objects' CURRENT poses (a few joints,
// a few dozen segments — cheaper than tracking them). LOCAL, no pref of its own: drawn for the joints
// touching the selection, and for every joint while Show colliders is on. Gone in Interact / Play
// (helpersHidden) and in wireframe view, like the collider wireframes.

/** @type {any} */ let lines = null;
let capacity = 0;
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const q = new THREE.Quaternion();

function ensureLines() {
	const scene = get(globalScene);
	if (!scene) return null;
	if (lines && lines.parent === scene) return lines;
	const geometry = new THREE.BufferGeometry();
	const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false });
	lines = new THREE.LineSegments(geometry, material);
	lines.name = 'joint-gizmos';
	lines.renderOrder = 999; // over the objects it explains
	lines.frustumCulled = false;
	lines.userData.__helper = true;
	scene.add(lines);
	capacity = 0;
	return lines;
}

/** The joints to draw this frame. @returns {any[]} */
function shownJoints() {
	const list = get(sceneJoints);
	if (!list.length) return list;
	if (get(showColliders)) return list;
	const picked = new Set(/** @type {string[]} */ (get(selectedObjects) ?? []));
	const primary = /** @type {any} */ (get(selectedObject));
	if (primary?.uuid) picked.add(primary.uuid);
	if (!picked.size) return [];
	return list.filter((j) => picked.has(j.a) || picked.has(j.b));
}

/** Per frame from Scene's useTask. */
export function updateJointHelpers() {
	const joints = shownJoints();
	if (!joints.length || helpersHidden() || wireframeActive()) {
		if (lines) lines.visible = false;
		return;
	}
	const group = get(objectsGroup);
	const target = ensureLines();
	if (!group || !target) return;
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const col = [];
	for (const def of joints) {
		const objA = group.getObjectByProperty('uuid', def.a);
		const objB = group.getObjectByProperty('uuid', def.b);
		if (!objA || !objB) continue;
		objA.updateWorldMatrix(true, false);
		objB.updateWorldMatrix(true, false);
		objA.localToWorld(a.fromArray(def.anchorA));
		objB.localToWorld(b.fromArray(def.anchorB));
		objA.getWorldQuaternion(q);
		jointGizmoSegments(def, a.toArray(), b.toArray(), [q.x, q.y, q.z, q.w], pos, col);
	}
	const count = pos.length / 3;
	const geometry = target.geometry;
	if (count > capacity) {
		capacity = Math.max(64, count * 2);
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
	}
	geometry.attributes.position.array.set(pos);
	geometry.attributes.color.array.set(col);
	geometry.attributes.position.needsUpdate = true;
	geometry.attributes.color.needsUpdate = true;
	geometry.setDrawRange(0, count);
	target.visible = count > 0;
}

/** test/debug view: how many joints and segments are drawn, and whether the gizmo shows. */
export function jointHelpersDebug() {
	return {
		joints: shownJoints().length,
		segments: lines ? (lines.geometry.drawRange.count === Infinity ? 0 : lines.geometry.drawRange.count / 2) : 0,
		visible: !!lines?.visible
	};
}
