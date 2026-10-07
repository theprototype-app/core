// 37-slipped (modules DEVX #29): THE POINTER SEAM — a module hears a PRESS, the drag after it
// and the release, and may OWN that gesture.
//
// Core dispatched a module click only on a short STATIONARY release (the editor's select rule,
// play's tap), so a press that moved never reached a module, and until the release the editor's
// OrbitControls orbited the camera under whatever the module was dragging. Untangle worked
// round it with window CAPTURE listeners that self-detach when a newer copy replaces it — a
// workaround every board/puzzle/instrument module would have to copy.
//
// The contract: `down(hit, ctx)` is offered every primary press in the modes the handler asked
// for; returning TRUE claims the gesture — core stands its own use of that press down (orbit,
// select, marquee, play's carry) and routes every move and the release to THAT handler only.
// `move`/`up` get the same `(hit, ctx)`. A handler that returns anything else sees nothing
// more of the gesture. `hit` = `{object, point: [x,y,z], uuid, distance}` for the nearest
// scene or module-content mesh under the pointer (null for the sky); `ctx = {mode, ray,
// clientX, clientY, pointerType}` — `ray` a fresh THREE.Raycaster through the pointer (the
// crosshair under a pointer lock). Callers: Scene.svelte (Edit, Interact) and playInteract.js
// (Play). A LEAF (three + svelte/store + the stores): both callers import it statically.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene } from '../stores/sceneStore';
import { moduleInteractiveGroups } from './sdk/registries.js';

/** @typedef {'edit' | 'interact' | 'play'} PointerMode */
/** @typedef {{down?: Function, move?: Function, up?: Function}} PointerHandler */

/** @type {{handler: PointerHandler, modes: PointerMode[]}[]} registration order */
const entries = [];
/** the handler that owns the gesture in flight @type {null | {handler: PointerHandler, mode: PointerMode}} */
let owner = null;

/**
 * Register a handler (api.registerPointerHandler). `modes` default ['interact', 'play'] —
 * the registerClickHandler default: a game piece is quiet in Edit, where a press selects.
 * @param {PointerHandler} handler @param {{modes?: PointerMode[]}} [opts] @returns {() => void} off
 */
export function registerModulePointer(handler, opts = {}) {
	const modes = Array.isArray(opts.modes) && opts.modes.length ? opts.modes.filter((m) => ['edit', 'interact', 'play'].includes(m)) : ['interact', 'play'];
	const entry = { handler, modes: /** @type {PointerMode[]} */ (modes) };
	entries.push(entry);
	return () => {
		const i = entries.indexOf(entry);
		if (i >= 0) entries.splice(i, 1);
		if (owner?.handler === handler) owner = null;
	};
}

/** Is any handler listening in this mode? (callers skip the raycast when none is) @param {PointerMode} mode */
export function modulePointerWanted(mode) {
	return entries.some((e) => e.modes.includes(mode));
}

/** Does a module own the gesture in flight? */
export function modulePointerOwned() {
	return !!owner;
}

/** the nearest mesh under the ray: scene objects and module content @param {THREE.Raycaster} ray */
function hitOf(ray) {
	/** @type {any[]} */
	const roots = [];
	const group = get(objectsGroup);
	if (group) roots.push(group);
	/** @type {any} */
	const scene = get(globalScene);
	for (const name of moduleInteractiveGroups) {
		const g = scene?.getObjectByName?.(name);
		if (g) roots.push(g);
	}
	let best = null;
	for (const root of roots) {
		for (const h of ray.intersectObject(root, true)) {
			if (!h.object?.visible || !(/** @type {any} */ (h.object).isMesh)) continue;
			if (!best || h.distance < best.distance) best = h;
			break; // sorted: the first visible mesh of each root is its nearest
		}
	}
	if (!best) return null;
	return { object: best.object, point: [best.point.x, best.point.y, best.point.z], uuid: best.object.uuid, distance: best.distance };
}

/** @param {any} handler @param {'down' | 'move' | 'up'} kind @param {any} hit @param {any} ctx */
function call(handler, kind, hit, ctx) {
	try {
		return handler?.[kind]?.(hit, ctx);
	} catch (error) {
		console.warn('module pointer handler failed', error);
		return false;
	}
}

/**
 * A primary press. Offers it to every handler in `mode`, in registration order; the first to
 * return true owns the gesture. @param {PointerMode} mode @param {THREE.Raycaster} ray
 * @param {{clientX?: number, clientY?: number, pointerType?: string}} event @returns {boolean} claimed
 */
export function modulePointerDown(mode, ray, event) {
	owner = null;
	if (!modulePointerWanted(mode)) return false;
	const hit = hitOf(ray);
	const ctx = { mode, ray, clientX: event.clientX ?? 0, clientY: event.clientY ?? 0, pointerType: event.pointerType ?? 'mouse' };
	for (const entry of [...entries]) {
		if (!entry.modes.includes(mode)) continue;
		if (call(entry.handler, 'down', hit, ctx) === true) {
			owner = { handler: entry.handler, mode };
			return true;
		}
	}
	return false;
}

/** The owned gesture moved. @param {THREE.Raycaster} ray @param {any} event @returns {boolean} routed */
export function modulePointerMove(ray, event) {
	if (!owner) return false;
	call(owner.handler, 'move', hitOf(ray), { mode: owner.mode, ray, clientX: event.clientX ?? 0, clientY: event.clientY ?? 0, pointerType: event.pointerType ?? 'mouse' });
	return true;
}

/** The owned gesture ended. @param {THREE.Raycaster} ray @param {any} event @returns {boolean} routed */
export function modulePointerUp(ray, event) {
	if (!owner) return false;
	const { handler, mode } = owner;
	owner = null;
	call(handler, 'up', hitOf(ray), { mode, ray, clientX: event.clientX ?? 0, clientY: event.clientY ?? 0, pointerType: event.pointerType ?? 'mouse' });
	return true;
}

/** suites: how many handlers, and whether one owns a gesture */
export function modulePointerDebug() {
	return { handlers: entries.length, modes: entries.map((e) => [...e.modes]), owned: !!owner };
}

/** a scratch Raycaster for callers that have none @returns {THREE.Raycaster} */
export function freshRay() {
	return new THREE.Raycaster();
}
