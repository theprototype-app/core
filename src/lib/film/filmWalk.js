// 68 V3 — AR WALK ("Track my movement"): the phone's own tracking moves the filming camera.
//
// Android Chrome's WebXR immersive-ar session tracks the phone in the ROOM; walking a metre moves
// the camera `scale` metres through the scene (0.1 = a miniature set, 20 = a city in a few steps).
// The XR runtime draws the views under the render camera's PARENT, and the preview camera hangs in
// its own mount group (filmState.filmCameraMount, inside the world rig) — so the walk poses that
// mount so the phone's room pose lands on the camera's scene pose —
//     mount = T(anchor) · Ry(δ) · S(scale) · T(-roomStart)        δ = anchor yaw − room yaw at start
// and the scene is drawn from exactly where Film says the camera is, while the take records the
// CONTENT-frame pose (walkPosition) through Film's own frame tail (walkFrame). (Posing the world rig
// instead does nothing: the camera sits inside it, so the rig cancels out of the view.) The mount is
// LOCAL (peers see the camera through filmpose presence) and goes back to identity when the session
// ends. The stick slides the anchor (walk + fly), Recentre makes the phone's heading the
// marker's again, the scale re-anchors where you stand (no jump), and the mini-map teleports it.
//
// What the AR view cannot show: the zoom and the dutch dial (the XR runtime owns the projection and
// the view's roll) — both still RECORD. The DOM overlay is #film-root, so every Film control stays.
// Lazy: only FilmMode imports this module.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { toggleXRSession } from '@threlte/xr';
import { filmWalkActive, setPhoneArTick } from '../arTableState.js';
import { globalRenderer, isVRMode, roomLook } from '../../stores/sceneStore';
import { filmCameraMount } from './filmState';
import { showToast } from '../../stores/appStore';
import { safeStorage } from '../safeStorage';
import { registerDebugHook } from '../debugHooks';
import { walkFrame, setWalking, walkNudge, startHeading } from './filmMode';
import { clampWalkScale, walkPosition, yawOf, quatAxisAngle, quatMul, quatRotate, passthroughLook, trackingVerdict, PASSTHROUGH } from './filmCore';

const Y = [0, 1, 0];
/** fix-film: a walk that never finds the room in this long hands over to the stick */
const NEVER_TRACKED_S = 10;

/** 'checking' until navigator.xr answers, then 'ready' or 'unsupported' */
export const walkEntry = writable(/** @type {'checking' | 'ready' | 'unsupported'} */ ('checking'));
(() => {
	try {
		const xr = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator).xr;
		if (!xr?.isSessionSupported) return walkEntry.set('unsupported');
		xr.isSessionSupported('immersive-ar')
			.then((/** @type {boolean} */ ok) => walkEntry.set(ok ? 'ready' : 'unsupported'))
			.catch(() => walkEntry.set('unsupported'));
	} catch {
		walkEntry.set('unsupported');
	}
})();

/** `passthrough` (fix-film): the live view behind the scene — 'off' (the scene's sky) | 'on' | 'dim'.
 * `lost`: tracking has dropped this long (s; 0 = tracked).
 * @typedef {{on: boolean, starting: boolean, tracking: boolean, scale: number, passthrough: string, lost: number}} WalkUi */
const storedPassthrough = safeStorage.getItem('film:passthrough') ?? 'off';
/** @type {import('svelte/store').Writable<WalkUi>} */
export const walk = writable({
	on: false,
	starting: false,
	tracking: false,
	scale: clampWalkScale(Number(safeStorage.getItem('film:walkScale')) || 1),
	passthrough: PASSTHROUGH.some((p) => p.key === storedPassthrough) ? storedPassthrough : 'off',
	lost: 0
});

/**
 * fix-film — what Film does when the walk cannot carry on (it failed to start, tracking was lost, or
 * the system ended the session): FilmMode registers it (pause the take at a Mark, say why, drop to
 * the stick). `recording` lets the tracking rule wait less during a take.
 * @type {{recording: () => boolean, fallback: (why: 'denied'|'failed'|'lost'|'ended', recording: boolean) => void}}
 */
const hooks = { recording: () => false, fallback: () => {} };
/** @param {Partial<typeof hooks>} h */
export function setWalkHooks(h) {
	Object.assign(hooks, h);
}
/** a stop WE asked for (stopWalk) — an 'end' without it is the system's */
let stopping = false;

