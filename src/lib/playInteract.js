import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { isLocked, isVRMode, objectsGroup, globalScene, lockedObjects } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { sceneHits } from './scenePick';
import { topLevelObjectOf } from './objectActions';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import {
	holdBody,
	releaseBody,
	listPhysicsObjects,
	simulating,
	remoteSimulating,
	isInitiator
} from './physics';
import { suspendAnimation, resumeAnimation, fireObjectClick } from './flowRuntime';
import { velocityFromSamples } from './throwVelocity';
import { resolvePlaySettings } from './playSettings';
import { nameOf } from './lockControl';
import { moduleClickHandlers, moduleInteractiveGroups } from './moduleSDK';

// 21-B B3: play mode becomes INTERACT mode — a crosshair grab at distance,
// scroll to push and pull, and a release that throws with the velocity you
// actually moved the object at.
//
// This is a NEW leaf rather than a lift of Scene.svelte's pick, and the
// `$isLocked` bails there stay exactly as they are:
//
//  - the editor's select branch is explicitly a SHORT STATIONARY CLICK (it
//    returns on moved > 5px or elapsed > 400ms) — the precise gesture a grab
//    discards. There is nothing in it to reuse.
//  - those same bails guard draw, sculpt, marquee, the snap-anchor pick, the
//    mesh-pivot pick and the vertex/face handle picks. Lifting isLocked would
//    put six editor modes onto the play-mode input path.
//  - play mode's ray is NDC (0,0) EVERY FRAME, not event.clientX/Y: under
//    pointer lock the cursor is pinned to the centre and the gizmo hover guard
//    does not even mean anything.
//
// The hold is a SMOOTHED KINEMATIC TARGET, not a rigid follow and not a rapier
// joint. The existing pipeline is already the other half of that spring:
// kinematicTargetOf turns the object transform into a body pose and step()
// SLERPs it across the substeps, so rapier derives a continuous velocity from
// it. Smoothing the TARGET therefore costs no new rapier surface and gives the
// heavy-crate-lags-the-cursor feel for free, mass-aware. A rigid follow would
// make the derived velocity a raw derivative of mouse motion, so one fast flick
// produces a single-frame spike that the 20 m/s clamp truncates arbitrarily —
// i.e. how hard you throw stops correlating with how hard you flicked.

const REACH = 6; // m: how far the crosshair can start a grab
const CARRY_DEFAULT = 2.5; // m
const CARRY_MIN = 0.8;
const CARRY_MAX = 6;
const CARRY_STEP = 0.25;
const SPRING_K = 14; // 1/s, scaled by 1/sqrt(mass) and clamped
const SPRING_K_MIN = 4;
const SPRING_K_MAX = 20;
const TAP_MS = 180;
const MOVE_HZ = 20; // carry broadcasts (the car module's cadence; the floor is
// 8 Hz, because EXTERNAL_HOLD_MS is 250)

/** what the reticle renders from: aim + carry state, LOCAL and never on the wire */
export const playInteractState = writable({
	/** @type {'off'|'idle'|'aiming'|'carrying'} */
	mode: 'off',
	distance: CARRY_DEFAULT,
	/** @type {string|null} */ uuid: null,
	/** @type {string|null} */ blocked: null
});

const raycaster = new THREE.Raycaster();
const centre = new THREE.Vector2(0, 0);
const camPos = new THREE.Vector3();
const camDir = new THREE.Vector3();
const targetPos = new THREE.Vector3();
const yawQuat = new THREE.Quaternion();
const desiredQuat = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** @type {{object: any, relQuat: THREE.Quaternion, mass: number, held: boolean,
 *   samples: {t: number, pos: THREE.Vector3, quat: THREE.Quaternion}[], lastSent: number}|null} */
let grab = null;
let carryDistance = CARRY_DEFAULT;
/** @type {{t: number, uuid: string|null, hit: any}|null} */ let press = null;
let started = false;
/** @type {((object: any) => boolean)|null} */ let moduleHitTest = null;
/** @type {any} */ let activeCamera = null;

