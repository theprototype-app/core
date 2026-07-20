<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three';
	import { T, useTask } from '@threlte/core';
	import { objectsGroup } from '../stores/sceneStore';
	import { pings, PING_TTL } from '$lib/ping';

	// Object pings (U-1): a ping that carries a `uuid` flashes a highlight box
	// around that object for its lifetime, tinted with the ping color — so a peer
	// can point everyone at a specific object, not just a spot. Emissive-
	// independent (a Box3Helper, not a material tint), tracks the object every
	// frame, and never touches replicated materials. The `pings` store already
	// prunes expired entries.

	const group = new THREE.Group();
	group.name = 'ping-highlights';

	/** @type {Map<string, any>} ping id -> Box3Helper */
	const helpers = new Map();

	useTask(() => {
		const scene = $objectsGroup;
		const now = Date.now();
		const wanted = new Map();
		if (scene) {
			for (const ping of $pings) {
				if (!ping.uuid) continue;
				const target = scene.getObjectByProperty('uuid', ping.uuid);
				if (target) wanted.set(ping.id, { ping, target });
			}
		}
		for (const [id, helper] of helpers) {
			if (!wanted.has(id)) {
				group.remove(helper);
				helper.dispose?.();
				helpers.delete(id);
			}
		}
		for (const [id, { ping, target }] of wanted) {
			let helper = helpers.get(id);
			if (!helper) {
				helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(ping.color || '#4f83cc'));
				helper.material.transparent = true;
				helper.material.depthTest = false;
				helper.renderOrder = 9998;
				helpers.set(id, helper);
				group.add(helper);
			}
			helper.box.setFromObject(target);
			// gentle pulse over the ping lifetime so it reads as a live highlight
			const age = (now - ping.ts) / PING_TTL;
			helper.material.opacity = 0.85 * Math.max(0, 1 - age) * (0.6 + 0.4 * Math.cos(age * Math.PI * 6));
		}
	});
</script>

<T is={group} />
