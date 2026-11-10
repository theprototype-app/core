// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalCamera } from '../../stores/sceneStore';
import { peers, userdata } from '../../stores/appStore';

// 85 N3: WHERE THE PLAYERS ARE, for the nodes that react to people (an animal that looks at you,
// that shies away). Every peer reads the same replicated avatars plus its OWN view, so peers agree
// up to the avatar stream's latency. Stores only (the playSpawn reads, without its imports), so
// flowRuntime can call it without closing the history cycle.

const v = new THREE.Vector3();

/** world feet-level positions of every player this page knows: the others' avatars (AvatarRig groups
 * named by peer id; one parked at y > 500 has no pose yet) and this page's own camera
 * @returns {number[][]} */
export function playerPositions() {
	/** @type {number[][]} */
	const out = [];
	/** @type {any} */
	const scene = get(globalScene);
	/** @type {any} */
	const me = get(peers)?.peer?.id;
	if (scene)
		for (const row of /** @type {any[]} */ (get(userdata) ?? [])) {
			const id = row?.[0];
			if (typeof id !== 'string' || !id || id === me) continue;
			const rig = scene.getObjectByName(id);
			if (!rig?.isObject3D || !rig.visible) continue;
			rig.getWorldPosition(v);
			if (v.y > 500) continue;
			out.push([v.x, v.y, v.z]);
		}
	/** @type {any} */
	const cam = get(globalCamera);
	if (cam?.isObject3D) {
		cam.getWorldPosition(v);
		out.push([v.x, v.y, v.z]);
	}
	return out;
}
