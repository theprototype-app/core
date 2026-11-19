// 2.0 N1 — the Effects family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import { particlePreset } from '../../particlePresets';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Effects',
	nodes: [
		{
			type: 'pulse',
			label: 'Pulse',
			defaults: { amount: 0.2, speed: 2 },
			params: [
				{ key: 'amount', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'blink',
			label: 'Blink',
			defaults: { speed: 2 },
			params: [{ key: 'speed', kind: 'range', min: 0.2, max: 10, step: 0.1 }],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// 85 N4: LIGHT CONTROL — a lamp you switch, a light that fades, a colour cycle. Drives every
		// light in the object (a lamp model's bulb light too) and, with glow on, its emissive
		// meshes. Local per peer from replicated stamps / the shared clock. motion/lightNodes.js
		{
			type: 'lightswitch',
			label: 'Light Switch',
			defaults: { on: true, fade: 0.3, glow: true },
			inputs: ['trigger', 'back', 'toggle', 'on'],
			inputLabels: { trigger: 'switch on', back: 'switch off', toggle: 'toggle — each pulse flips it', on: 'on — wire a boolean' },
			params: [
				{ key: 'on', kind: 'toggle', label: 'on at start' },
				{ key: 'fade', kind: 'range', min: 0, max: 5, step: 0.05 },
				{ key: 'glow', kind: 'toggle', label: 'dim glowing parts too' }
			],
			sockets: { out: 'effect', in: { trigger: 'event', back: 'event', toggle: 'event', on: 'boolean', fade: 'number' } },
			// 85 N4
			card: 'AnimationNode'
		},
		{
			type: 'lightintensity',
			label: 'Light Intensity',
			defaults: { level: 1, fade: 0.5, glow: true },
			params: [
				{ key: 'level', kind: 'range', min: 0, max: 10, step: 0.05, doc: 'times the light\'s own intensity' },
				{ key: 'fade', kind: 'range', min: 0, max: 10, step: 0.05 },
				{ key: 'glow', kind: 'toggle', label: 'dim glowing parts too' }
			],
			sockets: { out: 'effect', in: { level: 'number', fade: 'number' } },
			card: 'AnimationNode'
		},
		{
			type: 'lightcycle',
			label: 'Light Colour Cycle',
			defaults: { mode: 'rainbow', period: 4, saturation: 1, colors: '#ff3b30, #ffcc00, #34c759, #0a84ff', step: false, glow: true },
			params: [
				{ key: 'mode', kind: 'select', options: ['rainbow', 'list'] },
				{ key: 'period', kind: 'range', min: 0.2, max: 60, step: 0.1 },
				{ key: 'saturation', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'colors', kind: 'text', placeholder: '#ff0000, #00ff00, #0000ff', maxLength: 120 },
				{ key: 'step', kind: 'toggle', label: 'jump between colours' },
				{ key: 'glow', kind: 'toggle', label: 'tint glowing parts too' }
			],
			sockets: { out: 'effect', in: { period: 'number', saturation: 'number' } },
			card: 'AnimationNode'
		},
		// 85 I2: a HOVER HIGHLIGHT and a PRESS BUTTON. Highlight glows while this person points at
		// the object (a VR laser or the play crosshair) or while a wired boolean is true — local per
		// peer. Press Button goes in and springs back on each press, from the replicated stamp.
		// motion/pressNodes.js
		{
			type: 'highlight',
			label: 'Highlight',
			defaults: { color: '#ffd54a', strength: 0.6, fade: 0.15 },
			inputs: ['on'],
			inputLabels: { on: 'on — unwired: while you point at it' },
			params: [
				{ key: 'color', kind: 'color' },
				{ key: 'strength', kind: 'range', min: 0, max: 3, step: 0.05, doc: 'how bright the glow is' },
				{ key: 'fade', kind: 'range', min: 0, max: 2, step: 0.05, doc: 'seconds to light up / go out' }
			],
			note: 'Each player sees what THEY point at. Works on materials with a glow (standard, physical, lambert, phong).',
			// 85 I2
			sockets: { out: 'effect', in: { on: 'boolean', strength: 'number', fade: 'number' } },
			// 85 I2
			card: 'AnimationNode'
		},
		{
			type: 'pressbutton',
			label: 'Press Button',
			defaults: { axis: '-y', depth: 0.04, down: 0.08, hold: 0.1, up: 0.3 },
			inputs: ['trigger'],
			inputLabels: { trigger: 'press — On Click into here' },
			params: [
				{ key: 'axis', kind: 'select', options: ['-y', '+y', '-z', '+z', '-x', '+x'], doc: 'the way it goes in, in the object\'s own frame' },
				{ key: 'depth', kind: 'range', min: 0, max: 0.5, step: 0.005, doc: 'metres' },
				{ key: 'down', kind: 'range', min: 0.02, max: 1, step: 0.01, doc: 'seconds to go in' },
				{ key: 'hold', kind: 'range', min: 0, max: 2, step: 0.05, doc: 'seconds held in' },
				{ key: 'up', kind: 'range', min: 0.05, max: 2, step: 0.05, doc: 'seconds to spring back' }
			],
			sockets: { out: 'effect', in: { trigger: 'event', depth: 'number' } },
			card: 'AnimationNode'
		},
		{
			// spatial audio on the connected object; file from the Explorer (97)
			type: 'sound',
			label: 'Sound',
			defaults: { hash: null, file: '', volume: 0.8, radius: 5, rolloff: 1, loop: true, playing: false },
			// 21-E4: `trigger` was the whole reason play-a-sound-on-press was not authorable
			// by ANY means - the node had `playing` (a continuous state) and nothing else.
			sockets: { out: 'effect', in: { volume: 'number', trigger: 'event' } },
			card: 'SoundNode'
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
			],
			// PFX-B: drive emission from flow — density, tint, spawn offset, motion, and
			// a burst fired from any event (On Click / Key Press / On Impact)
			sockets: { out: 'effect', in: { count: 'number', color: 'color', offset: 'vector3', speed: 'number', gravity: 'number', size: 'number', trigger: 'event' } },
			card: 'ParticleNode'
		},
		// 36-sim U2b: secondary motion + soft-body wobble on the connected object (or the
		// graph owner). LOCAL per peer from the pose every peer sees — the jiggle runtime
		// (sim/jiggleRuntime.js), not animationTypes: it never writes the transform.
		{
			type: 'jiggle',
			label: 'Jiggle',
			defaults: { stiffness: 120, damping: 0.15, gravity: 0.3, maxOffset: 0.35, wind: 0, amplitude: 0.08, frequency: 3, falloff: 1.5, pivot: 'bottom', bones: '' },
			note: 'Each player sees their own wobble; the settings are shared.',
			params: [
				{ key: 'stiffness', kind: 'range', min: 5, max: 600, step: 5 },
				{ key: 'damping', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'gravity', kind: 'range', min: 0, max: 2, step: 0.05 },
				{ key: 'maxOffset', kind: 'range', label: 'max offset', min: 0, max: 1, step: 0.01 },
				{ key: 'wind', kind: 'range', min: 0, max: 20, step: 0.5 },
				{ key: 'amplitude', kind: 'range', label: 'wobble', min: 0, max: 0.4, step: 0.01 },
				{ key: 'frequency', kind: 'range', label: 'wobble Hz', min: 0.5, max: 10, step: 0.1 },
				{ key: 'falloff', kind: 'range', min: 0.25, max: 4, step: 0.05 },
				{ key: 'pivot', kind: 'select', options: ['bottom', 'center', 'top'] },
				{ key: 'bones', kind: 'text', label: 'bones (globs)', placeholder: 'hair*, tail*', maxLength: 200 }
			],
			sockets: { out: 'effect' },
			// 36-sim U2b
			card: 'AnimationNode'
		}
	]
};
