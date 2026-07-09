import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { flowNodes } from '../stores/flowStore';
import { setNodeData } from './nodesHandler';
import { showToast } from '../stores/appStore';

// Waypoint capture for the Path patrol node: while a node is "capturing",
// viewport clicks append world points to its data.points (replicated via the
// normal nodedata message, like every other node edit).

/** @type {import('svelte/store').Writable<string | null>} node id capturing clicks */
export const pathCaptureNode = writable(null);

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

/** @param {string | null} nodeId */
export function togglePathCapture(nodeId) {
	pathCaptureNode.update((current) => {
		const next = current === nodeId ? null : nodeId;
		if (next) showToast('Click in the viewport to add waypoints — toggle Capture off when done');
		return next;
	});
}

/**
 * Route a viewport click into the capturing node. Returns true when consumed.
 * @param {any} raycaster
 */
export function capturePathClick(raycaster) {
	const nodeId = get(pathCaptureNode);
	if (!nodeId) return false;
	const node = get(flowNodes).find((n) => n.id === nodeId);
	if (!node) {
		pathCaptureNode.set(null);
		return false;
	}
	const group = get(objectsGroup);
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	const point =
		hits[0]?.point ??
		(raycaster.ray.intersectPlane(groundPlane, planeHit) ? planeHit : null);
	if (point)
		setNodeData(nodeId, {
			points: [...(node.data.points ?? []), [point.x, point.y, point.z]]
		});
	return true;
}