/** the scene's effective interaction mode right now */
function interactionMode() {
	if (!get(isLocked) || get(isVRMode)) return 'off';
	return resolvePlaySettings(get(globalScene)).interaction;
}

function simRunning() {
	return !!get(simulating) || !!get(remoteSimulating);
}

/** uuids that get a DYNAMIC body at sim start — scenery and static level
 * geometry can never be dragged, which is what makes 'grab' safe as a default */
function dynamicUuids() {
	/** @type {Set<string>} */
	const set = new Set();
	for (const row of listPhysicsObjects()) if (row.mode === 'dynamic') set.add(row.uuid);
	return set;
}

/** @param {any} camera */
function aimFrom(camera) {
	camera.getWorldPosition(camPos);
	camera.getWorldDirection(camDir);
	raycaster.setFromCamera(centre, camera);
	return sceneHits(raycaster, {}); // no tinyProxies: a proxy carries no `face`
	// and is a SELECTION affordance — grabbing an invisible speck is not a feature
}

/** module scene-root content is picked for TAPS ONLY, never grabs: it lives
 * outside objectsGroup, has no physics body, and moving it would not replicate.
 * @returns {boolean} whether a module consumed the tap */
function moduleTap() {
	const scene = get(globalScene);
	if (!scene || !moduleHitTest) return false;
	for (const name of moduleInteractiveGroups) {
		const root = scene.getObjectByName(name);
		if (!root) continue;
		const hits = raycaster.intersectObject(root, true);
		if (hits.length > 0 && moduleHitTest(hits[0].object)) return true;
	}
	return false;
}

/** @param {any} object */
function massOf(object) {
	const mass = object?.userData?.physics?.mass;
	return typeof mass === 'number' && mass > 0 ? mass : 1;
}

/** Begin carrying. @param {any} object @param {any} camera */
function beginGrab(object, camera) {
	// the object's rotation relative to the camera's YAW, so carrying does not
	// tip the object when you look up or down
	euler.setFromQuaternion(camera.getWorldQuaternion(desiredQuat), 'YXZ');
	yawQuat.setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
	grab = {
		object,
		relQuat: yawQuat.clone().invert().multiply(object.quaternion.clone()),
		mass: massOf(object),
		held: isInitiator() ? holdBody(object.uuid) : false,
		samples: [],
		lastSent: 0
	};
	carryDistance = Math.min(
		CARRY_MAX,
		Math.max(CARRY_MIN, camPos.distanceTo(object.getWorldPosition(targetPos)))
	);
	suspendAnimation(object.uuid);
	playInteractState.set({ mode: 'carrying', distance: carryDistance, uuid: object.uuid, blocked: null });
}

/**
 * Stop carrying. `throwIt` false is a CANCEL — mode ended, sim stopped, the
 * object was deleted, interaction turned off — and a cancel is never a throw:
 * it releases with ZERO velocity, because the alternative is a body left
 * kinematic forever.
 * @param {boolean} throwIt
 */
export function endGrab(throwIt) {
	if (!grab) return null;
	const { object, samples, held } = grab;
	const velocity = throwIt ? velocityFromSamples(samples) : { linvel: [0, 0, 0], angvel: [0, 0, 0] };
	grab = null;
	resumeAnimation(object.uuid);
	if (held) releaseBody(object.uuid, velocity);
	else sendThrow(object, velocity, throwIt);
	playInteractState.update((s) => ({ ...s, mode: 'idle', uuid: null }));
	return { uuid: object.uuid, velocity };
}

/**
 * B5: we were carrying but we are NOT the peer stepping the world, so the
 * initiator has been reconstructing our release from a ~10 Hz move stream after
 * 250 ms of silence — late, slow, and in the wrong direction. Send it exactly,
 * once, as an EVENT.
 *
 * Not sent when nothing is simulating (there is no body to throw) or when the
 * release is a place-down: |v| under 5 cm/s saves the message entirely.
 * @param {any} object @param {any} velocity @param {boolean} throwIt
 */
