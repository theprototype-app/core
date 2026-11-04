// 68 V1-V3 — FILM MODE, the runtime half (a lazy chunk: only FilmMode.svelte imports it).
//
// The phone becomes a scene camera's viewfinder. Film reuses the 16-P5 camera preview (a real
// camera built from the marker, letterboxed to the shot's aspect) and takes its pose over
// through `setFilmPoseHook`, which CameraPreview asks every frame before anything else — so the
// frame loop IS Film's loop: orientation, movement and (V4) sampling all run inside that hook,
// in step with what is drawn.
//
// The MARKER does not move while you film: the live pose is the phone's, held here, and reaches
// peers as presence (V7), never as `move` edits. A recorded take becomes prop tracks (V4).
//
// ORIENTATION SOURCES, first that delivers wins for the session (two sources have two yaw
// bases, so they are never mixed): RelativeOrientationSensor (Generic Sensor, Chrome Android),
// else `deviceorientation` (iOS asks for permission on a tap), else TOUCH — drag to look, which
// is also the desktop / e2e path. Drag-to-look still turns the yaw with a gyro (the 360-video
// convention), and Recentre makes where the phone points now the camera's starting direction.
import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { startCameraPreview, stopCameraPreview, setFilmPoseHook, cameraPreview } from '../cameraPreview';
import { findCameraObject, cameraSpec } from '../cameraObjects';
import { recordingClean } from '../helperLayer';
import { skipTargets, applyProps, releaseProps } from '../propPlayback';
import { objectsGroup, worldRig } from '../../stores/sceneStore';
import { holdCamera } from '../sequencePlayer';
import { safeStorage } from '../safeStorage';
import { registerDebugHook } from '../debugHooks';
import { showToast, peers } from '../../stores/appStore';
import { postStackFor, addPostEffect, POST_SCENE_KEY } from '../scenePost';
import {
	IDENTITY,
	quatAxisAngle,
	quatMul,
	quatNorm,
	cameraQuatFromDevice,
	deviceQuatFromAngles,
	forwardOf,
	yawOf,
	recentreOffset,
	filmOrientation,
	withRoll,
	moveStep,
	tripodOrientation,
	lookAtQuat,
	quatConj,
	clampFov,
	oneEuro,
	oneEuroQuat,
	smoothingParams,
	levelHorizon
} from './filmCore';

const D2R = Math.PI / 180;
/** thumbstick top speeds (m/s); the chip cycles them */
export const SPEEDS = Object.freeze([0.5, 1, 2, 4, 8]);
/** no reading for this long = no motion sensor here: touch look */
const SENSOR_WAIT_MS = 1500;

/**
 * What the overlay shows. `sensor`: 'starting' (waiting for a first reading), 'gyro', 'touch'
 * (no sensor — drag to look), 'permission' (iOS: a tap must ask), 'denied'.
 * `rig`: 'handheld' | 'tripod' (position locked, pan / tilt only) | 'track' (keeps `target` framed).
 * @typedef {{uuid: string, name: string, aspect: string, sensor: string, source: string,
 *   horizonLock: boolean, speed: number, fov: number, roll: number, smoothing: number,
 *   rig: string, target: string, targetName: string, focus: number|null, aperture: number|null, walk?: boolean, heightLock?: boolean}} FilmUi
 */
/** @type {import('svelte/store').Writable<FilmUi | null>} */
export const film = writable(null);

