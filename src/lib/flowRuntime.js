import * as THREE from 'three';
import { flowNodes, flowEdges, mutedFlowObjects, syncedAnimations } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { animationTypes } from './nodeCatalog';
import { moduleEffects, moduleFrameTasks } from './moduleSDK';
import { runScript } from './scriptRuntime';
import { findNodeDef } from './customNodes';

// Runs the node graph: applies colorpicker->objectselector colors on graph changes
// and drives animation/effect nodes with a requestAnimationFrame loop.
// Lives outside the Flow drawer so animations keep running when it is closed.

let started = false;

/** @type {any[]} */ let nodes = [];
/** @type {any[]} */ let edges = [];
/** @type {any} */ let sceneObjects = null;
/** @type {string[]} */ let muted = [];
let synced = true;

// objectUuid -> captured base transform, restored when its animations are removed
const baseState = new Map();
// animated objects whose animation is paused while the user drags them
const suspended = new Set();

/** @param {any} object */
function captureBase(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray(),
		visible: object.visible
	};
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.visible = base.visible;
}

// Resolve which scene object a node graph edge targets:
// animation/color source -> objectselector node with a selected scene object
/** @param {any} edge */
function targetUuidOf(edge) {
	const target = nodes.find((n) => n.id === edge.target);
	if (target?.type !== 'objectselector') return null;
	const selected = target.data?.selected;
	if (!selected || selected === '-None-') return null;
	// per-object mute from the object list context menu
	if (muted.includes(selected)) return null;
	return selected;
}

function applyColors() {
	if (!sceneObjects) return;
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source) return;
		const uuid = targetUuidOf(edge);
		if (!uuid) return;
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) return;

		if (source.type === 'colorpicker' && source.data?.color) {
			if (object.material?.color) object.material.color.set(source.data.color);
		} else if (source.type === 'slider') {
			// slider scales its target (20 = neutral 1.0); animated targets scale via their base
			const factor = Math.min(Math.max((source.data?.value ?? 20) / 20, 0.05), 5);
			const base = baseState.get(uuid);
			if (base) base.scale = [factor, factor, factor];
			else object.scale.set(factor, factor, factor);
		} else if (source.type === 'switcher' && object.geometry) {
			const shape = source.data?.shape ?? 'cube';
			if (object.userData.switcherShape !== shape) {
				object.userData.switcherShape = shape;
				object.geometry.dispose();
				object.geometry =
					shape === 'pyramid' ? new THREE.ConeGeometry(1.4, 2, 4) : new THREE.BoxGeometry(2, 2, 2);
			}
		}
	});
}

/** Do the edges currently animate this object? @param {string} uuid */
export function isAnimatedTarget(uuid) {
	return baseState.has(uuid);
}

/**
 * Pause the animation of an object while the user drags it: the object is
 * put back at its logical base so the gizmo edits the base transform.
 * @param {string} uuid
 */
export function suspendAnimation(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) restoreBase(object, baseState.get(uuid));
	suspended.add(uuid);
}

/** Resume after a drag: the object's current transform becomes the new base @param {string} uuid */
export function resumeAnimation(uuid) {
	if (!suspended.has(uuid)) return;
	suspended.delete(uuid);
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object && baseState.has(uuid)) baseState.set(uuid, captureBase(object));
}

/**
 * An external move (remote peer, undo, align-to-ground) just wrote the intended
 * transform directly to the object — adopt it as the new animation base instead
 * of overwriting it on the next tick.
 * @param {string} uuid
 */
export function notifyExternalMove(uuid) {
	if (!baseState.has(uuid) || suspended.has(uuid)) return;
	const object = sceneObjects?.getObjectByProperty('uuid', uuid);
	if (object) baseState.set(uuid, captureBase(object));
}

