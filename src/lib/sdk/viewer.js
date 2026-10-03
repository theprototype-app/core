// Module SDK — where the viewer is and what is selected.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import * as THREE from 'three';
import { selectedObjects, globalCamera } from '../../stores/sceneStore';
import { get } from 'svelte/store';
import { objectActionsRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkViewer(ctx) {
	return {
		/**
		 * R3a: where the VIEWER is — the active camera's world position as [x, y, z], or
		 * null before the scene exists. In play mode the camera IS the player (walk mode,
		 * fly mode and VR all move it), so this is the read a self-proximity trigger wants:
		 * each peer detects ITSELF near an object and fires its own pulse, no physics sim
		 * required. @returns {number[] | null}
		 */
		playerPosition() {
			const cam = /** @type {any} */ (get(globalCamera));
			if (!cam?.getWorldPosition) return null;
			return cam.getWorldPosition(new THREE.Vector3()).toArray();
		},
		/**
		 * R3a: select an object (the viewport-click path — selection is also the lock).
		 * The manager-toolbox row click. @param {string} uuid
		 */
		selectObject(uuid) {
			objectActionsRef?.selectObject?.(uuid);
		},
		/** R3a: the current selection SET's uuids — [] when nothing is selected. Reads the
		 * SET, never the sticky primary (`selectedUuid`), which keeps the last object after
		 * a deselect. @returns {string[]} */
		selectedUuids() {
			return [...(get(selectedObjects) ?? [])].filter(Boolean);
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkViewer.surface = {
	playerPosition: 'read',
	selectObject: 'action',
	selectedUuids: 'read'
};
