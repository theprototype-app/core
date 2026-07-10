// Catalog of all available node types, grouped for the palette and context menu.
// `defaults` seeds node.data on creation (and gets replicated to peers with the node).
// `params` describes the controls rendered by AnimationNode-style generic nodes.
// Modules contribute additional groups through moduleNodeGroups (moduleSDK).

import { get } from 'svelte/store';
import { moduleNodeGroups } from './moduleSDK';

/**
 * @typedef {{ key: string, kind: 'range' | 'select', min?: number, max?: number, step?: number, options?: string[] }} NodeParam
 * @typedef {{ type: string, label: string, defaults: Record<string, any>, params?: NodeParam[] }} NodeSpec
 */

/** @type {{ group: string, items: NodeSpec[] }[]} */
export const nodeCatalog = [
	{
		group: 'Input',
		items: [
			{ type: 'slider', label: 'Slider', defaults: { value: 20 } },
			{ type: 'colorpicker', label: 'Color Picker', defaults: { color: '#ff4000' } },
			{ type: 'switcher', label: 'Switcher', defaults: { shape: 'cube' } }
		]
	},
	{
		group: 'Scene',
		items: [{ type: 'objectselector', label: 'Object Selector', defaults: { selected: '-None-' } }]
	},
	{
		group: 'Logic',
		items: [
			{
				type: 'script',
				label: 'Script',
				defaults: {
					code:
						'// runs every frame on every peer (keep it deterministic)\n' +
						'// object: the connected THREE object; base: {pos, rot, scale, visible}\n' +
						'// data: this node\'s data; time: synced seconds\n' +
						'object.position.y = base.pos[1] + Math.sin(time * 2) * 0.5;\n'
				}
			}
		]
	},
	{
		group: 'Animation',
		items: [
			{
				type: 'shake',
				label: 'Shake',
				defaults: { intensity: 0.2, speed: 10 },
				params: [
					{ key: 'intensity', kind: 'range', min: 0, max: 1, step: 0.01 },
					{ key: 'speed', kind: 'range', min: 1, max: 30, step: 1 }
				]
			},
			{
				type: 'spin',
				label: 'Spin',
				defaults: { axis: 'y', speed: 1 },
				params: [
					{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
					{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
				]
			},
			{
				type: 'bounce',
				label: 'Bounce',
				defaults: { amplitude: 0.5, speed: 2 },
				params: [
					{ key: 'amplitude', kind: 'range', min: 0, max: 3, step: 0.05 },
					{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
				]
			},
			{
				type: 'orbit',
				label: 'Orbit',
				defaults: { radius: 1, speed: 1 },
				params: [
					{ key: 'radius', kind: 'range', min: 0, max: 5, step: 0.05 },
					{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
				]
			},
			{
				type: 'pathpatrol',
				label: 'Path patrol',
				defaults: { points: [], speed: 1, mode: 'loop' }
			}
		]
	},
	{
		group: 'Physics',
		items: [
			{
				type: 'mass',
				label: 'Mass',
				defaults: { kg: 1 },
				params: [{ key: 'kg', kind: 'range', min: 0.1, max: 100, step: 0.1 }]
			},
			{
				type: 'bounciness',
				label: 'Bounciness',
				defaults: { value: 0.3 },
				params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }]
			},
			{
				type: 'friction',
				label: 'Friction',
				defaults: { value: 0.5 },
				params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }]
			}
		]
	},
	{
		group: 'Effects',
		items: [
			{
				type: 'pulse',
				label: 'Pulse',
				defaults: { amount: 0.2, speed: 2 },
				params: [
					{ key: 'amount', kind: 'range', min: 0, max: 1, step: 0.01 },
					{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
				]
			},
			{
				type: 'blink',
				label: 'Blink',
				defaults: { speed: 2 },
				params: [{ key: 'speed', kind: 'range', min: 0.2, max: 10, step: 0.1 }]
			}
		]
	}
];

// Node types the animation runtime evaluates every frame
export const animationTypes = ['shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink', 'pathpatrol'];

/**
 * Palette group a node type belongs to — drives the category accent color
 * (built-in groups by name, module groups fall back to the module accent,
 * user-designed custom nodes return null).
 * @param {string} type
 */
export function groupOf(type) {
	for (const group of nodeCatalog)
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	for (const group of get(moduleNodeGroups))
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	return null;
}

/** @param {string} type */
export function findNodeSpec(type) {
	for (const group of nodeCatalog) {
		const item = group.items.find((i) => i.type === type);
		if (item) return item;
	}
	for (const group of get(moduleNodeGroups)) {
		const item = group.items.find((i) => i.type === type);
		if (item) return item;
	}
	return null;
}
