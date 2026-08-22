// CO2 — THE CALIBRATION SESSION. colocation.js (CO1) is the pure maths leaf; this
// module is the ORCHESTRATION around it: the point+aim ritual's state machine, the
// same-spot fallback, roomKey minting, the VR wiring (radial entries, trigger
// swallowing, ghost markers, locomotion suppression) and the colocated world-grab
// divert. Kept apart from colocation.js on purpose — the leaf stays importable with no
// vrControls/vrRadialMenu edges, so its properties keep testing with nothing mounted.
//
// THE SESSION is drivable WITHOUT XR by design (the suite's requirement): `samplePoint`
// and `sampleAim` take plain vectors, and the VR trigger hook is a thin wrapper that
// reads the firing controller and calls them. A DEGENERATE aim (vertical — no yaw
// information) keeps the session alive in 'aim' with a toast naming the problem,
// because tearing the ritual down over a shaky wrist would make it feel broken.
//
// THE RE-APPLY SUBSCRIPTION lives HERE, not in colocation.js: a remote roomAnchor
// arriving while this device is aligned must re-seat the rig, and that is a module-level
// side effect — the leaf keeps every side effect behind an explicit call, while this
// module is guaranteed loaded at boot (App.svelte's startColocationCalibration). The
// subscription is also what makes the world-grab divert live: setRoomAnchor writes the
// store, the subscription re-composes the rig, and the SAME code path serves the local
// grabber and the colocated partner watching the anchor arrive.
//
// THE COLOCATED WORLD-GRAB (the plan's option (a), not the suppressor fallback):
// while `roomAlignment` is non-null the two-grip gesture writes the REPLICATED
// roomAnchor instead of bending the local rig. Inverting CO1's composition
// R_rig = M · K⁻¹ gives K' = R'⁻¹ · M for the rig transform R' the grab intends —
// componentwise q_K' = q_R'⁻¹·q_M and t_K' = q_R'⁻¹·(p_M − t_R'). The intended R' is
// the ordinary grab maths with the SCALE RATIO PINNED TO 1 (`colocatedGrabRig`),
// because colocation is 1:1 with a physical room — a stretch attempt gets a toast, not
// a zoom. Everything is yaw-only by construction (the grab yaws about +Y, M is yaw-only,
// and `normalizeRoomAnchor` flattens the result again at the boundary).
//
// SCENE-ROOT MARKERS (golden rule 5): the ghost point + aim arrow live at the scene
// root under ONE fixed-name group ('colocate-calibration'), never in objectsGroup —
// they are local guidance, and must not replicate, export or survive the session.

import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, globalRenderer, globalCamera, vrMenuHand } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { sessionHost } from './connectionState';
import {
	roomAlignment,
	roomKey,
	roomAnchor,
	alignmentFromPointAim,
	alignmentFromSpot,
	setRoomAlignment,
	setRoomAnchor,
	applyRoomAlignment,
	clearAlignment
} from './colocation';
import {
	controllerIndexFor,
	registerNavSuppressor,
	registerVRTriggerHooks,
	registerVRFrameHook,
	registerWorldGrabDivert,
	hapticPulse
} from './vrControls';
import { registerVRMenuEntry } from './vrRadialMenu';

const UP = new THREE.Vector3(0, 1, 0);
const MARKER_GROUP = 'colocate-calibration';

// ---- module state (every `let` ABOVE the module-level subscribe — the TDZ rule) ----

/** The ritual's phase: 'point' (waiting for the shared-point press), 'aim' (waiting
 * for the edge press), or null (no session).
 * @type {import('svelte/store').Writable<'point'|'aim'|null>} */
export const calibrating = writable(null);

/** @type {{roomKey: string, point: any, index: number}|null} the live session */
let session = null;
/** @type {any} the scene-root marker group while a session runs */
let markerGroup = null;
/** trailing-'select' swallow stamp (the vrSleeve idiom) */
let handledAt = 0;
/** one toast per stretch attempt burst, not one per frame */
let scaleToastAt = 0;
let registered = false;

