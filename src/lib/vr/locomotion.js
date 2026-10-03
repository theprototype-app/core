// VR controls — locomotion: move offset, the bounded teleport + blink, snap/smooth turn, walking in Interact, spawn.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	objectsGroup,
	globalCamera,
	globalScene,
	vrSnapAngle,
	vrMirrorSnapTurn,
	vrTeleportEnabled,
	editorMode
} from '../../stores/sceneStore';
import { moduleWorldChildren } from '../moduleWorld';
import { teleportVerdictPure, shrinkBox, BOUNDS_INSET, PROBE_HEIGHT } from '../teleportRules';
import { walkable as dungeonWalkable } from '../dungeonPlay';
import { resolvePlaySettings, playPublishers } from '../playSettings';
import { locomotionPolicy, vrSpawnOffsets, yawForward } from '../locomotionPolicy';
import { resolveWalk, charControl } from '../charController';
import { gameFeelActive } from '../gameFeel';
import { resolveTurning, gameSettingValues } from '../gameSettings';
import { topLevelObjectOf } from '../objectActions';
import { S } from './state.js';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor } from './input.js';
import { withRayCamera, safeIntersect } from './pointer.js';
import { perfMark } from '../perf/perfMarks.js'; // 34 PF: a profiler marker, a leaf

/**
 * Pure locomotion math (agreed VR map): left stick moves/strafes — toward the
 * aim direction when flying, horizontally otherwise; holding the left grip
 * switches the stick to the old pan/elevate behavior. Offsets follow the
 * reference-space convention used across this file (positive = viewer moves
 * along negative axis), matching the previous stick feel.
 * @param {{x: number, y: number, grip: boolean, flying: boolean, aimDir: {x:number,y:number,z:number}, cameraDir: {x:number,y:number,z:number}, speed?: number}} input
 */
export function computeMoveOffset({ x, y, grip, flying, aimDir, cameraDir, speed = 0.05 }) {
	const offset = { x: 0, y: 0, z: 0 };
	const dead = (v) => (Math.abs(v) > 0.15 ? v : 0);
	const sx = dead(x);
	const sy = dead(y);
	if (!sx && !sy) return offset;

	if (grip) {
		// pan/elevate (the old left-stick behavior)
		offset.x += speed * 2 * sx * cameraDir.z;
		offset.z += -speed * 2 * sx * cameraDir.x;
		offset.y += speed * 2 * sy;
		return offset;
	}

	// forward/back along the aim (fly) or the horizontal camera direction
	// (stick up = axes[3] negative = forward, same sign rule the old code used)
	const dir = flying ? aimDir : { x: cameraDir.x, y: 0, z: cameraDir.z };
	const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
	const forward = { x: dir.x / length, y: dir.y / length, z: dir.z / length };
	offset.x += speed * sy * forward.x;
	offset.y += flying ? speed * sy * forward.y : 0;
	offset.z += speed * sy * forward.z;
	// strafe stays horizontal
	offset.x += speed * sx * cameraDir.z;
	offset.z += -speed * sx * cameraDir.x;
	return offset;
}

// --- teleport: hold the right stick UP = ballistic arc, release = blink ---

const arcRaycaster = new THREE.Raycaster();

/**
 * Sample a ballistic arc from origin along direction; lands on the ground
 * plane (y=0) or an upward-facing surface of a scene object.
 * 31 K1: `opts.bounded` (a game's teleport) stops at the FIRST surface the arc meets, of any
 * slope — a wall face ends it (and is refused as too steep) instead of the arc passing
 * through the wall to the floor behind — and `opts.roots` adds module content (a dungeon's
 * walls live under module-world-root, not objectsGroup). `normalY` is the landing's world
 * normal (1 on the floor plane).
 * @param {any} origin @param {any} direction @param {any=} group
 * @param {{bounded?: boolean, roots?: any[]}} [opts]
 * @returns {{points: any[], target: any | null, normalY: number}}
 */
