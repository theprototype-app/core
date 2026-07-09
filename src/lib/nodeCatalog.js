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
export const animationTypes = ['shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink'];

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
