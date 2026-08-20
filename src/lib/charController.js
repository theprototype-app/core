import { writable, get } from 'svelte/store';
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { globalScene } from '../stores/sceneStore';
import { sceneGravity, scenePhysicsGround } from './scenePhysics';
import { dungeonData, slideMove } from './dungeonPlay';

// 21-E6 — THE CHARACTER CONTROLLER, as data a graph can own.
//
// A LEAF on purpose: svelte stores + THREE + two store-only modules and the pure
// dungeonPlay raster, nothing else. Both PointerLockControls (a component) and
// flowRuntime import it STATICALLY, and flowRuntime sits inside history's import
// subtree — so anything this module reached statically would close the TDZ cycle that
// crashes the SSR prerender. physics and possess are therefore reached the way
// flowRuntime reaches them: a PRIMED DYNAMIC IMPORT (the moduleSDK precedent), and
// primed LAZILY here so a scene with no controller node never even loads rapier.
//
// THE PARITY CONTRACT, which is the whole point of the phase: `charControl` is NULL
// when no `charcontroller` node exists in any graph, and PointerLockControls then
// runs the code it has always run, untouched. Nothing in this file executes.
//
// GROUND RESOLUTION IS TIERED, and the tiering is the honest part of the design —
// full collision NEEDS a running simulation, because the world (and every collider in
// it) exists only while one runs:
//
//   1. 'rapier'  — a sim is RUNNING: a KinematicCharacterController with a capsule,
//                  resolving the XZ+Y step in ONE call so walls, slopes and steps all
//                  work and you can stand on a box. The capsule is NEVER a scene
//                  collider: it is created straight onto the world here, so it holds
//                  no colliderOwner entry, is invisible to physics.js's own body list,
//                  and can never enter GLTF sync (the scene-root / local rule).
//                  physics.js's sensor + impact paths look every handle up in
//                  colliderOwner and already skip an unknown one.
//   2. 'dungeon' — no world, but a dungeon module published its raster: the EXISTING
//                  walk (dungeonPlay.slideMove), so the dungeon contract is unchanged.
//   3. 'plane'   — no world, no raster: the scene's ground plane height as a flat
//                  floor (y = 0 when the ground is switched off). A light scene still
//                  walks and still lands; it just cannot walk into things.
//
// UNITS, which are deliberately not uniform. `speed` IS PointerLockControls' own
// `moveSpeed`: per-FRAME translate units, the number the scroll wheel has always
// adjusted, and the parity contract pins it there (0.1). Walk mode scales it by
// dt * 60, so it covers the same distance at the nominal 60fps and stays stable when
// frames are dropped. `jumpHeight`, `eyeHeight` and gravity are metres and seconds,
// because they describe the WORLD rather than the input.
//
// `eyeHeight` is the eye's height above the ground in WORLD metres (1.7 = a person).
// Note that `playSettings.eyeHeight` means something else — a LOCAL offset for a
// camera that lives in a group at y = 0.9, so its 0.8 default is that same 1.7 world
// eye. The walker converts through the rig's parent, so both stay correct.

/** the fly speed PointerLockControls has always shipped with */
export const DEFAULT_FLY_SPEED = 0.1;
/** the capsule's radius; also the dungeon raster's walk radius */
const CAPSULE_RADIUS = 0.3;

/**
 * @typedef {{mode: 'fly'|'walk', speed: number, jumpHeight: number, eyeHeight: number,
 *   gravity: boolean, sourceNodeId: string}} CharControl
 */

/** The declared controller, or NULL for "no controller node exists" — which is the
 * built-in behaviour, byte-identical.
 * @type {import('svelte/store').Writable<CharControl | null>} */
export const charControl = writable(null);

/** The live movement speed OVERRIDE. NULL = PointerLockControls keeps its own local
 * `moveSpeed`, exactly as before. A number is written by the `movespeed` node's `set`
 * input and, while a controller is active, by the scroll wheel — so scroll STILL
 * adjusts speed, just through a store the graph can read and write.
 * @type {import('svelte/store').Writable<number | null>} */
export const playMoveSpeed = writable(null);

/** The walker's own state, published for the suite (and anything that wants to draw
 * it): vertical velocity, whether we stand on something, the resolved floor and WHICH
 * tier answered.
 * @type {import('svelte/store').Writable<{vy: number, grounded: boolean, ground: number, source: 'rapier'|'dungeon'|'plane'|'none'}>} */
