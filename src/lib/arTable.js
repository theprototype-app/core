// 50 R1 — PHONE AR TABLE PLACEMENT (Android Chrome: WebXR immersive-ar + hit-test).
//
// The phone shell's "AR table" entry asks for an immersive-ar session with HIT-TEST (required:
// placing is the whole point) and DOM-OVERLAY (optional: the overlay is where the buttons and the
// pinch/twist live). Then:
//   finding — a reticle sits on the surface the screen's centre points at (a viewer-space hit-test
//             source); the scene is hidden, because a full-size world wrapped round the phone is
//             not what anyone opened AR for
//   placed  — a tap stood the scene on the reticle at table size (arTableCore.tableScale); two
//             fingers pinch it bigger/smaller and twist it round; Move goes back to finding
//   playing — Play: the sim starts as Play's would (sim-on-play) and a tap is an Interact click
//             through the camera (module handlers, On Click, the miss) — never a select
// Exit (the overlay's button, Android Back, the browser ending the session) restores the editor:
// the rig back to 1:1, the editor mode it had, the near plane, nothing left in the scene.
//
// THE PLACEMENT IS THE WORLD RIG (Scene's `world-grab-rig`, the group the replicated objects live
// in, which a VR world-grab already bends). It is LOCAL by construction: peers keep playing the same
// room in their own frame, presence still travels in the content frame (worldToContentPose), and
// nothing is saved, sent or undone. The Quest's passthrough path (Play → the hidden XRButton) is a
// different session request and is untouched; while an AR table runs, the headset-only parts of the
// VR loop stand down (arTableState.arTableActive — the VR frame loop, the VR trigger, the
// Interact-entry spawn, the session-start sim, the hands stream).
//
// Inputs come from the DOM OVERLAY, not XR select events: every `beforexrselect` on the overlay is
// cancelled, so a button press never also places, and a two-finger pinch never fires two selects.
// Without dom-overlay (a browser that did not grant it) a screen tap arrives as an XR select and
// does the one-finger half: place at the reticle, or click while playing.
//
// VH2 — THE ROOM MODE (roadmap 74, the plan's CO6): the same session, but instead of a table-sized
// copy the phone joins the room a headset is colocated in. Two floor taps through the same reticle —
// the agreed point, then a point along the agreed edge — become this phone's ROOM ALIGNMENT
// (colocation.alignmentFromTwoPoints, the headset ritual's maths), and from then on the rig is
// whatever colocation.applyRoomAlignment says: M · K⁻¹ at 1:1, the SAME seat a Quest in the room
// computes. So the phone needs nothing of its own on the wire — its alignment carries the room key
// (CO5's `colocated` presence hides it from the headsets beside it, and only from them), its camera
// stream already travels in the content frame, and a headset's world-grab writes the shared anchor,
// which CO2's subscription re-seats this rig from. The tick only shows or hides the rig in room mode;
// it never poses it. The alignment is the phone's for THIS session (source 'phone': CO3 mints
// persistent anchors only for the headset rituals, and a phone browser has none to restore), so
// ending the session leaves the room.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { toggleXRSession } from '@threlte/xr';
import { arTable, AR_OFF, arTableActive, isRoomPhase } from './arTableState.js';
import { contentAnchor, tableScale, rigPose, pinchTwist, touchPair, isFlat, isTap, arEntryState, roomKeyToJoin } from './arTableCore.js';
import { roomAlignment, roomKey, alignmentFromTwoPoints, setRoomAlignment, applyRoomAlignment, clearAlignment, MIN_TAP_SPAN } from './colocation';
import { peerColocation } from './colocationPresence';
import { defaultRoomKey } from './colocationCalibrate';
import { worldRig, objectsGroup, globalScene, globalRenderer, globalCamera, editorMode, isVRMode } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { setEditorMode } from './objectActions';
import { interactClick } from './playInteract';
import { simOnPlay } from './playMode';

export { arTable, arTableActive };

/* ------------------------------------------------------------------ support ---- */

/** the entry's state: 'checking' until navigator.xr answers, then 'ready' or 'unsupported' */
export const arTableEntry = writable(/** @type {'ready' | 'checking' | 'unsupported'} */ ('checking'));
(() => {
	try {
		const xr = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator).xr;
		if (!xr?.isSessionSupported) {
			arTableEntry.set(arEntryState({ hasXR: false, arSupported: false }));
			return;
		}
		xr.isSessionSupported('immersive-ar')
			.then((/** @type {boolean} */ ok) => arTableEntry.set(arEntryState({ hasXR: true, arSupported: !!ok })))
			.catch(() => arTableEntry.set('unsupported'));
	} catch {
		arTableEntry.set('unsupported');
	}
})();

