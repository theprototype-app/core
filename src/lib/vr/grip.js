// VR controls — grip and world: object grabs (rigid, two-hand scale), world grab/pan/reel, vertex and face grabs, grip targeting.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	objectsGroup,
	lockedObjects,
	globalCamera,
	globalScene,
	vrMenuHand,
	vrVertexHold,
	selectedObjects,
	worldRig,
	vrStretchObject,
	vrSnapMode,
	vrGrabStyle,
	vrGrabbedHand,
	editorMode,
	pokeScene
} from '../../stores/sceneStore';
import { isScenery, pickGripTarget, gripMovesWorld } from '../vrGrip';
import { pointGrabAllowed } from '../pointGrab';
import { resolvePlaySettings } from '../playSettings';
import { withinReach } from '../playReach';
import {
	editingObject,
	vrRaycastHandle,
	vrBeginHandleDrag,
	vrEndHandleDrag,
	toggleVertexSelection
} from '../meshEdit';
import {
	faceEditObject,
	faceEditOp,
	faceEditAmount,
	commitArmedFaceOp,
	faceIndexForTriangle,
	beginFaceGrab,
	commitFaceGrab,
	beginFaceAdjust,
	commitFaceAdjust,
	faceGesturePending,
	highlightedFaceInfo,
	faceEditMulti,
	faceEditHoverTri,
	toggleFaceSelection,
	currentTargetFace
} from '../faceEdit';
import { peers } from '../../stores/appStore';
import { recordTransform } from '../history';
import { snapEnabled, snapSettings, dropToSurface } from '../snapping';
import { selectObject, topLevelObjectOf } from '../objectActions';
import { suspendAnimation, resumeAnimation, fireObjectGrab } from '../flowRuntime';
import { safeStorage } from '../safeStorage';
import { S } from './state.js';
import { renderer, tempVector } from './core.js';
import { hapticPulse, hapticPattern } from './haptics.js';
import { gripDropHooks, worldGrabDiverts, worldGestureDiverted } from './hooks.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { STANDING_HEAD, vrLocomotionNow, viewerNow } from './locomotion.js';
import {
	vrFaceCreateMode,
	vrPrefabGhost,
	cancelPrefabGhost,
	windowHitAt,
	finishWindowAdjust
} from './panels.js';
import { controllerRay } from './pointer.js';
import { stretch } from './tools.js';
import { perfMark } from '../perf/perfMarks.js';

/** @type {any[]} per-hand grabs, indexed by controller SLOT: each is { object, index, prevPos,
 * prevQuat, before, ... }. 33 G4: one per hand, so two hands hold two things at once — a single
 * shared slot let the second hand's grab overwrite the first, and the first hand's piece sat
 * in its kinematic hold in mid-air until it was grabbed again (the Towers report). */
export const grabs = [null, null];
/** 24-A A1: the object a VR hand is holding right now, or null — the knock probe
 * skips it (a hand knocking the crate it is carrying would fight its own hold). */
export function vrGrabbedUuid() {
	return grabs[0]?.object?.uuid ?? grabs[1]?.object?.uuid ?? S.scaleGrab?.object?.uuid ?? null;
}
/** 33 G4: EVERY object a VR hand holds right now (both hands may each hold one) */
export function vrGrabbedUuids() {
	return [grabs[0]?.object?.uuid, grabs[1]?.object?.uuid, S.scaleGrab?.object?.uuid].filter(Boolean);
}
/** 33 G4: vrGrabbedHand = the hand holding something, or 'both' — the stick gates read it */
export function syncGrabbedHand() {
	/** @type {any[]} */
	const hands = grabs.filter(Boolean).map((g) => renderer?.xr?.getController(g.index)?.userData?.handedness ?? null);
	vrGrabbedHand.set(hands.length === 0 ? null : hands.length === 1 ? hands[0] : 'both');
}
let lastMoveSent = 0;