export function computeTeleportArc(origin, direction, group, opts = {}) {
	const speed = 8;
	const gravity = -9.8;
	const step = 1 / 12;
	const maxT = 2.5;
	const velocity = direction.clone().normalize().multiplyScalar(speed);
	const points = [origin.clone()];
	let previous = origin.clone();
	let target = null;
	let normalY = 1;
	const bounded = !!opts.bounded;
	const roots = group ? [...group.children, ...(opts.roots ?? [])] : (opts.roots ?? []);

	for (let t = step; t <= maxT && !target; t += step) {
		const point = new THREE.Vector3(
			origin.x + velocity.x * t,
			origin.y + velocity.y * t + 0.5 * gravity * t * t,
			origin.z + velocity.z * t
		);
		if (roots.length) {
			const segment = point.clone().sub(previous);
			const length = segment.length();
			arcRaycaster.set(previous, segment.normalize());
			arcRaycaster.far = length;
			withRayCamera(arcRaycaster);
			/** @type {any[]} */ const hits = [];
			for (const root of roots) hits.push(...safeIntersect(arcRaycaster, root));
			hits.sort((x, y) => x.distance - y.distance);
			const landing = hits.find((hit) => {
				if (!hit.face) return false;
				if (bounded) return hit.object.visible !== false && !!(/** @type {any} */ (hit.object).isMesh);
				const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
				return normal.y > 0.5; // only land on top-ish faces
			});
			if (landing) {
				target = landing.point.clone();
				// @ts-ignore - a face is present (the find above)
				normalY = landing.face.normal.clone().transformDirection(landing.object.matrixWorld).y;
				points.push(target.clone());
				break;
			}
		}
		if (previous.y > 0 && point.y <= 0) {
			const k = previous.y / (previous.y - point.y);
			target = new THREE.Vector3(
				previous.x + (point.x - previous.x) * k,
				0,
				previous.z + (point.z - previous.z) * k
			);
			points.push(target.clone());
			break;
		}
		points.push(point.clone());
		previous = point;
	}
	return { points, target, normalY };
}

// ---- 31 K1 (D2/S1): THE BOUNDED TELEPORT -----------------------------------------------------
// Edit's teleport lands wherever the arc does. A game's (Interact/Play with
// `play.locomotion.teleport`) asks teleportRules for a verdict: walkable ground, inside the
// play area, no wall cell on the way, no collider or mesh crossed. Each rule reads its data in
// ITS OWN frame — a publisher's `play.bounds`/`play.colliders`/raster in the publisher group's
// local frame, the scene's bounds in objectsGroup's — so a world grab never skews a verdict.

/** content bounds per teleport engage (Box3 over the whole scene is not a per-frame cost) */
/** @type {any} */ let contentBoundsCache = null;

/** @param {any} object @param {{x: number, y: number, z: number}} p world -> the object's frame */
function toFrame(object, p) {
	const v = new THREE.Vector3(p.x, p.y, p.z);
	if (object) object.worldToLocal(v);
	return { x: v.x, y: v.y, z: v.z };
}

/** everything a teleport may land on or be stopped by: objectsGroup + registered module content */
function teleportRoots() {
	const group = get(objectsGroup);
	return [...(group ? group.children : []), ...moduleWorldChildren()];
}

/** the scene's content bounds (world), shrunk by BOUNDS_INSET on x and z; null when empty */
function contentBounds() {
	if (contentBoundsCache) return contentBoundsCache;
	const box = new THREE.Box3();
	for (const root of teleportRoots()) if (root.visible !== false) box.expandByObject(root);
	if (box.isEmpty()) return null;
	contentBoundsCache = shrinkBox({ min: box.min.toArray(), max: box.max.toArray() }, BOUNDS_INSET);
	return contentBoundsCache;
}

const _probeRay = new THREE.Raycaster();
/** does a mesh stand between the two ends, PROBE_HEIGHT above both? (world) */
function meshBetween(/** @type {any} */ from, /** @type {any} */ to) {
	const a = new THREE.Vector3(from.x, from.y + PROBE_HEIGHT, from.z);
	const b = new THREE.Vector3(to.x, to.y + PROBE_HEIGHT, to.z);
	const d = b.clone().sub(a);
	const length = d.length();
	if (length < 1e-4) return false;
	_probeRay.set(a, d.normalize());
	_probeRay.far = length;
	withRayCamera(_probeRay);
	return teleportRoots()
		.flatMap((root) => safeIntersect(_probeRay, root))
		.some((/** @type {any} */ hit) => hit.object.isMesh && hit.object.visible !== false && hit.distance > 0.05 && !movableBody(hit.object));
}

/** 31 K1: a DYNAMIC physics body (or a spawner's transient copy) is not a wall — a body you can
 * knock aside never refuses a teleport. Found by 31-stars-jam: the Stars Room's 24 floating
 * stars sit at 0.8-2.6 m, right on the 1.1 m probe, so any star in the line refused every
 * landing across the room. Static and pick-through solids (the room's glass) still block.
 * @param {any} mesh */