/**
 * The Play menu's AR rows, shared by the phone bar's Play and the desktop FAB's menu (the
 * `playAsItems` precedent) — only where they can work. VH2: the desktop half exists for the
 * UNFOLDED phone, which is wide enough to get the desktop UI and had no way into AR at all.
 * @returns {{label: string, tooltip: string, action: () => void}[]}
 */
export function arPlayItems() {
	if (get(arTableEntry) !== 'ready') return [];
	return [
		{ label: 'Play on a table (AR)', tooltip: 'Find a table through the camera and play the scene on it', action: () => enterArTable() },
		{ label: 'Join the room (AR)', tooltip: 'Two floor taps and you see the scene where the headsets in this room see it', action: () => enterArTable('room') }
	];
}

/* ------------------------------------------------------------------ state ------- */

/** the per-session runtime (never in a store: three objects and XR handles) */
const rt = {
	/** @type {any} */ session: null,
	/** @type {any} */ hitSource: null,
	/** @type {any} */ reticle: null,
	/** the last flat hit in WORLD space, or null */
	hit: /** @type {THREE.Vector3 | null} */ (null),
	/** where the scene stands (world) and its content anchor, once placed */
	at: /** @type {number[] | null} */ (null),
	anchor: [0, 0, 0],
	/** what to put back on exit */
	modeBefore: /** @type {'edit' | 'interact'} */ ('edit'),
	/** @type {any} */ camera: null,
	nearBefore: 0.1,
	/** frame timings for the budget readout (ms between XR frames, a ring) */
	frameGaps: /** @type {number[]} */ ([]),
	lastFrameAt: 0,
	/** the last tap's outcome (the suites read it) */
	lastTap: /** @type {string | null} */ (null),
	/** VH2: what the press asked for, and the first room tap (world) with its floor mark */
	mode: /** @type {'table' | 'room'} */ ('table'),
	roomA: /** @type {THREE.Vector3 | null} */ (null),
	/** @type {any} */ roomMark: null
};

/** @param {Partial<import('./arTableState.js').ArTableState>} patch */
function patch(patch) {
	arTable.update((s) => ({ ...s, ...patch }));
}

/** the overlay's root (ARTableOverlay.svelte renders it permanently; dom-overlay needs it at request time) */
function overlayRoot() {
	return typeof document === 'undefined' ? null : document.getElementById('ar-overlay');
}

/* ------------------------------------------------------------------ enter ------- */

/**
 * The entry. MUST be called directly from a press: `requestSession` needs the user activation, and
 * threlte's toggle calls it before its first await.
 * @param {'table' | 'room'} [mode] VH2: 'room' starts on the room taps instead of the table reticle
 */
export function enterArTable(mode = 'table') {
	if (arTableActive()) return;
	rt.mode = mode === 'room' ? 'room' : 'table';
	if (get(arTableEntry) === 'unsupported') return;
	const root = overlayRoot();
	// shown synchronously: the browser makes the overlay root fullscreen as the session starts, and a
	// root still `display: none` from the store's async flush would stay hidden
	if (root) root.dataset.active = '';
	rt.modeBefore = get(editorMode) === 'interact' ? 'interact' : 'edit';
	arTable.set({ ...AR_OFF, phase: 'starting' });
	/** @type {any} */
	const init = {
		requiredFeatures: ['hit-test'],
		optionalFeatures: ['dom-overlay', 'local-floor', 'anchors'],
		...(root ? { domOverlay: { root } } : {})
	};
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
	console.warn('AR table: no session', error);
	cleanup();
	const name = error?.name ?? '';
	showToast(
		name === 'NotSupportedError'
			? 'This browser cannot find surfaces for AR. AR tables need Chrome on an Android phone with Google Play Services for AR.'
			: name === 'NotAllowedError' || name === 'SecurityError'
				? 'AR was not allowed. Still in the editor.'
				: 'Could not start AR. Still in the editor.'
	);
}