export const walkerState = writable({ vy: 0, grounded: false, ground: 0, source: 'none' });

let vy = 0;
let grounded = false;
/** is the jump key physically down? A browser REPEATS keydown while a key is held, so
 * the edge has to be tracked here rather than trusted from the event. */
let jumpHeld = false;
/** an unconsumed jump edge, spent only when we are actually on the ground */
let jumpRequested = false;

// ---- the speed override -----------------------------------------------------

/** @param {number | null} value */
export function setPlayMoveSpeed(value) {
	if (value === null) {
		if (get(playMoveSpeed) !== null) playMoveSpeed.set(null);
		return;
	}
	const next = Math.max(0.001, Math.min(100, Number(value) || 0));
	if (get(playMoveSpeed) !== next) playMoveSpeed.set(next);
}

/** The effective movement speed: the live override, else the controller's own param,
 * else the caller's built-in default. ONE precedence, shared by the runtime readout
 * and PointerLockControls, so the number on the card is the number that moves you.
 * @param {number} builtin @returns {number} */
export function effectiveSpeed(builtin) {
	const override = get(playMoveSpeed);
	if (override !== null) return override;
	return get(charControl)?.speed ?? builtin;
}

// ---- the declaration --------------------------------------------------------

/**
 * Install (or clear) the declared controller. Writes ONLY on a real change — the
 * hudRuntime on-change rule: this store is read every frame by a threlte task and
 * subscribed by a component, so a per-tick write would be 60 notifications a second
 * for a value that did not move.
 *
 * Editing the node's `speed` CLEARS the live override, because the author has just
 * said what they want; without that, one scroll would pin the speed for ever and the
 * param would look broken.
 * @param {CharControl | null} next
 */
export function setCharControl(next) {
	const current = get(charControl);
	if (!next) {
		if (current) {
			charControl.set(null);
			setPlayMoveSpeed(null);
			resetWalker();
		}
		return;
	}
	if (
		current &&
		current.mode === next.mode &&
		current.speed === next.speed &&
		current.jumpHeight === next.jumpHeight &&
		current.eyeHeight === next.eyeHeight &&
		current.gravity === next.gravity &&
		current.sourceNodeId === next.sourceNodeId
	)
		return;
	// a changed authored speed wins over whatever the wheel left behind
	if (!current || current.speed !== next.speed) setPlayMoveSpeed(null);
	// switching mode restarts the walker rather than inheriting a fall
	if (current && current.mode !== next.mode) resetWalker();
	charControl.set(next);
}

// ---- jump -------------------------------------------------------------------

/**
 * The jump key went down or up. Edge-triggered HERE rather than at the call site,
 * because keydown REPEATS while a key is held: a held Space produces exactly ONE
 * request, and landing with the key still down produces none (no bunny-hopping).
 * The release is deliberately NOT gated on anything — the push-to-talk lesson: a mode
 * switch or a modifier mid-hold must never strand the flag down.
 * @param {boolean} down
 */
export function setJumpRequested(down = true) {
	if (!down) {
		jumpHeld = false;
		return;
	}
	if (jumpHeld) return;
	jumpHeld = true;
	jumpRequested = true;
}

// ---- input -> a horizontal step ---------------------------------------------

const _worldPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The wanted horizontal step, camera-relative but FLATTENED: walking is on the XZ
 * plane, so looking up must not slow you down and looking down must not sink you.
 * Derived from the rig's YAW only — projecting the forward vector and normalising it
 * divides by ~0 when you look straight down.
 * @param {any} rig the camera object PointerLockControls drives
 * @param {{forward: number, backward: number, left: number, right: number}} moveState
 * @param {number} speed per-frame units (see the UNITS note at the top)
 * @param {number} dt seconds
 * @returns {{dx: number, dz: number}}
 */
export function walkStep(rig, moveState, speed, dt) {
	const drive = (moveState?.forward ? 1 : 0) - (moveState?.backward ? 1 : 0);
	const strafe = (moveState?.right ? 1 : 0) - (moveState?.left ? 1 : 0);
	if ((!drive && !strafe) || !rig) return { dx: 0, dz: 0 };
	// frame-rate independent, and identical to the fly path at 60fps
	const step = speed * Math.max(0, Math.min(dt, 0.1)) * 60;
	rig.getWorldQuaternion(_quat);
	_euler.setFromQuaternion(_quat);
	const yaw = _euler.y;
	// forward = -Z of the yaw, right = +X of it (three's translateZ/translateX signs)
	let dx = -Math.sin(yaw) * drive + Math.cos(yaw) * strafe;
	let dz = -Math.cos(yaw) * drive - Math.sin(yaw) * strafe;
	// a diagonal must not be faster than a straight line
	const len = Math.hypot(dx, dz);
	if (len > 1e-6) {
		dx = (dx / len) * step;
		dz = (dz / len) * step;
	}
	return { dx, dz };
}