// A remote roomAnchor arriving while THIS device is aligned must re-seat the rig —
// CO1 deliberately left the arrival un-applied (its applier is pure). This is also the
// one place the world-grab divert's rig write happens: setRoomAnchor -> this
// subscription -> applyRoomAlignment, identical for the grabbing peer and the watching
// one. applyRoomAlignment is a silent no-op with no alignment, so a non-colocated peer
// receiving an anchor is untouched. (Reads only; never writes a store — safe inside a
// subscriber.)
roomAnchor.subscribe(() => {
	if (get(roomAlignment)) applyRoomAlignment();
});

// ---- roomKey minting ---------------------------------------------------------

/**
 * The default room key, derived from the session so both colocated users MINT THE SAME
 * ONE without typing: the session HOST's peer id (the joiner holds it in `sessionHost`,
 * the host is the peer with `sessionHost === null` and uses its own id). Solo with no
 * peer at all falls back to 'room-1'. The VR flow just confirms it — no keyboard.
 * @returns {string}
 */
export function defaultRoomKey() {
	const host = get(sessionHost);
	/** @type {any} */
	const peer = get(peers);
	const id = typeof host === 'string' && host ? host : peer?.peer?.id;
	return id ? 'room-' + String(id).slice(0, 6) : 'room-1';
}

// ---- ghost markers (scene root, fixed names, removed on end/cancel) ----------

/** @returns {any|null} the marker group, created on demand at the SCENE ROOT */
function ensureMarkers() {
	const scene = get(globalScene);
	if (!scene) return null;
	if (markerGroup && markerGroup.parent === scene) return markerGroup;
	markerGroup?.parent?.remove(markerGroup);
	const group = new THREE.Group();
	group.name = MARKER_GROUP;
	const point = new THREE.Mesh(
		new THREE.SphereGeometry(0.02, 16, 12),
		// ghost look; depthWrite stays TRUE (the documented postprocessing trap)
		new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.85 })
	);
	point.name = 'colocate-point';
	const arrow = new THREE.ArrowHelper(
		new THREE.Vector3(0, 0, -1),
		new THREE.Vector3(),
		0.5,
		0x4da3ff,
		0.09,
		0.045
	);
	arrow.name = 'colocate-aim';
	arrow.visible = false;
	group.add(point);
	group.add(arrow);
	scene.add(group);
	markerGroup = group;
	return group;
}

function removeMarkers() {
	if (!markerGroup) return;
	markerGroup.parent?.remove(markerGroup);
	markerGroup.traverse((/** @type {any} */ node) => {
		node.geometry?.dispose?.();
		if (node.material?.dispose) node.material.dispose();
	});
	markerGroup = null;
}

// ---- the session state machine (fully drivable without XR) -------------------

/**
 * Open a calibration session. Restarting mid-session is a clean restart, not an error —
 * "I pressed the wrong spot" is the normal reason to come back here.
 * @param {{roomKey?: string}} [opts]
 * @returns {string} the key the session will stamp
 */
export function startCalibration(opts = {}) {
	const key = typeof opts.roomKey === 'string' && opts.roomKey ? opts.roomKey : defaultRoomKey();
	session = { roomKey: key, point: null, index: -1 };
	ensureMarkers();
	calibrating.set('point');
	showToast('Colocate: touch the shared point with the controller tip and pull the trigger');
	return key;
}

/**
 * First press: the agreed physical point, in THIS device's tracking coords.
 * @param {any} pos THREE.Vector3 or {x,y,z}
 * @returns {boolean} whether the sample was taken
 */
export function samplePoint(pos) {
	if (get(calibrating) !== 'point' || !session) return false;
	const x = Number(pos?.x);
	const y = Number(pos?.y);
	const z = Number(pos?.z);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
	session.point = new THREE.Vector3(x, y, z);
	const group = ensureMarkers();
	if (group) {
		const point = group.getObjectByName('colocate-point');
		const arrow = group.getObjectByName('colocate-aim');
		if (point) point.position.copy(session.point);
		if (arrow) {
			arrow.position.copy(session.point);
			arrow.visible = true;
		}
	}
	calibrating.set('aim');
	showToast('Point set — now aim the controller along the agreed edge and pull the trigger');
	return true;
}

/**
 * Second press: the agreed direction. On success this installs the alignment, seats the
 * rig and ENDS the session. A DEGENERATE aim (vertical — carries no yaw) keeps the
 * session alive in 'aim' with a toast naming the problem, so the user can just re-aim.
 * @param {any} dir THREE.Vector3 or {x,y,z}, tracking coords
 * @returns {any|null} the installed alignment record, or null when refused
 */