/** @param {any} session */
function onSession(session) {
	if (!session) return failed(new Error('no session'));
	rt.session = session;
	const overlay = !!session.domOverlayState?.type;
	patch({ phase: 'finding', overlay, hit: false, playing: false });
	if (rt.mode === 'room') joinRoom();
	// the AR view is a player's view: helpers and markers stand down (Interact), the gizmo with them
	setEditorMode('interact');
	const cam = get(globalCamera);
	if (cam && typeof cam.near === 'number') {
		// a table-sized scene is looked at from 20-40 cm; the editor's 0.1 m near plane cuts it open
		rt.camera = cam;
		rt.nearBefore = cam.near;
		cam.near = 0.01;
		cam.updateProjectionMatrix?.();
	}
	session.addEventListener('end', onEnd);
	session.addEventListener('select', onXRSelect);
	session
		.requestReferenceSpace('viewer')
		.then((/** @type {any} */ viewer) => session.requestHitTestSource?.({ space: viewer }))
		.then((/** @type {any} */ source) => {
			if (rt.session !== session) return source?.cancel?.();
			rt.hitSource = source ?? null;
		})
		.catch((/** @type {any} */ error) => {
			console.warn('AR table: no hit-test source', error);
			patch({ error: 'This phone could not start surface finding.' });
		});
}

/* ------------------------------------------------------------------ exit -------- */

/** the overlay's Exit (Android Back and the system UI end the session themselves) */
export function exitArTable() {
	const session = rt.session;
	if (session) {
		session.end().catch(() => onEnd());
		return;
	}
	cleanup();
}

function onEnd() {
	cleanup();
}

/** put everything back: the rig, the editor mode, the near plane, the reticle, the overlay */
function cleanup() {
	const session = rt.session;
	if (session) {
		session.removeEventListener('end', onEnd);
		session.removeEventListener('select', onXRSelect);
	}
	try {
		rt.hitSource?.cancel?.();
	} catch {
		/* the session already ended */
	}
	rt.session = null;
	rt.hitSource = null;
	rt.hit = null;
	rt.at = null;
	rt.frameGaps = [];
	rt.lastFrameAt = 0;
	rt.lastTap = null;
	rt.mode = 'table';
	rt.roomA = null;
	disposeMark('roomMark');
	// VH2: the phone's alignment belongs to this session's tracking space — it ends with it (the rig
	// write below would undo the seat anyway; this also takes the room key off the wire)
	if (get(roomAlignment)?.source === 'phone') {
		clearAlignment();
		roomKey.set(null);
	}
	if (rt.reticle) {
		rt.reticle.parent?.remove(rt.reticle);
		rt.reticle.traverse((/** @type {any} */ o) => {
			o.geometry?.dispose?.();
			o.material?.dispose?.();
		});
		rt.reticle = null;
	}
	const rig = /** @type {any} */ (get(worldRig));
	if (rig) {
		rig.visible = true;
		rig.position.set(0, 0, 0);
		rig.quaternion.identity();
		rig.scale.set(1, 1, 1);
		rig.updateMatrixWorld(true);
	}
	if (rt.camera) {
		rt.camera.near = rt.nearBefore;
		rt.camera.updateProjectionMatrix?.();
		rt.camera = null;
	}
	const wasActive = arTableActive();
	arTable.set({ ...AR_OFF });
	if (wasActive) setEditorMode(rt.modeBefore);
	const root = overlayRoot();
	if (root) delete root.dataset.active;
	// a request that failed before any session started leaves the optimistic flag nowhere to be reset
	if (!get(globalRenderer)?.xr?.isPresenting && get(isVRMode) === true) isVRMode.set(false);
}

/* ------------------------------------------------------------------ the frame --- */

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const hitMatrix = new THREE.Matrix4();

/** a scene-root floor ring (the reticle's look) @param {string} name @param {number} color */
function makeRing(name, color) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return null;
	const group = new THREE.Group();
	group.name = name;
	group.matrixAutoUpdate = false;
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(0.06, 0.075, 40).rotateX(-Math.PI / 2),
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
	);
	const dot = new THREE.Mesh(
		new THREE.CircleGeometry(0.012, 20).rotateX(-Math.PI / 2),
		new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
	);
	ring.renderOrder = dot.renderOrder = 4999;
	group.add(ring, dot);
	group.visible = false;
	scene.add(group);
	return group;
}

function ensureReticle() {
	if (!rt.reticle) rt.reticle = makeRing('ar-reticle', 0xffffff);
	return rt.reticle;
}

/** @param {'roomMark'} key */
function disposeMark(key) {
	const mark = rt[key];
	if (!mark) return;
	mark.parent?.remove(mark);
	mark.traverse((/** @type {any} */ o) => {
		o.geometry?.dispose?.();
		o.material?.dispose?.();
	});
	rt[key] = null;
}

