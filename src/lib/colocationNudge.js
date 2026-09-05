// CO7 — FINE-TUNE: the persistence, the write path and the stick drive.
//
// The maths and the store live in `colocation.js` (the leaf) because
// `applyRoomAlignment` composes the correction on every rig write — see the nudge
// block there for WHY it composes at write time instead of being folded into the
// stored alignment (CO3's drift would ease it away within a second). This module is
// the half with side effects: localStorage, the VR wiring, the toasts.
//
// PERSISTED PER ROOM, PER DEVICE, in its own key rather than inside CO3's anchor
// record — a nudge outlives the thing that produced it. A device whose runtime has
// no persistent anchors (or a phone, later) still calibrates by ritual every session
// and still wants its correction back, so the two records have different lifetimes
// and are stored apart. Together they are the whole promise: calibrate once,
// fine-tune once, and every later session in that room is already right.
//
// THE STICK IS FREE, and that is not a coincidence: CO2 suppresses locomotion while
// colocated (a stick flick offsets the XR reference space and silently breaks the
// room mapping), so in a colocated session nothing else wants the thumbsticks. In a
// real room you walk with your legs; the stick has nothing better to do than trim
// the alignment. Axes come from `inputRuntime.getInput()`, which vrControls already
// publishes every frame — no vrControls edit for this phase.

import { get, writable } from 'svelte/store';
import * as THREE from 'three';
import { showToast } from '../stores/appStore';
import { globalCamera, globalRenderer } from '../stores/sceneStore';
import {
	roomAlignment,
	roomNudge,
	roomKey,
	normalizeNudge,
	nudgeIsZero,
	nudgeFromStick,
	yawFromDirection,
	applyRoomAlignment,
	NUDGE_ZERO
} from './colocation';
import { registerVRFrameHook } from './vrControls';
import { registerVRMenuEntry } from './vrRadialMenu';
import { getInput } from './inputRuntime';
import { calibrating } from './colocationCalibrate';

const STORE_KEY = 'colocation-nudge-v1';

/** Full-deflection rates. Slow ON PURPOSE: this control exists to close a
 * centimetre-scale gap, and a fast one cannot be stopped on the right centimetre.
 * At these rates a 3cm correction takes well under a second of hold. */
export const NUDGE_RATE_M = 0.05; // metres per second
export const NUDGE_RATE_YAW = (3 * Math.PI) / 180; // radians per second
/** Stick noise floor. Above it the response is SQUARED, so the first third of the
 * throw is very fine and the far end still moves at a useful pace. */
export const NUDGE_DEADZONE = 0.15;

/** the fine-tune mode is ARMED — the sticks trim the world while it is */
/** @type {import('svelte/store').Writable<boolean>} */
export const nudgeMode = writable(false);

// ---- persistence ---------------------------------------------------------------------

function readAll() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/** @param {any} all */
function writeAll(all) {
	try {
		if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(all));
	} catch {
		// private mode / quota: the live correction still works for this session
	}
}

/** Every remembered room's correction — for the debug view and the suite. */
export function nudgeRecords() {
	return readAll();
}

/** @param {string} key @returns {any} */
export function nudgeFor(key) {
	const rec = readAll()[key];
	return rec ? normalizeNudge(rec) : null;
}

/** Drop one room's remembered correction. Called by CO3's `forgetRoom`, because
 * forgetting a room means forgetting everything about it. @param {string} key */
export function forgetNudge(key) {
	const all = readAll();
	if (!(key in all)) return false;
	delete all[key];
	writeAll(all);
	if (get(roomKey) === key || get(roomAlignment)?.roomKey === key) {
		roomNudge.set(null);
		applyRoomAlignment();
	}
	return true;
}

// ---- the write path ------------------------------------------------------------------

/** The room a correction belongs to: the ALIGNMENT's key, never the bare `roomKey`
 * store — CO2 mints the key first and the alignment a moment later, and a nudge
 * saved against a room we are not actually aligned to would be silently wrong. */
function currentKey() {
	return get(roomAlignment)?.roomKey ?? null;
}

/**
 * Write the correction for the current room: normalize (clamped), re-pose the rig,
 * persist. Returns the stored value, or null when nothing is aligned — a correction
 * with no alignment has no frame to be expressed in.
 * @param {any} patch a partial {dx, dy, dz, dyaw}
 * @param {{silent?: boolean}} [opts]
 */
export function setRoomNudge(patch, opts = {}) {
	const key = currentKey();
	if (!key) {
		if (!opts.silent) showToast('Colocate first — a fine-tune needs a room to adjust');
		return null;
	}
	const next = normalizeNudge({ ...(get(roomNudge) || NUDGE_ZERO), ...(patch || {}) });
	roomNudge.set(next);
	applyRoomAlignment();
	const all = readAll();
	if (nudgeIsZero(next)) delete all[key];
	else all[key] = { ...next, at: Date.now() };
	writeAll(all);
	return next;
}

/** Add to the current correction (the sticks and the arrow keys both land here).
 * @param {any} delta */
export function adjustRoomNudge(delta) {
	const cur = get(roomNudge) || NUDGE_ZERO;
	return setRoomNudge(
		{
			dx: cur.dx + (Number(delta?.dx) || 0),
			dy: cur.dy + (Number(delta?.dy) || 0),
			dz: cur.dz + (Number(delta?.dz) || 0),
			dyaw: cur.dyaw + (Number(delta?.dyaw) || 0)
		},
		{ silent: true }
	);
}

