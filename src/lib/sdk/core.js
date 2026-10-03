// Module SDK — the basics: selection, scene + objects group, assets, peer id, toast, clock, THREE.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import * as THREE from 'three';
import { peers, showToast } from '../../stores/appStore';
import { syncedAnimations } from '../../stores/flowStore';
import { globalScene, objectsGroup, selectedObject } from '../../stores/sceneStore';
import { sessionNow } from '../sessionClock';
import { get } from 'svelte/store';
import { moduleAssets } from './registries.js';

/**
 * The clock the effect runtime runs on (seconds). Stamp replicated timestamps
 * with this so time-based effects agree across peers.
 */
export function runtimeNow() {
	return get(syncedAnimations) ? (sessionNow() % 86400000) / 1000 : performance.now() / 1000;
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkCore(ctx) {
	const { moduleId } = ctx;
	return {
		/** the currently selected object's uuid (undefined when none) */
		selectedUuid() {
			return /** @type {any} */ (get(selectedObject))?.uuid;
		},
		scene: () => get(globalScene),
		objectsGroup: () => get(objectsGroup),
		/** The assets the shared scene uses right now — [{group, name, kind, hash}] (108) */
		sceneAssets: () => {
			// dynamic to stay outside the module graph cycle guard
			return import('../sceneAssets').then((m) => m.sceneAssetList());
		},
		peerId: () => /** @type {any} */ (get(peers))?.peer?.id,
		toast: showToast,
		now: runtimeNow,
		// user modules are self-contained (no imports) — THREE + assets come via the api
		THREE: THREE,
		/** blob URL for a packaged file, e.g. api.assetUrl('assets/pling.mp3') @param {string} path */
		assetUrl: (path) => moduleAssets[moduleId]?.[path] ?? null
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkCore.surface = {
	selectedUuid: 'read',
	scene: 'read',
	objectsGroup: 'read',
	sceneAssets: 'read',
	peerId: 'read',
	toast: 'action',
	now: 'read',
	THREE: 'value',
	assetUrl: 'read'
};