/** the live state, outside the store: written every frame */
const live = {
	uuid: '',
	/** @type {number[]} world position */
	pos: [0, 0, 0],
	/** @type {number[]} the marker's world orientation when Film began */
	startQ: IDENTITY.slice(),
	/** @type {number[] | null} the latest device rotation (Earth frame) */
	deviceQ: null,
	/** @type {'' | 'sensor' | 'event'} the source that delivered first */
	source: '',
	/** @type {number[]} recentre: a yaw offset in front of the sensor orientation */
	offset: IDENTITY.slice(),
	/** set on the first reading: the offset that makes the start face the marker's way */
	aligned: false,
	dragYaw: 0,
	dragPitch: 0,
	stick: { x: 0, y: 0 },
	lift: 0,
	roll: 0,
	/** @type {number} vertical fov, degrees */
	fov: 50,
	/** the marker's own lens when Film began (a take's base values) */
	base: /** @type {Record<string, number>} */ ({}),
	/** @type {number[]} the orientation drawn last frame */
	q: IDENTITY.slice(),
	lastT: 0,
	/** V8 focus pull: the distance shown, and where a pull is heading (eased over FOCUS_PULL_S) */
	/** @type {number | null} */
	focus: null,
	/** @type {{from: number, to: number, start: number} | null} */
	pull: null,
	/** @type {number | null} f-number; null = no depth of field asked for */
	aperture: null,
	/** track-a-target: the framing offset kept since the tap @type {number[] | null} */
	trackOffset: null,
	/** the One-Euro filters (null = raw handheld) @type {any} */
	posFilter: null,
	/** @type {any} */
	quatFilter: null,
	/** the marker the live lens is posed on (so the post look reads it) @type {any} */
	lensObject: null
};

/** how long a focus pull takes, seconds */
export const FOCUS_PULL_S = 0.6;

/** @type {Array<() => void>} */
let teardown = [];
/** @type {any} */
let sensor = null;
let sensorTimer = 0;
/** @type {boolean | null} the clean-view flag before Film set it */
let cleanBefore = null;
/** @type {Set<(pose: FilmPose, dt: number) => void>} per-frame listeners (the recorder, presence) */
const frameListeners = new Set();

/** @typedef {{pos: number[], q: number[], qBase: number[], fov: number, roll: number, focus?: number, aperture?: number,
 *   rawPos?: number[], rawQBase?: number[]}} FilmPose */

/** @param {Partial<FilmUi>} patch */
function patchUi(patch) {
	film.update((s) => (s ? { ...s, ...patch } : s));
}

/** the screen's rotation (0 / 90 / 180 / 270) — portrait is 0 */
function screenAngle() {
	if (typeof window === 'undefined') return 0;
	const a = window.screen?.orientation?.angle;
	if (typeof a === 'number') return a;
	const legacy = /** @type {any} */ (window).orientation;
	return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}

/** the camera orientation the sensor says right now (no offsets), or null */
function sensorCamQ() {
	return live.deviceQ ? cameraQuatFromDevice(live.deviceQ, screenAngle()) : null;
}

/** pitch (radians, + = up) of an orientation's forward @param {number[]} q */
function pitchOf(q) {
	const f = forwardOf(q);
	return Math.atan2(f[1], Math.hypot(f[0], f[2]));
}

/** The orientation Film draws this frame (before horizon lock / roll). */
function rawOrientation() {
	const camQ = sensorCamQ();
	if (camQ) {
		const q = quatMul(live.offset, camQ);
		return live.dragYaw ? quatMul(quatAxisAngle([0, 1, 0], live.dragYaw), q) : q;
	}
	// touch look: yaw + pitch about the start, no roll (a dragged camera has no reason to tilt)
	const yaw = yawOf(live.startQ) + live.dragYaw;
	const pitch = Math.max(-1.5, Math.min(1.5, pitchOf(live.startQ) + live.dragPitch));
	return quatNorm(quatMul(quatAxisAngle([0, 1, 0], yaw), quatAxisAngle([1, 0, 0], pitch)));
}

/** @param {number[]} deviceQ @param {'sensor' | 'event'} source */
function onDeviceRotation(deviceQ, source) {
	if (live.source && live.source !== source) return;
	if (!live.source) {
		live.source = source;
		clearTimeout(sensorTimer);
		patchUi({ sensor: 'gyro', source });
	}
	live.deviceQ = deviceQ;
	if (!live.aligned) {
		// the first reading: whatever way the phone points, the camera starts facing the marker's way
		live.aligned = true;
		const camQ = sensorCamQ();
		if (camQ) live.offset = recentreOffset(camQ, live.startQ);
		live.dragYaw = 0;
	}
}

/** @param {DeviceOrientationEvent} e */
function onOrientationEvent(e) {
	if (e.alpha == null && e.beta == null && e.gamma == null) return;
	onDeviceRotation(deviceQuatFromAngles(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0), 'event');
}

