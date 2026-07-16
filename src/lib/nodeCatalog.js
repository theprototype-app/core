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
			{ type: 'slider', label: 'Slider', defaults: { value: 20, min: 0, max: 40 } },
			{ type: 'colorpicker', label: 'Color Picker', defaults: { color: '#ff4000' } },
			{ type: 'switcher', label: 'Switcher', defaults: { items: ['cube', 'pyramid'], index: 0, shape: 'cube' } },
			// 133: value inputs — feed consumer node handles (deterministic)
			{ type: 'number', label: 'Number', defaults: { value: 1, step: 1 } },
			{ type: 'vector3', label: 'Vector3', defaults: { x: 0, y: 0, z: 0 } },
			{ type: 'toggle', label: 'Toggle', defaults: { on: false } },
			{ type: 'random', label: 'Random', defaults: { min: 0, max: 1, interval: 0 } },
			{ type: 'time', label: 'Time', defaults: { mode: 'sin', rate: 1 } }
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
						'// data: this node\'s data (incl. wired a/b/c inputs); time: synced seconds\n' +
						'object.position.y = base.pos[1] + Math.sin(time * 2) * 0.5;\n'
				}
			},
			// 133: pure logic on wired inputs (deterministic, no streaming)
			{ type: 'math', label: 'Math', defaults: { op: 'add', a: 0, b: 0 } },
			{ type: 'compare', label: 'Compare', defaults: { op: 'gt', a: 0, b: 0 } },
			{ type: 'gate', label: 'Gate', defaults: { op: 'and', a: false, b: false } },
			// 134: loops, timers, sensors + object actions (all deterministic)
			{ type: 'loop', label: 'Loop', defaults: { from: 0, to: 1, rate: 1, mode: 'wrap' } },
			{ type: 'timer', label: 'Timer', defaults: { delay: 1, a: 0 } },
			{ type: 'distance', label: 'Distance', defaults: {} },
			{ type: 'proximity', label: 'Proximity', defaults: { radius: 3 } },
			{ type: 'lookat', label: 'Look At', defaults: {} },
			{ type: 'setcolor', label: 'Set Color', defaults: { color: '#ff4000' } },
			{ type: 'visibility', label: 'Visibility', defaults: { on: true } }
		]
	},
	{
		group: 'Triggers',
		items: [
			// 134: EVENT nodes — ride small replicated trigger messages, not state
			{ type: 'onclick', label: 'On Click', defaults: { pulse: 0.3 } },
			{ type: 'counter', label: 'Counter', defaults: { op: 'up', step: 1 } }
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
			},
			{
				// spatial audio on the connected object; file from the Explorer (97)
				type: 'sound',
				label: 'Sound',
				defaults: { hash: null, file: '', volume: 0.8, radius: 5, loop: true, playing: false }
			}
		]
	}
];

// Node types the animation runtime evaluates every frame (134 adds the base-
// managed object actions: LookAt orients, Set Color paints, Visibility toggles)
export const animationTypes = [
	'shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink', 'pathpatrol',
	'lookat', 'setcolor', 'visibility'
];

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
