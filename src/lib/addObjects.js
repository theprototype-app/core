import { get } from 'svelte/store';
import { selectedObject } from '../stores/sceneStore';
import { peers, meshGenModalOpen } from '../stores/appStore';
import { sceneCommand } from './commandsHandler.svelte';
import { primitivesCatalog } from './primitivesCatalog';
import { meshGenReady } from './ai/meshProviders';

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