export function sampleAim(dir) {
	if (get(calibrating) !== 'aim' || !session?.point) return null;
	const alignment = alignmentFromPointAim(session.point, dir);
	if (!alignment) {
		showToast('That aim is too vertical to give a heading — hold the controller level along the edge and pull the trigger again');
		return null;
	}
	const record = setRoomAlignment(alignment, { roomKey: session.roomKey, source: 'calibration' });
	applyRoomAlignment();
	endSession();
	showToast('Colocated — room ' + (record?.roomKey ?? ''));
	hapticPulse(0.4, 60);
	return record;
}

/** Abandon the ritual: markers gone, state null, any WORKING alignment untouched. */
export function cancelCalibration() {
	if (!get(calibrating)) return;
	endSession();
	showToast('Calibration cancelled');
}

function endSession() {
	session = null;
	removeMarkers();
	calibrating.set(null);
}

/**
 * THE ZERO-SKILL FALLBACK: both users stand on the same spot facing the same way and
 * press one button (colocation.js owns the maths — floor projection + head heading).
 * @param {any} headPos tracking coords @param {any} headQuat head orientation
 * @param {{roomKey?: string}} [opts]
 * @returns {any|null} the installed alignment record
 */
export function colocateHere(headPos, headQuat, opts = {}) {
	const alignment = alignmentFromSpot(headPos, headQuat);
	if (!alignment) {
		showToast('Could not read a heading — look level and try again');
		return null;
	}
	const key =
		typeof opts.roomKey === 'string' && opts.roomKey
			? opts.roomKey
			: (get(roomKey) ?? defaultRoomKey());
	if (get(calibrating)) endSession();
	const record = setRoomAlignment(alignment, { roomKey: key, source: 'spot' });
	applyRoomAlignment();
	showToast('Colocated — room ' + (record?.roomKey ?? ''));
	return record;
}

/**
 * `colocateHere` off the LIVE viewpoint: the XR camera while presenting, the editor
 * camera on the desktop (the Settings row's path).
 * @returns {any|null}
 */
export function colocateHereFromView() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const cam = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : get(globalCamera);
	if (!cam) {
		showToast('No camera to colocate from');
		return null;
	}
	return colocateHere(
		cam.getWorldPosition(new THREE.Vector3()),
		cam.getWorldQuaternion(new THREE.Quaternion())
	);
}

/**
 * Leave colocation entirely: session gone, alignment cleared, rig back to identity,
 * roomKey dropped. Deliberately does NOT touch `roomAnchor` — that is the scene's, and
 * other peers may still be colocated against it (colocation.js says the same).
 */
export function stopColocation() {
	if (get(calibrating)) endSession();
	const was = !!get(roomAlignment);
	clearAlignment();
	roomKey.set(null);
	if (was) showToast('Colocation stopped — the world moves freely again');
}

// ---- the colocated world-grab divert (plan option (a)) ------------------------

/**
 * The two-grip world-grab maths with the SCALE RATIO PINNED TO 1 — the rigid part of
 * `computeWorldGrabTransform` (same midpoints, same +Y yaw, same application order),
 * because a colocated rig is 1:1 with a physical room by rule. Pure and exported so the
 * suite can compare the seam against it.
 * @param {{a: number[], b: number[]}} start hand positions at grab start (tracking)
 * @param {{a: number[], b: number[]}} now hand positions this frame
 * @param {{pos: number[], quat: number[]}} rig0 the rig at grab start
 * @returns {{pos: number[], quat: number[], stretch: number}} + the ATTEMPTED stretch
 */