/**
 * Per frame, from Scene's task while presenting. Reads the hit, moves the reticle, poses the rig.
 * @param {any} renderer @param {any} camera the user camera (its parent maps reference space to world)
 */
export function tickArTable(renderer, camera) {
	const st = get(arTable);
	if (st.phase === 'off' || st.phase === 'starting') return;
	const now = performance.now();
	if (rt.lastFrameAt) {
		rt.frameGaps.push(now - rt.lastFrameAt);
		if (rt.frameGaps.length > 240) rt.frameGaps.shift();
	}
	rt.lastFrameAt = now;
	const rig = /** @type {any} */ (get(worldRig));
	const reticle = ensureReticle();
	if (isRoomPhase(st.phase)) {
		// VH2: the rig is colocation's (applyRoomAlignment seats it, CO2's subscription re-seats it on a
		// new anchor) — only shown, never posed, here. Until the first alignment there is no room to show.
		if (rig) rig.visible = !!get(roomAlignment);
		if (st.phase === 'room') {
			if (reticle) reticle.visible = false;
			return;
		}
		const hit = readHit(renderer, camera);
		if (reticle) {
			reticle.visible = !!hit;
			if (hit) {
				reticle.matrix.compose(hit, tmpQuat.identity(), tmpScale.set(1, 1, 1));
				reticle.matrixWorldNeedsUpdate = true;
			}
		}
		if (!!hit !== st.hit) patch({ hit: !!hit });
		return;
	}
	if (st.phase === 'finding') {
		if (rig) rig.visible = false;
		const hit = readHit(renderer, camera);
		if (reticle) {
			reticle.visible = !!hit;
			if (hit) {
				reticle.matrix.compose(hit, tmpQuat.identity(), tmpScale.set(1, 1, 1));
				reticle.matrixWorldNeedsUpdate = true;
			}
		}
		if (!!hit !== st.hit) patch({ hit: !!hit });
		return;
	}
	if (reticle) reticle.visible = false;
	if (rig && rt.at) {
		// re-asserted every frame: the pose is the state, and nothing else may bend the rig mid-AR
		const pose = rigPose({ hit: rt.at, yaw: st.yaw, scale: st.scale, anchor: rt.anchor });
		rig.visible = true;
		rig.position.fromArray(pose.position);
		rig.quaternion.fromArray(pose.quaternion);
		rig.scale.setScalar(pose.scale);
	}
}

/** the frame's first FLAT hit, in world space @param {any} renderer @param {any} camera */
function readHit(renderer, camera) {
	const frame = renderer?.xr?.getFrame?.();
	const space = renderer?.xr?.getReferenceSpace?.();
	if (!frame || !space || !rt.hitSource) return (rt.hit = null);
	const results = frame.getHitTestResults?.(rt.hitSource) ?? [];
	for (const result of results) {
		const pose = result.getPose(space);
		if (!pose) continue;
		hitMatrix.fromArray(pose.transform.matrix);
		// reference space -> world: three draws the reference space under the camera's parent
		if (camera?.parent) hitMatrix.premultiply(camera.parent.matrixWorld);
		hitMatrix.decompose(tmpPos, tmpQuat, tmpScale);
		tmpUp.set(0, 1, 0).applyQuaternion(tmpQuat);
		if (!isFlat([tmpUp.x, tmpUp.y, tmpUp.z])) continue;
		rt.hit = (rt.hit ?? new THREE.Vector3()).copy(tmpPos);
		return rt.hit;
	}
	return (rt.hit = null);
}

/* ------------------------------------------------------------------ actions ----- */

/** the scene's footprint in the CONTENT frame (the rig's own), or null when empty */
function contentBox() {
	const group = /** @type {any} */ (get(objectsGroup));
	const rig = /** @type {any} */ (get(worldRig));
	if (!group || !group.children.length) return null;
	group.updateWorldMatrix(true, true);
	const box = new THREE.Box3().setFromObject(group, true);
	if (box.isEmpty()) return null;
	if (rig) box.applyMatrix4(new THREE.Matrix4().copy(rig.matrixWorld).invert());
	return { min: box.min.toArray(), max: box.max.toArray() };
}

