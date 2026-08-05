import { get } from 'svelte/store';
import { selectedObject } from '../stores/sceneStore';
import { peers, meshGenModalOpen, showSidebar } from '../stores/appStore';
import { sceneCommand } from './commandsHandler.svelte';
import { primitivesCatalog } from './primitivesCatalog';
import { meshGenReady } from './ai/meshProviders';
import { addParticlesPreset } from './particleActions';
import { PARTICLE_PRESETS } from './particlePresets';

// Spawning for the viewport Add menu (77): run the replicated create command,
// then land the new object at the clicked ground point (groups keep their
// default spot) — the position rides the normal `move` message.

/** @param {string} command @param {number[] | null | undefined} point */
export function spawnAtPoint(command, point) {
	sceneCommand(command);
	const object = get(selectedObject);
	if (point && object?.uuid && !command.startsWith('/group')) {
		object.position.set(point[0], point[1], point[2]);
		/** @type {any} */
		const peer = get(peers);
		if (peer)
			peer.send({
				type: 'move',
				uuid: object.uuid,
				pos: object.position.toArray(),
				rot: object.rotation.toArray(),
				scale: object.scale.toArray()
			});
	}
	// 16-Q2: adding from the menu OPENS the new object's properties, even when
	// another panel (Configure Scene, a different selection) was showing — creation
	// already selects the object, this makes the "now tweak it" step obvious.
	if (object?.uuid) showSidebar('properties');
	return object;
}

/** Nested `Add ▸` children for the viewport menu @param {() => number[] | null} pointOf */
export function buildAddChildren(pointOf) {
	return [
		...primitivesCatalog.map((group) => ({
			label: group.group,
			children: group.items.map((item) => ({
				label: item.label,
				action: () => spawnAtPoint(item.command, pointOf())
			}))
		})),
		{ label: 'Group', tooltip: 'Create an empty group', action: () => spawnAtPoint('/group New', null) },
		// PFX-A: standalone emitters — a small marker sphere carries the config
		// (userData.particles rides object sync / GLTF extras, so it replicates
		// and saves like any object)
		{
			label: 'Effects',
			children: PARTICLE_PRESETS.map((preset) => ({
				label: preset.name,
				tooltip: 'Place a ' + preset.name + ' particle emitter',
				action: () => {
					const object = spawnAtPoint('/create Sphere 0.15', pointOf());
					if (!object?.uuid) return;
					/** @type {any} */
					const peer = get(peers);
					object.name = preset.name + ' emitter';
					if (peer) peer.send({ type: 'name', uuid: object.uuid, name: object.name });
					// the marker itself should not cast a shadow (userData.shadow
					// keeps the opt-out through GLTF sync, V-1)
					object.castShadow = false;
					object.userData.shadow = false;
					if (peer) peer.send({ type: 'objectParameters', parameter: 'castShadow', uuid: object.uuid, castShadow: false });
					// nor join simulations (primitives spawn dynamic by default now —
					// an emitter marker must stay scenery, not tumble away)
					delete object.userData.physics;
					if (peer) peer.send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: null });
					addParticlesPreset(object.uuid, preset.key);
				}
			}))
		},
		// Generate a custom mesh from a prompt (roadmap #11) — only when configured
		...(meshGenReady()
			? [
					{
						label: '✨ Generate 3D model…',
						tooltip: 'Create a custom mesh from a text prompt',
						action: () => meshGenModalOpen.set({ position: pointOf() })
					}
			  ]
			: [])
	];
}
