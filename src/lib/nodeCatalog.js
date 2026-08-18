// Catalog of all available node types, grouped for the palette and context menu.
// `defaults` seeds node.data on creation (and gets replicated to peers with the node).
// `params` describes the controls rendered by AnimationNode-style generic nodes.
// Modules contribute additional groups through moduleNodeGroups (moduleSDK).

import { get } from 'svelte/store';
import { moduleNodeGroups } from './moduleSDK';
import { particlePreset } from './particlePresets';

/**
 * A1: `kind: 'text'` is a free-text param. It writes on COMMIT (change/blur),
 * never per keystroke — a node edit replicates the whole node, so an input-time
 * write is one broadcast per character. `placeholder`/`maxLength` are hints for it.
 * @typedef {{ key: string, kind: 'range' | 'select' | 'toggle' | 'text', min?: number, max?: number, step?: number, options?: string[], placeholder?: string, maxLength?: number }} NodeParam
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
		items: [
			{ type: 'objectselector', label: 'Object Selector', defaults: { selected: '-None-' } },
			// CL-C C3: live speed (m/s) of the wired object — LOCAL feed, exact on
			// the sim initiator, ~10Hz move-delta approximation on other peers
			{ type: 'velocity', label: 'Velocity', defaults: {} }
		]
	},
	{
		// H5: object-flow composition — Flow Input/Output DECLARE an object flow's
		// public sockets; Object Flow embeds a flow into the scene graph with those
		// sockets. Interface nodes only mean something inside an object flow.
		group: 'Object Flow',
		items: [
			{ type: 'flowinput', label: 'Flow Input', defaults: { name: 'value', vtype: 'number', fallback: 0 } },
			{ type: 'flowoutput', label: 'Flow Output', defaults: { name: 'out', fallback: 0 } },
			{ type: 'objectflow', label: 'Object Flow', defaults: { flowUuid: '' } }
		]
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
			// 4.6: loop-closers from the NODES.md audit
			{ type: 'maprange', label: 'Map Range', defaults: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: true, a: 0 } },
			{ type: 'select', label: 'Select', defaults: { index: 0, a: 0, b: 0 } },
			// 134: loops, timers, sensors + object actions (all deterministic)
			{ type: 'loop', label: 'Loop', defaults: { from: 0, to: 1, rate: 1, mode: 'wrap' } },
			{ type: 'timer', label: 'Timer', defaults: { delay: 1, a: 0 } },
			{ type: 'distance', label: 'Distance', defaults: {} },
			{ type: 'proximity', label: 'Proximity', defaults: { radius: 3 } },
			{ type: 'lookat', label: 'Look At', defaults: {} },
			{ type: 'setcolor', label: 'Set Color', defaults: { color: '#ff4000' } },
			{ type: 'visibility', label: 'Visibility', defaults: { on: true } },
			// SH7: write a shader-graph uniform. `uniform` is the generated name the Shader
			// editor shows beside a uniform-backed param; the value rides a number socket, so
			// no recompile and no message of its own (the flow value is already replicated).
			{ type: 'setuniform', label: 'Set Shader Uniform', defaults: { uniform: '', value: 0 } }
		]
	},
	{
		group: 'Triggers',
		items: [
			// 134: EVENT nodes — ride small replicated trigger messages, not state
			{ type: 'onclick', label: 'On Click', defaults: { pulse: 0.3 } },
			// H3: keyboard trigger — LOCAL key presses replicate as trigger pulses
			// (golden rule: never stream local state); held keys re-pulse so the
			// output stays high while held
			{ type: 'keypress', label: 'Key Press', defaults: { code: 'KeyR', pulse: 0.3 } },
			// PFX-C: fires when the physics sim lands this object on the ground /
			// another object (initiator-detected, replicated trigger stamp)
			{
				type: 'onimpact',
				label: 'On Impact',
				defaults: { pulse: 0.3, minStrength: 1 },
				params: [{ key: 'minStrength', kind: 'range', min: 0, max: 10, step: 0.1 }]
			},
			// CL-C C2: sensor overlap edges (initiator-detected, replicated stamps)
			{ type: 'onenter', label: 'On Enter', defaults: { pulse: 0.3 } },
			{ type: 'onexit', label: 'On Exit', defaults: { pulse: 0.3 } },
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
			},
			{
				// 17-E: the other half of Play Animation — pulses when a clip FINISHES,
				// so a movement can hand off to whatever comes next (a door that has
				// finished opening plays a latch sound, or starts the next door). Fired
				// locally on every peer from the same deterministic end-of-clip the
				// runtime already computes, so it needs no message of its own.
				type: 'animfinished',
				label: 'Animation Finished',
				defaults: { clip: '', pulse: 0.3 }
			},
			{
				// 17-E F5: pulses as the playhead CROSSES a named point in the clip, so
				// a footstep sound or a puff of dust can sit at the exact frame of a
				// movement instead of only at its end. `name` empty = any marker on the
				// clip, which is one node for "every beat". Fired locally on every peer:
				// each travels the same clip interval from the same synced stamp.
				type: 'animmarker',
				label: 'Animation Marker',
				defaults: { name: '', pulse: 0.3 }
			},
			{
				// 17-E F3: the READABLE half of Animation Finished — a value node, so
				// the clip can drive something continuously instead of only handing
				// off at its end (progress into a Map Range that fades a light, or
				// `playing` into a Gate). One number socket whose meaning `read`
				// picks: a boolean rides a number socket already, and it keeps the
				// card in the same shape as Math / Select.
				type: 'animstate',
				label: 'Animation State',
				defaults: { clip: '', read: 'progress' },
				params: [
					{
						key: 'read',
						kind: 'select',
						options: ['progress', 'playing', 'position', 'duration', 'remaining']
					}
				]
			},
			{
				// 17-E A5: drives an AUTHORED clip (or a clip the model was imported
				// with) from a flow event — wire On Click to it and a door opens when
				// someone clicks it. Not in `animationTypes`: it is an event consumer
				// that starts a keyed clip, not a per-frame offset.
				type: 'playanim',
				label: 'Play Animation',
				defaults: { clip: '', action: 'toggle', speed: 1 },
				params: [
					{ key: 'action', kind: 'select', options: ['toggle', 'play', 'stop', 'restart'] },
					{ key: 'speed', kind: 'range', min: 0.1, max: 4, step: 0.1 }
				]
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
			},
			// C2 (roadmap #13): constant rotation under physics. Both are consumed
			// by physics.js (sim start + live re-apply on node edits), like mass.
			{
				type: 'angularvelocity',
				label: 'Angular Velocity',
				defaults: { axis: 'y', speed: 2 },
				params: [
					{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
					{ key: 'speed', kind: 'range', min: -10, max: 10, step: 0.1 }
				]
			},
			// CL-C C1: collider shape override (wins over the Inspector pick, the
			// mass precedent); shape 'object' hulls the wired source object
			{
				type: 'collider',
				label: 'Collider',
				defaults: { shape: 'box', sensor: false, scale: 1 },
				params: [
					{ key: 'shape', kind: 'select', options: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull', 'custom', 'object'] },
					{ key: 'scale', kind: 'range', min: 0.25, max: 4, step: 0.05 },
					{ key: 'sensor', kind: 'toggle' }
				]
			},
			{
				type: 'motor',
				label: 'Motor',
				defaults: { vel: 3, maxForce: 100 },
				params: [
					{ key: 'vel', kind: 'range', min: -20, max: 20, step: 0.1 },
					{ key: 'maxForce', kind: 'range', min: 0, max: 500, step: 5 }
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
			},
			{
				// spatial audio on the connected object; file from the Explorer (97)
				type: 'sound',
				label: 'Sound',
				defaults: { hash: null, file: '', volume: 0.8, radius: 5, rolloff: 1, loop: true, playing: false }
			},
			{
				// PFX-B: particle emitter driven by flow — targets the connected object
				// (or the graph owner). Wired inputs: count (number), color (color),
				// trigger (event, fires a burst-mode emitter). Config = node.data,
				// seeded from a preset; the particle RUNTIME renders it (particleRuntime).
				type: 'particle',
				label: 'Particles',
				defaults: particlePreset('sparkles'),
				params: [
					{ key: 'mode', kind: 'select', options: ['continuous', 'burst'] },
					{ key: 'count', kind: 'range', min: 1, max: 500, step: 1 },
					{ key: 'lifetime', kind: 'range', min: 0.1, max: 6, step: 0.1 },
					{ key: 'speed', kind: 'range', min: 0, max: 8, step: 0.1 },
					{ key: 'gravity', kind: 'range', min: -10, max: 10, step: 0.1 },
					{ key: 'turbulence', kind: 'range', min: 0, max: 1, step: 0.05 },
					{ key: 'sizeStart', kind: 'range', min: 0.01, max: 1, step: 0.01 },
					{ key: 'opacity', kind: 'range', min: 0, max: 1, step: 0.05 },
					{ key: 'sprite', kind: 'select', options: ['dot', 'streak', 'puff', 'star', 'square'] },
					{ key: 'blending', kind: 'select', options: ['additive', 'normal'] },
					{ key: 'space', kind: 'select', options: ['local', 'world'] }
				]
			}
		]
	}
];

// Node types the animation runtime evaluates every frame (134 adds the base-
// managed object actions: LookAt orients, Set Color paints, Visibility toggles)
export const animationTypes = [
	'shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink', 'pathpatrol',
	'lookat', 'setcolor', 'visibility', 'setuniform'
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
		const item = group.items.find((/** @type {any} */ i) => i.type === type);
		if (item) return item;
	}
	return null;
}