export function colocatedGrabRig(start, now, rig0) {
	const a0 = new THREE.Vector3().fromArray(start.a);
	const b0 = new THREE.Vector3().fromArray(start.b);
	const a = new THREE.Vector3().fromArray(now.a);
	const b = new THREE.Vector3().fromArray(now.b);
	const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
	const mid = a.clone().add(b).multiplyScalar(0.5);
	const angle0 = Math.atan2(b0.z - a0.z, b0.x - a0.x);
	const angle = Math.atan2(b.z - a.z, b.x - a.x);
	const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, angle0 - angle);
	const pos = new THREE.Vector3().fromArray(rig0.pos).sub(mid0).applyQuaternion(qYaw).add(mid);
	return {
		pos: pos.toArray(),
		quat: qYaw.multiply(new THREE.Quaternion().fromArray(rig0.quat)).toArray(),
		stretch: Math.max(a.distanceTo(b), 0.001) / Math.max(a0.distanceTo(b0), 0.05)
	};
}

/**
 * Invert CO1's composition: given the rig transform R' a grab intends and this device's
 * alignment M, the anchor that makes every colocated device derive R' is
 *
 *     R' = M · K'⁻¹  =>  K' = R'⁻¹ · M
 *     q_K' = q_R'⁻¹ · q_M,   t_K' = q_R'⁻¹ · (p_M − t_R')
 *
 * Pure and exported for the suite (which also proves the FLIPPED order disagrees).
 * @param {{pos: number[], quat: number[]}} rig the intended CONTENT -> WORLD transform
 * @param {any} alignment this device's {px, py, pz, yaw}
 * @returns {{pos: number[], quat: number[]}|null}
 */
export function anchorFromRig(rig, alignment) {
	if (!rig || !alignment || typeof alignment.yaw !== 'number' || !Number.isFinite(alignment.yaw))
		return null;
	const invQr = new THREE.Quaternion().fromArray(rig.quat).invert();
	const qm = new THREE.Quaternion().setFromAxisAngle(UP, alignment.yaw);
	const pm = new THREE.Vector3(
		Number(alignment.px) || 0,
		Number(alignment.py) || 0,
		Number(alignment.pz) || 0
	);
	const quat = invQr.clone().multiply(qm);
	const pos = pm.sub(new THREE.Vector3().fromArray(rig.pos)).applyQuaternion(invQr);
	return { pos: pos.toArray(), quat: quat.toArray() };
}

/**
 * The divert vrControls consults every world-grab frame. Non-colocated -> false, the
 * ordinary rig-bending path runs untouched. Colocated -> the intended (scale-pinned)
 * rig transform becomes a replicated roomAnchor write; the roomAnchor subscription
 * above then re-seats OUR rig through the one compose path, and every colocated peer's
 * rig follows the same record — which is the whole point: one user drags the scene onto
 * the real table and their partner sees it land there too. `setRoomAnchor`'s monotonic
 * stamp absorbs the per-frame cadence (the scenePhysics gesture rule).
 * @param {{start: {a: number[], b: number[]}, now: {a: number[], b: number[]}, rig0: any}} grab
 * @returns {boolean} whether the gesture was consumed
 */
export function colocatedWorldGrab(grab) {
	const alignment = get(roomAlignment);
	if (!alignment) return false;
	const next = colocatedGrabRig(grab.start, grab.now, grab.rig0);
	if (Math.abs(next.stretch - 1) > 0.2 && Date.now() - scaleToastAt > 8000) {
		scaleToastAt = Date.now();
		showToast('World scale is locked 1:1 while colocated — Stop colocating to zoom');
	}
	const anchor = anchorFromRig(next, alignment);
	if (anchor) setRoomAnchor(anchor);
	return true;
}

// ---- VR wiring (through the GENERIC vrControls hook registries — the vrsleeve
// precedent; nothing here reaches vrControls internals) -------------------------

/** @param {number} index @returns {any|null} */
function controllerAt(index) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	return index >= 0 ? (renderer?.xr?.getController?.(index) ?? null) : null;
}

/**
 * selectstart while calibrating: press 1 samples the firing controller's TIP position,
 * press 2 its forward (-Z of the world quaternion; colocation.js projects it
 * horizontal). Always consumed while a session runs — a ritual press must never select
 * an object behind the shared point. @param {number} index @returns {boolean}
 */
export function calibrateTriggerStart(index) {
	if (!get(calibrating)) return false;
	handledAt = Date.now();
	const controller = controllerAt(index);
	if (!controller) return true;
	if (get(calibrating) === 'point') {
		if (session) session.index = index;
		samplePoint(controller.getWorldPosition(new THREE.Vector3()));
		hapticPulse(0.3, 40);
	} else {
		sampleAim(
			new THREE.Vector3(0, 0, -1).applyQuaternion(
				controller.getWorldQuaternion(new THREE.Quaternion())
			)
		);
	}
	return true;
}