function movableBody(mesh) {
	const top = topLevelObjectOf(mesh);
	return !!top && (top.userData?.physics?.mode === 'dynamic' || top.userData?.transient === true);
}

/**
 * 31 K1: may a player standing at `from` (feet, world) teleport to `to` (a landing, world)
 * whose surface normal has y = `normalY`? The dungeon lane's e2e entry point too.
 * @param {number[] | {x: number, y: number, z: number} | null} fromRaw
 * @param {number[] | {x: number, y: number, z: number}} toRaw
 * @param {number} [normalY]
 * @returns {{ok: boolean, reason: string}}
 */
export function teleportVerdict(fromRaw, toRaw, normalY = 1) {
	const pt = (/** @type {any} */ p) => (Array.isArray(p) ? { x: +p[0], y: +p[1], z: +p[2] } : p);
	const from = fromRaw ? pt(fromRaw) : null;
	const to = pt(toRaw);
	const scene = /** @type {any} */ (get(globalScene));
	const play = resolvePlaySettings(scene);
	// 1 + 2: the surface and the play area
	/** @type {any} */ let verdict;
	if (play.bounds) {
		const owner = play.boundsOwner ?? get(objectsGroup);
		verdict = teleportVerdictPure({ to: toFrame(owner, to), normalY, bounds: play.bounds });
	} else verdict = teleportVerdictPure({ to, normalY, bounds: contentBounds() });
	if (!verdict.ok) return verdict;
	// 3: a dungeon raster, in its group's frame
	const dungeon = scene?.getObjectByName('dungeon-module');
	const raster = dungeon?.userData?.play;
	if (raster?.grid) {
		verdict = teleportVerdictPure({
			from: from ? toFrame(dungeon, from) : null,
			to: toFrame(dungeon, to),
			raster,
			walkable: dungeonWalkable
		});
		if (!verdict.ok) return verdict;
	}
	// 4: published collider boxes (each publisher's frame), then real meshes
	if (from) {
		for (const publisher of playPublishers(scene)) {
			const boxes = publisher.userData.play.colliders;
			if (!Array.isArray(boxes) || !boxes.length) continue;
			const colliders = boxes.filter((/** @type {any} */ b) => Array.isArray(b?.min) && Array.isArray(b?.max));
			verdict = teleportVerdictPure({ from: toFrame(publisher, from), to: toFrame(publisher, to), colliders });
			if (!verdict.ok) return verdict;
		}
		if (meshBetween(from, to)) return { ok: false, reason: 'blocked' };
	}
	return { ok: true, reason: 'ok' };
}

/** 31 K1: the live arc's verdict, for the suites @type {{engaged: boolean, bounded: boolean, valid: boolean, reason: string, target: number[] | null, color: number}} */
let teleportPreviewState = { engaged: false, bounded: false, valid: false, reason: '', target: null, color: 0 };
export function teleportPreview() {
	return { ...teleportPreviewState, engaged: S.teleportEngaged };
}
/** @type {any} */ let lastArc = null;
/** @type {any} */ let arcGroup = null;
/** @type {any} */ let arcLine = null;
/** @type {any} */ let arcDisc = null;
/** @type {any} */ let blinkSphere = null;

function ensureArcVisuals() {
	if (arcGroup) return;
	const scene = get(globalScene);
	if (!scene) return;
	arcGroup = new THREE.Group();
	arcGroup.name = 'teleport-arc';
	arcLine = new THREE.Line(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial({ color: 0x22cc66, transparent: true, opacity: 0.9, depthTest: false })
	);
	arcDisc = new THREE.Mesh(
		new THREE.CircleGeometry(0.35, 24),
		new THREE.MeshBasicMaterial({ color: 0x22cc66, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide })
	);
	arcDisc.rotation.x = -Math.PI / 2;
	arcGroup.add(arcLine, arcDisc);
	arcGroup.visible = false;
	scene.add(arcGroup);
}

/** @param {any[]} points @param {boolean} valid @param {any} target */
function showArc(points, valid, target) {
	ensureArcVisuals();
	if (!arcGroup) return;
	arcGroup.visible = true;
	arcLine.geometry.dispose();
	arcLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
	const color = valid ? 0x22cc66 : 0xcc3344;
	teleportPreviewState.color = color;
	arcLine.material.color.setHex(color);
	arcDisc.material.color.setHex(color);
	arcDisc.visible = !!target;
	if (target) arcDisc.position.set(target.x, target.y + 0.02, target.z);
}

