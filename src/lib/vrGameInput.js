// 30b (vr-play) — THE GAME IN YOUR HANDS, the VR input half: what a controller is pointing
// at or touching in a GAME, and what that feels like. P1 (C4) is the haptic defaults —
// a `tap` when the laser enters something clickable, a `bump` when the trigger lands on
// it; P4 (C3) grows the hold-and-sweep on the same resolver.
//
// "Clickable" is decided HERE, once, for the tap, the bump and the sweep alike:
//  · anything under a module's scene-root INTERACTIVE group (a board, a dungeon door);
//  · a part of a module DEVICE (`userData.device` on an ancestor — the music lab's piano
//    keys, drum pads, transport buttons: every one is its own control);
//  · an object an On Click node targets (flowRuntime's own rule), or one a module marked
//    `userData.clickable = true`.
// The ENTRY KEY is what "once per entry" counts: the exact mesh for module content and
// device parts (a key is not its piano), the top-level object otherwise (an object with an
// On Click is one thing to press however many meshes it is built from).
//
// Everything is LOCAL and gated on gameFeelActive(): the editor never buzzes (the user's
// rule), and nothing here sends anything — a click that lands replicates through the paths
// it always did (module handlers, the On Click trigger).
//
// Plugs into vrControls through its generic registries (registerVRFrameHook,
// registerVRTriggerHooks) — the vrSleeve precedent — so vrControls never imports it.
// Started from Scene.svelte (`startVrGameInput`), which already imports everything here.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalRenderer } from '../stores/sceneStore';
import { gameFeelActive } from './gameFeel';
import { sceneHits } from './scenePick';
import { pickStack, primaryIndex } from './selectThrough';
import { topLevelObjectOf } from './objectActions';
import { objectHasOnClick } from './flowRuntime';
import { moduleInteractiveGroups } from './moduleSDK';
import { registerVRFrameHook, registerVRTriggerHooks, registerPanelGroupProvider, controllerIndexFor, hapticPattern } from './vrControls';
// P3 (C2): the game UI in VR — the panel, the wrist card, the strip, the banner
import { vrGamePanelFrame, panelTargetAlong, panelHover, pressPanelTarget, pokeFrame, uAcross, vrGameSurface, hideVrGamePanel } from './vrGamePanel';

const _mat = new THREE.Matrix4();

/**
 * @typedef {{kind: 'object', key: string, mesh: any, top: any | null, point: any, distance: number, group: string | null}} ClickTarget
 */

/** the scene-root interactive group a mesh sits under, or null @param {any} mesh */
function interactiveGroupOf(mesh) {
	const scene = get(globalScene);
	for (let node = mesh; node && node !== scene; node = node.parent) {
		if (node.parent === scene && moduleInteractiveGroups.includes(node.name)) return node.name;
	}
	return null;
}

/** is there a module device on the path from the mesh up to `top`? @param {any} mesh @param {any} top */
function deviceBetween(mesh, top) {
	for (let node = mesh; node; node = node.parent) {
		if (node.userData?.device) return true;
		if (node === top) break;
	}
	return false;
}

/**
 * Resolve a raycast/overlap HIT to the thing a press would reach — or null when nothing
 * clickable is there. Pure over the scene; exported for the suites.
 * @param {any} hit a THREE intersection ({object, point, distance})
 * @returns {ClickTarget | null}
 */
export function clickTargetOf(hit) {
	const mesh = hit?.object;
	if (!mesh) return null;
	const group = interactiveGroupOf(mesh);
	if (group) return { kind: 'object', key: mesh.uuid, mesh, top: null, point: hit.point, distance: hit.distance ?? 0, group };
	const top = topLevelObjectOf(mesh);
	if (!top) return null;
	if (deviceBetween(mesh, top)) return { kind: 'object', key: mesh.uuid, mesh, top, point: hit.point, distance: hit.distance ?? 0, group: null };
	if (top.userData?.clickable === true || objectHasOnClick(top.uuid))
		return { kind: 'object', key: top.uuid, mesh, top, point: hit.point, distance: hit.distance ?? 0, group: null };
	return null;
}

/**
 * The nearest clickable along a ray: module interactive groups first (the viewport click's
 * order), then the scene with the see-through rule (a faint wall does not take the press).
 * @param {any} ray a THREE.Raycaster @returns {ClickTarget | null}
 */
export function clickTargetAlong(ray) {
	/** @type {ClickTarget | null} */
	let best = null;
	const scene = get(globalScene);
	for (const name of moduleInteractiveGroups) {
		const root = scene?.getObjectByName(name);
		if (!root) continue;
		const hits = ray.intersectObject(root, true).filter((/** @type {any} */ h) => h.object.visible !== false);
		const target = hits.length ? clickTargetOf(hits[0]) : null;
		if (target && (!best || target.distance < best.distance)) best = target;
	}
	if (get(objectsGroup)) {
		const stack = pickStack(sceneHits(ray), topLevelObjectOf);
		const entry = stack.length ? stack[primaryIndex(stack)] : null;
		const target = entry?.hit ? clickTargetOf(entry.hit) : null;
		if (target && (!best || target.distance < best.distance)) best = target;
	}
	return best;
}

/* -------------------------------------------------------------- controller rays ---- */

/** the world ray of three.js controller SLOT `index` @param {number} index */
export function controllerRayOf(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const controller = renderer?.xr?.getController?.(index);
	if (!controller) return null;
	const ray = new THREE.Raycaster();
	_mat.identity().extractRotation(controller.matrixWorld);
	ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	ray.ray.direction.set(0, 0, -1).applyMatrix4(_mat);
	return ray;
}