function listenForMotion() {
	if (typeof window === 'undefined') return;
	window.addEventListener('deviceorientation', onOrientationEvent);
	teardown.push(() => window.removeEventListener('deviceorientation', onOrientationEvent));
	const Relative = /** @type {any} */ (window).RelativeOrientationSensor;
	if (typeof Relative === 'function') {
		try {
			const s = new Relative({ frequency: 60, referenceFrame: 'device' });
			s.addEventListener('reading', () => {
				if (s.quaternion) onDeviceRotation(Array.from(s.quaternion), 'sensor');
			});
			// NotAllowed / NotReadable: no sensor here — the event path (or touch) carries on
			s.addEventListener('error', () => stopSensor());
			s.start();
			sensor = s;
		} catch {
			sensor = null;
		}
	}
	armSensorWait();
}

/**
 * 'starting' until the first reading; none in SENSOR_WAIT_MS → iOS (requestPermission exists and
 * nothing arrives until a tap grants it) asks, everything else falls back to touch. Asking only
 * when nothing came keeps a browser that HAS requestPermission but streams anyway (desktop
 * Chromium, some Android builds) from showing a needless button. A screen without touch is never
 * held up as a camera, so it gets drag-to-look even where requestPermission exists (desktop Chromium).
 */
function armSensorWait() {
	clearTimeout(sensorTimer);
	patchUi({ sensor: 'starting' });
	sensorTimer = /** @type {any} */ (setTimeout(() => {
		if (!live.source) patchUi({ sensor: needsPermission() ? 'permission' : 'touch' });
	}, SENSOR_WAIT_MS));
}

function stopSensor() {
	try {
		sensor?.stop?.();
	} catch {
		/* already stopped */
	}
	sensor = null;
}

/** iOS: motion needs a permission asked from a tap (only on a touch screen — see armSensorWait). */
function needsPermission() {
	const DOE = typeof window !== 'undefined' ? /** @type {any} */ (window).DeviceOrientationEvent : null;
	return !!DOE && typeof DOE.requestPermission === 'function' && navigator.maxTouchPoints > 0;
}

/** The "Use phone motion" tap (iOS). */
export async function enableMotion() {
	const DOE = /** @type {any} */ (window).DeviceOrientationEvent;
	try {
		const answer = await DOE.requestPermission();
		if (answer !== 'granted') {
			patchUi({ sensor: 'denied' });
			showToast('Motion is off — drag to look instead (Settings ▸ Safari ▸ Motion & Orientation Access)');
			return false;
		}
	} catch {
		patchUi({ sensor: 'denied' });
		return false;
	}
	armSensorWait(); // the listeners are already on; readings start now
	return true;
}

/**
 * The per-frame pose hook (CameraPreview calls it before following the marker).
 * @param {any} camera @param {string} uuid
 */
function frame(camera, uuid) {
	if (!live.uuid || uuid !== live.uuid) return false;
	// AR walk: the headset runtime poses the camera, filmWalk feeds walkFrame from the XR frame
	if (walking) return true;
	const now = performance.now() / 1000;
	const dt = live.lastT ? Math.min(0.25, Math.max(0, now - live.lastT)) : 0;
	live.lastT = now;
	liveCamera = camera;
	const ui = get(film);
	// the orientation WITHOUT the dutch dial: a take records it as its own `camera.roll` track
	const sensed = filmOrientation(rawOrientation(), { horizonLock: !!ui?.horizonLock });
	const rig = ui?.rig ?? 'handheld';
	if (dt && rig !== 'tripod' && (live.stick.x || live.stick.y || live.lift))
		live.pos = moveStep(live.pos, sensed, live.stick, live.lift, ui?.speed ?? 1, dt);
	if (heightY !== null) live.pos[1] = heightY;
	let qBase = sensed;
	if (rig === 'tripod') qBase = tripodOrientation(sensed);
	else if (rig === 'track') {
		const target = targetPos(ui?.target ?? '');
		if (target) qBase = lookAtQuat(live.pos, target, live.trackOffset ?? undefined);
	}
	// V5 smoothing (F3): what you see is the smoothed pose, and the take keeps the raw one too
	const rawPos = live.pos.slice();
	const rawQBase = qBase;
	let pos = rawPos;
	if (live.posFilter) pos = live.posFilter.filter(rawPos, now);
	if (live.quatFilter) qBase = live.quatFilter.filter(qBase, now);
	const pose = finishPose(pos, qBase, rawPos, rawQBase, now, dt);
	camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
	camera.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
	if (camera.isPerspectiveCamera && Math.abs(camera.fov - pose.fov) > 1e-4) {
		camera.fov = pose.fov;
		camera.updateProjectionMatrix();
	}
	return true;
}