/** the session runtime (never in a store: XR handles + arrays) */
const rt = {
	/** @type {any} */ session: null,
	/** where the walk is anchored: the content pose and the room pose it maps from */
	/** @type {{pos: number[], yaw: number, roomStart: number[], roomYaw: number} | null} */
	anchor: null,
	/** the last frame's room + content poses (re-anchoring keeps you where you stand) */
	room: { pos: [0, 0, 0], q: [0, 0, 0, 1] },
	/** @type {number[] | null} */
	content: null,
	/** @type {number[]} */
	contentQ: [0, 0, 0, 1],
	lastT: 0,
	/** fix-film: when tracking dropped (seconds, performance clock; 0 = tracked) */
	lostSince: 0
};

/** @param {Partial<WalkUi>} patch */
function patch(patch) {
	walk.update((s) => ({ ...s, ...patch }));
}

/**
 * "Track my movement" — MUST run inside the press (requestSession needs the user activation).
 * @param {{pos: number[], q: number[]}} from the pose Film is drawing (the walk starts there)
 */
export function startWalk(from) {
	if (rt.session || get(walk).starting) return;
	if (get(walkEntry) !== 'ready') {
		showToast('Walking needs AR — Chrome on an Android phone with Google Play Services for AR');
		return;
	}
	const root = typeof document === 'undefined' ? null : document.getElementById('film-root');
	/** @type {any} */
	const init = { optionalFeatures: ['dom-overlay', 'local-floor'], ...(root ? { domOverlay: { root } } : {}) };
	rt.anchor = null;
	rt.content = from.pos.slice();
	rt.contentQ = from.q.slice();
	filmWalkActive.set(true); // before the request: Scene's session-start must already stand down
	roomLook.set(passthroughLook(get(walk).passthrough)); // fix-film: before the session derives its sky
	stopping = false;
	patch({ starting: true, lost: 0 });
	let started;
	try {
		started = toggleXRSession('immersive-ar', init, 'enter');
	} catch (error) {
		failed(error);
		return;
	}
	Promise.resolve(started).then(onSession, failed);
}