/** @param {any} object */
export function transformStateOf(object) {
	return {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
}

/** @param {any} object @param {boolean=} force */
export function broadcastMove(object, force = false) {
	const now = Date.now();
	if (!force && now - lastMoveSent < 50) return;
	lastMoveSent = now;
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
}

/** @param {any} object @param {any} before null = a PLAYER's grab (Interact): moved and
 * thrown like any other, but not an edit, so no undo entry */
export function endGrab(object, before) {
	broadcastMove(object, true);
	const after = transformStateOf(object);
	if (before && JSON.stringify(before) !== JSON.stringify(after))
		recordTransform({ uuid: object.uuid, before: before, after: after });
	// PFX-C: mid-sim release = throw (velocity estimate from the hold samples)
	import('../physics').then((m) => m.releaseBody(object.uuid));
	resumeAnimation(object.uuid); // release spot becomes the new animation base
}

/** 33 (G2): a pan with nothing under the ray reels from this far (metres) */
const WORLD_REEL_DEFAULT = 1.5;
/**
 * 33 (G2) — "stick up/down while holding it pushes it farther / pulls it closer, just as in
 * edit mode for objects": one frame of the world-pan hand's stick. The SAME reel an Edit grab
 * applies to a held object (grabStickAdjust: forward = y < 0 pushes away, back reels in, a
 * share of the distance per frame) applied to `reach`, the distance to the gripped spot.
 * Returns the new reach and the metres the world moves AWAY along the hand's ray (negative =
 * toward you). Pure; exported for the suites. @param {number} reach @param {number} y stick Y
 */
export function worldReelStep(reach, y) {
	const next = grabStickAdjust({ length: reach, scale: 1, x: 0, y }).length;
	return { reach: next, push: next - reach };
}
/** where a pan's reel starts: the first world surface on the hand's ray, else the default
 * @param {number} index */
function panReach(index) {
	try {
		const root = get(worldRig) ?? get(objectsGroup);
		const hit = root ? controllerRay(index).intersectObject(root, true).find((h) => h.object.visible !== false) : null;
		return hit ? Math.min(Math.max(hit.distance, 0.3), 30) : WORLD_REEL_DEFAULT;
	} catch {
		return WORLD_REEL_DEFAULT;
	}
}
export const _reelDir = new THREE.Vector3();
export const _reelQuat = new THREE.Quaternion();

/** 30b P2: test/debug view of what the grips are doing right now */
export function vrGripDebug() {
	return {
		grab: (grabs[0] ?? grabs[1])?.object?.uuid ?? null,
		grabInteract: !!(grabs[0] ?? grabs[1])?.interact,
		grabs: grabs.map((g) => g?.object?.uuid ?? null),
		scaleGrab: S.scaleGrab?.object?.uuid ?? null,
		worldGrab: !!S.worldGrab,
		worldPan: !!S.worldPan,
		panReach: S.worldPan ? S.worldPan.reach : null, // 33: the stick reel's distance
		emptyAir: [...emptyAirSqueeze]
	};
}

// ---- world grab (71): BOTH grips in empty air scale/rotate/pan the world ---
// The gesture transforms the world-grab-rig LOCALLY (peers see nothing —
// broadcasts stay in objectsGroup-local coords, which never change here).

const WORLD_SCALE_MIN = 0.05;
const WORLD_SCALE_MAX = 20;

export const emptyAirSqueeze = [false, false];
/** 186: grip pressed per controller index — gates the two-grip stretch gesture */
export const gripHeld = [false, false];

/** 186: two-grip stretch — opposite thumbstick Y directions DIVERGE (grow),
 * matching directions cancel. @param {number} leftY @param {number} rightY */
export function stretchDivergence(leftY, rightY) {
	return rightY - leftY;
}
/** 186: is a two-grip stretch gesture active (both grips held in stretch mode)? */
export function twoGripStretchActive() {
	return !!stretch && gripHeld[0] && gripHeld[1];
}

/** current uniform world scale (1 outside a grab / on desktop) */
export function worldScale() {
	return get(worldRig)?.scale.x ?? 1;
}

/** Snap the world back to 1:1 (quick-menu tile + VR session end) */
export function resetWorldRig() {
	const rig = get(worldRig);
	if (!rig) return;
	rig.position.set(0, 0, 0);
	rig.quaternion.identity();
	rig.scale.set(1, 1, 1);
	rig.updateMatrixWorld(true);
}

/**
 * Pure gesture math (headless-testable): given both hands' start/current
 * positions and the rig's start state, produce the rig transform that keeps
 * the world point between the hands glued to them while scaling by the
 * hands' distance ratio and yawing by the hands' axis rotation.
 * @param {{a: number[], b: number[]}} start
 * @param {{a: number[], b: number[]}} now
 * @param {{pos: number[], quat: number[], scale: number}} rig0
 */
export function computeWorldGrabTransform(start, now, rig0) {
	const a0 = new THREE.Vector3().fromArray(start.a);
	const b0 = new THREE.Vector3().fromArray(start.b);
	const a = new THREE.Vector3().fromArray(now.a);
	const b = new THREE.Vector3().fromArray(now.b);
	const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
	const mid = a.clone().add(b).multiplyScalar(0.5);
	const d0 = Math.max(a0.distanceTo(b0), 0.05);
	const d = Math.max(a.distanceTo(b), 0.001);
	// clamp the TOTAL scale, then work with the relative ratio
	const total = THREE.MathUtils.clamp(rig0.scale * (d / d0), WORLD_SCALE_MIN, WORLD_SCALE_MAX);
	const ratio = total / rig0.scale;
	// yaw from the hands' axis on the ground plane (angle0 - angleNow, +Y up)
	const angle0 = Math.atan2(b0.z - a0.z, b0.x - a0.x);
	const angle = Math.atan2(b.z - a.z, b.x - a.x);
	const yaw = angle0 - angle;
	const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
	const quat0 = new THREE.Quaternion().fromArray(rig0.quat);
	// rig' = T(mid) · R(yaw) · S(ratio) · T(-mid0) applied to the rig's start
	const pos = new THREE.Vector3()
		.fromArray(rig0.pos)
		.sub(mid0)
		.multiplyScalar(ratio)
		.applyQuaternion(qYaw)
		.add(mid);
	return {
		pos: pos.toArray(),
		quat: qYaw.multiply(quat0).toArray(),
		scale: total
	};
}

function beginWorldGrab() {
	const rig = get(worldRig);
	if (!rig) return;
	S.worldPan = null; // the two-hand gesture replaces the single-hand pan
	S.worldGrab = {
		a0: renderer.xr.getController(0).getWorldPosition(new THREE.Vector3()),
		b0: renderer.xr.getController(1).getWorldPosition(new THREE.Vector3()),
		rig0: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x }
	};
}

