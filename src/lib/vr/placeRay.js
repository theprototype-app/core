// VR controls — 52-browser: THE DRAG-TO-PLACE GHOST ON THE LASER (absorbs follow-up f-vr-place).
// The desktop's drag-to-place (placeDrag.js, 39) with the pointer hand's ray instead of the mouse: the
// same ghost tiers (box first, the real model when it is decoded and under the budget), the same
// surface rest + grid snap + overlap colours, the same ONE-undo replicated spawn (explorerDrop
// .placeFromGhost). This file is only the VR glue; the layout lives in placeDrag's RAY mode, in the
// objectsGroup's frame — so it works unchanged while the world rig is moved or shrunk (miniature).
//
// THE GESTURE, one model for a controller and a tracked hand (pinch = trigger):
//   · pick an item (a wrist Asset Browser card, a prefab tile)      -> the ghost rides the laser
//   · trigger-DRAG out of the panel and let go over the world        -> placed there (once)
//   · let go still on the panel (a click)                            -> armed: the next trigger places,
//                                                                       and stays armed for the next one
//   · the pointer hand's stick sideways                              -> turn 15° per flick
//   · either grip                                                    -> cancel (nothing spawns, no undo)
//   · the laser on a panel                                           -> no ghost; a trigger there is the
//                                                                       panel's, never a placement
//
// Rides the K1 hook registries (frame / trigger / grip / stick owner), registered on first use (the
// dollhouse pattern) and left in place — every hook is a no-op while nothing is being placed.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { renderer } from './core.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { pointerHand } from './bindings.js';
import { hapticPulse } from './haptics.js';
import { beamTarget, withRayCamera } from './pointer.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerGripHooks, registerStickOwner } from './hooks.js';
import { beginRayPlace, updateRayPlace, commitRayPlace, cancelPlaceDrag, rotateBy, rayPlaceActive, rayPlace, placeRotation } from '../placeDrag';

export { rayPlace };

/** a stick deflection past this is a flick; it re-arms back under STICK_REARM */
const STICK_FLICK = 0.6;
const STICK_REARM = 0.3;

/**
 * The running VR placement, or null: what was picked (so a placement can re-arm), which hand's laser
 * carries it, and whether its trigger is still held from the pick (a drag).
 * @type {null | {payload: any, hand: 'left' | 'right', dragging: boolean, repeat: boolean, onEnd: ((why: string) => void) | null,
 *   placed: number, stickArmed: boolean}}
 */
let current = null;
/** published for panels / suites: {label, hand, armed} or null @type {import('svelte/store').Writable<any>} */
export const vrPlacing = writable(null);
/** the laser this module hands placeDrag (it HOLDS the ray, so it is ours alone) */
const ray = new THREE.Raycaster();
let hooked = false;
/** a press this module took: its 'select' is ours (a FLAG for the press, cleared on its selectend — a
 * time window lost to a slow frame and placed twice). The stamp only retires a flag no end came for. */
let swallowNext = false;
let swallowSetAt = 0;
function claimSelect() {
	swallowNext = true;
	swallowSetAt = Date.now();
}
/**
 * Is controller slot `index`'s 'select' the placement's? Its press's flag, or — whatever the runtime's event
 * order (IWER fires select BEFORE selectstart) — the placing hand's select while its laser is off the panels:
 * the trigger hook is what places, so that select must not also select or place.
 * @param {number} index
 */
function swallowSelect(index) {
	if (swallowNext && Date.now() - swallowSetAt < 5000) return true;
	if (!current || index < 0 || index !== placingSlot()) return false;
	const laser = laserOf(current.hand);
	return !!laser && !beamTarget(laser).panel;
}
/** the suites' view */
const debug = { placed: 0, cancelled: 0, rotations: 0, onPanelFrames: 0, lastEnd: /** @type {string | null} */ (null), frames: 0, frameMs: 0 };

/** the laser of `hand` as a world raycaster, or null (not tracked) @param {'left' | 'right'} hand */
function laserOf(hand) {
	const index = controllerIndexFor(hand);
	if (index < 0) return null;
	const controller = renderer?.xr?.getController(index);
	if (!controller) return null;
	controller.updateWorldMatrix(true, false);
	const m = new THREE.Matrix4().extractRotation(controller.matrixWorld);
	ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	ray.ray.direction.set(0, 0, -1).applyMatrix4(m).normalize();
	ray.far = Infinity;
	return withRayCamera(ray);
}

let publishedSig = '';
function publish() {
	const next = current ? { label: get(rayPlace)?.label ?? '', hand: current.hand, armed: !current.dragging } : null;
	const sig = next ? next.label + '|' + next.hand + '|' + next.armed : '';
	if (sig === publishedSig) return;
	publishedSig = sig;
	vrPlacing.set(next);
}

/**
 * Pick something up onto the laser. `payload` is Explorer-shaped ({url, name} a pack item, {id, name}
 * a Library item, {prefabId, name} a prefab). `dragging`: the trigger that picked it is still down —
 * its release over the world places (a drag); released on the panel it stays armed (a click).
 * @param {any} payload
 * @param {{hand?: 'left' | 'right', dragging?: boolean, repeat?: boolean, onEnd?: (why: string) => void}} [opts]
 * @returns {boolean}
 */