// ---- tier 1: the rapier capsule ---------------------------------------------

/** @type {any} */ let physicsRef = null;
let physicsPrimed = false;
/** @type {any} */ let capsule = null;
/** @type {any} */ let controller = null;
/** @type {any} */ let capsuleWorld = null;
let capsuleKey = '';

/** The live world + rapier module, or null when no simulation is running. Primed
 * LAZILY so the parity path never pulls physics in at all. @returns {any} */
function physicsRuntime() {
	if (!physicsPrimed) {
		physicsPrimed = true;
		import('./physics')
			.then((m) => (physicsRef = m))
			.catch(() => {});
	}
	try {
		return physicsRef?.physicsRuntime?.() ?? null;
	} catch {
		return null;
	}
}

/** Drop the capsule + controller. Every call is guarded: the world they belong to may
 * already have been freed by stopSimulation. */
function dropCapsule() {
	try {
		if (capsuleWorld && capsule) capsuleWorld.removeCollider(capsule, false);
	} catch {}
	try {
		if (capsuleWorld && controller) capsuleWorld.removeCharacterController(controller);
	} catch {}
	capsule = null;
	controller = null;
	capsuleWorld = null;
	capsuleKey = '';
}

/**
 * The capsule for this eye height in THIS world, built on demand. A new simulation is
 * a NEW world object, so world IDENTITY is what invalidates it — not a flag somebody
 * has to remember to clear.
 * @param {any} rt @param {number} eyeHeight @returns {any}
 */
function ensureCapsule(rt, eyeHeight) {
	if (!rt) {
		if (capsule) dropCapsule();
		return null;
	}
	const world = rt.world;
	const RAPIER = rt.RAPIER;
	if (!world || !RAPIER) return null;
	if (capsuleWorld && world !== capsuleWorld) dropCapsule();
	// total capsule height = 2*half + 2*radius, so it spans feet -> eye
	const half = Math.max(0.05, eyeHeight / 2 - CAPSULE_RADIUS);
	const key = CAPSULE_RADIUS + '|' + half.toFixed(3);
	if (capsule && key !== capsuleKey) dropCapsule();
	if (!capsule) {
		try {
			capsule = world.createCollider(RAPIER.ColliderDesc.capsule(half, CAPSULE_RADIUS));
			controller = world.createCharacterController(0.02);
			controller.enableAutostep?.(0.3, 0.2, true);
			controller.enableSnapToGround?.(0.3);
			controller.setMaxSlopeClimbAngle?.((50 * Math.PI) / 180);
			controller.setMinSlopeSlideAngle?.((40 * Math.PI) / 180);
			capsuleWorld = world;
			capsuleKey = key;
		} catch (error) {
			console.log('character capsule failed', error);
			dropCapsule();
			return null;
		}
	}
	return { world, half };
}

// ---- tiers 2 and 3: the floor without a world -------------------------------

/** The scene's flat floor: the ground plane's height, or 0 when it is switched off. A
 * walker that can fall for ever is not a feature. @returns {number} */
function floorHeight() {
	const ground = get(scenePhysicsGround);
	return ground?.enabled ? Number(ground.height ?? 0) || 0 : 0;
}

// ---- the walker -------------------------------------------------------------

/**
 * One frame of the walker: gravity, jump, and whichever ground tier can answer. OWNS
 * Y. The caller owns the horizontal INTENT (`desired`), because that part belongs to
 * the input; here it is only resolved against the world.
 * @param {any} rig the camera object PointerLockControls drives
 * @param {CharControl} settings
 * @param {number} dt seconds
 * @param {{dx: number, dz: number}} desired the wanted horizontal step, world units
 * @returns {{grounded: boolean, vy: number, source: string}}
 */