export function updateWorldGrab() {
	const rig = get(worldRig);
	if (!rig || !S.worldGrab) return;
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(tempVector);
	const live = {
		start: { a: S.worldGrab.a0.toArray(), b: S.worldGrab.b0.toArray() },
		now: { a: a.toArray(), b: b.toArray() },
		rig0: S.worldGrab.rig0
	};
	// CO2: a registered divert (colocation) may consume the gesture wholesale —
	// the colocated grab writes the replicated roomAnchor instead of this rig
	for (const hooks of worldGrabDiverts) {
		try {
			if (hooks.apply?.(live)) return;
		} catch (error) {
			console.log('world-grab divert failed', error);
		}
	}
	const next = computeWorldGrabTransform(live.start, live.now, S.worldGrab.rig0);
	rig.position.fromArray(next.pos);
	rig.quaternion.fromArray(next.quat);
	rig.scale.setScalar(next.scale);
	rig.updateMatrixWorld(true);
}

/** convert a real-space delta vector into rig-local (grabbed objects live there) */
function realDeltaToRigLocal(vector) {
	const rig = get(worldRig);
	if (!rig) return vector;
	return vector.applyQuaternion(rig.quaternion.clone().invert()).divideScalar(rig.scale.x);
}

/**
 * Which top-level object contains a world point (100.3): grabbing with the
 * controller INSIDE an object needs no pointer. Exported for headless tests.
 * @param {any} point THREE.Vector3 @param {any} group objectsGroup
 */
export function containedTopLevel(point, group) {
	if (!group) return null;
	const box = new THREE.Box3();
	for (const child of group.children) {
		box.setFromObject(child);
		if (isFinite(box.min.x) && box.containsPoint(point)) return child;
	}
	return null;
}

/** @type {any} active VR vertex-handle drag: {index, offset} */
export let vertexGrab = null;
/** @type {any} active VR face grab (122): {index, pos0, quat0, push, scale} */
export let faceGrabHand = null;

/**
 * Face-mode trigger (122): a pending extrude/inset adjust commits; otherwise
 * extrude/inset START a live adjust on the highlighted face, move/delete commit
 * immediately. A grip grab in progress ignores the trigger.
 */
/** @type {any} 184/185: pointer-hand state while a live extrude/inset adjust runs */
export let faceAdjustHand = null;