/**
 * The shared tail of a frame (the gyro path and the AR walk): focus pull, the lens values, the
 * recorder's Move fly, the dutch roll, then presence + the frame listeners.
 * @param {number[]} pos @param {number[]} qBase @param {number[]} rawPos @param {number[]} rawQBase
 * @param {number} now seconds @param {number} dt @returns {FilmPose}
 */
function finishPose(pos, qBase, rawPos, rawQBase, now, dt) {
	if (live.pull) {
		const s = Math.min(1, (now - live.pull.start) / FOCUS_PULL_S);
		const e = s * s * (3 - 2 * s);
		live.focus = live.pull.from + (live.pull.to - live.pull.from) * e;
		if (s >= 1) live.pull = null;
	}
	/** @type {FilmPose} */
	let pose = { pos, qBase, q: qBase, fov: live.fov, roll: live.roll, rawPos, rawQBase };
	if (live.focus !== null) pose.focus = live.focus;
	if (live.aperture !== null) pose.aperture = live.aperture;
	// the recorder's Move fly blends from the last frame of the previous shot to here
	if (poseFilter) pose = poseFilter(pose, now) ?? pose;
	pose.q = withRoll(pose.qBase, pose.roll);
	drawn = pose;
	live.q = pose.q;
	poseLens(pose);
	sendPresence(pose);
	for (const fn of frameListeners) fn(pose, dt);
	return pose;
}

// ---- V8 wave 2: height lock — the camera keeps the height it had when locked ------------
/** @type {number | null} */
let heightY = null;
/** @param {boolean} on */
export function setHeightLock(on) {
	heightY = on ? (drawn?.pos[1] ?? live.pos[1]) : null;
	patchUi({ heightLock: heightY !== null });
}

// ---- V3 AR walk (filmWalk.js drives it) ------------------------------------------------
let walking = false;

/** filmWalk: the session took over (true) or ended (false) @param {boolean} on */
export function setWalking(on) {
	walking = !!on;
	live.lastT = 0;
	patchUi({ walk: walking });
}

/**
 * One AR frame: the phone's tracked pose, already mapped into the scene (CONTENT frame). The XR
 * runtime draws the view itself; Film records + publishes what it would have drawn.
 * @param {number[]} pos @param {number[]} q @param {any} camera the camera the XR view renders through
 */
export function walkFrame(pos, q, camera) {
	if (!walking || !live.uuid) return null;
	const now = performance.now() / 1000;
	const dt = live.lastT ? Math.min(0.25, Math.max(0, now - live.lastT)) : 0;
	live.lastT = now;
	liveCamera = camera;
	if (heightY !== null) pos = [pos[0], heightY, pos[2]];
	live.pos = pos.slice();
	const qBase = get(film)?.horizonLock ? levelHorizon(q) : q;
	return finishPose(pos.slice(), qBase, pos.slice(), qBase, now, dt);
}

/** the stick + lift while walking: they slide the walk's anchor (filmWalk asks) @param {number[]} q @param {number} dt */
export function walkNudge(q, dt) {
	const ui = get(film);
	if (!dt || (!live.stick.x && !live.stick.y && !live.lift)) return null;
	const from = [0, 0, 0];
	return moveStep(from, q, live.stick, live.lift, ui?.speed ?? 1, dt);
}

/** where Film started looking (the marker's heading) — the walk's recentre target */
export function startHeading() {
	return live.startQ.slice();
}

// ---- V7 presence: peers see the live camera (filmPresence.js poses it on their side) ----
const presence = { rec: false, lastAt: 0, sent: false };
const PRESENCE_MS = 66;
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpPQ = new THREE.Quaternion();

/** the recorder says whether a take is rolling (peers see a recording camera) @param {boolean} on */
export function setPresenceRecording(on) {
	presence.rec = !!on;
	presence.lastAt = 0;
}