/** stand the scene on the reticle (the first placement fits it to the table; a Move keeps the size) */
export function placeAtReticle() {
	const st = get(arTable);
	if (st.phase !== 'finding' || !rt.hit) return false;
	const first = !rt.at;
	const box = contentBox();
	rt.anchor = contentAnchor(box);
	rt.at = rt.hit.toArray();
	patch({ phase: 'placed', ...(first ? { scale: tableScale(box), yaw: 0 } : {}) });
	// posed right away: the tick re-asserts it next frame, and a reader in between sees the truth
	tickArTable(get(globalRenderer), get(globalCamera));
	return true;
}

/** back to finding a surface (the scene keeps its size and turn) */
export function moveScene() {
	if (get(arTable).phase !== 'placed') return;
	patch({ phase: 'finding', hit: false });
}

/** Play: the scene's sim starts as Play's would, and a tap clicks */
export function playOnTable() {
	const st = get(arTable);
	if (!placedOrRoom(st.phase) || st.playing) return;
	patch({ playing: true });
	simOnPlay();
}

/** Stop playing (taps stop clicking; the sim keeps the session's own transport) */
export function stopPlayingOnTable() {
	if (get(arTable).playing) patch({ playing: false });
}

/**
 * A one-finger tap on the overlay, in client px.
 * @param {number} x @param {number} y
 * @returns {'placed' | 'click' | 'module-group' | 'module-handler' | 'miss' | 'none'}
 */
export function arTap(x, y) {
	const kind = tapKind(x, y);
	rt.lastTap = kind;
	return kind;
}

/** @param {number} x @param {number} y @returns {any} */
function tapKind(x, y) {
	const st = get(arTable);
	if (st.phase === 'finding') return placeAtReticle() ? 'placed' : 'none';
	if (st.phase === 'room-a' || st.phase === 'room-b') return roomTap();
	if (!placedOrRoom(st.phase) || !st.playing) return 'none';
	const renderer = /** @type {any} */ (get(globalRenderer));
	const xrCam = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : get(globalCamera);
	const cam = xrCam?.cameras?.[0] ?? xrCam;
	if (!cam) return 'none';
	const w = typeof window === 'undefined' ? 1 : window.innerWidth || 1;
	const h = typeof window === 'undefined' ? 1 : window.innerHeight || 1;
	const ray = new THREE.Raycaster();
	ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), cam);
	return interactClick(ray);
}

/** a select with no dom-overlay (the one-finger fallback) @param {any} event */
function onXRSelect(event) {
	if (get(arTable).overlay) return; // the overlay's taps already handled it
	const st = get(arTable);
	if (st.phase === 'finding') {
		placeAtReticle();
		return;
	}
	if (st.phase === 'room-a' || st.phase === 'room-b') {
		roomTap();
		return;
	}
	if (!placedOrRoom(st.phase) || !st.playing) return;
	const renderer = /** @type {any} */ (get(globalRenderer));
	const space = renderer?.xr?.getReferenceSpace?.();
	const pose = space && event?.frame?.getPose?.(event.inputSource?.targetRaySpace, space);
	if (!pose) return;
	const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
	const parent = /** @type {any} */ (get(globalCamera))?.parent;
	if (parent) m.premultiply(parent.matrixWorld);
	const ray = new THREE.Raycaster();
	ray.ray.origin.setFromMatrixPosition(m);
	ray.ray.direction.set(0, 0, -1).transformDirection(m);
	interactClick(ray);
}

/** the two phases where the scene is on screen and Play means something @param {string} phase */
function placedOrRoom(phase) {
	return phase === 'placed' || phase === 'room';
}

/* ------------------------------------------------------------------ the room (VH2) */

/** the room this phone would join right now (a colocated headset's, else ours, else the session's) */
export function phoneRoomKey() {
	return roomKeyToJoin(get(peerColocation), get(roomKey), defaultRoomKey());
}

/**
 * Into the room taps — from the session start (More ▸ Join a room) or from a table session's
 * "Join room". A table placement is dropped: the room is 1:1, so the table's size and turn mean
 * nothing there.
 */
export function joinRoom() {
	const st = get(arTable);
	if (st.phase !== 'finding' && st.phase !== 'placed') return false;
	rt.mode = 'room';
	rt.at = null;
	rt.roomA = null;
	patch({ phase: 'room-a', room: phoneRoomKey(), note: '', hit: false, playing: false, scale: 1, yaw: 0 });
	return true;
}

