import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, isLocked } from '../stores/sceneStore';
import { findNodeAnyGraph, flowGraphs, activeGraphId, SCENE_GRAPH } from '../stores/flowStore';
import { setNodeData } from './nodesHandler';
import { showToast } from '../stores/appStore';
import { scopeOfEvent } from './keyScope';
import { pathCaptureNode } from './pathCaptureState';

// Waypoint capture for the Path patrol node: while a node is "capturing",
// viewport clicks append world points to its data.points (replicated via the
// normal nodedata message, like every other node edit).
//
// fix-batch-2 (the capture trap): capture used to end ONLY through the card's own
// toggle, so deselecting the object (which swaps the editor to the scene graph and
// hides the card) left every later viewport click silently appending an invisible
// point. Capture is now a SESSION with exits: deselect / another selection, the
// editor showing another graph, Esc, a click on the node-editor pane or another
// card, the node deleted or muted, Play — and a click on the patrolling object
// itself ends it and selects that object.

export { pathCaptureNode };

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

/** @type {(() => void)[]} the running session's watchers */
let watchers = [];

/** @param {string | null} nodeId */
export function togglePathCapture(nodeId) {
	if (nodeId && get(pathCaptureNode) !== nodeId) startPathCapture(nodeId);
	else endPathCapture();
}

/** @param {string} nodeId */
export function startPathCapture(nodeId) {
	endPathCapture();
	const found = findNodeAnyGraph((n) => n.id === nodeId);
	if (!found) return;
	pathCaptureNode.set(nodeId);
	const { graphId } = found;
	const selectionKey = (/** @type {any} */ set) => (Array.isArray(set) ? set.join(',') : '');
	const startSelection = selectionKey(get(selectedObjects));
	const startGraph = get(activeGraphId);
	watchers = [
		selectedObjects.subscribe((set) => {
			if (selectionKey(set) !== startSelection) endPathCapture();
		}),
		activeGraphId.subscribe((id) => {
			if (id !== startGraph && id !== graphId) endPathCapture();
		}),
		flowGraphs.subscribe((graphs) => {
			const node = graphs?.[graphId]?.nodes?.find((/** @type {any} */ n) => n.id === nodeId);
			if (!node || node.data?.muted === true) endPathCapture();
		}),
		isLocked.subscribe((locked) => {
			if (locked === true) endPathCapture();
		})
	];
	if (typeof window !== 'undefined') {
		window.addEventListener('keydown', onKeydown, true);
		watchers.push(() => window.removeEventListener('keydown', onKeydown, true));
	}
	// a subscriber may already have ended the session on its first (synchronous) call
	if (get(pathCaptureNode) === nodeId)
		showToast('Placing waypoints — click the scene to add points · Esc or Done to finish');
}

export function endPathCapture() {
	const list = watchers;
	watchers = [];
	list.forEach((stop) => stop());
	if (get(pathCaptureNode) !== null) pathCaptureNode.set(null);
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key !== 'Escape') return;
	const scope = scopeOfEvent(event);
	if (scope === 'text' || scope === 'code') return; // Esc in a field is the field's
	endPathCapture();
}

/**
 * The objects a path node moves: its wired Object Selectors, else (inside an object's
 * own graph) the graph's owner — flowRuntime's implicit-owner rule.
 * @param {any} node @param {string} graphId @returns {Set<string>}
 */
export function patrolTargets(node, graphId) {
	const graph = get(flowGraphs)?.[graphId];
	const out = new Set();
	let wired = false;
	for (const edge of graph?.edges ?? []) {
		if (edge.source !== node.id) continue;
		const target = graph.nodes.find((/** @type {any} */ n) => n.id === edge.target);
		if (target?.type !== 'objectselector') continue;
		wired = true;
		const uuid = target.data?.selected;
		if (uuid && uuid !== '-None-') out.add(uuid);
	}
	if (!wired && graphId !== SCENE_GRAPH) out.add(graphId);
	return out;
}

/**
 * Would this hit select the patrolling object or one of its ancestors? True when the
 * hit's parent chain holds a target, or the top-level object the click selects
 * contains one.
 * @param {any} hitObject @param {Set<string>} targets @param {any} group
 */
function hitsPatroller(hitObject, targets, group) {
	if (!targets.size) return false;
	let top = hitObject;
	for (let o = hitObject; o && o !== group; o = o.parent) {
		if (targets.has(o.uuid)) return true;
		top = o;
	}
	let inside = false;
	top?.traverse?.((/** @type {any} */ o) => {
		if (targets.has(o.uuid)) inside = true;
	});
	return inside;
}

/**
 * Route a viewport click into the capturing node. Returns true ONLY when the click
 * was used (a point added, or a press on one of the node's own markers); anything
 * else falls through to the normal selection path.
 * @param {any} raycaster
 */
export function capturePathClick(raycaster) {
	const nodeId = get(pathCaptureNode);
	if (!nodeId) return false;
	// H1: the capturing path node can live in any graph document
	const found = findNodeAnyGraph((n) => n.id === nodeId);
	if (!found) {
		endPathCapture();
		return false;
	}
	const { node, graphId } = found;
	const group = get(objectsGroup);
	// clicks on existing waypoint markers are drags/removals, not new points
	const markers = group?.parent?.getObjectByName('path-waypoints');
	if (
		markers &&
		raycaster.intersectObject(markers, true).some((/** @type {any} */ h) => h.object.userData.wpIndex != null)
	)
		return true;
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	// a click on the patrolling object itself ends capture and selects it
	if (hits[0] && hitsPatroller(hits[0].object, patrolTargets(node, graphId), group)) {
		endPathCapture();
		return false;
	}
	const point =
		hits[0]?.point ??
		(raycaster.ray.intersectPlane(groundPlane, planeHit) ? planeHit : null);
	if (!point) return false;
	setNodeData(
		nodeId,
		{ points: [...(node.data.points ?? []), [point.x, point.y, point.z]] },
		graphId
	);
	return true;
}