/** @param {FilmPose} pose */
function sendPresence(pose) {
	const now = performance.now();
	if (now - presence.lastAt < PRESENCE_MS) return;
	presence.lastAt = now;
	const peer = /** @type {any} */ (get(peers));
	if (!peer?.peer?.id || !peer.openedPeers?.size) return;
	// the marker's PARENT frame: what a receiver writes onto its own copy of the marker
	tmpV.fromArray(pose.pos);
	tmpQ.fromArray(pose.qBase);
	const parentM = parentInContent(findCameraObject(live.uuid));
	if (parentM) {
		tmpM.copy(parentM).invert();
		tmpV.applyMatrix4(tmpM);
		parentM.decompose(new THREE.Vector3(), tmpPQ, new THREE.Vector3());
		tmpQ.premultiply(tmpPQ.invert());
	}
	peer.send({ type: 'filmpose', peerId: peer.peer.id, uuid: live.uuid, pos: tmpV.toArray(), q: tmpQ.toArray(), fov: pose.fov, roll: pose.roll, rec: presence.rec });
	presence.sent = true;
}

function presenceOff() {
	if (!presence.sent) return;
	presence.sent = false;
	presence.rec = false;
	const peer = /** @type {any} */ (get(peers));
	if (peer?.peer?.id) peer.send({ type: 'filmpose', peerId: peer.peer.id, off: true });
}

/**
 * The lens values a post look reads (depth of field) live on the MARKER's userData.camera — posed
 * LOCALLY through prop playback (base restored on exit, parked for every save), never an edit.
 * Compared with what the marker HOLDS each frame, never with what was posed last: autosave parks the
 * bases and puts them back only when its async export finishes (the tree is read synchronously, so a
 * re-pose cannot leak into the file), and a settings write replaces the whole camera block — a
 * "posed already" cache left the depth of field on the base focus through both.
 * @param {FilmPose} pose
 */
function poseLens(pose) {
	if (pose.focus === undefined && pose.aperture === undefined) return;
	if (live.lensObject?.uuid !== live.uuid || !live.lensObject.parent) live.lensObject = findCameraObject(live.uuid);
	const held = live.lensObject?.userData?.camera;
	if (!held) return;
	if ((pose.focus === undefined || held.focus === pose.focus) && (pose.aperture === undefined || held.aperture === pose.aperture)) return;
	/** @type {{target: string, path: string, value: any}[]} */
	const list = [];
	if (pose.focus !== undefined) list.push({ target: live.uuid, path: 'camera.focus', value: pose.focus });
	if (pose.aperture !== undefined) list.push({ target: live.uuid, path: 'camera.aperture', value: pose.aperture });
	applyProps('film', list, { force: true, quiet: true });
}

/** a scene object's world position by uuid @param {string} uuid */
function targetPos(uuid) {
	if (!uuid) return null;
	const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
	if (!object) return null;
	object.updateWorldMatrix(true, false);
	const e = object.matrixWorld.elements;
	return [e[12], e[13], e[14]];
}

/** @param {(pose: FilmPose, dt: number) => void} fn */
export function onFilmFrame(fn) {
	frameListeners.add(fn);
	return () => frameListeners.delete(fn);
}

/** The pose drawn last frame. @returns {FilmPose} */
export function filmPose() {
	return structuredClone(drawn ?? { pos: live.pos.slice(), q: live.q.slice(), qBase: live.q.slice(), fov: live.fov, roll: live.roll });
}

/** @type {FilmPose | null} */
let drawn = null;
/** @type {((pose: FilmPose, now: number) => FilmPose | void) | null} */
let poseFilter = null;

/** Bend the drawn pose (the recorder's Move fly); null removes it.
 * @param {((pose: FilmPose, now: number) => FilmPose | void) | null} fn */
export function setPoseFilter(fn) {
	poseFilter = fn;
}

/** Film's own live controls (where the stick put the camera, the dial, the lens) + the camera. */
export function liveState() {
	return { uuid: live.uuid, pos: live.pos.slice(), fov: live.fov, roll: live.roll, base: { ...live.base } };
}

/**
 * Start filming through a scene camera. @param {string} uuid
 * @returns {boolean}
 */
