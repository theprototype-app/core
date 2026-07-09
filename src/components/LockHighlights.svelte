<script>
	import * as THREE from 'three';
	import { T, useTask } from '@threlte/core';
	import { lockedObjects, objectsGroup } from '../stores/sceneStore';
	import { peers } from '../stores/appStore';
	import { peerColor } from '$lib/lockControl';

	// Wireframe box around every object locked by ANOTHER peer, tinted with
	// that peer's color (same hash as pings/cursors). Boxes track the object
	// every frame; nothing here touches replicated materials.

	const group = new THREE.Group();
	group.name = 'lock-highlights';

	/** @type {Map<string, any>} lock key -> Box3Helper */
	const helpers = new Map();

	useTask(() => {
		/** @type {any} */
		const peer = $peers;
		const scene = $objectsGroup;
		const wanted = new Map();
		if (scene && peer) {
			for (const [holder, uuid] of $lockedObjects) {
				if (holder === peer.peer?.id) continue;
				const target = scene.getObjectByProperty('uuid', uuid);
				if (target) wanted.set(holder + ':' + uuid, { holder, target });
			}
		}
		// drop stale helpers
		for (const [key, helper] of helpers) {
			if (!wanted.has(key)) {
				group.remove(helper);
				helper.dispose?.();
				helpers.delete(key);
			}
		}
		// add/update
		for (const [key, { holder, target }] of wanted) {
			let helper = helpers.get(key);
			if (!helper) {
				helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(peerColor(holder)));
				helpers.set(key, helper);
				group.add(helper);
			}
			helper.box.setFromObject(target);
		}
	});
</script>

<T is={group} />