export function hideArc() {
	if (arcGroup) arcGroup.visible = false;
}

/** @param {any} target @param {boolean} [bounded] 31 K1: a game's teleport lands the FEET on it */
function executeTeleport(target, bounded = false) {
	const space = renderer?.xr.getReferenceSpace();
	if (!space) return;
	const pose = bounded ? viewerNow() : null;
	const viewer = pose
		? new THREE.Vector3(pose.head.x, pose.head.y, pose.head.z)
		: renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
	// reference-space convention: offset = -(viewer displacement); Edit keeps its height, a
	// game's teleport stands you ON the landing (a step up onto a platform is a step up)
	const feet = pose ? pose.head.y - pose.headHeight : null;
	const t = { x: viewer.x - target.x, y: feet === null ? 0 : feet - target.y, z: viewer.z - target.z };
	renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(new XRRigidTransform(t)));
	// blink to soften the jump
	const camera = get(globalCamera);
	if (camera) {
		if (!blinkSphere) {
			blinkSphere = new THREE.Mesh(
				new THREE.SphereGeometry(0.2, 16, 12),
				new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 1, depthTest: false })
			);
			blinkSphere.renderOrder = 999;
		}
		blinkSphere.material.opacity = 1;
		blinkSphere.visible = true;
		camera.add(blinkSphere);
	}
	hapticPulse(0.4, 60);
}

/** Does a right-stick position arm the teleport arc? (up + more up than sideways). Pure for tests. @param {number} x @param {number} y */
export function teleportArms(x, y) {
	return y < -0.7 && Math.abs(y) > Math.abs(x);
}

/** Teleport state for tests (157) @returns {{enabled: boolean, engaged: boolean}} */
export function teleportState() {
	return { enabled: get(vrTeleportEnabled), engaged: S.teleportEngaged };
}

/** @param {any} session */
export function updateTeleport(session) {
	const sources = [...session.inputSources];
	const source = sources.find((s) => s.handedness === 'right');
	const x = source?.gamepad?.axes?.[2] ?? 0;
	const y = source?.gamepad?.axes?.[3] ?? 0;

	// 157: teleport can be disabled — reset any arm + hide the arc
	// 30b P3: ...and Interact allows it only when the scene's play block says so
	if (!get(vrTeleportEnabled) || !vrLocomotionNow().teleport) {
		S.teleportEngaged = false;
		hideArc();
		return;
	}

	if (!S.teleportEngaged) {
		// stick pushed clearly UP and more up than sideways -> arm
		if (teleportArms(x, y)) {
			S.teleportEngaged = true;
			contentBoundsCache = null; // re-measured once per aim
		} else {
			hideArc();
			return;
		}
	} else if (y > -0.4) {
		// released -> blink if we had a VALID landing (31 K1: an invalid, red one does nothing)
		S.teleportEngaged = false;
		if (lastArc?.target && lastArc.valid) {
			perfMark('teleport', { bounded: !!lastArc.bounded });
			executeTeleport(lastArc.target, lastArc.bounded);
		}
		lastArc = null;
		hideArc();
		return;
	}

	const pose = teleportArcPose(session);
	if (!pose) {
		hideArc();
		return;
	}
	// 31 K1: a GAME's teleport (Interact/Play) is bounded; Edit's lands where the arc does
	const bounded = get(editorMode) === 'interact';
	lastArc = computeTeleportArc(pose.origin, pose.direction, get(objectsGroup), bounded ? { bounded, roots: moduleWorldChildren() } : {});
	lastArc.bounded = bounded;
	let verdict = { ok: !!lastArc.target, reason: lastArc.target ? 'ok' : 'off-floor' };
	if (bounded && lastArc.target) {
		const viewer = viewerNow();
		const from = viewer ? { x: viewer.head.x, y: viewer.head.y - viewer.headHeight, z: viewer.head.z } : null;
		verdict = teleportVerdict(from, lastArc.target, lastArc.normalY);
	}
	lastArc.valid = verdict.ok;
	teleportPreviewState = {
		engaged: true,
		bounded,
		valid: verdict.ok,
		reason: verdict.reason,
		target: lastArc.target ? lastArc.target.toArray() : null,
		color: teleportPreviewState.color
	};
	showArc(lastArc.points, verdict.ok, lastArc.target);
}