export function startFilm(uuid) {
	const object = findCameraObject(uuid);
	if (!object) {
		showToast('That camera is not in the scene any more');
		return false;
	}
	if (get(film)) stopFilm();
	if (!startCameraPreview(uuid)) return false;
	const spec = cameraSpec(object);
	object.updateWorldMatrix(true, false);
	const e = object.matrixWorld.elements;
	// position from the matrix; orientation from the decomposed rotation (scale-free)
	const sx = Math.hypot(e[0], e[1], e[2]) || 1;
	const sy = Math.hypot(e[4], e[5], e[6]) || 1;
	const sz = Math.hypot(e[8], e[9], e[10]) || 1;
	live.uuid = uuid;
	live.pos = [e[12], e[13], e[14]];
	live.startQ = quatFromBasis(
		[e[0] / sx, e[1] / sx, e[2] / sx],
		[e[4] / sy, e[5] / sy, e[6] / sy],
		[e[8] / sz, e[9] / sz, e[10] / sz]
	);
	live.q = live.startQ.slice();
	live.deviceQ = null;
	live.source = '';
	live.offset = IDENTITY.slice();
	live.aligned = false;
	live.dragYaw = 0;
	live.dragPitch = 0;
	live.stick = { x: 0, y: 0 };
	live.lift = 0;
	live.roll = Number(spec.roll) || 0;
	live.fov = Number(spec.fov) || 50;
	live.base = { fov: live.fov, roll: live.roll };
	live.focus = null;
	live.pull = null;
	live.aperture = null;
	live.trackOffset = null;
	live.lensObject = null;
	const smoothing = Math.min(1, Math.max(0, Number(safeStorage.getItem('film:smoothing') ?? 0.3)));
	setFilters(smoothing);
	live.lastT = 0;
	film.set({
		uuid,
		name: object.name || 'Camera',
		aspect: spec.aspect,
		sensor: 'starting',
		source: '',
		horizonLock: safeStorage.getItem('film:horizonLock') === '1',
		speed: Number(safeStorage.getItem('film:speed')) || 1,
		fov: live.fov,
		roll: live.roll,
		smoothing,
		rig: 'handheld',
		target: '',
		targetName: '',
		focus: null,
		aperture: null
	});
	skipTargets.add(uuid);
	cleanBefore = get(recordingClean);
	recordingClean.set(true); // no grid, gizmo or helpers in the shot
	teardown.push(setFilmPoseHook(frame));
	// a playing sequence must not cut away from the viewfinder (the take plays the timeline)
	teardown.push(holdCamera());
	// the preview ended or moved to another camera under us (a shot cut, the banner, a peer join)
	let first = true;
	teardown.push(
		cameraPreview.subscribe((p) => {
			if (first) return void (first = false);
			if (!p || p.uuid !== live.uuid) stopFilm({ keepPreview: true });
		})
	);
	listenForMotion();
	return true;
}

/** Leave Film mode. @param {{keepPreview?: boolean}} [opts] */
export function stopFilm(opts = {}) {
	const uuid = live.uuid;
	for (const fn of teardown.splice(0)) fn();
	clearTimeout(sensorTimer);
	stopSensor();
	frameListeners.clear();
	poseFilter = null;
	drawn = null;
	releaseProps('film');
	presenceOff();
	live.uuid = '';
	if (uuid) skipTargets.delete(uuid);
	if (cleanBefore !== null) recordingClean.set(cleanBefore);
	cleanBefore = null;
	if (!opts.keepPreview && get(cameraPreview)?.uuid === uuid) stopCameraPreview();
	film.set(null);
}

/** @param {number[]} x @param {number[]} y @param {number[]} z unit basis columns @returns {number[]} */
function quatFromBasis(x, y, z) {
	// three's Quaternion.setFromRotationMatrix, on plain arrays
	const [m11, m21, m31] = x;
	const [m12, m22, m32] = y;
	const [m13, m23, m33] = z;
	const trace = m11 + m22 + m33;
	let q;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
	} else if (m11 > m22 && m11 > m33) {
		const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
		q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
	} else if (m22 > m33) {
		const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
		q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
	} else {
		const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
		q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
	}
	return quatNorm(q);
}

// ---- controls (the overlay calls these) ------------------------------------------------

