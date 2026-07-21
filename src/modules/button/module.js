import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { allNodes } from '../../stores/flowStore';
import { setNodeData } from '$lib/nodesHandler';
import { runtimeNow } from '$lib/moduleSDK';
import ButtonTriggerNode from './ButtonTriggerNode.svelte';

// Button/actuator: pick any scene object as a button in the "Button trigger"
// node; clicking that object (desktop click or VR trigger) presses the node,
// and an edge to an Object Selector slides the target up while pressed (door).
// Everything replicates through node data (pressed + press timestamp) — the
// slide itself is computed deterministically from the synced clock.

/** Press a trigger node like a viewport click would @param {any} node */
export function pressTriggerNode(node) {
	const pressed = node.data?.mode === 'push' ? true : !node.data?.pressed;
	// H1: route the data write to the node's own graph (allNodes tags __graph)
	setNodeData(node.id, { pressed: pressed, at: runtimeNow() }, node.__graph);
}

export default {
	id: 'button',
	name: 'Button & door',
	version: '1.0.0',
	description: 'Clickable button/actuator that slides a door object through the graph.',
	/** @param {any} api */
	register(api) {
		// distinctive squat button shape (base plate + cap), one mesh
		api.registerPrimitive(
			'Button',
			() => {
				const base = new THREE.CylinderGeometry(0.5, 0.6, 0.2, 24);
				const cap = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 24);
				cap.translate(0, 0.15, 0);
				return mergeGeometries([base, cap]);
			},
			{ label: 'Button', command: '/create Button' }
		);

		api.registerNodeGroup(
			{
				group: 'Modules',
				items: [
					{
						type: 'buttontrigger',
						label: 'Button trigger',
						defaults: { button: '-None-', mode: 'toggle', height: 2, pressed: false, at: 0 }
					}
				]
			},
			{ buttontrigger: ButtonTriggerNode }
		);

		// clicking the chosen button object presses the node instead of selecting
		api.registerClickHandler((object) => {
			const group = api.objectsGroup();
			if (!group) return false;
			let top = object;
			while (top.parent && top.parent !== group) top = top.parent;
			// H1: the trigger node can live in any graph document
			const node = allNodes().find(
				(n) => n.type === 'buttontrigger' && n.data?.button === top.uuid
			);
			if (!node) return false;
			pressTriggerNode(node);
			return true;
		});

		// door effect: slide the connected object up while pressed
		api.registerEffect('buttontrigger', (object, base, data, time) => {
			const height = data.height ?? 2;
			const duration = Math.max(Math.abs(height) / 2, 0.15); // ~2 m/s
			const at = data.at ?? 0;
			const clamp01 = (value) => Math.min(Math.max(value, 0), 1);
			let lift;
			if (data.pressed) {
				lift = clamp01((time - at) / duration);
				if (data.mode === 'push') {
					// spring back after a short hold, no extra message needed
					const downStart = at + duration + 1.5;
					if (time >= downStart) lift = 1 - clamp01((time - downStart) / duration);
				}
			} else {
				lift = 1 - clamp01((time - at) / duration);
			}
			object.position.y = base.pos[1] + height * lift;
		});
	}
};
