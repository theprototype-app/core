// 36 F22 — WHICH OBJECTS A RAY PASSES THROUGH, per mode. The editor's selection reads the
// scene's own setting (Configure Scene ▸ Advanced, saved + replicated in the scenePhysics
// singleton as `pick`); a GAME's rays (Interact/Play taps and carries, the VR laser and
// sweep) skip water and trigger volumes unless the scene's play block opts back in
// (`play.rayHits`). The rules themselves are selectThrough.js (pure, vitest).
import { get } from 'svelte/store';
import { scenePhysicsState_ } from './scenePhysics';
import { normalizePassThrough, gamePassThrough } from './selectThrough';
import { gameFeelActive } from './gameFeel';

/** What the editor's selection passes through in this scene. */
export function editorPass() {
	return normalizePassThrough(get(scenePhysicsState_)?.pick);
}

/** What a game's interaction rays pass through in this scene. */
export function gamePass() {
	return gamePassThrough(get(scenePhysicsState_)?.play?.rayHits);
}

/** The pass for a ray cast right now: the game's in Interact/Play, the editor's otherwise. */
export function rayPass() {
	return gameFeelActive() ? gamePass() : editorPass();
}