/** D1 (roadmap 13): the teleport arc anchors to the RIGHT hand's controller
 * slot resolved by HANDEDNESS — this was the last raw `inputSources.indexOf`
 * holdout (194/210 class: the slot order and the inputSources order DIVERGE
 * after a hands<->controllers swap, so the arc came off the wrong controller).
 * Exported for headless tests. When the slots aren't stamped yet, falls back
 * to the CALLER's session inputSources order (also keeps fake-session tests
 * working). @param {any=} session @returns {{index: number, origin: any, direction: any} | null} */
export function teleportArcPose(session) {
	let index = controllerIndexFor('right');
	if (index < 0 && session)
		index = [...session.inputSources].findIndex((s) => s.handedness === 'right');
	if (index < 0) return null;
	const controller = renderer.xr.getController(index);
	const origin = controller.getWorldPosition(new THREE.Vector3());
	const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
		controller.getWorldQuaternion(new THREE.Quaternion())
	);
	return { index, origin, direction };
}

export function updateBlink() {
	if (!blinkSphere || !blinkSphere.visible) return;
	blinkSphere.material.opacity -= 0.12;
	if (blinkSphere.material.opacity <= 0) {
		blinkSphere.visible = false;
		blinkSphere.parent?.remove(blinkSphere);
	}
}

/** Thumbstick flick on the RIGHT hand rotates the rig in snaps around the viewer */
/**
 * Snap-turn rotation for a stick flick, in radians (155). deg 0 = Off -> no
 * turn; mirror flips left/right. Pure for tests.
 * @param {number} deg @param {number} x stick x @param {boolean} mirror
 */
export function snapTurnRadians(deg, x, mirror) {
	if (!deg) return 0; // Off
	const dir = (x > 0 ? -1 : 1) * (mirror ? -1 : 1);
	return THREE.MathUtils.degToRad(deg) * dir;
}

/** 31 K3: the turning in force — a game's own setting while playing it (snap / smooth /
 * off + angle), the device's snap angle everywhere else @returns {{mode: string, angle: number}} */
export function turningInForce() {
	const device = Number(get(vrSnapAngle)) || 0;
	if (!gameFeelActive()) return device ? { mode: 'snap', angle: device } : { mode: 'off', angle: 0 };
	return resolveTurning(get(gameSettingValues), device);
}
/** degrees per second at full stick for SMOOTH turning */
export const SMOOTH_TURN_DPS = 90;
let smoothTurnAt = 0;
/** the smooth turn applied last frame, radians — the comfort vignette reads it */
export let lastSmoothTurn = 0;

export function updateSnapTurn(session) {
	lastSmoothTurn = 0;
	if (S.teleportEngaged) return; // the stick is busy aiming a teleport
	const source = [...session.inputSources].find((s) => s.handedness === 'right');
	const x = source?.gamepad?.axes?.[2] ?? 0;
	const turning = turningInForce();
	if (turning.mode === 'smooth') {
		// 31 K3: SMOOTH turning — a continuous yaw proportional to the stick past a deadzone
		const now = performance.now();
		const dt = smoothTurnAt ? Math.min(0.1, (now - smoothTurnAt) / 1000) : 0;
		smoothTurnAt = now;
		if (Math.abs(x) < 0.2 || !dt) return;
		const mag = (Math.abs(x) - 0.2) / 0.8;
		const dir = (x > 0 ? -1 : 1) * (get(vrMirrorSnapTurn) ? -1 : 1);
		turnRigBy(THREE.MathUtils.degToRad(SMOOTH_TURN_DPS) * mag * dt * dir);
		lastSmoothTurn = THREE.MathUtils.degToRad(SMOOTH_TURN_DPS) * mag * dt;
		return;
	}
	smoothTurnAt = 0;
	if (Math.abs(x) < 0.4) {
		S.snapArmed = true;
		return;
	}
	if (!S.snapArmed || Math.abs(x) < 0.7) return;
	S.snapArmed = false;

	const angle = turning.mode === 'off' ? 0 : snapTurnRadians(turning.angle, x, get(vrMirrorSnapTurn));
	if (!angle) return; // snap-turn off
	turnRigBy(angle);
}

