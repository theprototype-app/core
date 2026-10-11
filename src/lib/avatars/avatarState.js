// 36-avatars: the small LOCAL state the rigged avatars share with the rest of the UI. A leaf
// (svelte/store + safeStorage). Nothing here replicates.

import { derived, writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

/**
 * Which peers' hands the rigged body is currently holding with its IK (so Player stops drawing the
 * floating controller box for that side — the body's hand IS the marker). Written on CHANGE only.
 * @type {import('svelte/store').Writable<Record<string, Record<string, boolean>>>}
 */
export const avatarIkPeers = writable({});

/**
 * The customise panel's live preview of YOUR character: the draft config and where it stands.
 * null = no preview. Rendered by Player, LOCAL only (golden rule 5: scene root, never objectsGroup).
 * @type {import('svelte/store').Writable<null | {config: any, photo: string, position: number[], yaw: number, walk: boolean}>}
 */
export const avatarPreview = writable(null);

/**
 * 41 G10: the customise panel's ISOLATED STUDIO (characterStudio.js). `studioOpen` = the panel
 * is open on a flat screen; `studioInScene` = the remembered "Show in scene" switch (the
 * character previewed in the current scene instead). LOCAL prefs, never replicated.
 */
export const studioOpen = writable(false);
export const studioInScene = writable(safeStorage.getItem('characterStudio:inScene') === '1');
studioInScene.subscribe((v) => safeStorage.setItem('characterStudio:inScene', v ? '1' : '0'));
/** the studio also shows ping markers until this performance.now() (the ping Preview) */
export const studioPingUntil = writable(0);
/** the scene is hidden from the render right now */
export const studioIsolating = derived([studioOpen, studioInScene], ([open, inScene]) => open && !inScene);

/** live RiggedAvatar instances by root name, for the debug hook / e2e @type {Map<string, any>} */
export const avatarInstances = new Map();

/** e2e/debug: every rigged body's state */
export function avatarsDebug() {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [name, a] of avatarInstances) out[name] = a.state();
	return out;
}

/**
 * LOCAL pref (Settings ▸ Interface ▸ Avatars): draw everybody as the classic floating head on THIS
 * device — the fallback for a headset with many peers. Never replicated; peers still see your choice.
 */
export const peersAsClassic = writable(safeStorage.getItem('avatars:peersClassic') === '1');
peersAsClassic.subscribe((v) => safeStorage.setItem('avatars:peersClassic', v ? '1' : '0'));

// 37 R23: where THIS player's feet are while a walker owns them (desktop Play walk / the grounded
// pin, the VR Interact walker), in WORLD metres. Written every frame by the walking code, read by
// the camera broadcast, which adds it to the `camera` message as an optional `feet` — so peers
// stand our body on the floor our walker actually found (slopes and steps included) instead of
// guessing it a body-height under the head. Stale after FEET_STALE_MS: flying, the editor and a
// left Play stop writing, and the field simply drops off the wire.
const FEET_STALE_MS = 250;
let feetY = /** @type {number | null} */ (null);
let feetAt = 0;
/** @param {number | null} y world metres, or null = not walking */
export function setLocalFeet(y) {
	feetY = Number.isFinite(y) ? /** @type {number} */ (y) : null;
	feetAt = typeof performance !== 'undefined' ? performance.now() : 0;
}
/** @returns {number | null} */
export function localFeet() {
	if (feetY === null) return null;
	const now = typeof performance !== 'undefined' ? performance.now() : 0;
	return now - feetAt > FEET_STALE_MS ? null : feetY;
}

// 37 R22: THIS player is "knocked off" — no input for `knockedAfterSeconds`. The camera broadcast
// carries it as `knocked: 1`; every peer animates the stars and the sway locally.
/** the choices Settings ▸ Avatars offers (seconds; 0 = never) */
export const KNOCKED_AFTER_CHOICES = [0, 10, 20, 60];
export const KNOCKED_AFTER_DEFAULT = 20;
const storedKnock = Number(safeStorage.getItem('avatars:knockedAfter'));
/** LOCAL pref: seconds without input before your character is knocked off (0 = never) */
export const knockedAfterSeconds = writable(KNOCKED_AFTER_CHOICES.includes(storedKnock) && safeStorage.getItem('avatars:knockedAfter') !== null ? storedKnock : KNOCKED_AFTER_DEFAULT);
let knockedAfterMs = KNOCKED_AFTER_DEFAULT * 1000;
knockedAfterSeconds.subscribe((v) => {
	knockedAfterMs = Math.max(0, Number(v) || 0) * 1000;
	safeStorage.setItem('avatars:knockedAfter', String(v));
});

/** moving the head this far (m) or turning it this much (rad) is input, not a sway */
const STILL_M = 0.03;
const STILL_RAD = 0.07;
let knocked = false;
let lastActivity = typeof performance !== 'undefined' ? performance.now() : 0;
/** @type {number[] | null} */
let anchorPos = null;
/** @type {number[] | null} */
let anchorQuat = null;
let listening = false;

/** any input (a key, the pointer, a wheel, a touch) wakes you */
export function noteActivity() {
	lastActivity = typeof performance !== 'undefined' ? performance.now() : 0;
	knocked = false;
}

function listen() {
	if (listening || typeof window === 'undefined') return;
	listening = true;
	for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'])
		window.addEventListener(type, noteActivity, { capture: true, passive: true });
}

/**
 * One frame of the idle watch, from the camera broadcast (Scene.svelte): the head moving or turning
 * past a small threshold counts as input too (a VR head, a gamepad stick, a flown camera).
 * @param {number[]} pos [x, y, z] @param {number[]} quat [x, y, z, w] @param {number} nowMs
 * @returns {boolean} knocked off now
 */
export function tickIdle(pos, quat, nowMs) {
	listen();
	if (!anchorPos || !anchorQuat) {
		anchorPos = [...pos];
		anchorQuat = [...quat];
	}
	const moved = Math.hypot(pos[0] - anchorPos[0], pos[1] - anchorPos[1], pos[2] - anchorPos[2]);
	const dot = Math.min(1, Math.abs(quat[0] * anchorQuat[0] + quat[1] * anchorQuat[1] + quat[2] * anchorQuat[2] + quat[3] * anchorQuat[3]));
	if (moved > STILL_M || 2 * Math.acos(dot) > STILL_RAD) {
		anchorPos = [...pos];
		anchorQuat = [...quat];
		lastActivity = nowMs;
	}
	knocked = knockedAfterMs > 0 && nowMs - lastActivity > knockedAfterMs;
	return knocked;
}

/** @param {boolean} on e2e/debug: force the state (the next real input wakes it) */
export function setLocalKnockedOut(on) {
	knocked = !!on;
	if (on) lastActivity = -Infinity;
	else noteActivity();
}
export function localKnockedOut() {
	return knocked;
}
