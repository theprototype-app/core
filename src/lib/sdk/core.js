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

/**
 * 101 F6: the module api's contract version (`api.version`). 1 = everything before 101; 2 = the
 * same api, with a version number to probe and a notice: the RAW renderer a module can reach
 * (`api.camera()`'s renderer read, the `renderer` handed to shader / post backends) stays for now
 * but leaves the contract later (roadmap 100 swaps renderers) — use the look / post SDK calls.
 *
 * 3 (2.0-n3c, additive): the SCRIPT api a module's behaviours and Script nodes run with gained `api.version`
 * (scriptIO SCRIPT_API_VERSION, 2), `api.self()` and `api.stamp(input)`. A module that writes such code probes
 * `(api.version ?? 1) >= 3` here before relying on them on the host it was loaded into.
 */
export const SDK_API_VERSION = 3;

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
		/** 101 F6: the api contract version — feature-probe with `(api.version ?? 1) >= 2` */
		version: SDK_API_VERSION,
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
	version: 'value',
	assetUrl: 'read'
};