export function vrFaceTrigger() {
	// 212: Multi mode — the trigger ACCUMULATES the pointed unit; the op button
	// applies to the whole set (no live adjust while multi-selecting)
	if (get(faceEditMulti)) {
		toggleFaceSelection(get(faceEditHoverTri));
		hapticPulse(0.2, 25);
		return;
	}
	if (commitFaceAdjust()) {
		faceAdjustHand = null; // the second trigger CONFIRMS the extrude/inset
		return;
	}
	if (faceGesturePending()) return; // a grip grab owns the gesture
	const op = get(faceEditOp);
	const target = currentTargetFace(); // 212: hovered polygon / face group
	if (!target) return;
	if (op === 'extrude' || op === 'inset') {
		if (beginFaceAdjust(target, /** @type {any} */ (op), get(faceEditAmount))) {
			// 184/185: capture the pointer hand so controller motion along the face
			// normal drives depth (extrude) / size (inset) until the next trigger
			const info = highlightedFaceInfo();
			const pIdx = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
			const pos = pIdx >= 0 ? renderer.xr.getController(pIdx).getWorldPosition(new THREE.Vector3()) : null;
			faceAdjustHand = info && pos ? { index: pIdx, lastPos: pos, normal: info.normal.clone() } : null;
		}
	} else commitArmedFaceOp();
}

/**
 * VR trigger while in VERTEX edit mode (159). It must NOT exit the session — a
 * stray trigger off the object used to cancel the whole edit. Exit is explicit
 * (Edit ▸ Done / the ring). 160 fills this with ray-pick + drag a vertex.
 * @param {number=} index
 */
// ray-pick a handle + start carrying it (rides the controller each frame). The
// grip drag (113) still works too. Shared by the hold + toggle styles.
/** @param {number} index */
function beginVertexCarry(index) {
	const handle = vrRaycastHandle(controllerRay(index ?? 0));
	if (handle < 0) return false;
	const handleWorld = vrBeginHandleDrag(handle);
	if (!handleWorld) return false;
	const controllerPos = renderer.xr.getController(index ?? 0).getWorldPosition(new THREE.Vector3());
	S.vertexTriggerGrab = { index: index ?? 0, offset: handleWorld.sub(controllerPos) };
	hapticPulse(0.3, 30);
	return true;
}
function endVertexCarry() {
	if (!S.vertexTriggerGrab) return;
	vrEndHandleDrag();
	S.vertexTriggerGrab = null;
	hapticPulse(0.3, 30);
}

// TOGGLE style (182: only when the hold setting is OFF) — a full trigger click
// grabs the picked vertex; the next click drops it.
/** @param {number} index */
export function vrVertexTrigger(index) {
	if (!get(editingObject)) return;
	// 183: in create-face mode a trigger click toggles the picked vertex into the
	// selection (once per click — the 'select' event) instead of grabbing it
	if (get(vrFaceCreateMode)) {
		const h = vrRaycastHandle(controllerRay(index ?? 0));
		if (h >= 0) toggleVertexSelection(h);
		return;
	}
	if (get(vrVertexHold)) return;
	if (S.vertexTriggerGrab) return endVertexCarry();
	beginVertexCarry(index);
}

// HOLD style (182, default) — grab on trigger press (selectstart), carry while
// held, drop on release (selectend).
/** @param {number} index */
export function vrVertexGrabStart(index) {
	// create-face selection is driven by the 'select' click, not the press
	if (!get(editingObject) || get(vrFaceCreateMode) || !get(vrVertexHold) || S.vertexTriggerGrab) return;
	beginVertexCarry(index);
}
export function vrVertexGrabEnd() {
	if (get(vrVertexHold)) endVertexCarry();
}

/** Is a trigger vertex-carry active? (160, for tests) */
export function vertexTriggerActive() {
	return !!S.vertexTriggerGrab;
}