/** @param {any} object @param {any} base @param {any} anim @param {number} time */
function applyAnimation(object, base, anim, time) {
	const data = anim.data || {};
	if (anim.type === 'script') {
		runScript(anim.id, data.code ?? '', object, base, data, time);
		return;
	}
	if (anim.type === 'customnode') {
		const def = findNodeDef(data.defId);
		if (def) runScript(anim.id, def.code ?? '', object, base, data, time);
		return;
	}
	if (moduleEffects[anim.type]) {
		try {
			moduleEffects[anim.type](object, base, data, time);
		} catch (error) {
			console.log('module effect ' + anim.type + ' failed', error);
		}
		return;
	}
	if (anim.type === 'shake') {
		const intensity = data.intensity ?? 0.2;
		const speed = data.speed ?? 10;
		// deterministic jitter from overlapping sine waves
		object.position.x += Math.sin(time * speed * 7.1) * intensity * 0.3;
		object.position.y += Math.sin(time * speed * 8.9 + 1.3) * intensity * 0.3;
		object.position.z += Math.sin(time * speed * 6.3 + 2.7) * intensity * 0.3;
	} else if (anim.type === 'spin') {
		const axis = data.axis ?? 'y';
		const speed = data.speed ?? 1;
		object.rotation[axis] += time * speed;
	} else if (anim.type === 'bounce') {
		const amplitude = data.amplitude ?? 0.5;
		const speed = data.speed ?? 2;
		object.position.y += Math.abs(Math.sin(time * speed)) * amplitude;
	} else if (anim.type === 'orbit') {
		const radius = data.radius ?? 1;
		const speed = data.speed ?? 1;
		object.position.x += Math.cos(time * speed) * radius;
		object.position.z += Math.sin(time * speed) * radius;
	} else if (anim.type === 'pulse') {
		const amount = data.amount ?? 0.2;
		const speed = data.speed ?? 2;
		const factor = 1 + Math.sin(time * speed) * amount;
		object.scale.set(base.scale[0] * factor, base.scale[1] * factor, base.scale[2] * factor);
	} else if (anim.type === 'blink') {
		const speed = data.speed ?? 2;
		object.visible = Math.sin(time * speed * Math.PI) > 0;
	}
}

/** @param {number} now */
function tick(now) {
	// wall clock (wrapped daily to keep float noise low) -> same phase on every peer
	const time = synced ? (Date.now() % 86400000) / 1000 : now / 1000;

	// collect active animations per scene object
	const active = new Map(); // uuid -> anim nodes
	if (sceneObjects) {
		edges.forEach((edge) => {
			const source = nodes.find((n) => n.id === edge.source);
			if (
				!source ||
				(!animationTypes.includes(source.type) &&
					!moduleEffects[source.type] &&
					source.type !== 'script' &&
					source.type !== 'customnode')
			)
				return;
			const uuid = targetUuidOf(edge);
			if (!uuid) return;
			if (!active.has(uuid)) active.set(uuid, []);
			active.get(uuid).push(source);
		});
	}

	// restore objects whose animations were disconnected/deleted
	baseState.forEach((base, uuid) => {
		if (!active.has(uuid)) {
			const object = sceneObjects?.getObjectByProperty('uuid', uuid);
			if (object) restoreBase(object, base);
			baseState.delete(uuid);
		}
	});

	active.forEach((anims, uuid) => {
		if (suspended.has(uuid)) return; // user is dragging it — leave it alone
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (!object) {
			baseState.delete(uuid);
			return;
		}
		if (!baseState.has(uuid)) baseState.set(uuid, captureBase(object));
		const base = baseState.get(uuid);
		// reset to base, then let each animation add its offset
		restoreBase(object, base);
		anims.forEach((anim) => applyAnimation(object, base, anim, time));
	});

	moduleFrameTasks.forEach((task) => {
		try {
			task(time);
		} catch (error) {
			console.log('module frame task failed', error);
		}
	});

	requestAnimationFrame(tick);
}

export function startFlowRuntime() {
	if (started || typeof window === 'undefined') return;
	started = true;

	flowNodes.subscribe((value) => {
		nodes = value;
		applyColors();
	});
	flowEdges.subscribe((value) => {
		edges = value;
		applyColors();
	});
	objectsGroup.subscribe((value) => {
		sceneObjects = value;
	});
	mutedFlowObjects.subscribe((value) => {
		muted = value;
		applyColors();
	});
	syncedAnimations.subscribe((value) => {
		synced = value;
		if (typeof localStorage !== 'undefined') localStorage.setItem('syncedAnimations', String(value));
	});

	requestAnimationFrame(tick);
}