/** The thumbstick, -1..1 each (y up = forward). @param {number} x @param {number} y */
export function setStick(x, y) {
	live.stick = { x: Number(x) || 0, y: Number(y) || 0 };
}

/** Up / down: -1, 0 or 1 (or anything between). @param {number} v */
export function setLift(v) {
	live.lift = Math.max(-1, Math.min(1, Number(v) || 0));
}

/**
 * Drag to look: px moved on a viewfinder `heightPx` tall. A drag the full height turns the
 * view by one field of view (the world follows the finger).
 * @param {number} dx @param {number} dy @param {number} heightPx
 */
export function lookDrag(dx, dy, heightPx) {
	const k = (live.fov * D2R) / Math.max(1, heightPx);
	live.dragYaw += dx * k;
	if (!live.deviceQ) live.dragPitch += dy * k;
}

/** Recentre: where the phone points now becomes the direction the camera started in. */
export function recentre() {
	const camQ = sensorCamQ();
	if (camQ) live.offset = recentreOffset(camQ, live.startQ);
	live.dragYaw = 0;
	live.dragPitch = 0;
}

export function toggleHorizonLock() {
	const next = !get(film)?.horizonLock;
	patchUi({ horizonLock: next });
	safeStorage.setItem('film:horizonLock', next ? '1' : '0');
}

/** The speed chip: the next speed in SPEEDS. */
export function cycleSpeed() {
	const cur = get(film)?.speed ?? 1;
	const i = SPEEDS.indexOf(cur);
	const next = SPEEDS[(i + 1) % SPEEDS.length];
	patchUi({ speed: next });
	safeStorage.setItem('film:speed', String(next));
}

/** Put the camera somewhere (teleport) — world position. @param {number[]} pos */
export function placeCamera(pos) {
	if (Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite)) live.pos = pos.slice();
}

/** debug probe for the suites (opt-in through debugStores, like every __*Debug) */
export function filmDebug() {
	return {
		ui: get(film),
		pos: live.pos.slice(),
		q: live.q.slice(),
		startQ: live.startQ.slice(),
		fov: live.fov,
		roll: live.roll,
		source: live.source,
		stick: { ...live.stick },
		lift: live.lift,
		screenAngle: screenAngle()
	};
}

// the suites reach the runtime once it loaded (a ROW in DEBUG_HOOKS would pull it into every debug boot)
registerDebugHook('filmMode', { film, startFilm, stopFilm, setStick, setLift, lookDrag, recentre, toggleHorizonLock, cycleSpeed, placeCamera, filmPose, filmDebug, onFilmFrame, lookHasDof, setHeightLock, setRig, pickAt });

// ---- V5 / V8 live controls ------------------------------------------------------------

/** @param {number} amount 0 (raw handheld) … 1 (steady rig) */
function setFilters(amount) {
	const params = smoothingParams(amount);
	live.posFilter = params ? oneEuro(params) : null;
	live.quatFilter = params ? oneEuroQuat(params) : null;
}

/** Smoothing, live (stabilisation can change mid-take). @param {number} amount */
export function setSmoothing(amount) {
	const a = Math.min(1, Math.max(0, Number(amount) || 0));
	setFilters(a);
	patchUi({ smoothing: a });
	safeStorage.setItem('film:smoothing', String(a));
}

/** Zoom: the vertical FOV, degrees (a recorded `camera.fov` track). @param {number} fov */
export function setFov(fov) {
	live.fov = clampFov(fov);
	patchUi({ fov: live.fov });
}

/** The dutch dial, degrees (a recorded `camera.roll` track). @param {number} deg */
export function setRoll(deg) {
	live.roll = Math.max(-180, Math.min(180, Number(deg) || 0));
	patchUi({ roll: live.roll });
}

/** Aperture (f-number); null = depth of field off. @param {number | null} f */
export function setAperture(f) {
	if (f !== null && live.aperture === null) offerDof();
	live.aperture = f === null ? null : Math.max(0.7, Math.min(64, Number(f) || 5.6));
	if (live.aperture !== null && live.focus === null) live.focus = 10;
	patchUi({ aperture: live.aperture, focus: live.focus });
}

