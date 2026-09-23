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
import { gameFeelActive, gameClickMode } from './gameFeel';
import { sceneHits } from './scenePick';
import { pickStack, primaryIndex } from './selectThrough';
import { topLevelObjectOf } from './objectActions';
import { objectHasOnClick, fireObjectClick } from './flowRuntime';
import { moduleInteractiveGroups, runClickHandlers } from './moduleSDK';
import { registerVRFrameHook, registerVRTriggerHooks, registerPanelGroupProvider, controllerIndexFor, hapticPattern, triggerClaimed } from './vrControls';
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
const stats = { taps: 0, bumps: 0, sweepClicks: 0 };

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

/** @returns {{taps: number, bumps: number, sweepClicks: number, hover: (string | null)[], sweeps: boolean[]}} */
export function vrGameInputDebug() {
	return { ...stats, hover: [...hoverKey], sweeps: sweeps.map(Boolean) };
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

/* ---------------------------------------------------------------- P4 the sweep ---- */

// C3 — HOLD THE TRIGGER AND SWEEP. The user: "I want to be able to hold trigger and
// automatically press the buttons where I move the controller around. So, for example, I
// can hit different keys on piano holding trigger and on the mixer enable/disable".
//
// While the trigger is held in Interact/Play, every clickable the controller TIP (a
// ~6 cm sphere just ahead of the controller) ENTERS is clicked once, and re-armed when
// the tip leaves it; with the tip touching nothing, the LASER does the same for things
// out of reach (and for the game board's buttons). The first entry is the press itself
// (`source: 'trigger'`), fired on the PRESS rather than the release, so an instrument
// sounds when you hit it; every later one is `source: 'sweep'`, which a handler can opt
// out of (`registerClickHandler(fn, {sweep: false})`). A press another feature CLAIMED
// (a knob drag, a cable, the sleeve) is left alone — read one frame later, because this
// hook does not consume and cannot see the hooks after it. When the sweep clicked
// anything, the press's trailing 'select' is swallowed: that click already happened.

/** the tip sphere's radius (~6 cm across) and how far ahead of the controller it sits */
export const TIP_RADIUS = 0.03;
const TIP_AHEAD = 0.03;
/** the laser sweeps only what the tip cannot reach */
const LASER_MIN = 0.25;

/** @typedef {{first: boolean, inside: Set<string>, laserKey: string | null, panelKey: string | null, fired: number}} Sweep */
/** @type {(Sweep | null)[]} */
const sweeps = [null, null];

const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

/**
 * Every clickable a TIP sphere touches (bounding sphere, then the world box — a key, a
 * pad, a step cell is a box). Keyed by entry, so a device part is its own control.
 * @param {THREE.Vector3} tip @param {number} [radius] @returns {ClickTarget[]}
 */
export function clickTargetsTouching(tip, radius = TIP_RADIUS) {
	/** @type {any[]} */
	const roots = [];
	const group = get(objectsGroup);
	if (group) roots.push(group);
	const scene = /** @type {any} */ (get(globalScene));
	for (const name of moduleInteractiveGroups) {
		const root = scene?.getObjectByName(name);
		if (root) roots.push(root);
	}
	/** @type {Map<string, ClickTarget>} */
	const found = new Map();
	for (const root of roots)
		root.traverseVisible((/** @type {any} */ node) => {
			if (!node.isMesh || !node.geometry) return;
			const geo = node.geometry;
			if (!geo.boundingSphere) geo.computeBoundingSphere();
			_sphere.copy(geo.boundingSphere).applyMatrix4(node.matrixWorld);
			if (_sphere.distanceToPoint(tip) > radius) return;
			if (!geo.boundingBox) geo.computeBoundingBox();
			_box.copy(geo.boundingBox).applyMatrix4(node.matrixWorld);
			if (_box.distanceToPoint(tip) > radius) return;
			const distance = _box.distanceToPoint(tip);
			const target = clickTargetOf({ object: node, point: tip.clone(), distance });
			const known = target ? found.get(target.key) : null;
			if (target && (!known || distance < known.distance)) found.set(target.key, target);
		});
	return [...found.values()].sort((a, b) => a.distance - b.distance);
}

/**
 * CLICK a target the way Interact/Play's tap does — the module handlers for this mode
 * first, then the object's On Click — and bump the hand when something acted.
 * @param {ClickTarget} target @param {string} source @param {number} index @returns {boolean}
 */
export function fireClickTarget(target, source, index) {
	let acted = runClickHandlers(target.mesh, gameClickMode(), { source });
	if (!acted && target.top) acted = fireObjectClick(target.top.uuid) > 0;
	if (acted) {
		hapticPattern('bump', handOf(index));
		stats.sweepClicks++;
	}
	return acted;
}

/** the tip sphere's centre for slot `index` @param {number} index */
function tipAhead(index) {
	const ray = controllerRayOf(index);
	return ray ? ray.ray.origin.clone().addScaledVector(ray.ray.direction, TIP_AHEAD) : null;
}

/**
 * One frame of a held trigger on slot `index`. `opts.tip`/`opts.ray` inject the pose (the
 * suites; no headset headless). Returns the entry keys this frame clicked, or null when
 * no sweep is live.
 * @param {number} index @param {{tip?: THREE.Vector3 | null, ray?: THREE.Raycaster | null}} [opts]
 * @returns {string[] | null}
 */
export function sweepFrame(index, opts = {}) {
	const sweep = sweeps[index];
	if (!sweep) return null;
	if (!gameFeelActive() || (sweep.first && triggerClaimed(index))) {
		sweeps[index] = null;
		return null;
	}
	const source = sweep.first ? 'trigger' : 'sweep';
	sweep.first = false;
	const tip = opts.tip === undefined ? tipAhead(index) : opts.tip;
	const ray = opts.ray === undefined ? controllerRayOf(index) : opts.ray;
	/** @type {string[]} */
	const fired = [];
	// the tip plays what it is NEAREST to: a 6 cm sphere is wider than a piano key, and
	// "every key it touches" would sound clusters. A target fires when it becomes the
	// nearest touching one; it stays spent while the tip still touches it, and LEAVING
	// re-arms it.
	const touching = tip ? clickTargetsTouching(tip) : [];
	const nearest = touching[0] ?? null;
	const still = new Set([...sweep.inside].filter((key) => touching.some((t) => t.key === key)));
	if (nearest && !still.has(nearest.key)) {
		if (fireClickTarget(nearest, source, index)) fired.push(nearest.key);
		still.add(nearest.key);
	}
	sweep.inside = still;
	if (!touching.length && ray) {
		const board = panelTargetAlong(ray);
		const boardKey = board?.hit.id ?? null;
		if (board && boardKey !== sweep.panelKey && pressPanelTarget(board, { source, u: uAcross(board) })) {
			hapticPattern('bump', handOf(index));
			fired.push(board.hit.id);
		}
		sweep.panelKey = boardKey;
		const far = board ? null : clickTargetAlong(ray);
		const farKey = far && far.distance > LASER_MIN ? far.key : null;
		if (far && farKey && farKey !== sweep.laserKey && fireClickTarget(far, source, index)) fired.push(farKey);
		sweep.laserKey = farKey;
	} else {
		sweep.laserKey = null;
		sweep.panelKey = null;
	}
	if (fired.length) {
		sweep.fired += fired.length;
		swallowNext = true;
	}
	return fired;
}

/**
 * A trigger PRESS on slot `index`. In Interact/Play: a game-board button under the laser
 * is pressed at once and the press consumed (the sweep carries on across the board); any
 * other press starts a SWEEP, which fires on the next frame once it knows no other
 * gesture claimed this press. Returns whether the press was consumed. Exported for the
 * suites (the live hook calls it).
 * @param {number} index @returns {boolean}
 */
export function triggerStart(index) {
	swallowNext = false;
	sweeps[index] = null;
	if (!gameFeelActive()) return false;
	const ray = controllerRayOf(index);
	const target = ray ? panelTargetAlong(ray) : null;
	if (target) {
		pressPanelTarget(target, { source: 'trigger', u: uAcross(target) });
		hapticPattern('bump', handOf(index));
		swallowNext = true;
		sweeps[index] = { first: false, inside: new Set(), laserKey: null, panelKey: target.hit.id, fired: 1 };
		return true;
	}
	sweeps[index] = { first: true, inside: new Set(), laserKey: null, panelKey: null, fired: 0 };
	return false;
}

/** The trigger RELEASED on slot `index`: the sweep ends (the swallow stays armed for the
 * trailing 'select', which WebXR fires before 'selectend'). @param {number} index */
export function triggerEnd(index) {
	sweeps[index] = null;
	return false;
}

/** is a sweep live on slot `index`? (suites) @param {number} index */
export function sweepLive(index) {
	return !!sweeps[index];
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
				sweepFrame(index);
			}
		}),
		registerVRTriggerHooks({
			start: (/** @type {number} */ index) => triggerStart(index),
			end: (/** @type {number} */ index) => triggerEnd(index),
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
	sweeps[0] = sweeps[1] = null;
	hideVrGamePanel();
}
