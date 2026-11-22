// 2.0 N1 — the Physics family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import * as shared from '../evalShared.js';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Physics',
	nodes: [
		// 36 X6: the CONTACT triggers moved here from Triggers — they gained a `filter`
		// input (only fire for that other object) and an `other` output, and Triggers
		// holds only input-less sources (the palette rule). Palette-only: no wire change.
		// PFX-C: fires when the physics sim lands this object on the ground /
		// another object (initiator-detected, replicated trigger stamp).
		// fix-batch-1 #14: from ANY side by default; a node saved before `direction`
		// existed reads 'down' (`legacy`), so old scenes fire exactly as they did
		{
			type: 'onimpact',
			label: 'On Impact',
			defaults: { pulse: 0.3, minStrength: 1, direction: 'any' },
			params: [
				{ key: 'minStrength', kind: 'range', min: 0, max: 10, step: 0.1 },
				{
					key: 'direction',
					kind: 'select',
					options: ['any', 'down'],
					legacy: 'down',
					doc: 'any = a hit from any side (speed along the contact); down = landings only'
				}
			],
			// PFX-C
			// 36 X6: contacts take an OBJECT filter — fire only when the other body is that one
			// 36 X6: the OTHER body of the contact, as an object (wire it into lookat/distance)
			sockets: { out: 'event', in: { filter: 'object' }, outHandles: { other: 'object' } },
			// 36 X6: filter input + other output
			card: 'ContactNode',
			eval(node, { ctx, time, d }, rt) {
				// PFX-C: physics impacts arrive as replicated trigger stamps too; 36 X6: the
				// OTHER body rides a named `other` output (the onhit shape)
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				return {
					__default: dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0,
					__handles: { other: rt.contactOthers.get(node.id) ?? '' }
				};
			}
		},
		// CL-C C2: sensor overlap edges (initiator-detected, replicated stamps)
		// 78 F10: + the player (every peer feels its own); `who` picks anything / player / objects
		{
			type: 'onenter',
			label: 'On Enter',
			defaults: { pulse: 0.3 },
			params: [{ key: 'who', kind: 'select', options: ['any', 'player', 'objects'], legacy: 'any', doc: 'any = objects and the player; player = only a player walking in; objects = only bodies' }],
			sockets: { out: 'event', in: { filter: 'object' }, outHandles: { other: 'object' } },
			// CL-C sensor edges; 36 X6: the contact card
			card: 'ContactNode',
			eval: shared.evalSensorEdge
		},
		{
			type: 'onexit',
			label: 'On Exit',
			defaults: { pulse: 0.3 },
			params: [{ key: 'who', kind: 'select', options: ['any', 'player', 'objects'], legacy: 'any', doc: 'any = objects and the player; player = only a player walking out; objects = only bodies' }],
			// CL-C: sensor overlap edges
			sockets: { out: 'event', in: { filter: 'object' }, outHandles: { other: 'object' } },
			card: 'ContactNode',
			eval: shared.evalSensorEdge
		},
		{
			type: 'mass',
			label: 'Mass',
			defaults: { kg: 1 },
			params: [{ key: 'kg', kind: 'range', min: 0.1, max: 100, step: 0.1 }],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'bounciness',
			label: 'Bounciness',
			defaults: { value: 0.3 },
			params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		{
			type: 'friction',
			label: 'Friction',
			defaults: { value: 0.5 },
			params: [{ key: 'value', kind: 'range', min: 0, max: 1, step: 0.05 }],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
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
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// CL-C C1: collider shape override (wins over the Inspector pick, the
		// mass precedent); shape 'object' hulls the wired source object
		{
			type: 'collider',
			label: 'Collider',
			defaults: { shape: 'box', sensor: false, scale: 1, group: 'inherit' },
			params: [
				{ key: 'shape', kind: 'select', options: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull', 'trimesh', 'custom', 'object'] },
				{ key: 'scale', kind: 'range', min: 0.25, max: 4, step: 0.05 },
				{ key: 'sensor', kind: 'toggle' },
				// 36 X5: collision group ('inherit' keeps the Inspector's pick)
				{ key: 'group', kind: 'select', options: ['inherit', 'default', 'a', 'b', 'c', 'd', 'water'] }
			],
			// CL-C: collider takes an object source (shape 'object') + a scale number;
			// velocity reads the wired object's live speed
			sockets: { out: 'effect', in: { source: 'object', scale: 'number' } },
			// CL-C
			card: 'ColliderNode'
		},
		{
			type: 'motor',
			label: 'Motor',
			// B6: `side` — one motor node used to drive EVERY revolute joint on the
			// object identically, so differential steering could not be expressed
			defaults: { vel: 3, maxForce: 100, side: 'all' },
			params: [
				{ key: 'vel', kind: 'range', min: -20, max: 20, step: 0.1 },
				{ key: 'maxForce', kind: 'range', min: 0, max: 500, step: 5 },
				{ key: 'side', kind: 'select', options: ['all', '+x', '-x', '+z', '-z'] }
			],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// B6: THE single biggest hole in the catalog — nothing in a graph could
		// push anything. api.physics.applyImpulse existed with no node at all.
		// ONE card with a mode select (the animstate precedent), not two.
		{
			type: 'impulse',
			label: 'Impulse',
			defaults: { mode: 'impulse', space: 'world', x: 0, y: 5, z: 0 },
			inputs: ['trigger', 'force', 'target'],
			inputLabels: { force: 'force — wire a Vector 3', target: 'target object' },
			// no x/y/z dials: a vector belongs in a Vector 3 node, and carrying both
			// only raises the question of which one wins. `defaults` still holds
			// (0, 5, 0), so an unwired Impulse hops rather than doing nothing.
			params: [
				{ key: 'mode', kind: 'select', options: ['impulse', 'torque'] },
				{ key: 'space', kind: 'select', options: ['world', 'local'] }
			],
			// B6: the physics ACTION nodes feed an Object Selector
			sockets: { out: 'effect', in: { trigger: 'event', force: 'vector3', target: 'object' } },
			// B6
			card: 'AnimationNode'
		},
		// B6: reset-to-grid, freeze, stop-a-topple. 'continuous' is a
		// kinematic-ish override rather than a force — it REPLACES the velocity
		// every frame the trigger is high.
		{
			type: 'setvelocity',
			label: 'Set Velocity',
			defaults: { mode: 'once', x: 0, y: 0, z: 0 },
			inputs: ['trigger', 'linear', 'angular', 'target'],
			inputLabels: {
				linear: 'linear — wire a Vector 3',
				angular: 'angular — wire a Vector 3',
				target: 'target object'
			},
			params: [{ key: 'mode', kind: 'select', options: ['once', 'continuous'] }],
			sockets: { out: 'effect', in: { trigger: 'event', linear: 'vector3', angular: 'vector3', target: 'object' } },
			// B6
			card: 'AnimationNode'
		},
		// B6: joints were scene data with no node. Reuses joints.createJoint, so
		// the undo entry and the jointcreate message are the existing ones.
		{
			type: 'joint',
			label: 'Joint',
			defaults: { kind: 'revolute', axis: 'y', vel: 0, maxForce: 100 },
			inputs: ['trigger', 'a', 'b'],
			// the handle IDS stay a/b (the wire and the docs call them that); the CARD
			// says which end of the joint each one is
			inputLabels: { a: 'a — anchor', b: 'b — attached' },
			params: [
				{ key: 'kind', kind: 'select', options: ['revolute', 'weld'] },
				{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
				{ key: 'vel', kind: 'range', min: -20, max: 20, step: 0.1 },
				{ key: 'maxForce', kind: 'range', min: 0, max: 500, step: 5 }
			],
			sockets: { out: 'effect', in: { trigger: 'event', a: 'object', b: 'object' } },
			// B6
			card: 'AnimationNode'
		}
	]
};