/** @param {any} error */
function failed(error) {
	console.warn('Film walk: no session', error);
	cleanup();
	const name = error?.name ?? '';
	hooks.fallback(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed', hooks.recording());
}

/** @param {any} session */
function onSession(session) {
	if (!session) return failed(new Error('no session'));
	rt.session = session;
	session.addEventListener('end', onEnd);
	setPhoneArTick(tick);
	setWalking(true);
	patch({ on: true, starting: false, tracking: false });
}

/** Stop walking (the session ends; Film carries on with the gyro from where you stood). */
export function stopWalk() {
	const session = rt.session;
	if (session) {
		stopping = true;
		session.end().catch(() => cleanup());
		return;
	}
	cleanup();
}

/** the session ended: ours (Stop walking), or the system's (the app backgrounded, ARCore gave up) */
function onEnd() {
	const ours = stopping;
	const wasOn = get(walk).on;
	const recording = hooks.recording();
	cleanup();
	if (!ours && wasOn) hooks.fallback('ended', recording);
}

/** fix-film: tracking stayed lost past the grace — end the walk and hand over to the stick */
function giveUp() {
	const recording = hooks.recording();
	hooks.fallback('lost', recording); // pauses the take at a Mark FIRST (the last tracked frame is the shot's end)
	stopWalk();
}

function cleanup() {
	rt.session?.removeEventListener?.('end', onEnd);
	rt.session = null;
	rt.anchor = null;
	rt.lastT = 0;
	rt.lostSince = 0;
	stopping = false;
	roomLook.set('room');
	setPhoneArTick(null);
	const mount = /** @type {any} */ (get(filmCameraMount));
	if (mount) {
		mount.position.set(0, 0, 0);
		mount.quaternion.identity();
		mount.scale.set(1, 1, 1);
		mount.updateMatrixWorld(true);
	}
	const wasOn = get(walk).on;
	filmWalkActive.set(false);
	patch({ on: false, starting: false, tracking: false, lost: 0 });
	if (wasOn) setWalking(false);
	// a request that failed before any session started leaves the optimistic flag nowhere to be reset
	if (!get(globalRenderer)?.xr?.isPresenting && get(isVRMode) === true) isVRMode.set(false);
}

/** Walk scale: scene metres per metre walked (0.1-20). Re-anchors where you stand. @param {number} s */
export function setWalkScale(s) {
	const scale = clampWalkScale(s);
	reanchor();
	patch({ scale });
	safeStorage.setItem('film:walkScale', String(scale));
}

/** fix-film: the walk's live view behind the scene — 'off' | 'on' | 'dim' (never the take). @param {string} key */
export function setPassthrough(key) {
	if (!PASSTHROUGH.some((p) => p.key === key)) return;
	patch({ passthrough: key });
	safeStorage.setItem('film:passthrough', key);
	if (get(filmWalkActive)) roomLook.set(passthroughLook(key));
}

/** Recentre while walking: the way the phone points now becomes the marker's heading. */
export function recentreWalk() {
	if (!rt.anchor) return;
	reanchor();
	rt.anchor = { ...rt.anchor, yaw: yawOf(startHeading()), roomYaw: yawOf(rt.room.q) };
}

/** Mini-map teleport while walking: the anchor jumps, your room position stays. @param {number[]} to content position */
export function teleportWalk(to) {
	if (!rt.anchor || !rt.content) return false;
	reanchor();
	rt.anchor = { ...rt.anchor, pos: to.slice() };
	return true;
}

/** keep the camera where it is and restart the mapping from here */
function reanchor() {
	if (!rt.anchor || !rt.content) return;
	rt.anchor = { ...rt.anchor, pos: rt.content.slice(), roomStart: rt.room.pos.slice() };
}

const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();

/**
 * Per XR frame (Scene's task, through arTableState.tickPhoneAr): read the phone's room pose, map it
 * into the scene, pose the rig, hand the content pose to Film.
 * @param {any} renderer @param {any} camera
 */
function tick(renderer, camera) {
	if (!rt.session) return;
	const frame = renderer?.xr?.getFrame?.();
	const space = renderer?.xr?.getReferenceSpace?.();
	const viewer = frame && space ? frame.getViewerPose?.(space) : null;
	// fix-film: no pose, or an orientation-only one (ARCore lost the room), is LOST: hold the last
	// pose a moment (a blip), then give up safely — a take never films a frozen or drifting view
	if (!viewer || viewer.emulatedPosition) {
		const now = performance.now() / 1000;
		if (!rt.lostSince) rt.lostSince = now;
		const lostFor = now - rt.lostSince;
		if (get(walk).tracking || Math.abs(get(walk).lost - lostFor) > 0.1) patch({ tracking: false, lost: lostFor });
		// (the walk has to have tracked once to be LOST; one that never finds the room gives up later)
		if (rt.anchor ? trackingVerdict(lostFor, hooks.recording()) === 'fallback' : lostFor > NEVER_TRACKED_S) giveUp();
		return;
	}
	if (rt.lostSince) {
		rt.lostSince = 0;
		patch({ lost: 0 });
	}
	// the ROOM pose: the reference space itself (the mount below maps it into the scene)
	tmpM.fromArray(viewer.transform.matrix);
	tmpM.decompose(tmpP, tmpQ, tmpS);
	rt.room = { pos: tmpP.toArray(), q: tmpQ.toArray() };
	const now = performance.now() / 1000;
	const dt = rt.lastT ? Math.min(0.25, now - rt.lastT) : 0;
	rt.lastT = now;
	if (!rt.anchor) {
		rt.anchor = { pos: (rt.content ?? [0, 1.6, 0]).slice(), yaw: yawOf(rt.contentQ), roomStart: rt.room.pos.slice(), roomYaw: yawOf(rt.room.q) };
		patch({ tracking: true });
	} else if (!get(walk).tracking) patch({ tracking: true });
	const scale = get(walk).scale;
	const delta = rt.anchor.yaw - rt.anchor.roomYaw;
	const turn = quatAxisAngle(Y, delta);
	const contentQ = quatMul(turn, rt.room.q);
	// the stick still flies (walk + fly): it slides the anchor
	const nudge = walkNudge(contentQ, dt);
	if (nudge) rt.anchor = { ...rt.anchor, pos: rt.anchor.pos.map((v, i) => v + nudge[i]) };
	const contentPos = walkPosition(rt.anchor.pos, delta, rt.anchor.roomStart, rt.room.pos, scale);
	rt.content = contentPos;
	rt.contentQ = contentQ;
	const mount = /** @type {any} */ (get(filmCameraMount));
	if (mount) {
		const r = quatRotate(turn, rt.anchor.roomStart.map((v) => v * scale));
		mount.quaternion.fromArray(turn);
		mount.scale.setScalar(scale);
		mount.position.set(rt.anchor.pos[0] - r[0], rt.anchor.pos[1] - r[1], rt.anchor.pos[2] - r[2]);
		mount.updateMatrixWorld(true);
	}
	walkFrame(contentPos, contentQ, camera);
}

export function filmWalkDebug() {
	return { ...get(walk), entry: get(walkEntry), presenting: !!get(globalRenderer)?.xr?.isPresenting, anchor: rt.anchor, room: rt.room, content: rt.content };
}

registerDebugHook('filmWalk', { walk, walkEntry, setWalkScale, setPassthrough, recentreWalk, teleportWalk, stopWalk, filmWalkDebug });