/** Pull focus to a distance (metres), eased — the focus puller's move. @param {number} metres */
export function pullFocus(metres) {
	const to = Math.max(0.05, Math.min(1000, Number(metres) || 10));
	const from = live.focus ?? to;
	live.pull = { from, to, start: performance.now() / 1000 };
	if (live.aperture === null) {
		offerDof();
		live.aperture = 2.8;
	}
	patchUi({ focus: to, aperture: live.aperture });
}

/**
 * The rig: handheld, tripod (position locked, pan / tilt only), or track a target (the camera
 * keeps `uuid` framed as it was framed at the tap — the offset). @param {'handheld'|'tripod'|'track'} rig
 * @param {string} [uuid] the target for 'track'
 */
export function setRig(rig, uuid = '') {
	if (rig === 'track') {
		const target = targetPos(uuid);
		if (!target) return false;
		const look = lookAtQuat(live.pos, target);
		const current = drawn?.qBase ?? live.q;
		live.trackOffset = quatNorm(quatMul(quatConj(look), current));
		const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
		patchUi({ rig, target: uuid, targetName: object?.name || 'object' });
		return true;
	}
	live.trackOffset = null;
	patchUi({ rig, target: '', targetName: '' });
	return true;
}

/** Turn the live filters' state back to zero (a cut: the next frame starts unsmoothed). */
export function resetFilters() {
	live.posFilter?.reset?.();
	live.quatFilter?.reset?.();
}

registerDebugHook('filmLive', { setSmoothing, setFov, setRoll, setAperture, pullFocus, setRig, resetFilters, liveState: () => liveState() });

/** the camera Film drew last frame (for tap raycasts) @type {any} */
let liveCamera = null;
const raycaster = new THREE.Raycaster();

/**
 * What is under a point of the viewfinder: the top-level scene object and its distance.
 * @param {number} x @param {number} y normalised device coords (-1..1, y up)
 * @returns {{uuid: string, name: string, distance: number} | null}
 */
export function pickAt(x, y) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!liveCamera || !group) return null;
	liveCamera.updateMatrixWorld?.();
	raycaster.setFromCamera(new THREE.Vector2(x, y), liveCamera);
	for (const hit of raycaster.intersectObjects(group.children, true)) {
		let o = hit.object;
		if (!o.visible || o.userData?.camera || o.userData?.helper) continue;
		while (o.parent && o.parent !== group) o = o.parent;
		if (o.uuid === live.uuid || o.userData?.camera) continue;
		// focus distance is DEPTH (along the view axis), which is what a lens focuses at
		const forward = liveCamera.getWorldDirection(new THREE.Vector3());
		const depth = hit.point.clone().sub(raycaster.ray.origin).dot(forward);
		return { uuid: o.uuid, name: o.name || 'object', distance: Math.max(0.05, depth) };
	}
	return null;
}
registerDebugHook('filmPick', { pickAt });

/** Is depth of field in the look this camera renders with (the scene's or its own)? @param {string} uuid */
export function lookHasDof(uuid) {
	const has = (/** @type {string} */ key) => postStackFor(key).effects.some((e) => e.kind === 'dof' && e.enabled);
	return has(POST_SCENE_KEY) || (!!uuid && has(uuid));
}

/** Focus and aperture need a Depth of field effect to show: offer to add one to the camera's look. */
function offerDof() {
	const uuid = live.uuid;
	if (!uuid || lookHasDof(uuid)) return;
	showToast("Focus needs depth of field in this camera's look", [
		{
			label: 'Add depth of field',
			action: () => {
				if (!lookHasDof(uuid)) addPostEffect('dof', undefined, uuid);
			}
		}
	]);
}

/**
 * A marker's PARENT frame in the CONTENT frame: Film's poses are content-frame poses, and while an
 * AR walk bends the world rig (the group the replicated objects live in), the parent's world matrix
 * carries that bend — so it is taken back out. With the rig at rest this IS parent.matrixWorld.
 * @param {any} object @returns {THREE.Matrix4 | null}
 */
export function parentInContent(object) {
	const parent = object?.parent;
	if (!parent) return null;
	parent.updateWorldMatrix(true, false);
	const m = parent.matrixWorld.clone();
	const rig = /** @type {any} */ (get(worldRig));
	if (rig) {
		rig.updateWorldMatrix(true, false);
		m.premultiply(rig.matrixWorld.clone().invert());
	}
	return m;
}