/** Back to the raw ritual/anchor alignment, and forget the room's record. */
export function resetRoomNudge() {
	const key = currentKey();
	roomNudge.set(null);
	applyRoomAlignment();
	if (key) {
		const all = readAll();
		delete all[key];
		writeAll(all);
	}
	return true;
}

// ---- the stick drive -----------------------------------------------------------------

/** @param {number} v */
function curve(v) {
	const mag = Math.abs(v);
	if (mag < NUDGE_DEADZONE) return 0;
	const scaled = (mag - NUDGE_DEADZONE) / (1 - NUDGE_DEADZONE);
	return Math.sign(v) * scaled * scaled;
}

/** The head's yaw in tracking space — the stick is head-relative, so this is what
 * makes "push right" mean right. Reads the XR camera while presenting (the
 * colocateHereFromView idiom). */
function headYaw() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const cam = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : get(globalCamera);
	if (!cam) return null;
	const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(
		cam.getWorldQuaternion(new THREE.Quaternion())
	);
	return yawFromDirection(facing);
}

let lastTick = 0;

/**
 * One frame of stick trim. LEFT stick translates in the horizontal plane (converted
 * from head-relative to room axes), RIGHT stick lifts on Y and turns yaw. Exported
 * so the suite can drive exact time steps instead of racing a frame loop.
 * @param {{lx?: number, ly?: number, rx?: number, ry?: number}} axes
 * @param {number} dt seconds
 */
export function tickNudge(axes, dt) {
	if (!get(nudgeMode) || !currentKey()) return null;
	if (!(dt > 0)) return null;
	// never fight the ritual: a calibration in progress owns the controllers
	if (get(calibrating)) return null;
	const lx = curve(Number(axes?.lx) || 0);
	const ly = curve(Number(axes?.ly) || 0);
	const rx = curve(Number(axes?.rx) || 0);
	const ry = curve(Number(axes?.ry) || 0);
	if (!lx && !ly && !rx && !ry) return null;
	const base = get(roomAlignment);
	const hy = headYaw();
	// with no head to be relative to, fall back to the room's own axes
	const horiz = nudgeFromStick(lx, -ly, hy === null ? base.yaw : hy, base.yaw);
	const step = NUDGE_RATE_M * dt;
	return adjustRoomNudge({
		dx: horiz.dx * step,
		dz: horiz.dz * step,
		dy: -ry * step,
		dyaw: -rx * NUDGE_RATE_YAW * dt
	});
}

function frameTick() {
	if (!get(nudgeMode)) {
		lastTick = 0;
		return;
	}
	const now = Date.now();
	const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
	lastTick = now;
	if (dt > 0) tickNudge(getInput().axes, dt);
}

/** Arm/disarm the sticks. Armed state is meaningless without an alignment, so it
 * refuses rather than silently arming. @param {boolean} [on] */
export function setNudgeMode(on) {
	const next = on === undefined ? !get(nudgeMode) : !!on;
	if (next && !currentKey()) {
		showToast('Colocate first — a fine-tune needs a room to adjust');
		return false;
	}
	nudgeMode.set(next);
	lastTick = 0;
	if (next)
		showToast('Fine-tune armed — left stick slides the world, right stick lifts and turns it');
	return next;
}

// ---- lifecycle -----------------------------------------------------------------------

let started = false;
/** the room whose record is currently loaded into `roomNudge` @type {string|null} */
let loadedKey = null;

/**
 * Load a room's remembered correction whenever the alignment's room changes — which
 * covers the ritual, a CO3 anchor restore and a stop. This is the half that makes
 * "fine-tune once" true across sessions.
 */
export function startColocationNudge() {
	if (started) return;
	started = true;
	roomAlignment.subscribe((record) => {
		const key = /** @type {any} */ (record)?.roomKey ?? null;
		if (key === loadedKey) return;
		loadedKey = key;
		if (!key) {
			// stopped: drop the live correction, KEEP the record (stop is not forget)
			roomNudge.set(null);
			nudgeMode.set(false);
			return;
		}
		const stored = nudgeFor(key);
		roomNudge.set(stored);
		// the alignment write that triggered this already posed the rig from the OLD
		// correction, so re-pose with the one that belongs to this room
		if (stored) applyRoomAlignment();
	});
	registerVRFrameHook(frameTick);
	registerVRMenuEntry({
		id: 'colo:finetune',
		group: 'colocate',
		label: () => (get(nudgeMode) ? 'Fine-tune ✓' : 'Fine-tune'),
		order: 3,
		active: () => get(nudgeMode),
		visible: () => !!get(roomAlignment),
		closes: true,
		action: () => void setNudgeMode()
	});
	registerVRMenuEntry({
		id: 'colo:finetune-reset',
		group: 'colocate',
		label: () => 'Reset fine-tune',
		order: 4,
		visible: () => !!get(roomAlignment) && !nudgeIsZero(get(roomNudge)),
		closes: true,
		action: () => void resetRoomNudge()
	});
}

/** test seam */
export function nudgeDebug() {
	return {
		nudge: get(roomNudge) ? { ...get(roomNudge) } : null,
		mode: get(nudgeMode),
		key: currentKey(),
		records: readAll(),
		rates: { m: NUDGE_RATE_M, yaw: NUDGE_RATE_YAW, deadzone: NUDGE_DEADZONE }
	};
}

/** test seam: forget everything this module remembers */
export function resetColocationNudge() {
	roomNudge.set(null);
	nudgeMode.set(false);
	loadedKey = null;
	lastTick = 0;
	try {
		if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY);
	} catch {
		// nothing to do
	}
}