function sendThrow(object, velocity, throwIt) {
	if (!throwIt || !simRunning()) return false;
	const linvel = velocity.linvel?.toArray?.() ?? velocity.linvel ?? [0, 0, 0];
	const angvel = velocity.angvel?.toArray?.() ?? velocity.angvel ?? [0, 0, 0];
	if (Math.hypot(linvel[0], linvel[1], linvel[2]) < 0.05) return false;
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return false;
	// twelve plain numbers, so the raw-bytes rule does not apply: it exists
	// because binarypack recurses per element and a ~40k-number array throws
	// inside broadcast()'s swallowing catch. the rot field stays EULER, matching move /
	// duplicate / the history appliers — and the Euler bug cannot come back,
	// because the ANGULAR VELOCITY travels as a vector.
	peer.send({
		type: 'throw',
		uuid: object.uuid,
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		linvel,
		angvel
	});
	return true;
}

/** @param {PointerEvent} event */
function onPointerDown(event) {
	if (event.button !== 0) return;
	const mode = interactionMode();
	if (mode === 'off' || !activeCamera) return;
	const hits = aimFrom(activeCamera);
	const hit = hits.find((/** @type {any} */ candidate) => candidate.distance <= REACH);
	const target = hit ? topLevelObjectOf(hit.object) : null;
	press = { t: performance.now(), uuid: target?.uuid ?? null, hit: hit ?? null };
	if (mode !== 'grab' || !target) return;
	if (!simRunning()) return; // nothing to hold; the tap path still works
	if (!dynamicUuids().has(target.uuid)) return;
	const lock = get(lockedObjects).find((/** @type {any} */ entry) => entry[1] === target.uuid);
	if (lock) {
		playInteractState.update((s) => ({ ...s, blocked: nameOf(lock[0]) }));
		return;
	}
	if (!canEditObject(target)) {
		warnViewerReadOnly();
		return;
	}
	beginGrab(target, activeCamera);
}

/** @param {PointerEvent} event */
function onPointerUp(event) {
	if (event.button !== 0) return;
	const wasPress = press;
	press = null;
	if (grab) {
		endGrab(true);
		return;
	}
	if (!wasPress || interactionMode() === 'off') return;
	// a short press with nothing carried is a TAP. Play mode had no clicking at
	// all before this, so it is the first time an On Click node or a module
	// button (a piano key, a keypad) works in play mode — which is also why
	// `interaction` is grab | click | off rather than a boolean.
	if (performance.now() - wasPress.t > TAP_MS) return;
	if (moduleTap()) return;
	if (wasPress.hit && moduleHitTest && moduleHitTest(wasPress.hit.object)) return;
	if (wasPress.uuid) fireObjectClick(wasPress.uuid);
}

/**
 * The wheel is claimed in CAPTURE phase so it runs before
 * PointerLockControls.onScroll (which spends it on moveSpeed), and the two
 * agree through the EVENT — `defaultPrevented` — never a one-shot store flag.
 * That is this codebase's own convention for two handlers claiming one input
 * (the twin-Escape lesson).
 * @param {WheelEvent} event
 */
function onWheel(event) {
	if (!grab) return;
	event.preventDefault();
	carryDistance = Math.min(
		CARRY_MAX,
		Math.max(CARRY_MIN, carryDistance + (event.deltaY > 0 ? -CARRY_STEP : CARRY_STEP))
	);
	playInteractState.update((s) => ({ ...s, distance: carryDistance }));
}

/**
 * Per frame, from Scene's useTask.
 * @param {number} delta seconds @param {any} camera
 */