export function tickWalker(rig, settings, dt, desired) {
	if (!rig) return { grounded, vy, source: 'none' };
	const step = Math.max(0, Math.min(dt, 0.1)); // a tab that was backgrounded
	const eyeHeight = Math.max(0.1, Number(settings?.eyeHeight ?? 1.7) || 1.7);
	const useGravity = settings?.gravity !== false;
	const g = Math.abs(Number(get(sceneGravity)) || 9.81);

	rig.getWorldPosition(_worldPos);
	let feet = _worldPos.y - eyeHeight;

	// gravity + the jump edge. The jump is spent only while we are ON something, so a
	// press in mid-air is DROPPED rather than queued — a queued one fires on landing,
	// which reads as an unrequested second jump.
	if (useGravity) {
		if (jumpRequested && grounded) {
			jumpRequested = false;
			vy = Math.sqrt(2 * g * Math.max(0, Number(settings?.jumpHeight ?? 0) || 0));
		}
		vy -= g * step;
	} else {
		vy = 0;
		jumpRequested = false;
	}

	/** @type {'rapier'|'dungeon'|'plane'} */
	let source = 'plane';
	let dx = desired?.dx ?? 0;
	let dz = desired?.dz ?? 0;
	let dy = useGravity ? vy * step : 0;

	const built = ensureCapsule(physicsRuntime(), eyeHeight);
	if (built && capsule && controller) {
		try {
			// the capsule's CENTRE sits half a body above the feet
			capsule.setTranslation({ x: _worldPos.x, y: feet + eyeHeight / 2, z: _worldPos.z });
			controller.computeColliderMovement(capsule, { x: dx, y: dy, z: dz });
			const moved = controller.computedMovement();
			dx = moved.x;
			dy = moved.y;
			dz = moved.z;
			grounded = !!controller.computedGrounded();
			feet += dy;
			if (grounded && vy < 0) vy = 0;
			source = 'rapier';
			// leave the collider where we actually ENDED UP, so the next frame's query
			// starts from the truth rather than from where we asked to be
			capsule.setTranslation({ x: _worldPos.x + dx, y: feet + eyeHeight / 2, z: _worldPos.z + dz });
		} catch (error) {
			console.log('character controller step failed', error);
			dropCapsule();
			source = 'plane';
			dy = useGravity ? vy * step : 0;
		}
	}

	if (source !== 'rapier') {
		const raster = dungeonData(get(globalScene));
		if (raster) {
			// tier 2: the EXISTING dungeon walk, unchanged
			const slid = slideMove(raster, _worldPos.x, _worldPos.z, dx, dz, CAPSULE_RADIUS);
			dx = slid.x - _worldPos.x;
			dz = slid.z - _worldPos.z;
			source = 'dungeon';
		}
		// tiers 2 and 3 share the flat floor — the dungeon raster carries no heights
		const floor = raster ? 0 : floorHeight();
		feet += dy;
		if (!useGravity) {
			feet = floor;
			grounded = true;
		} else if (feet <= floor + 1e-4) {
			feet = floor;
			if (vy < 0) vy = 0;
			grounded = true;
		} else {
			grounded = false;
		}
	}

	// write back through the rig's PARENT: the camera lives in a group at y = 0.9, so a
	// world target has to be converted rather than assigned
	_target.set(_worldPos.x + dx, feet + eyeHeight, _worldPos.z + dz);
	if (rig.parent) rig.parent.worldToLocal(_target);
	rig.position.copy(_target);

	const state = { vy, grounded, ground: feet, source };
	const previous = get(walkerState);
	if (
		previous.grounded !== state.grounded ||
		previous.source !== state.source ||
		Math.abs(previous.vy - state.vy) > 1e-4 ||
		Math.abs(previous.ground - state.ground) > 1e-4
	)
		walkerState.set(state);
	return { grounded, vy, source };
}

/** Forget the walker's motion (a mode change, the controller removed, a test starting
 * over). Drops the capsule too, so the next run rebuilds it against whatever world
 * exists then. */
export function resetWalker() {
	vy = 0;
	grounded = false;
	jumpRequested = false;
	jumpHeld = false;
	dropCapsule();
	walkerState.set({ vy: 0, grounded: false, ground: 0, source: 'none' });
}

/** test/debug view */
export function charControllerDebug() {
	return {
		control: get(charControl),
		moveSpeed: get(playMoveSpeed),
		walker: get(walkerState),
		capsule: !!capsule,
		jumpHeld,
		jumpRequested
	};
}

/** test hook: back to the pristine no-controller state */
export function resetCharController() {
	charControl.set(null);
	playMoveSpeed.set(null);
	resetWalker();
}