/** @param {number} index */
export function onSqueezeStart(index) {
	// an armed prefab ghost cancels on grip (115) — nothing else grabs
	if (get(vrPrefabGhost)) {
		cancelPrefabGhost();
		return;
	}
	// face edit mode (122): grip the face under the ray to grab it (rigid
	// move/rotate; stick reels along the normal + scales). Exits are hub/Back.
	if (get(faceEditObject)) {
		const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
		const hit = edited ? controllerRay(index).intersectObject(edited, false)[0] : null;
		const fi = hit && hit.faceIndex != null ? faceIndexForTriangle(hit.faceIndex) : -1;
		if (fi >= 0 && beginFaceGrab(fi)) {
			const controller = renderer.xr.getController(index);
			faceGrabHand = {
				index,
				pos0: controller.getWorldPosition(new THREE.Vector3()),
				quat0: controller.getWorldQuaternion(new THREE.Quaternion()),
				push: 0,
				scale: 1
			};
			hapticPulse(0.3, 30);
			return;
		}
		// 158: aimed at the object but got no face -> swallow the grip; aimed
		// ELSEWHERE (e.g. the Edit Mesh menu) -> fall through so the window grab
		// below can detach + re-place the menu, like the radial ring.
		if (hit) return;
	}
	// vertex edit mode (113): grip a handle to drag its vertex
	if (get(editingObject)) {
		const handle = vrRaycastHandle(controllerRay(index));
		if (handle >= 0) {
			const handleWorld = vrBeginHandleDrag(handle);
			if (handleWorld) {
				const controllerPos = renderer.xr
					.getController(index)
					.getWorldPosition(new THREE.Vector3());
				vertexGrab = { index, offset: handleWorld.sub(controllerPos) };
				hapticPulse(0.3, 30);
			}
			return;
		}
	}
	// grip on a follower window (111): hold to detach it into adjust mode
	const windowId = windowHitAt(index);
	if (windowId) {
		S.windowGrabPending = { id: windowId, index, startedAt: Date.now() };
		return;
	}
	if (!get(objectsGroup)) return;
	const controller = renderer.xr.getController(index);
	// 30b P2: the grip takes what vrGrip.pickGripTarget says — scenery (floors, walls, the
	// room you stand in) passes through, and in INTERACT only a player-holdable body counts
	const mode = get(editorMode) === 'interact' ? 'interact' : 'edit';
	let object = gripTargetOf(controllerRay(index), controller.getWorldPosition(new THREE.Vector3()), mode);
	if (!object) {
		// 31-towers P1: a piece beyond the scene's reach says so with a short buzz, no more
		if (lastGripRefusal) hapticPattern('fail', renderer.xr.getController(index)?.userData?.handedness ?? undefined);
		// 30b P2: Interact's grips never move the world (contract C1) — 31 K1: unless the play
		// block allows it (`locomotion.worldGrab`); a grip on a grabbable still took it above
		if (!gripMovesWorld(mode, mode === 'interact' && vrLocomotionNow().worldGestures)) return;
		hintSceneryGrip();
		emptyAirSqueeze[index] = true;
		// 186: in stretch mode both grips drive the stretch, not a world grab
		if (get(vrStretchObject)) return;
		// both hands gripping air -> world grab (zoom/rotate/pan the world)
		if (emptyAirSqueeze[0] && emptyAirSqueeze[1]) {
			beginWorldGrab();
			return;
		}
		// gripping air with the RIGHT hand pans the world with the controller
		// (CO2: not while a divert claims the world — the pan offsets the XR
		// reference space, which would silently break a colocated alignment)
		const handedness = renderer.xr.getController(index)?.userData?.handedness ?? null;
		if (handedness === 'right' && !worldGestureDiverted())
			S.worldPan = { index, prev: renderer.xr.getController(index).getWorldPosition(new THREE.Vector3()), reach: panReach(index) };
		return;
	}
	if (get(lockedObjects).find((lock) => lock[1] === object.uuid)) return;

	const other = grabs[1 - index];
	if (other && other.object === object) {
		// 30b P2: a player's second hand does not resize the thing it is holding
		if (mode === 'interact') return;
		// second hand on the same object -> two-hand scale
		const distance = controllerDistance();
		S.scaleGrab = {
			object,
			startDistance: Math.max(distance, 0.05),
			startScale: object.scale.clone(),
			before: other.before
		};
		grabs[1 - index] = null;
		syncGrabbedHand();
		return;
	}
	// 33 G4: the OTHER hand keeps whatever it holds; only this hand's slot changes
	const previous = grabs[index];
	if (previous) {
		grabs[index] = null;
		endGrab(previous.object, previous.interact ? null : previous.before);
	}

	const interact = mode === 'interact';
	suspendAnimation(object.uuid); // animated objects park at their base while held
	// PFX-C: mid-sim, a VR-grabbed dynamic body follows the hand kinematically
	// and RELEASE throws it with the estimated hand velocity — the exact desktop
	// gizmo contract (holdBody/releaseBody). Dynamic import keeps the vrControls
	// import graph physics-free (the multiTransform pattern); no-op outside a sim.
	import('../physics').then((m) => m.holdBody(object.uuid));
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	// rigid attach (100): the object's pose RELATIVE to the controller, in the
	// object's parent space, stays constant while held — like a skewer
	object.parent.updateMatrixWorld(true);
	const parentQuat = object.parent.getWorldQuaternion(new THREE.Quaternion());
	const parentInv = object.parent.matrixWorld.clone().invert();
	const pPos = cPos.clone().applyMatrix4(parentInv);
	const pQuat = parentQuat.clone().invert().multiply(cQuat);
	perfMark('grab', { hand: index, interact: !!interact }); // 34 PF: a profiler marker
	grabs[index] = {
		object,
		index,
		// 30b P2: a player's hand is RIGID (no gizmo-style move/rotate), and `interact`
		// switches off the editor's extras in updateGrab/endGrab (snap, stick scale, undo)
		interact,
		style: interact ? 'rigid' : get(vrGrabStyle),
		relPos: object.position.clone().sub(pPos).applyQuaternion(pQuat.clone().invert()),
		relQuat: pQuat.clone().invert().multiply(object.quaternion),
		startScale: object.scale.clone(),
		scaleFactor: 1,
		prevPos: cPos,
		prevQuat: cQuat,
		before: transformStateOf(object)
	};
	syncGrabbedHand();
	// 30b (C4): a grab lands with a `hit` (a gated no-op in Edit, like every pulse)
	hapticPattern('hit', renderer.xr.getController(index)?.userData?.handedness ?? undefined);
	// 30b P2: a player picking something up is not SELECTING it — no lock broadcast, no
	// selection shell, no inspector (Edit keeps all three)
	if (!interact) selectObject(object.uuid); // locks it for peers, updates selection state
	// 30b (core-games): a PLAYER's grab reaches On Grab nodes (Edit moves things, it does not play)
	else fireObjectGrab(object.uuid);
}