export function tickPlayInteract(delta, camera) {
	activeCamera = camera ?? activeCamera;
	const mode = interactionMode();
	if (mode === 'off' || !camera) {
		if (grab) endGrab(false);
		if (get(playInteractState).mode !== 'off')
			playInteractState.set({ mode: 'off', distance: carryDistance, uuid: null, blocked: null });
		return;
	}

	if (grab) {
		// every cancel path releases with zero velocity — a body left kinematic
		// forever is the failure mode this guards
		const group = get(objectsGroup);
		if (!simRunning() || !group?.getObjectByProperty('uuid', grab.object.uuid)) {
			endGrab(false);
			return;
		}
		camera.getWorldPosition(camPos);
		camera.getWorldDirection(camDir);
		targetPos.copy(camPos).addScaledVector(camDir, carryDistance);
		// dt-based, so a throttled tab does not change the feel
		const k = Math.min(SPRING_K_MAX, Math.max(SPRING_K_MIN, SPRING_K / Math.sqrt(Math.max(grab.mass, 1))));
		const alpha = 1 - Math.exp(-k * Math.max(delta, 1e-3));
		grab.object.position.lerp(targetPos, alpha);
		euler.setFromQuaternion(camera.getWorldQuaternion(desiredQuat), 'YXZ');
		yawQuat.setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
		desiredQuat.copy(yawQuat).multiply(grab.relQuat);
		grab.object.quaternion.slerp(desiredQuat, alpha);
		grab.object.updateMatrixWorld();

		const now = performance.now();
		grab.samples.push({
			t: now,
			pos: grab.object.position.clone(),
			quat: grab.object.quaternion.clone()
		});
		if (grab.samples.length > 4) grab.samples.shift();

		if (now - grab.lastSent > 1000 / MOVE_HZ) {
			grab.lastSent = now;
			/** @type {any} */
			const peer = get(peers);
			// when we ARE the initiator holdBody already set hold:'user', which the
			// deviation detector skips and the write-back excludes, so there is no
			// fight; when we are not, these moves refresh the EXTERNAL hold, which is
			// pre-existing behaviour simply fed at a usable rate
			if (peer)
				peer.send({
					type: 'move',
					uuid: grab.object.uuid,
					pos: grab.object.position.toArray(),
					rot: [grab.object.rotation.x, grab.object.rotation.y, grab.object.rotation.z],
					scale: grab.object.scale.toArray()
				});
		}
		objectsGroup.update((v) => v);
		return;
	}

	// not carrying: what is the crosshair over?
	const hits = aimFrom(camera);
	const hit = hits.find((/** @type {any} */ candidate) => candidate.distance <= REACH);
	const target = hit ? topLevelObjectOf(hit.object) : null;
	const grabbable =
		mode === 'grab' && !!target && simRunning() && dynamicUuids().has(target.uuid);
	const state = get(playInteractState);
	const next = grabbable ? 'aiming' : 'idle';
	if (state.mode !== next || state.uuid !== (target?.uuid ?? null))
		playInteractState.set({
			mode: next,
			distance: carryDistance,
			uuid: target?.uuid ?? null,
			blocked: null
		});
}

/**
 * Wire the listeners. Called from Scene's onMount BELOW every `let` its closure
 * reads: a registration seam that re-applies synchronously above its own `let`
 * TDZ-throws and takes the whole app down (the signature is every suite dying
 * inside setupPage's waitForFunction).
 * @param {{moduleHitTest?: (object: any) => boolean}} [options]
 */
export function startPlayInteract(options = {}) {
	if (started || typeof window === 'undefined') return () => {};
	started = true;
	moduleHitTest = options.moduleHitTest ?? null;
	window.addEventListener('pointerdown', onPointerDown);
	window.addEventListener('pointerup', onPointerUp);
	window.addEventListener('wheel', onWheel, { capture: true, passive: false });
	return stopPlayInteract;
}

export function stopPlayInteract() {
	if (!started) return;
	started = false;
	if (grab) endGrab(false);
	press = null;
	moduleHitTest = null;
	activeCamera = null;
	playInteractState.set({ mode: 'off', distance: carryDistance, uuid: null, blocked: null });
	window.removeEventListener('pointerdown', onPointerDown);
	window.removeEventListener('pointerup', onPointerUp);
	window.removeEventListener('wheel', onWheel, { capture: true });
}

/** test/debug view */
export function playInteractDebug() {
	return {
		started,
		mode: interactionMode(),
		carrying: grab?.object?.uuid ?? null,
		held: !!grab?.held,
		distance: carryDistance,
		samples: grab?.samples.length ?? 0
	};
}