/** the trailing 'select' click after a ritual press must not fall through to
 * raycastSelect (the vrSleeve swallow idiom) @returns {boolean} */
export function calibrateSwallowSelect() {
	return !!get(calibrating) || Date.now() - handledAt < 300;
}

/** Per-frame marker guidance in XR: during 'point' the ghost rides the pointing tip;
 * during 'aim' the arrow previews the live heading from the sampled point. */
export function updateCalibrationMarkers() {
	const state = get(calibrating);
	if (!state) return;
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!renderer?.xr?.isPresenting) return;
	const group = ensureMarkers();
	if (!group) return;
	const index =
		session && session.index >= 0
			? session.index
			: controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
	const controller = controllerAt(index);
	const point = group.getObjectByName('colocate-point');
	const arrow = group.getObjectByName('colocate-aim');
	if (state === 'point') {
		if (controller && point) point.position.copy(controller.getWorldPosition(new THREE.Vector3()));
	} else if (state === 'aim' && session?.point) {
		if (point) point.position.copy(session.point);
		if (arrow && controller) {
			const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
				controller.getWorldQuaternion(new THREE.Quaternion())
			);
			dir.y = 0;
			if (dir.lengthSq() > 1e-6) arrow.setDirection(dir.normalize());
		}
	}
}

/**
 * Wire everything at boot (App.svelte onMount — the startTrackpadNav shape,
 * idempotent). Locomotion is suppressed BOTH while calibrating (a stick flick
 * mid-ritual moves the rig under the sampled point) and while COLOCATED: stick
 * locomotion, teleport and snap-turn all offset the XR reference space, which silently
 * invalidates the room mapping — a colocated user walks with their feet, or stops
 * colocating first. The same reasoning gates the single-grip world PAN through the
 * divert registry's `active` half.
 */
export function startColocationCalibration() {
	if (registered) return;
	registered = true;
	registerNavSuppressor(() => !!get(calibrating) || !!get(roomAlignment));
	registerVRTriggerHooks({
		start: calibrateTriggerStart,
		end: () => !!get(calibrating),
		swallow: calibrateSwallowSelect
	});
	registerVRFrameHook(updateCalibrationMarkers);
	registerWorldGrabDivert({ active: () => !!get(roomAlignment), apply: colocatedWorldGrab });

	// the radial menu: Scene ▸ Colocate ▸ (start/cancel the ritual · colocate here ·
	// stop) — entries carry their own actions, ids resolve through the registry
	registerVRMenuEntry({
		id: 'nav:colocate',
		group: 'scene',
		label: () => (get(roomAlignment) ? 'Colocated ▸' : 'Colocate ▸'),
		order: 2,
		ring: 'colocate'
	});
	registerVRMenuEntry({
		id: 'colo:calibrate',
		group: 'colocate',
		label: () => (get(calibrating) ? 'Cancel ritual' : 'Point + aim'),
		order: 0,
		active: () => !!get(calibrating),
		closes: true,
		action: () => (get(calibrating) ? cancelCalibration() : void startCalibration())
	});
	registerVRMenuEntry({
		id: 'colo:here',
		group: 'colocate',
		label: 'Colocate here',
		order: 1,
		closes: true,
		action: () => void colocateHereFromView()
	});
	registerVRMenuEntry({
		id: 'colo:stop',
		group: 'colocate',
		label: () => 'Stop colocating' + (get(roomKey) ? ' (' + get(roomKey) + ')' : ''),
		order: 2,
		closes: true,
		visible: () => !!get(roomAlignment),
		action: () => stopColocation()
	});
}

/** test/debug view */
export function calibrateDebug() {
	const scene = get(globalScene);
	const group = scene?.getObjectByName?.(MARKER_GROUP) ?? null;
	return {
		calibrating: get(calibrating),
		sessionKey: session?.roomKey ?? null,
		point: session?.point ? session.point.toArray() : null,
		markers: group
			? group.children.map((/** @type {any} */ c) => ({ name: c.name, visible: c.visible }))
			: null,
		registered
	};
}