/**
 * 30b P2: the top-level object a grip closes on, or null for empty air. Ray hits first
 * (nearest first, each top-level object once), then the hand-inside test (100.3); both go
 * through the vrGrip rule, so a floor, a wall or the room you stand in is never held.
 * Exported for the headless suite. @param {any} ray a THREE.Raycaster
 * @param {any} handPos the controller's world position @param {'edit'|'interact'} mode
 */
export function gripTargetOf(ray, handPos, mode) {
	lastGripRefusal = null;
	const group = get(objectsGroup);
	if (!group) return null;
	/** @type {any} */
	const camera = get(globalCamera);
	const head = camera ? camera.getWorldPosition(new THREE.Vector3()) : null;
	const locked = get(lockedObjects);
	const selectedNow = get(selectedObjects);
	const settings = mode === 'interact' ? resolvePlaySettings(get(globalScene)) : null;
	const interaction = settings ? settings.interaction : 'grab';
	// 31-towers P1: a player's grip reaches `play.reach` from the BODY (head down to the feet)
	const reach = settings?.reach ?? null;
	const feetY = head ? head.y - (viewerNow()?.headHeight ?? STANDING_HEAD) : 0;
	/** @param {any} object @param {any} point where the grip would take it */
	const describe = (object, point) => {
		const box = new THREE.Box3().setFromObject(object);
		const holdable =
			interaction === 'grab' &&
			object.userData?.physics?.mode === 'dynamic' &&
			!locked.find((/** @type {any} */ lock) => lock[1] === object.uuid);
		const near = !holdable || reach == null || !head || withinReach(point, head, feetY, reach);
		if (holdable && !near) lastGripRefusal = { uuid: object.uuid, reach };
		return {
			scenery: isScenery(box.isEmpty() ? null : box, head),
			grabbable: holdable && near,
			// 33 E4: in Edit a SELECTED wall/floor/arena is held like any object
			selected: selectedNow.includes(object.uuid)
		};
	};
	/** @type {any[]} */
	const order = [];
	/** @type {any[]} */
	const points = [];
	// 31 (Stars Room S2): a scene may switch POINTING off for players — then only a hand
	// inside the object holds it (below); the ray reaches nothing. Edit is never affected.
	const byRay = mode !== 'interact' || pointGrabAllowed();
	if (byRay) for (const hit of ray.intersectObjects(group.children, true)) {
		const top = topLevelObjectOf(hit.object);
		if (top && !order.includes(top)) {
			order.push(top);
			points.push(hit.point);
		}
	}
	const described = order.map((object, i) => describe(object, points[i]));
	const picked = pickGripTarget(described, mode);
	// 33 E4: the first thing along the ray was a wall/floor the grip passed through — the
	// hint below says how to move it instead (select it first)
	lastGripPassedScenery = mode === 'edit' && picked !== 0 && !!described[0]?.scenery;
	if (picked >= 0) {
		lastGripRefusal = null;
		return order[picked];
	}
	// a hand INSIDE an object needs no pointer (100.3) — the same rule decides
	const inside = containedTopLevel(handPos, group);
	if (inside && pickGripTarget([describe(inside, handPos)], mode) === 0) {
		lastGripRefusal = null;
		return inside;
	}
	return null;
}

