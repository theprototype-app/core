import { writable, get } from 'svelte/store';

// W4: THE TOUCH PLAY CONTROLS LEAF — a virtual move stick and a look drag, plus the
// one local preference that tunes them.
//
// Imports NOTHING but svelte/store, deliberately: PointerLockControls reads these
// numbers from inside its per-frame task and the overlay component writes them from
// window listeners, and neither may reach the other. It is the gamepadPrefs shape one
// device over — the pad leaf exists for exactly this reason (inputRuntime polls,
// PointerLockControls consumes, and neither imports the other).
//
// THE INTEGRATION RULE, which is the whole design: a phone does NOT get a second
// movement pipeline. The move stick publishes the same kind of number the gamepad's
// left stick publishes (a RATE in -1..1) and folds into the same two lines of
// PointerLockControls that already consume `getGamepadAxes()`; the look drag publishes
// the same kind of number a mouse publishes (a DISPLACEMENT in pixels) and is applied
// by the same euler code `onMouseMove` uses. Everything downstream therefore comes for
// free and cannot drift: E6's walk mode, the grounded pin, the dungeon wall slide, the
// 'keys' input claim and the E3 `playPointerFree` menu substate all gate the touch
// input exactly as they gate WASD and the pad, because they gate the code it feeds.
//
// The two natures are why there are two channels rather than one. A stick that is not
// being pushed reads zero every frame, so it is a STORE the task samples. A drag that
// is not moving produces no events at all, so its delta is ACCUMULATED between frames
// and drained — sampling a "current" look delta would apply the last swipe forever.

/** Pixels from the touch-down point at which the move stick reads full deflection. */
export const TOUCH_STICK_RADIUS = 64;

/**
 * Travel, in CSS pixels, past which a right-half gesture is a LOOK and not a tap — and
 * the ONLY test the overlay applies.
 *
 * There was a duration test beside it (250 ms) and measuring it is what removed it: a
 * two-event tap measured 258 ms in the harness, so it read as a drag and the interact
 * click silently did not happen. A slow thumb does the same thing on a phone. The test
 * could only ever SUPPRESS interactions — a gesture that moved 8 px looked at nothing
 * either way — and the duration verdict already exists one layer down, in
 * playInteract's own tuned and documented 400 ms window (whose comment records a
 * deliberate 120 ms tap arriving as 180 ms on a busy frame). One threshold, in the
 * place that already owned it.
 */
export const TOUCH_TAP_SLOP = 8;

/**
 * Radians of yaw per pixel of drag, before `touchLookSpeed`. Twice the mouse's own
 * 0.002, because a thumb crosses a phone in ~350 px where a mouse crosses a desk in
 * thousands of counts — at the mouse constant a full-width swipe turned 40 degrees and
 * read as a broken control.
 */
export const TOUCH_LOOK_RADIANS_PER_PX = 0.004;

const SPEED_KEY = 'touchLookSpeed';
/** @type {{min: number, max: number}} */
export const TOUCH_LOOK_SPEED_RANGE = { min: 0.25, max: 3 };

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function storedSpeed() {
	if (typeof localStorage === 'undefined') return 1;
	const raw = Number(localStorage.getItem(SPEED_KEY));
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return clamp(raw, TOUCH_LOOK_SPEED_RANGE.min, TOUCH_LOOK_SPEED_RANGE.max);
}

/**
 * Look sensitivity multiplier. A LOCAL pref, the viewPrefs/gridSettings/gamepadPrefs
 * family: how fast I like to turn with my thumb is a fact about my hand and my screen,
 * so it is never replicated and never saved into a scene.
 */
export const touchLookSpeed = writable(storedSpeed());

/** @param {number} value */
export function setTouchLookSpeed(value) {
	const next = clamp(Number(value) || 1, TOUCH_LOOK_SPEED_RANGE.min, TOUCH_LOOK_SPEED_RANGE.max);
	touchLookSpeed.set(next);
	try {
		if (typeof localStorage !== 'undefined') localStorage.setItem(SPEED_KEY, String(next));
	} catch {
		/* private mode — the pref is a convenience, never a requirement */
	}
}

/**
 * The virtual move stick, -1..1 per axis, in the gamepad's own sign convention:
 * `y` is NEGATIVE forward, because that is what a standard-mapping stick reports and
 * what PointerLockControls' `translateZ` already expects.
 * @type {import('svelte/store').Writable<{x: number, y: number}>}
 */
export const touchMove = writable({ x: 0, y: 0 });

/**
 * What the overlay DRAWS: where each stick was placed and where the thumb is now, in
 * client pixels. Presentation only — every decision it renders was already made by the
 * gesture code, the PlayReticle contract.
 * @type {import('svelte/store').Writable<{
 *   move: {ox: number, oy: number, x: number, y: number} | null,
 *   look: {x: number, y: number} | null
 * }>}
 */
export const touchSticks = writable({ move: null, look: null });

let lookDx = 0;
let lookDy = 0;

/**
 * Accumulate a look drag. Called once per pointermove; several may land between two
 * frames, and dropping all but the last would make a fast swipe turn less than a slow
 * one covering the same distance.
 * @param {number} dx @param {number} dy
 */
export function pushTouchLook(dx, dy) {
	lookDx += dx;
	lookDy += dy;
}

/**
 * Take the pending look drag and reset it. The caller applies it and nobody else may
 * read it — a peek would double-apply.
 * @returns {{dx: number, dy: number}}
 */
export function drainTouchLook() {
	const drained = { dx: lookDx, dy: lookDy };
	lookDx = 0;
	lookDy = 0;
	return drained;
}

/** Is any touch gesture live? (the render-loop nudge, and the debug view) */
export function touchLookPending() {
	return lookDx !== 0 || lookDy !== 0;
}

/**
 * Everything back to rest. The gamepad's `quietPad` discipline, and needed for the same
 * reason: a stick left deflected because play mode ended, a menu opened or the finger
 * left the screen during a scroll would drive the camera forever.
 */
export function resetTouchInput() {
	lookDx = 0;
	lookDy = 0;
	const move = get(touchMove);
	if (move.x !== 0 || move.y !== 0) touchMove.set({ x: 0, y: 0 });
	const sticks = get(touchSticks);
	if (sticks.move || sticks.look) touchSticks.set({ move: null, look: null });
}

/**
 * Map a thumb offset from the stick's origin onto the axes.
 * Clamped to the unit disc rather than per axis: clamping the components separately
 * makes the diagonal 1.41x faster than a cardinal, so a player walks fastest at 45
 * degrees (the same reasoning as throwVelocity's magnitude clamp).
 * @param {number} dx @param {number} dy
 * @returns {{x: number, y: number}}
 */
export function stickAxes(dx, dy) {
	const distance = Math.hypot(dx, dy);
	if (distance < 1) return { x: 0, y: 0 };
	const scale = Math.min(1, distance / TOUCH_STICK_RADIUS) / distance;
	return { x: dx * scale, y: dy * scale };
}

/** test/debug view */
export function touchControlsDebug() {
	return { move: get(touchMove), sticks: get(touchSticks), lookDx, lookDy };
}