/** rotate the reference space about the viewer (turn in place) @param {number} angle radians */
function turnRigBy(angle) {
	const frame = renderer.xr.getFrame?.();
	const space = renderer.xr.getReferenceSpace();
	const pose = frame?.getViewerPose?.(space);
	if (!pose || !space) return;
	const p = pose.transform.position;
	const s = Math.sin(angle);
	const c = Math.cos(angle);
	// rotate the reference space about the viewer position (turn in place)
	const q = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
	const t = { x: p.x - (c * p.x + s * p.z), y: 0, z: p.z - (-s * p.x + c * p.z) };
	renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(new XRRigidTransform(t, q)));
}

// ---- 30b P3: WALK LIKE A GAME (Interact) ------------------------------------------------
// Edit keeps the editor's stick (VRControls.svelte: fly/strafe, left-grip pan/elevate,
// teleport, the world gestures). INTERACT walks: the left stick moves along the head's
// yaw at a walking pace, the step resolves through charController.resolveWalk — the SAME
// three tiers desktop's walker uses (the rapier capsule when a sim runs, a dungeon raster,
// the ground plane) — gravity pulls the feet down, a ~0.3 m step is climbed (the
// capsule's autostep), and nothing flies or teleports unless the play block allows it.
// The rig moves the WebXR way: by offsetting the reference space (offset = -(the viewer's
// displacement), the convention across this file).
//
// FEET. A headset reports the HEAD. The physical head height comes from the viewer pose in
// the BASE reference space captured at session start (local-floor: y 0 is the real floor),
// and the feet are the head's current world y minus it — robust to every offset any gesture
// applied since. Without a base space (a fake session in a suite), a standing 1.6 m head.

/** metres per second on a full stick */
export const VR_WALK_SPEED = 2.2;
/** a standing head when no base space can say better */
export const STANDING_HEAD = 1.6;
/** @type {any} */ let xrBaseSpace = null;

/** Scene's onsessionstart: remember the untouched reference space. */
export function noteXRBaseSpace() {
	xrBaseSpace = renderer?.xr?.getReferenceSpace?.() ?? null;
}

/** 30b P3: the locomotion rules in force right now (mode + the resolved play block). */
export function vrLocomotionNow() {
	const mode = get(editorMode) === 'interact' ? 'interact' : 'edit';
	return locomotionPolicy(mode, resolvePlaySettings(get(globalScene)).locomotion);
}

/** the viewer pose in the current space, and the head's physical height @returns {any} */
export function viewerNow() {
	const frame = renderer?.xr?.getFrame?.();
	const space = renderer?.xr?.getReferenceSpace?.();
	const pose = frame && space ? frame.getViewerPose?.(space) : null;
	if (!pose) return null;
	const base = xrBaseSpace ? frame.getViewerPose?.(xrBaseSpace) : null;
	const p = pose.transform.position;
	const o = pose.transform.orientation;
	const q = new THREE.Quaternion(o.x, o.y, o.z, o.w);
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
	return {
		head: { x: p.x, y: p.y, z: p.z },
		yaw: Math.atan2(-fwd.x, -fwd.z),
		headHeight: base ? base.transform.position.y : STANDING_HEAD
	};
}

/** @param {{x: number, y: number, z: number}} offset reference-space offset (-(displacement))
 * @param {{x: number, y: number, z: number, w: number}} [orientation] */
function offsetSpace(offset, orientation) {
	const space = renderer?.xr?.getReferenceSpace?.();
	if (!space) return false;
	renderer.xr.setReferenceSpace(
		space.getOffsetReferenceSpace(
			orientation ? new XRRigidTransform(offset, orientation) : new XRRigidTransform(offset)
		)
	);
	return true;
}

/**
 * 30b P3: ONE walker step as data — the wanted displacement from the stick, resolved against
 * the world. Exported so a suite drives it with a real simulation and no headset.
 * 31-towers P1: `jumpHeight` (metres) lets a jump edge (right A, `setJumpRequested`) leave the
 * ground — the Character Controller node's own jump, so desktop and VR share one authoring place.
 * @param {{head: {x: number, y: number, z: number}, headHeight: number, yaw: number,
 *   stick: {x: number, y: number}, dt: number, fly?: boolean, aim?: {x: number, y: number, z: number},
 *   jumpHeight?: number}} input
 * @returns {{dx: number, dy: number, dz: number, feet: number, grounded: boolean, source: string}}
 */