export function beginVRPlace(payload, opts = {}) {
	if (!payload) return false;
	ensureHooks();
	const prevEnd = current?.onEnd;
	current = null;
	if (rayPlaceActive()) cancelPlaceDrag('restart');
	prevEnd?.('restart');
	const hand = opts.hand ?? pointerHand();
	if (!beginRayPlace({ payload, hand })) return false;
	current = { payload, hand, dragging: !!opts.dragging, repeat: opts.repeat !== false, onEnd: opts.onEnd ?? null, placed: 0, stickArmed: true };
	hapticPulse(0.2, 25, hand);
	frame();
	publish();
	return true;
}

/** Drop the ghost: nothing spawns, nothing enters the undo stack. @param {string} [why] */
export function cancelVRPlace(why = 'cancel') {
	if (!current) return;
	const end = current.onEnd;
	current = null;
	cancelPlaceDrag(why);
	debug.cancelled++;
	debug.lastEnd = why;
	publish();
	end?.(why);
}

/** Is a VR placement running? */
export function vrPlaceActive() {
	return !!current && rayPlaceActive();
}

/**
 * Place at the ghost (the trigger / the drag release). A click placement re-arms the same item; a
 * drag (`opts.drop`) places once. Returns true when something spawned.
 * @param {{drop?: boolean}} [opts]
 */
export function placeVRNow(opts = {}) {
	if (!current || !rayPlaceActive()) return false;
	const host = current;
	const rotation = placeRotation();
	const ok = commitRayPlace();
	if (!ok) {
		// no spot (the laser on the sky, off the world): the gesture stays as it was
		if (!rayPlaceActive()) beginRayPlace({ payload: host.payload, hand: host.hand, rotation });
		hapticPulse(0.15, 20, host.hand);
		return false;
	}
	debug.placed++;
	host.placed++;
	hapticPulse(0.35, 40, host.hand);
	if (host.repeat && !opts.drop) {
		// stay armed, turned as before: the next trigger places another
		beginRayPlace({ payload: host.payload, hand: host.hand, rotation });
		current = host;
		frame();
		publish();
		return true;
	}
	current = null;
	debug.lastEnd = 'placed';
	publish();
	host.onEnd?.('placed');
	return true;
}

/** the slot index of the placing hand, or -1 */
function placingSlot() {
	return current ? controllerIndexFor(current.hand) : -1;
}

/** One frame: the ghost follows the placing hand's laser; on a panel there is no ghost. */
function frame() {
	if (!current) return;
	const t0 = performance.now();
	frameBody();
	debug.frames++;
	debug.frameMs += performance.now() - t0;
}

function frameBody() {
	if (!current) return;
	if (!rayPlaceActive()) {
		// placeDrag ended underneath us (a scene clear, another drag): let go too
		const end = current.onEnd;
		current = null;
		publish();
		end?.('ended');
		return;
	}
	if (!renderer?.xr?.isPresenting) return;
	const laser = laserOf(current.hand);
	if (!laser) return;
	if (beamTarget(laser).panel) {
		debug.onPanelFrames++;
		updateRayPlace(null);
	} else updateRayPlace(laser);
	// the stick turns the ghost, a flick per 15°
	const axes = axesForSlot(placingSlot());
	const x = axes[2] ?? 0;
	if (current.stickArmed && Math.abs(x) > STICK_FLICK) {
		current.stickArmed = false;
		rotateBy(x > 0 ? -1 : 1); // right turns clockwise seen from above
		debug.rotations++;
		hapticPulse(0.12, 15, current.hand);
	} else if (!current.stickArmed && Math.abs(x) < STICK_REARM) current.stickArmed = true;
	publish();
}

/** @param {number} index */
function onTrigger(index) {
	if (!current || index !== placingSlot()) return false;
	const laser = laserOf(current.hand);
	// a trigger on a panel belongs to the panel (re-pick a card, press a button)
	if (laser && beamTarget(laser).panel) return false;
	claimSelect();
	placeVRNow();
	return true;
}

/** @param {number} index */
function onTriggerEnd(index) {
	// the press is over: its flag is spent (a headset's select came just before this)
	swallowNext = false;
	if (!current?.dragging || index !== placingSlot()) return false;
	current.dragging = false;
	const laser = laserOf(current.hand);
	// let go over the world = the drag's drop; still on the panel = a click, stay armed
	if (laser && !beamTarget(laser).panel) {
		claimSelect();
		placeVRNow({ drop: true });
		return true;
	}
	publish();
	return false;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	registerVRFrameHook(frame);
	registerVRTriggerHooks({
		start: onTrigger,
		end: onTriggerEnd,
		swallow: swallowSelect
	});
	// either grip cancels — before anything grabs
	registerGripHooks({
		start: () => {
			if (!current) return false;
			cancelVRPlace('grip');
			return true;
		}
	});
	// the placing hand's stick turns the ghost: its turn / teleport stand down meanwhile
	registerStickOwner(() => (current ? current.hand : null));
}

/** the suites' view */
export function vrPlaceDebug() {
	return { active: vrPlaceActive(), current: current ? { hand: current.hand, dragging: current.dragging, repeat: current.repeat, placed: current.placed } : null, ...debug };
}