/** 33 E4: did the last Edit grip pass THROUGH scenery (an unselected wall/floor) first? */
let lastGripPassedScenery = false;
const SCENERY_HINT_KEY = 'hint:vrSelectScenery';
/** Say ONCE (ever) how a wall or a floor moves in Edit: the grip that passed through it went
 * to the world, which reads as "this object cannot be moved" unless something says so. */
function hintSceneryGrip() {
	if (!lastGripPassedScenery || safeStorage.getItem(SCENERY_HINT_KEY) === 'true') return;
	safeStorage.setItem(SCENERY_HINT_KEY, 'true');
	import('../gameAnnounce')
		.then((m) => m.announce('Grip moves the world', { sub: 'To move a wall or a floor, select it with the trigger, then grip it', ms: 4500 }))
		.catch(() => {});
}

/** 31-towers P1: the grip the reach refused last ({uuid, reach}), for the buzz and the suite
 * @type {{uuid: string, reach: number} | null} */
let lastGripRefusal = null;
/** @returns {{uuid: string, reach: number} | null} */
export function lastGripRefusalDebug() {
	return lastGripRefusal;
}

/** @param {number} index */
export function onSqueezeEnd(index) {
	// face grab (122): release commits the reshape as one meshgeo + undo entry
	if (faceGrabHand?.index === index) {
		faceGrabHand = null;
		commitFaceGrab();
		hapticPulse(0.2, 30);
		return;
	}
	// vertex handle drag (113): release commits the pull + one undo entry
	if (vertexGrab?.index === index) {
		vrEndHandleDrag();
		vertexGrab = null;
		hapticPulse(0.18, 24);
		return;
	}
	// window grab (111): a short grip is a no-op, a held one re-anchors
	if (S.windowGrabPending?.index === index) {
		S.windowGrabPending = null;
		return;
	}
	if (S.windowGrab?.index === index) {
		finishWindowAdjust();
		return;
	}
	emptyAirSqueeze[index] = false;
	if (S.worldGrab) {
		// releasing either grip ends the world gesture; a still-held RIGHT grip
		// resumes the single-hand world pan without re-squeezing
		S.worldGrab = null;
		const other = index === 0 ? 1 : 0;
		if (emptyAirSqueeze[other]) {
			const handedness = renderer.xr.getController(other)?.userData?.handedness ?? null;
			if (handedness === 'right' && !worldGestureDiverted())
				S.worldPan = { index: other, prev: renderer.xr.getController(other).getWorldPosition(new THREE.Vector3()), reach: panReach(other) };
		}
		return;
	}
	if (S.worldPan?.index === index) S.worldPan = null;
	if (S.scaleGrab) {
		endGrab(S.scaleGrab.object, S.scaleGrab.before);
		S.scaleGrab = null;
		return;
	}
	const grab = grabs[index];
	if (grab) {
		// K2: a hook may consume the release (drop onto the sleeve = capture a
		// slot; the hook restores the object's pose + animation itself, so no
		// move commits — but the physics hold must still release)
		const object = grab.object;
		const consumed = gripDropHooks.some((fn) => {
			try {
				return !!fn(object, grab.before);
			} catch (error) {
				console.log('VR grip-drop hook failed', error);
				return false;
			}
		});
		if (consumed) {
			import('../physics').then((m) => m.releaseBody(object.uuid));
			grabs[index] = null;
			syncGrabbedHand();
			hapticPulse(0.4, 60);
			return;
		}
		grabs[index] = null;
		endGrab(object, grab.interact ? null : grab.before);
		syncGrabbedHand();
		hapticPulse(0.18, 24);
	}
}

function controllerDistance() {
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(tempVector);
	return a.distanceTo(b);
}

const deltaQuat = new THREE.Quaternion();

/**
 * Pure rigid-grab pose (100): controller pose in the object's parent space +
 * the constant relative offset -> object pose. Exported for headless tests.
 * @param {any} pPos controller position (parent space) @param {any} pQuat controller quaternion (parent space)
 * @param {any} relPos @param {any} relQuat
 */
export function rigidGrabPose(pPos, pQuat, relPos, relQuat) {
	return {
		position: pPos.clone().add(relPos.clone().applyQuaternion(pQuat)),
		quaternion: pQuat.clone().multiply(relQuat)
	};
}

