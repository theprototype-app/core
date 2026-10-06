// Module SDK — the pointer seam, the click miss, the camera and the play-mode signal
// (37-slipped: modules DEVX #29, #31, #11 — the B4 remainder of roadmap 36).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { get, derived } from 'svelte/store';
import { globalCamera, globalRenderer, isLocked, isVRMode, editorMode } from '../../stores/sceneStore';
import { registerModulePointer } from '../modulePointer.js';
import { moduleClickMissHandlers } from './registries.js';

/**
 * THE play signal a module can trust: desktop Play (the pointer lock / ▶), OR a headset's
 * game mode — VR Play enters Interact and never takes a pointer lock, so `isPlaying()` alone
 * reads false for every headset player. dungeon-realms watched `#dungeon-minimap`'s class
 * for this (DEVX #11).
 */
export const modulePlayMode = derived(
	[isLocked, isVRMode, editorMode],
	([$locked, $vr, $mode]) => $locked === true || (!!$vr && $mode === 'interact')
);

/** live onPlayMode subscriptions (the lifecycle fixture counts them) @type {Set<Function>} */
export const playModeWatchers = new Set();

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPointerSeam(ctx) {
	const { owned } = ctx;
	return {
		/**
		 * DEVX #29: hear a PRESS, its drag and its release — and own the gesture. `down(hit, ctx)`
		 * runs on every primary press in `modes` (default ['interact', 'play']); return TRUE to
		 * claim it: the editor stops orbiting/selecting, Play stops its carry, and `move` / `up`
		 * come to you alone until the release. `hit` = `{object, point, uuid, distance}` (scene
		 * objects AND registered module content) or null; `ctx = {mode, ray, clientX, clientY,
		 * pointerType}` with `ray` a fresh THREE.Raycaster (the crosshair under a pointer lock).
		 * Desktop / touch only — VR has its own trigger hooks. Returns off(); torn down with the
		 * module. @param {{down?: Function, move?: Function, up?: Function}} handler
		 * @param {{modes?: ('edit' | 'interact' | 'play')[]}} [opts] @returns {() => void}
		 */
		registerPointerHandler(handler, opts) {
			return owned('pointerHandler', registerModulePointer(handler, opts));
		},
		/**
		 * DEVX #29: a viewport click that hit NOTHING selectable (the sky, empty floor) — the
		 * place to drop a carried piece or disarm a tool. Never consumes (a miss is still a
		 * deselect). Returns off(); torn down with the module. @param {() => void} fn
		 */
		onClickMiss(fn) {
			const wrapped = () => fn();
			moduleClickMissHandlers.push(wrapped);
			return owned('clickMiss', () => {
				const i = moduleClickMissHandlers.indexOf(wrapped);
				if (i >= 0) moduleClickMissHandlers.splice(i, 1);
			});
		},
		/**
		 * DEVX #31: the camera the user is looking through right now — the play camera in Play,
		 * a previewed scene camera, the editor camera, or the headset's XR camera. LOCAL,
		 * read-only: aim with it, never move it. @returns {any} THREE.Camera | null
		 */
		camera() {
			/** @type {any} */
			const r = get(globalRenderer);
			if (r?.xr?.isPresenting) return r.xr.getCamera();
			return get(globalCamera) ?? null;
		},
		/**
		 * DEVX #11: `fn(playing)` now and on every change. `playing` = desktop Play, or a headset's
		 * game (VR Play is Interact with no pointer lock). Returns off(); torn down with the module.
		 * @param {(playing: boolean) => void} fn @returns {() => void}
		 */
		onPlayMode(fn) {
			let last = /** @type {boolean | null} */ (null);
			const unsub = modulePlayMode.subscribe((playing) => {
				if (playing === last) return;
				last = playing;
				try {
					fn(playing);
				} catch (error) {
					console.warn('onPlayMode handler failed', error);
				}
			});
			playModeWatchers.add(fn);
			return owned('playMode', () => {
				unsub();
				playModeWatchers.delete(fn);
			});
		},
		/** The same answer as onPlayMode, read once. @returns {boolean} */
		inGame() {
			return get(modulePlayMode);
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkPointerSeam.surface = {
	registerPointerHandler: 'registers',
	onClickMiss: 'registers',
	camera: 'read',
	onPlayMode: 'registers',
	inGame: 'read'
};