export function vrWalkStep(input) {
	const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
	const sx = dead(input.stick.x);
	const sy = dead(input.stick.y);
	const dt = Math.max(0, Math.min(input.dt, 0.1));
	const speed = VR_WALK_SPEED * dt;
	const fwd = input.fly && input.aim ? input.aim : yawForward(input.yaw);
	const flat = yawForward(input.yaw);
	// stick UP is negative y in xr-standard; strafe is always horizontal
	const right = { x: -flat.z, z: flat.x };
	const desired = {
		dx: speed * (-sy * fwd.x + sx * right.x),
		dz: speed * (-sy * fwd.z + sx * right.z),
		...(input.fly ? { dy: speed * -sy * (fwd.y ?? 0) } : {})
	};
	// the capsule is quantised to 10 cm so a nodding head does not rebuild it every frame
	const height = Math.min(2.1, Math.max(1, Math.round(input.headHeight * 10) / 10));
	const feet = input.head.y - input.headHeight;
	const r = resolveWalk({ x: input.head.x, y: feet, z: input.head.z }, height, dt, desired, {
		gravity: !input.fly,
		jumpHeight: input.fly ? 0 : Number(input.jumpHeight) || 0
	});
	return { dx: r.dx, dy: r.feet - feet, dz: r.dz, feet: r.feet, grounded: r.grounded, source: r.source };
}

/**
 * 30b P3: the Interact half of VRControls.svelte's stick task. Returns false in Edit (the
 * caller then runs the editor's own stick code unchanged).
 * @param {number} dt seconds @param {any} session
 */
export function tickVRInteractLocomotion(dt, session) {
	const policy = vrLocomotionNow();
	if (!policy.walk) return false;
	const viewer = viewerNow();
	if (!viewer) return true;
	const left = [...(session?.inputSources ?? [])].find((s) => s.handedness === 'left');
	const axes = left?.gamepad?.axes ?? [];
	/** @type {any} */
	let aim = null;
	if (policy.fly) {
		const index = controllerIndexFor('left');
		if (index >= 0) {
			const v = new THREE.Vector3(0, 0, -1).applyQuaternion(
				renderer.xr.getController(index).getWorldQuaternion(new THREE.Quaternion())
			);
			aim = { x: v.x, y: v.y, z: v.z };
		}
	}
	const step = vrWalkStep({
		head: viewer.head,
		headHeight: viewer.headHeight,
		yaw: viewer.yaw,
		stick: { x: axes[2] ?? 0, y: axes[3] ?? 0 },
		dt,
		fly: policy.fly,
		aim,
		jumpHeight: vrJumpHeight()
	});
	// fell out of the world: back to the spawn (or the origin)
	if (step.feet < -50) {
		// no spawn: stand back up on the origin, feet at 0
		if (!spawnPlayer())
			offsetSpace({ x: viewer.head.x, y: viewer.head.y - viewer.headHeight, z: viewer.head.z });
		return true;
	}
	if (step.dx || step.dy || step.dz) offsetSpace({ x: -step.dx, y: -step.dy, z: -step.dz });
	return true;
}

/**
 * 31-towers P1: the jump the VR walker has right now — the Character Controller node's
 * `jumpHeight` while it declares WALK mode and Interact walks (not flies); 0 = no jump, and the
 * right A button stays push-to-talk.
 * @returns {number}
 */
export function vrJumpHeight() {
	const control = get(charControl);
	if (!control || control.mode !== 'walk') return 0;
	const policy = vrLocomotionNow();
	if (!policy.walk || policy.fly) return 0;
	const h = Number(control.jumpHeight);
	return Number.isFinite(h) && h > 0 ? h : 0;
}

/**
 * 30b P4: put the player on the game's spawn — the runtime api.setSpawn, else the scene's
 * `play.spawn` (resolvePlaySettings). In VR the FEET land on it facing its yaw; on the
 * desktop the play camera does (PointerLockControls reads the same resolution). No spawn,
 * no move. @returns {boolean} whether the player was moved
 */
export function spawnPlayer() {
	const spawn = resolvePlaySettings(get(globalScene)).spawn;
	if (!spawn || !renderer?.xr?.getSession?.()) return false;
	const viewer = viewerNow();
	if (!viewer) return false;
	const { turn, move } = vrSpawnOffsets(viewer.head, viewer.yaw, viewer.headHeight, spawn);
	offsetSpace(turn.position, turn.orientation);
	offsetSpace(move);
	return true;
}
