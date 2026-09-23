// 30 P3 — FREE-CURSOR GAMES (roadmap 30 fork 6): WHERE PLAY MODE AIMS.
//
// Play mode had exactly one aim: NDC (0, 0), the crosshair, because under pointer lock the
// cursor is pinned to the centre of the canvas and does not exist for the player. A board
// game, a puzzle or an instrument wants the opposite — the real cursor, visible, aiming
// wherever it is — and `scenePhysics.play.cursor: 'free'` asks for that (absent = 'locked',
// today, byte for byte). A module may publish it too, field by field, through the
// `userData.play` contract (`resolvePlaySettings`).
//
// THIS LEAF IS THE ONE ANSWER to "where is the player aiming right now", so the pieces that
// ask cannot disagree:
//   · playInteract's tap and grab (the crosshair ray before this),
//   · PointerLockControls, which must not ask for a lock in free mode,
//   · PlayReticle, which has no crosshair to draw in free mode,
//   · the module SDK's `pointerRay()` (lane 30-core-modes reads `playAimNdc()` in play:
//     the cursor when free, the crosshair under a lock — which is also the fix for the
//     stale-mouse ray it returned under a lock).
//
// The cursor is recorded in CLIENT pixels and converted to NDC against the canvas at read
// time (the W9 rule `pointerRay` already keeps: the viewport can change with the pointer
// perfectly still). LOCAL and unreplicated — an aim is a fact about this screen.
//
// Imports stores and leaves only (sceneStore, scenePhysics via playSettings, canvasRect),
// so playInteract, PointerLockControls and moduleSDK can all reach it without a cycle.

import { get } from 'svelte/store';
import { isLocked, isVRMode, globalScene } from '../stores/sceneStore';
import { resolvePlaySettings } from './playSettings';
import { ndcFromClient } from './canvasRect';

/** the last pointer position over the page, CLIENT pixels */
const cursor = { x: 0, y: 0, seen: false };

if (typeof window !== 'undefined') {
	// capture phase + passive: we only read coordinates, and a panel that stops the event
	// on its way up (the documented delegated-handler trap) must not hide the cursor from us
	const note = (/** @type {PointerEvent} */ event) => {
		cursor.x = event.clientX;
		cursor.y = event.clientY;
		cursor.seen = true;
	};
	window.addEventListener('pointermove', note, { capture: true, passive: true });
	window.addEventListener('pointerdown', note, { capture: true, passive: true });
}

/** 'free' | 'locked' — the scene's play cursor, publishers included. Readable in the
 * editor too (it is authored data), so the Inspector can show it. @returns {'free'|'locked'} */
export function playCursorSetting() {
	return resolvePlaySettings(get(globalScene)).cursor === 'free' ? 'free' : 'locked';
}

/** Is play running with a FREE cursor right now? Desktop play only: a headset has no
 * cursor to free, and outside play there is no aim at all. */
export function playCursorFree() {
	if (get(isLocked) !== true || get(isVRMode)) return false;
	return playCursorSetting() === 'free';
}

/** The last cursor position in client pixels, or null before the first pointer event. */
export function cursorClient() {
	return cursor.seen ? { x: cursor.x, y: cursor.y } : null;
}

/**
 * WHERE PLAY MODE AIMS, in NDC: the cursor in free-cursor play (the centre until the first
 * pointer event), the crosshair (0, 0) otherwise.
 * @returns {{x: number, y: number}}
 */
export function playAimNdc() {
	if (!playCursorFree() || !cursor.seen) return { x: 0, y: 0 };
	return ndcFromClient(cursor.x, cursor.y);
}

/** test/debug view */
export function playCursorDebug() {
	return { setting: playCursorSetting(), free: playCursorFree(), cursor: cursorClient(), ndc: playAimNdc() };
}
