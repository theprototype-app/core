// 2.0 N1 — the Animation family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import { GAME_SOUNDS as GAME_SOUND_NAMES } from '../../gameSfx';
import { EASINGS, PIVOTS } from '../../motion/tweenCore.js';
import { TWEEN_LABELS } from '../catalogShared.js';
import * as shared from '../evalShared.js';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Animation',
	nodes: [
		// 78 F2: a swing / wobble / pop from hover stamps — every peer computes the same pose
		{
			type: 'hoveranimate',
			label: 'Hover Animate',
			defaults: { style: 'swing', mode: 'energy', amount: 20, axis: 'z', freq: 1.2, damping: 1.2, seconds: 0.25, sound: 'none', soundName: 'ring' },
			inputs: ['trigger'],
			inputLabels: { trigger: 'trigger - an On Hover (or any event)' },
			params: [
				{ key: 'style', kind: 'select', options: ['swing', 'wobble', 'pop'] },
				{ key: 'mode', kind: 'select', options: ['energy', 'once', 'restart', 'while', 'stop', 'inout'] },
				{ key: 'amount', kind: 'range', min: 0, max: 90, step: 1, label: 'amount (degrees, % for pop)' },
				{ key: 'axis', kind: 'select', options: ['z', 'x', 'y'] },
				{ key: 'freq', kind: 'range', min: 0.2, max: 6, step: 0.1, label: 'swings per second' },
				{ key: 'damping', kind: 'range', min: 0, max: 6, step: 0.1 },
				{ key: 'seconds', kind: 'range', min: 0.05, max: 2, step: 0.05, label: 'in-out seconds' },
				{ key: 'sound', kind: 'select', options: ['none', 'start', 'extremes'] },
				{ key: 'soundName', kind: 'select', options: [...GAME_SOUND_NAMES] }
			],
			note: 'energy: each hover adds a swing (a bell) · once · restart · while hovered · stop dead when it ends · in-out holds a hovered pose.',
			sockets: { out: 'effect', in: { trigger: 'event' } },
			// 78 F2
			card: 'AnimationNode'
		},
		// 78 F3 / F8: a door, a lid, a drawer — between captured poses, state saved in the node
		{
			type: 'toggleanim',
			label: 'Toggle Animation',
			defaults: { duration: 0.6, ease: 'smooth', interrupt: 'reverse', autoClose: 0, pose: '', openSound: 'none', closeSound: 'none', poses: [] },
			inputs: ['trigger', 'open', 'close', 'goto', 'pose', 'enabled'],
			params: [
				{ key: 'duration', kind: 'range', min: 0, max: 5, step: 0.05 },
				{ key: 'ease', kind: 'select', options: ['smooth', 'linear'] },
				{ key: 'interrupt', kind: 'select', options: ['reverse', 'finish'] },
				{ key: 'autoClose', kind: 'range', min: 0, max: 60, step: 0.5 },
				{ key: 'pose', kind: 'text', placeholder: 'pose for "go to" (name or number)', maxLength: 40 },
				{ key: 'openSound', kind: 'select', options: ['none', ...GAME_SOUND_NAMES] },
				{ key: 'closeSound', kind: 'select', options: ['none', ...GAME_SOUND_NAMES] }
			],
			note: 'Open/closed is shared and saved: everyone, and anyone who joins later, sees the same door.',
			// 78 F3: the door's state beside its effect output
			sockets: { out: 'effect', in: { trigger: 'event', open: 'event', close: 'event', goto: 'event', pose: 'any', enabled: 'boolean' }, outHandles: { isOpen: 'boolean', moving: 'boolean', pose: 'number', opened: 'event', closed: 'event' } },
			// 78 F3 / F8
			card: 'ToggleAnimNode',
			eval(node, { ctx, time }, rt) {
				// 78 F3: the door's state (computed where it is posed, read here a frame later)
				const door = rt.doors.get(node.id);
				const pulse = (/** @type {string} */ name) => {
					const trig = ctx && ctx.triggers ? ctx.triggers[node.id + '#' + name] : null;
					const dt = trig ? time - trig.lastT : Infinity;
					return dt >= 0 && dt < 0.3 ? 1 : 0;
				};
				const isOpen = !!door && door.st.to !== 0;
				return { __handles: { isOpen, moving: !!door?.moving, pose: door ? door.st.to : 0, opened: pulse('opened'), closed: pulse('closed') }, __default: isOpen };
			}
		},
		{
			type: 'shake',
			label: 'Shake',
			defaults: { intensity: 0.2, speed: 10 },
			params: [
				{ key: 'intensity', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'speed', kind: 'range', min: 1, max: 30, step: 1 }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'spin',
			label: 'Spin',
			defaults: { axis: 'y', speed: 1 },
			params: [
				{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
				{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// 36-fb F25: a real axle — a LOCAL axis (a tilted wheel turns about its own hub), the
		// object's origin as the pivot, rpm with a spin-up, and on a DYNAMIC body during a run a
		// torque-limited motor instead (sim/motionNodes.js)
		{
			type: 'rotor',
			label: 'Rotate / Motor',
			defaults: { axis: 'x', rpm: 10, torque: 50, spinUp: 1, on: true },
			inputs: ['on'],
			inputLabels: { on: 'on — wire a boolean (off rests at its pose)' },
			params: [
				{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
				{ key: 'rpm', kind: 'range', min: -120, max: 120, step: 1 },
				{ key: 'torque', kind: 'range', min: 0, max: 2000, step: 5 },
				{ key: 'spinUp', kind: 'range', min: 0, max: 10, step: 0.1 }
			],
			// 36-fb F25
			sockets: { out: 'effect', in: { on: 'boolean' } },
			// 36-fb F25
			card: 'AnimationNode'
		},
		// 36-fb F24: ride a Flow path (the nearest one when nothing is wired)
		{
			type: 'flowfloat',
			label: 'Float Along Flow',
			defaults: { speed: 1, bob: 0.03, align: true },
			inputs: ['path'],
			inputLabels: { path: 'path — a Flow path (else the nearest)' },
			params: [
				{ key: 'speed', kind: 'range', min: 0, max: 5, step: 0.05 },
				{ key: 'bob', kind: 'range', min: 0, max: 0.3, step: 0.01 },
				{ key: 'align', kind: 'toggle' }
			],
			// 36-fb F24
			sockets: { out: 'effect', in: { path: 'object' } },
			// 36-fb F24
			card: 'AnimationNode'
		},
		{
			type: 'bounce',
			label: 'Bounce',
			defaults: { amplitude: 0.5, speed: 2 },
			params: [
				{ key: 'amplitude', kind: 'range', min: 0, max: 3, step: 0.05 },
				{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'orbit',
			label: 'Orbit',
			defaults: { radius: 1, speed: 1 },
			params: [
				{ key: 'radius', kind: 'range', min: 0, max: 5, step: 0.05 },
				{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.1 }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// 85 N1: a swing / sway / bob — a sine on rotation, position or scale from the shared clock,
		// about a PIVOT face (a sign on its hook, a door on its hinge). A wired trigger starts a
		// swing that dies away with damping (a struck bell). motion/tweenNodes.js
		{
			type: 'oscillate',
			label: 'Oscillate / Swing',
			defaults: { property: 'rotation', axis: 'z', amplitude: 20, period: 2, phase: 0, damping: 0, wave: 'sine', pivot: 'top' },
			inputs: ['trigger'],
			inputLabels: { trigger: 'trigger — start a swing that dies away (optional)' },
			params: [
				{ key: 'property', kind: 'select', options: ['rotation', 'position', 'scale'] },
				{ key: 'axis', kind: 'select', options: ['x', 'y', 'z', 'all'] },
				{ key: 'amplitude', kind: 'range', min: -180, max: 180, step: 0.01, doc: 'degrees (rotation), metres (position) or a fraction (scale)' },
				{ key: 'period', kind: 'range', min: 0.1, max: 20, step: 0.05, doc: 'seconds per full swing' },
				{ key: 'phase', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'damping', kind: 'range', min: 0, max: 5, step: 0.05, doc: 'how fast a triggered swing dies away' },
				{ key: 'wave', kind: 'select', options: ['sine', 'triangle', 'bob'] },
				{ key: 'pivot', kind: 'select', options: PIVOTS }
			],
			note: 'Rotation swings about the pivot face: top for a hanging sign or lamp, left / right for a door.',
			// 85 N1/N2/N4: the swing's trigger; the tweens' go / back / toggle events, held boolean,
			// hand-driven amount and goal (a point, or an object off a selector); the light switch
			sockets: { out: 'effect', in: { trigger: 'event', amplitude: 'number', period: 'number', phase: 'number', damping: 'number' } },
			// 85 N1
			card: 'AnimationNode'
		},
		// 85 N2: the TWEENS — go to a goal over a duration with easing, and back. Every peer computes
		// the pose from the same replicated trigger stamps (trigger = go, back = return, toggle =
		// alternate, open = a boolean held true / false). motion/tweenNodes.js
		{
			type: 'moveto',
			label: 'Move To',
			defaults: { x: 0, y: 1, z: 0, space: 'offset', duration: 1, easing: 'smooth', repeat: 'none' },
			inputs: ['trigger', 'back', 'toggle', 'open', 'amount', 'to'],
			inputLabels: TWEEN_LABELS,
			params: [
				{ key: 'x', kind: 'range', min: -20, max: 20, step: 0.05 },
				{ key: 'y', kind: 'range', min: -20, max: 20, step: 0.05 },
				{ key: 'z', kind: 'range', min: -20, max: 20, step: 0.05 },
				{ key: 'space', kind: 'select', options: ['offset', 'world'] },
				{ key: 'duration', kind: 'range', min: 0.05, max: 10, step: 0.05 },
				{ key: 'easing', kind: 'select', options: EASINGS },
				{ key: 'repeat', kind: 'select', options: ['none', 'pingpong', 'loop'] }
			],
			sockets: { out: 'effect', in: { trigger: 'event', back: 'event', toggle: 'event', open: 'boolean', amount: 'number', to: 'vector3', x: 'number', y: 'number', z: 'number', duration: 'number' } },
			// 85 N2
			card: 'AnimationNode'
		},
		{
			type: 'rotateto',
			label: 'Rotate To',
			defaults: { axis: 'y', angle: 90, pivot: 'origin', duration: 1, easing: 'smooth', repeat: 'none' },
			inputs: ['trigger', 'back', 'toggle', 'open', 'amount', 'to'],
			inputLabels: { ...TWEEN_LABELS, to: 'to — match this object\'s rotation (optional)' },
			params: [
				{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
				{ key: 'angle', kind: 'range', min: -360, max: 360, step: 1, doc: 'degrees from the rest pose' },
				{ key: 'pivot', kind: 'select', options: PIVOTS },
				{ key: 'duration', kind: 'range', min: 0.05, max: 10, step: 0.05 },
				{ key: 'easing', kind: 'select', options: EASINGS },
				{ key: 'repeat', kind: 'select', options: ['none', 'pingpong', 'loop'] }
			],
			note: 'A door: pivot left (or right), axis y, angle 90 — wire On Click into toggle.',
			sockets: { out: 'effect', in: { trigger: 'event', back: 'event', toggle: 'event', open: 'boolean', amount: 'number', to: 'object', angle: 'number', duration: 'number' } },
			card: 'AnimationNode'
		},
		{
			type: 'scaleto',
			label: 'Scale To',
			defaults: { factor: 2, axis: 'all', pivot: 'origin', duration: 1, easing: 'smooth', repeat: 'none' },
			inputs: ['trigger', 'back', 'toggle', 'open', 'amount', 'to'],
			inputLabels: { ...TWEEN_LABELS, to: 'to — match this object\'s size (optional)' },
			params: [
				{ key: 'factor', kind: 'range', min: 0, max: 10, step: 0.05, doc: 'times the rest size' },
				{ key: 'axis', kind: 'select', options: ['all', 'x', 'y', 'z'] },
				{ key: 'pivot', kind: 'select', options: PIVOTS },
				{ key: 'duration', kind: 'range', min: 0.05, max: 10, step: 0.05 },
				{ key: 'easing', kind: 'select', options: EASINGS },
				{ key: 'repeat', kind: 'select', options: ['none', 'pingpong', 'loop'] }
			],
			sockets: { out: 'effect', in: { trigger: 'event', back: 'event', toggle: 'event', open: 'boolean', amount: 'number', to: 'object', factor: 'number', duration: 'number' } },
			card: 'AnimationNode'
		},
		{
			// 78 F4: walks a PATH OBJECT (`path`, picked on the card or wired) on its schedule —
			// waits, speeds, gaps, events, loop modes all live on the Path. `trigger` starts a
			// once-walk; `offset` (s) spreads several guards on one path. Clicked waypoints
			// (`points`) are the legacy walk, and the card offers Convert
			type: 'pathpatrol',
			label: 'Path patrol',
			defaults: { points: [], speed: 1, mode: 'loop', path: '', offset: 0, face: true },
			inputs: ['path', 'trigger'],
			inputLabels: { path: 'path — a Path object', trigger: 'trigger — starts a Once walk' },
			// 78 F4: the Path object it walks
			sockets: { out: 'effect', in: { path: 'object' } },
			card: 'PathPatrolNode'
		},
		{
			// 78 F4: a walker on a Path arrived at a point carrying an EVENT (named on the point).
			// Blank path / event = any. Fired LOCALLY on every peer at the SAME shared moment
			// (each walks the same schedule), the onseqevent reasoning
			type: 'onpathevent',
			label: 'On Path Event',
			defaults: { path: '', event: '', pulse: 0.3 },
			// 78 F4: a walker on a Path arrived at a point with an event
			sockets: { out: 'event' },
			// 78 F4: On Path Event
			card: 'PathEventNode',
			// no pulled value: consumers read this node's trigger log (a stamp-edge source)
			eval: null
		},
		// 40 F15: GENERAL-PURPOSE motion (motion/motionNodes.js). Movers first (Follow Path,
		// Wander are pure functions of the shared clock), then the followers that read the
		// motion they produce (Orient to Velocity turns, Body Wave bends) — flowRuntime
		// applies them in that order whatever order the graph lists them in.
		{
			type: 'followpath',
			label: 'Follow Path',
			defaults: {
				points: [],
				speed: 0.5,
				mode: 'loop',
				closed: true,
				smooth: true,
				offset: 0,
				align: true,
				pitch: true,
				bank: 0.5,
				maxBank: 30,
				forward: '+z'
			},
			inputs: ['path'],
			inputLabels: { path: 'path — a Spline or Flow path' },
			params: [
				{ key: 'speed', kind: 'range', min: -5, max: 5, step: 0.05 },
				{ key: 'offset', kind: 'range', min: 0, max: 1, step: 0.01 },
				{ key: 'mode', kind: 'select', options: ['loop', 'pingpong', 'once'] },
				{ key: 'align', kind: 'toggle' },
				{ key: 'pitch', kind: 'toggle' },
				{ key: 'bank', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'maxBank', kind: 'range', min: 0, max: 80, step: 1 },
				{ key: 'forward', kind: 'select', options: ['+z', '-z', '+x', '-x'] }
			],
			// 40 F15
			sockets: { out: 'effect', in: { path: 'object' } },
			// 40 F15
			card: 'AnimationNode'
		},
		{
			type: 'wander',
			label: 'Wander',
			// 54i r: a new Wander walks on the ground (ground: true holds its placed height); switch it
			// off for a fish or a bird, which drift in 3-D within ry
			defaults: { speed: 0.3, seed: 0, margin: 0.2, rx: 1, ry: 0.3, rz: 1, ground: true },
			inputs: ['area'],
			inputLabels: { area: 'area — stay inside this object' },
			params: [
				{ key: 'speed', kind: 'range', min: 0, max: 3, step: 0.05 },
				{ key: 'seed', kind: 'range', min: 0, max: 999, step: 1 },
				{ key: 'margin', kind: 'range', min: 0, max: 2, step: 0.05 },
				{ key: 'rx', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'ry', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'rz', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'ground', kind: 'toggle' }
			],
			// 40 F15
			sockets: { out: 'effect', in: { area: 'object' } },
			card: 'AnimationNode'
		},
		// 85 N3: AMBIENT ANIMALS — Wander with rests, facing where it goes, looking at the nearest
		// player while resting, optionally shying away; an animated model plays its idle / walk /
		// run clips (57's Blend by Speed). motion/ambientNodes.js
		{
			type: 'ambientanimal',
			label: 'Ambient Animal',
			defaults: { speed: 0.3, seed: 0, rx: 3, ry: 0.3, rz: 3, margin: 0.2, ground: true, rest: 0.35, restTime: 3, lookRadius: 4, fleeRadius: 0, fleeDistance: 2, turnSpeed: 4, forward: '+z', clips: true },
			inputs: ['area'],
			inputLabels: { area: 'area — stay inside this object (a pen, a tank)' },
			params: [
				{ key: 'speed', kind: 'range', min: 0, max: 3, step: 0.05 },
				{ key: 'rest', kind: 'range', min: 0, max: 0.9, step: 0.05, doc: 'the share of time it stands still (0 = never)' },
				{ key: 'restTime', kind: 'range', min: 0.5, max: 30, step: 0.5, doc: 'seconds per rest' },
				{ key: 'lookRadius', kind: 'range', min: 0, max: 20, step: 0.5, doc: 'looks at a player this close while resting (0 = never)' },
				{ key: 'fleeRadius', kind: 'range', min: 0, max: 20, step: 0.5, doc: 'shies away from a player this close (0 = tame)' },
				{ key: 'fleeDistance', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'rx', kind: 'range', min: 0, max: 30, step: 0.1 },
				{ key: 'ry', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'rz', kind: 'range', min: 0, max: 30, step: 0.1 },
				{ key: 'seed', kind: 'range', min: 0, max: 999, step: 1 },
				{ key: 'turnSpeed', kind: 'range', min: 0.5, max: 30, step: 0.5 },
				{ key: 'forward', kind: 'select', options: ['+z', '-z', '+x', '-x'] },
				{ key: 'ground', kind: 'toggle', label: 'walks on the ground (off: fish, birds)' },
				{ key: 'clips', kind: 'toggle', label: 'play idle / walk / run clips' }
			],
			// 85 N3
			sockets: { out: 'effect', in: { area: 'object', speed: 'number' } },
			// 85 N3
			card: 'AnimationNode'
		},
		{
			type: 'orientvelocity',
			label: 'Orient to Velocity',
			defaults: { turnSpeed: 4, bank: 0.5, maxBank: 30, pitch: true, minSpeed: 0.02, forward: '+z' },
			params: [
				{ key: 'turnSpeed', kind: 'range', min: 0.1, max: 30, step: 0.1 },
				{ key: 'bank', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'maxBank', kind: 'range', min: 0, max: 80, step: 1 },
				{ key: 'minSpeed', kind: 'range', min: 0, max: 2, step: 0.01 },
				{ key: 'pitch', kind: 'toggle' },
				{ key: 'forward', kind: 'select', options: ['+z', '-z', '+x', '-x'] }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'bodywave',
			label: 'Body Wave',
			defaults: {
				forward: '+z',
				side: 'horizontal',
				amplitude: 0.08,
				wavelength: 1,
				frequency: 1.5,
				stiffness: 0.3,
				falloff: 2,
				speedGain: 1,
				ampGain: 0.5,
				turnBend: 0.5,
				reverse: false
			},
			params: [
				{ key: 'amplitude', kind: 'range', min: 0, max: 0.5, step: 0.01 },
				{ key: 'wavelength', kind: 'range', min: 0.2, max: 4, step: 0.05 },
				{ key: 'frequency', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'stiffness', kind: 'range', min: 0, max: 0.95, step: 0.05 },
				{ key: 'falloff', kind: 'range', min: 0.25, max: 6, step: 0.25 },
				{ key: 'speedGain', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'ampGain', kind: 'range', min: 0, max: 5, step: 0.1 },
				{ key: 'turnBend', kind: 'range', min: 0, max: 2, step: 0.05 },
				{ key: 'forward', kind: 'select', options: ['+z', '-z', '+x', '-x'] },
				{ key: 'side', kind: 'select', options: ['horizontal', 'vertical'] },
				{ key: 'reverse', kind: 'toggle' }
			],
			note: 'Bends the look only (a vertex shader): physics and picking see the rest pose.',
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// 85 N5: WIND — plants lean and sway in gusts, flags wave from their pole. A vertex
		// deformer like Body Wave, so it composes with Jiggle / Body Wave on the same mesh.
		{
			type: 'windsway',
			label: 'Wind Sway',
			defaults: { mode: 'plant', anchor: 'bottom', strength: 0.15, frequency: 0.6, gust: 0.5, direction: 0, wavelength: 1, flutter: 0.3 },
			params: [
				{ key: 'mode', kind: 'select', options: ['plant', 'flag'] },
				{ key: 'anchor', kind: 'select', options: ['bottom', 'top', 'left', 'right', 'front', 'back'], doc: 'the fixed end: bottom for a plant, left for a flag on a pole' },
				{ key: 'strength', kind: 'range', min: 0, max: 2, step: 0.01, doc: 'metres the free end moves' },
				{ key: 'frequency', kind: 'range', min: 0, max: 5, step: 0.05 },
				{ key: 'gust', kind: 'range', min: 0, max: 1, step: 0.05 },
				{ key: 'direction', kind: 'range', min: -180, max: 180, step: 1, doc: 'wind heading in degrees (0 = +x)' },
				{ key: 'wavelength', kind: 'range', min: 0.1, max: 10, step: 0.05 },
				{ key: 'flutter', kind: 'range', min: 0, max: 1, step: 0.05 }
			],
			note: 'Moves the look only (a vertex shader): physics and picking see the rest pose.',
			// 85 N5
			sockets: { out: 'effect', in: { strength: 'number', direction: 'number', gust: 'number' } },
			// 85 N5
			card: 'AnimationNode'
		},
		// 85 N5: FLOWING WATER — the material's maps scroll with the current and the surface swells;
		// a mesh with no normal map borrows the procedural ripples (the Water preset's)
		{
			type: 'waterflow',
			label: 'Flowing Water',
			defaults: { speed: 0.1, direction: 0, swell: 0.03, swellSize: 2, ripples: true },
			params: [
				{ key: 'speed', kind: 'range', min: -2, max: 2, step: 0.01, doc: 'texture tiles per second' },
				{ key: 'direction', kind: 'range', min: -180, max: 180, step: 1 },
				{ key: 'swell', kind: 'range', min: 0, max: 0.5, step: 0.005, doc: 'metres up and down' },
				{ key: 'swellSize', kind: 'range', min: 0.2, max: 20, step: 0.1 },
				{ key: 'ripples', kind: 'toggle', label: 'add ripples if the material has none' }
			],
			note: 'Best on the Water material preset; the look only (physics keeps the flat surface).',
			sockets: { out: 'effect', in: { speed: 'number', swell: 'number' } },
			card: 'AnimationNode'
		},
		{
			// 17-E: the other half of Play Animation — pulses when a clip FINISHES,
			// so a movement can hand off to whatever comes next (a door that has
			// finished opening plays a latch sound, or starts the next door). Fired
			// locally on every peer from the same deterministic end-of-clip the
			// runtime already computes, so it needs no message of its own.
			type: 'animfinished',
			label: 'Animation Finished',
			defaults: { clip: '', pulse: 0.3 },
			// 17-E: a clip reached its end
			sockets: { out: 'event' },
			// 17-E: a pulse when a clip ends
			card: 'OnClickNode',
			// 17-E: fired locally when a clip reaches its end
			eval: shared.evalPulseWindow
		},
		{
			// 17-E F5: pulses as the playhead CROSSES a named point in the clip, so
			// a footstep sound or a puff of dust can sit at the exact frame of a
			// movement instead of only at its end. `name` empty = any marker on the
			// clip, which is one node for "every beat". Fired locally on every peer:
			// each travels the same clip interval from the same synced stamp.
			type: 'animmarker',
			label: 'Animation Marker',
			defaults: { name: '', pulse: 0.3 },
			// 17-E F5: the playhead crossed a named point in a clip
			sockets: { out: 'event' },
			// 17-E F5: a pulse at a named point in a clip
			card: 'OnClickNode',
			// 17-E F5: fired locally when the playhead crosses one
			eval: shared.evalPulseWindow
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
			],
			// 17-E F3: progress / playing / position, one at a time
			// 17-E F3: whose clip to read (or the graph owner)
			sockets: { out: 'number', in: { target: 'object' } },
			// 17-E F3: the readable half of it
			card: 'AnimStateNode',
			eval(node, { input, d }, rt) {
				// 17-E F3: the readable half of animfinished. ONE number output whose
				// meaning the `read` param picks, rather than a multi-output handle map:
				// a boolean rides a number socket already (the COERCE table), and this
				// keeps the node in the same shape as math/select.
				//
				// LOCAL like velocity, and for a stronger reason — the transport itself
				// replicates (animplay, a synced-clock stamp), so every peer computes the
				// same reading from the same data with no message of its own.
				const target = input('target', null) || rt.implicitOwnerOf(node);
				if (typeof target !== 'string' || !rt.animRef?.transportOf) return 0;
				const t = rt.animRef.transportOf(target);
				// an empty clip name means "whatever is loaded"; a named one reports 0
				// unless THAT clip is the one on the transport
				if (d.clip) {
					const wanted = rt.animRef.clipIdByName?.(target, d.clip);
					if (!wanted || wanted !== t.clipId) return 0;
				}
				const span = t.rangeOut - t.rangeIn;
				switch (d.read ?? 'progress') {
					case 'playing':
						return t.playing ? 1 : 0;
					case 'position':
						return t.position;
					case 'duration':
						return t.duration;
					case 'remaining':
						return Math.max(0, t.rangeOut - t.position);
					default:
						// progress through the A/B window, which is what the transport
						// actually loops over — clamped, because a parked playhead can sit
						// outside a window set after it was parked
						return span > 1e-6 ? Math.min(1, Math.max(0, (t.position - t.rangeIn) / span)) : 0;
				}
			}
		},
		{
			// 17-E A5: drives an AUTHORED clip (or a clip the model was imported
			// with) from a flow event — wire On Click to it and a door opens when
			// someone clicks it. Not in `animationTypes`: it is an event consumer
			// that starts a keyed clip, not a per-frame offset.
			type: 'playanim',
			label: 'Play Animation',
			defaults: { clip: '', action: 'toggle', speed: 1, crossfade: 0 },
			params: [
				{ key: 'action', kind: 'select', options: ['toggle', 'play', 'stop', 'restart'] },
				{ key: 'speed', kind: 'range', min: 0.1, max: 4, step: 0.1 },
				// 57 M3: seconds a clip change blends over (imported / clip-asset clips) instead of snapping
				{ key: 'crossfade', kind: 'range', min: 0, max: 2, step: 0.05 }
			],
			// 17-E A5: the trigger that starts/stops an authored clip, plus a wired speed
			sockets: { out: 'effect', in: { trigger: 'event', speed: 'number' } },
			// 17-E A5
			card: 'PlayAnimNode'
		},
		{
			// 57 M4: a VRM character's FACE — sets one expression (happy, blink, aa, a custom one)
			// to a weight when the trigger fires. Every peer runs it from the shared trigger stamp
			// (the playanim reasoning), so the face needs no message of its own.
			type: 'setexpression',
			label: 'Set Expression',
			defaults: { expression: 'happy', weight: 1 },
			inputs: ['trigger', 'weight'],
			params: [
				{ key: 'expression', kind: 'text', placeholder: 'happy / blink / aa', maxLength: 64 },
				{ key: 'weight', kind: 'range', min: 0, max: 1, step: 0.05 }
			],
			// 57 M4: a VRM's face
			sockets: { out: 'effect', in: { trigger: 'event', weight: 'number' } },
			// 57 M4: spec-driven (expression text + weight)
			card: 'AnimationNode'
		},
		{
			// 57 M3: idle / walk / run by a SPEED, blended and eased — a character stops snapping
			// between poses. Unwired, the speed is the object's own; empty clips pick by name.
			type: 'blendspeed',
			label: 'Blend by Speed',
			defaults: { idle: '', walk: '', run: '', walkSpeed: 1.4, runSpeed: 3.5, crossfade: 0.25, speed: 0 },
			inputs: ['speed'],
			params: [
				{ key: 'walkSpeed', kind: 'range', min: 0.2, max: 4, step: 0.1 },
				{ key: 'runSpeed', kind: 'range', min: 0.5, max: 10, step: 0.1 },
				{ key: 'crossfade', kind: 'range', min: 0, max: 1, step: 0.05 }
			],
			// 57 M3
			sockets: { out: 'effect', in: { speed: 'number' } },
			// 57 M3
			card: 'BlendSpeedNode'
		},
		{
			// 57 M11: drives a model's Animation states graph from logic — set a parameter (on a
			// pulse, or continuously when nothing is wired to trigger) or fire a trigger (Jump)
			type: 'setanimparam',
			label: 'Set Animation Parameter',
			defaults: { name: 'jump', mode: 'trigger', value: 0 },
			inputs: ['trigger', 'value'],
			inputLabels: { trigger: 'trigger — sets on the pulse', value: 'value — wire a number' },
			params: [
				{ key: 'name', kind: 'text', placeholder: 'speed / jump', maxLength: 40 },
				{ key: 'mode', kind: 'select', options: ['trigger', 'set'] },
				{ key: 'value', kind: 'range', min: -10, max: 10, step: 0.1 }
			],
			// 57 M11
			sockets: { out: 'effect', in: { trigger: 'event', value: 'number' } },
			// 57 M11 (spec-driven: named inputs + text/select/range)
			card: 'AnimationNode'
		},
		{
			// 57 M12: a model's named node (a hand, a hook, a rotor arm) becomes an attach point —
			// on a pulse the wired `item` follows it (or lets go). The model is the node's owner.
			type: 'attachsocket',
			label: 'Attach to Socket',
			defaults: { socket: '', action: 'attach', snap: true },
			inputs: ['trigger', 'item'],
			inputLabels: { trigger: 'trigger — attach on the pulse', item: 'item — the object to attach' },
			params: [
				{ key: 'socket', kind: 'text', placeholder: 'hand_r', maxLength: 80 },
				{ key: 'action', kind: 'select', options: ['attach', 'detach'] },
				{ key: 'snap', kind: 'toggle' }
			],
			// 57 M12
			sockets: { out: 'effect', in: { trigger: 'event', item: 'object' } },
			// 57 M12
			card: 'AnimationNode'
		},
		{
			// 57 M11: pulses when the model's Animation states machine ENTERS a state (empty = any).
			// Fired locally on every peer: each runs the same machine from the same inputs.
			type: 'onanimstate',
			label: 'On Animation State',
			defaults: { state: '', pulse: 0.3 },
			params: [{ key: 'state', kind: 'text', placeholder: 'any state', maxLength: 40 }],
			// 57 M11: an Animation states machine entered a state
			sockets: { out: 'event' },
			// 57 M11 (the onrest precedent: a trigger with params)
			card: 'AnimationNode',
			// 57 M11: fired locally when a state machine enters a state
			eval: shared.evalPulseWindow
		},
		{
			// 48 S2: plays a Timeline SEQUENCE (camera shots, clips, audio, events) on the
			// trigger's rising stamp — on EVERY peer from that shared stamp, so the cutscene
			// lines up with no message of its own; a shot changes each player's own view.
			type: 'playseq',
			label: 'Play Sequence',
			defaults: { sequence: '', action: 'play' },
			inputs: ['trigger'],
			params: [{ key: 'action', kind: 'select', options: ['play', 'stop', 'toggle', 'restart'] }],
			// 48 S2
			sockets: { out: 'effect', in: { trigger: 'event' } },
			// 48 S2: Play Sequence
			card: 'TimelineSeqNode'
		},
		{
			// 48 S2: the event half of the Timeline — pulses as a running sequence crosses an
			// EVENT item (`end` = it finished). Blank sequence / event = any. Fired LOCALLY on
			// every peer, the animmarker reasoning: each runs the same sequence itself.
			type: 'onseqevent',
			label: 'On Sequence Event',
			defaults: { sequence: '', event: '', pulse: 0.3 },
			// 48 S2: a running sequence crossed an event item (or ended)
			sockets: { out: 'event' },
			// 48 S2: On Sequence Event
			card: 'TimelineSeqNode',
			// no pulled value: consumers read this node's trigger log (a stamp-edge source)
			eval: null
		}
	]
};