/** 'left' | 'right' | undefined for a controller slot @param {number} index */
export function handOf(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const h = renderer?.xr?.getController?.(index)?.userData?.handedness;
	return h === 'left' || h === 'right' ? h : undefined;
}

/* ----------------------------------------------------------------- the defaults ---- */

/** what each slot's laser pointed at last frame (entry key) — the hover-enter edge */
const hoverKey = /** @type {(string | null)[]} */ ([null, null]);
const stats = { taps: 0, bumps: 0 };

/**
 * One frame of the hover edge for slot `index`: a NEW clickable under the laser taps that
 * hand. Exported so the suites drive it with a posed controller (no XR session headless).
 * @param {number} index @param {any} [ray] defaults to the controller's own ray
 * @returns {ClickTarget | null}
 */
export function hoverFrame(index, ray = controllerRayOf(index)) {
	if (!ray || !gameFeelActive()) {
		hoverKey[index] = null;
		return null;
	}
	const target = clickTargetAlong(ray);
	const key = target?.key ?? null;
	if (key && key !== hoverKey[index]) {
		hapticPattern('tap', handOf(index));
		stats.taps++;
	}
	hoverKey[index] = key;
	return target;
}

/**
 * A trigger PRESS on slot `index`: a bump when it lands on something clickable. Never
 * consumes the press — the click itself still travels the normal select path.
 * @param {number} index @param {any} [ray] @returns {boolean} whether it bumped
 */
export function pressFeedback(index, ray = controllerRayOf(index)) {
	if (!ray || !gameFeelActive()) return false;
	if (!clickTargetAlong(ray)) return false;
	hapticPattern('bump', handOf(index));
	stats.bumps++;
	return true;
}

/** @returns {{taps: number, bumps: number, hover: (string | null)[]}} */
export function vrGameInputDebug() {
	return { ...stats, hover: [...hoverKey] };
}

/* --------------------------------------------------------------- P3 the panel ---- */

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/** one hand's controller world pose, or null @param {'left'|'right'} hand */
function handPose(hand) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const index = controllerIndexFor(hand);
	const controller = index >= 0 ? renderer?.xr?.getController?.(index) : null;
	if (!controller) return null;
	controller.getWorldPosition(_pos);
	controller.getWorldQuaternion(_quat);
	return { position: _pos.clone(), quaternion: _quat.clone() };
}

/** the controller's TIP for a poke (the target-ray origin is its front end) @param {number} index */
function tipOf(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const controller = renderer?.xr?.getController?.(index);
	return controller ? controller.getWorldPosition(new THREE.Vector3()) : null;
}

/** true once a press of OURS (a panel button) took this trigger: its trailing 'select'
 * must not also reach Scene's pick */
let swallowNext = false;
/** was a headset presenting on the last frame (the session-end edge) */
let presenting = false;

/**
 * A trigger PRESS on slot `index`: a game-panel button under the laser is pressed and the
 * press consumed; anything else only gets its haptic bump and falls through untouched.
 * Exported for the suites (the live hook calls it).
 * @param {number} index @returns {boolean} consumed
 */
export function triggerStart(index) {
	swallowNext = false;
	const ray = controllerRayOf(index);
	const target = ray && gameFeelActive() ? panelTargetAlong(ray) : null;
	if (target) {
		pressPanelTarget(target, { source: 'trigger', u: uAcross(target) });
		hapticPattern('bump', handOf(index));
		swallowNext = true;
		return true;
	}
	pressFeedback(index);
	return false;
}

/** @type {(() => void)[]} */
let offs = [];

/** Wire the defaults into the VR loop. Returns the stop. Idempotent. */
export function startVrGameInput() {
	stopVrGameInput();
	offs = [
		registerVRFrameHook(() => {
			const renderer = /** @type {any} */ (get(globalRenderer));
			if (!renderer?.xr?.isPresenting) {
				// the session ENDED: take the surfaces down once (this hook runs every desktop
				// frame too, where there is nothing to do)
				if (presenting) hideVrGamePanel();
				presenting = false;
				return;
			}
			presenting = true;
			vrGamePanelFrame({ hands: [handPose('left'), null] });
			for (const index of [0, 1]) {
				const ray = controllerRayOf(index);
				// the laser on the board wins over the world behind it
				if (panelHover(index, gameFeelActive() ? ray : null)) hoverKey[index] = null;
				else hoverFrame(index, ray);
				pokeFrame(index, gameFeelActive() ? tipOf(index) : null);
			}
		}),
		registerVRTriggerHooks({
			start: (/** @type {number} */ index) => triggerStart(index),
			swallow: () => {
				if (!swallowNext) return false;
				swallowNext = false;
				return true;
			}
		}),
		// the beam ends ON the board and the wrist card (the reticle sits on the button)
		registerPanelGroupProvider(() => {
			const s = vrGameSurface('vr-game-panel');
			return s?.mesh.visible ? s.mesh : null;
		}),
		registerPanelGroupProvider(() => {
			const s = vrGameSurface('vr-game-wrist');
			return s?.mesh.visible ? s.mesh : null;
		})
	];
	return stopVrGameInput;
}

export function stopVrGameInput() {
	for (const off of offs) off();
	offs = [];
	hoverKey[0] = hoverKey[1] = null;
	hideVrGamePanel();
}