/**
 * One frame of stick input while gripping (100.2): forward/back reels the
 * relative distance, left/right scales. Pure + clamped.
 * @param {{length: number, scale: number, x: number, y: number}} input
 */
export function grabStickAdjust({ length, scale, x, y }) {
	const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
	const reel = dead(y);
	const grow = dead(x);
	return {
		// stick forward (y negative in xr-standard) pushes the object AWAY,
		// pulling back reels it in
		length: Math.min(Math.max(length * (1 - reel * 0.03), 0.05), 60),
		scale: Math.min(Math.max(scale * (1 + grow * 0.025), 0.02), 25)
	};
}

/** @param {any} grab one hand's grab (33 G4: each hand updates its own) */
export function updateGrab(grab) {
	const controller = renderer.xr.getController(grab.index);
	const position = controller.getWorldPosition(new THREE.Vector3());
	const quaternion = controller.getWorldQuaternion(new THREE.Quaternion());
	const object = grab.object;

	if (grab.style === 'rigid') {
		// controller-as-handle (100): the object keeps its grab-start offset and
		// follows position AND rotation 1:1; the grab hand's stick reels + scales
		object.parent.updateMatrixWorld(true);
		const parentQuat = object.parent.getWorldQuaternion(new THREE.Quaternion());
		const parentInv = object.parent.matrixWorld.clone().invert();
		const pPos = position.clone().applyMatrix4(parentInv);
		const pQuat = parentQuat.clone().invert().multiply(quaternion);

		const axes = grab.interact ? [] : axesForSlot(grab.index); // 30b P2: no reel/scale in Interact
		const adjusted = grabStickAdjust({
			length: Math.max(grab.relPos.length(), 0.05),
			scale: grab.scaleFactor,
			x: axes[2] ?? 0,
			y: axes[3] ?? 0
		});
		if (grab.relPos.lengthSq() > 1e-8) grab.relPos.setLength(adjusted.length);
		if (adjusted.scale !== grab.scaleFactor) {
			grab.scaleFactor = adjusted.scale;
			object.scale.copy(grab.startScale).multiplyScalar(grab.scaleFactor);
		}

		const pose = rigidGrabPose(pPos, pQuat, grab.relPos, grab.relQuat);
		object.position.copy(pose.position);
		object.quaternion.copy(pose.quaternion);
		if (grab.interact) {
			// 30b P2: a player's hand does not snap
		} else if (get(vrSnapMode) === 'surface') {
			dropToSurface(object, get(objectsGroup)); // 156: rest on the nearest surface under it
		} else if (get(snapEnabled)) {
			const step = get(snapSettings).translate;
			object.position.x = Math.round(object.position.x / step) * step;
			object.position.z = Math.round(object.position.z / step) * step;
		}
		grab.prevPos.copy(position);
		grab.prevQuat.copy(quaternion);
		pokeScene();
		broadcastMove(object);
		return;
	}

	// legacy gizmo-style grabs (vrGrabStyle 'move' / 'rotate')
	if (grab.style === 'rotate') {
		deltaQuat.copy(grab.prevQuat).invert().premultiply(quaternion);
		// under a grabbed world (71) the hand delta converts into rig-local
		const rig = get(worldRig);
		if (rig) {
			const rigQuat = rig.quaternion;
			deltaQuat.premultiply(rigQuat.clone().invert()).multiply(rigQuat);
		}
		object.quaternion.premultiply(deltaQuat);
	} else {
		tempVector.copy(position).sub(grab.prevPos);
		realDeltaToRigLocal(tempVector); // 1:1 when the world is unscaled
		object.position.add(tempVector);
		if (get(vrSnapMode) === 'surface') {
			dropToSurface(object, get(objectsGroup)); // 156
		} else if (get(snapEnabled)) {
			const step = get(snapSettings).translate;
			object.position.x = Math.round(object.position.x / step) * step;
			object.position.z = Math.round(object.position.z / step) * step;
		}
	}
	grab.prevPos.copy(position);
	grab.prevQuat.copy(quaternion);
	pokeScene();
	broadcastMove(object);
}

export function updateScaleGrab() {
	const factorRaw = controllerDistance() / S.scaleGrab.startDistance;
	let factor = factorRaw;
	if (get(snapEnabled)) {
		const step = get(snapSettings).scale;
		factor = Math.max(Math.round(factorRaw / step) * step, step);
	}
	S.scaleGrab.object.scale.copy(S.scaleGrab.startScale).multiplyScalar(factor);
	pokeScene();
	broadcastMove(S.scaleGrab.object);
}