/** tap again: back to the first tap. A working alignment stays until the new one replaces it. */
export function redoRoom() {
	const st = get(arTable);
	if (!isRoomPhase(st.phase)) return false;
	rt.roomA = null;
	disposeMark('roomMark');
	patch({ phase: 'room-a', note: '', hit: false, playing: false });
	return true;
}

/**
 * A room tap at the reticle. The first is the agreed point (a cyan mark stays on it), the second
 * the point along the agreed edge, which installs the alignment. A second tap too close to the
 * first is refused with a note and waits for another — the heading would be guesswork.
 * @returns {'room-a' | 'room' | 'too-close' | 'none'}
 */
export function roomTap() {
	const st = get(arTable);
	if (!rt.hit || (st.phase !== 'room-a' && st.phase !== 'room-b')) return 'none';
	if (st.phase === 'room-a') {
		rt.roomA = rt.hit.clone();
		disposeMark('roomMark');
		rt.roomMark = makeRing('ar-room-mark', 0x9fe8ff);
		if (rt.roomMark) {
			rt.roomMark.matrix.compose(rt.roomA, tmpQuat.identity(), tmpScale.set(1, 1, 1));
			rt.roomMark.matrixWorldNeedsUpdate = true;
			rt.roomMark.visible = true;
		}
		patch({ phase: 'room-b', note: '' });
		return 'room-a';
	}
	const alignment = rt.roomA ? alignmentFromTwoPoints(rt.roomA, rt.hit) : null;
	if (!alignment) {
		patch({ note: `Too close to the first point — tap a point at least ${Math.round(MIN_TAP_SPAN * 100)} cm away along the edge` });
		return 'too-close';
	}
	// the key is decided at the tap that joins: a headset that colocated meanwhile wins
	const key = roomKeyToJoin(get(peerColocation), st.room || null, defaultRoomKey());
	setRoomAlignment(alignment, { roomKey: key, source: 'phone' });
	applyRoomAlignment();
	rt.roomA = null;
	disposeMark('roomMark');
	patch({ phase: 'room', room: key, note: '' });
	tickArTable(get(globalRenderer), get(globalCamera));
	return 'room';
}

/* ------------------------------------------------------------------ the gestures - */

/** @type {{start: {scale: number, yaw: number}, from: {distance: number, angle: number}} | null} */
let pinch = null;

/** two fingers landed (overlay px) @param {{x: number, y: number}[]} pts */
export function beginPinch(pts) {
	const st = get(arTable);
	if (st.phase !== 'placed' || pts.length < 2) return false;
	pinch = { start: { scale: st.scale, yaw: st.yaw }, from: touchPair(pts) };
	return true;
}

/** the fingers moved @param {{x: number, y: number}[]} pts */
export function movePinch(pts) {
	if (!pinch || pts.length < 2) return;
	const next = pinchTwist(pinch.start, pinch.from, touchPair(pts));
	patch(next);
}

export function endPinch() {
	pinch = null;
}

export { isTap };

/* ------------------------------------------------------------------ the readouts - */

/** the frame budget over the last ~4 s of XR frames: median and p95 gaps (ms), and how many */
export function arFrameStats() {
	const gaps = [...rt.frameGaps].sort((a, b) => a - b);
	if (!gaps.length) return { n: 0, p50: 0, p95: 0 };
	const at = (/** @type {number} */ q) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
	return { n: gaps.length, p50: at(0.5), p95: at(0.95) };
}

/** what the suites read: the store, the hit, the anchor, the rig */
export function arTableDebug() {
	const rig = /** @type {any} */ (get(worldRig));
	return {
		...get(arTable),
		hasSession: !!rt.session,
		lastTap: rt.lastTap,
		mode: rt.mode,
		roomA: rt.roomA ? rt.roomA.toArray() : null,
		roomMark: rt.roomMark ? { visible: rt.roomMark.visible, at: [rt.roomMark.matrix.elements[12], rt.roomMark.matrix.elements[13], rt.roomMark.matrix.elements[14]] } : null,
		alignment: get(roomAlignment) ? { ...get(roomAlignment) } : null,
		hasHitSource: !!rt.hitSource,
		hitAt: rt.hit ? rt.hit.toArray() : null,
		at: rt.at,
		anchor: rt.anchor,
		reticle: rt.reticle ? { visible: rt.reticle.visible, y: rt.reticle.matrix.elements[13] } : null,
		rig: rig ? { visible: rig.visible, position: rig.position.toArray(), scale: rig.scale.x, quaternion: rig.quaternion.toArray() } : null,
		frames: arFrameStats()
	};
}
