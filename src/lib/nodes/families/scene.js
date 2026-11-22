// 2.0 N1 — the Scene family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Scene',
	nodes: [
		{
			type: 'objectselector', label: 'Object Selector', defaults: { selected: '-None-' },
			sockets: { out: 'object', in: { _default: 'effect' } },
			card: 'ObjectSelectorNode',
			eval(node, { d }, rt) {
				return d.selected && d.selected !== '-None-' ? d.selected : undefined;
			}
		},
		// CL-C C3: live speed (m/s) of the wired object — LOCAL feed, exact on
		// the sim initiator, ~10Hz move-delta approximation on other peers
		{
			type: 'velocity', label: 'Velocity', defaults: {},
			// CL-C: live speed readout
			sockets: { out: 'number', in: { target: 'object' } },
			// CL-C
			card: 'VelocityNode',
			eval(node, { input, ctx }, rt) {
				// CL-C: live speed (m/s) of the wired object (or the graph owner).
				// APPROXIMATE on non-initiators: fed by ~10Hz move-message deltas,
				// exact-ish on the stepping peer (per-step write-back deltas).
				const target = input('target', null) || rt.implicitOwnerOf(node);
				return typeof target === 'string' && ctx && ctx.speed ? ctx.speed(target) : 0;
			}
		},
		// B6: the numbers a rule graph asks for — how tall is this, where is its
		// top. From colliderSpecOf, the same spec physics builds the body from.
		{
			type: 'measure',
			label: 'Measure',
			defaults: { read: 'top' },
			inputs: ['target'],
			inputLabels: { target: 'target object' },
			params: [{ key: 'read', kind: 'select', options: ['top', 'bottom', 'height', 'y', 'speed'] }],
			// B6: top / bottom / height / y / speed
			// B6: the physics action nodes. `target` is an alternative to wiring the node
			// into an Object Selector, exactly like velocity's.
			sockets: { out: 'number', in: { target: 'object' } },
			// B6
			card: 'AnimationNode',
			eval(node, { input, d, ctx }, rt) {
				// B6: the numbers a rule graph actually asks for — how tall is the
				// stack, where is its top. Read from colliderSpecOf, the same spec
				// physics builds the body from, rather than a per-frame Box3.
				const target = input('target', null) || rt.implicitOwnerOf(node);
				if (typeof target !== 'string') return 0;
				const read = d.read ?? 'top';
				if (read === 'speed') return ctx && ctx.speed ? ctx.speed(target) : 0;
				const object = rt.sceneObjects?.getObjectByProperty('uuid', target);
				if (!object) return 0;
				if (read === 'y') return object.position.y;
				// only the measured AABB is read, which every kind shares — asking for
				// 'box' never builds a hull or a 20k-triangle trimesh per frame (36 X2)
				const spec = rt.colliderSpecOf(object, 'box');
				if (!spec) return object.position.y;
				const half = spec.halfExtents?.y ?? 0;
				const centre = spec.center?.y ?? object.position.y;
				if (read === 'bottom') return centre - half;
				if (read === 'height') return half * 2;
				return centre + half; // 'top'
			}
		},
		// 21-B B7: THE SPAWNER. Copies of a template object, with real bodies — the
		// thing that could not exist before, because startSimulation walked the scene
		// exactly once and anything created during a run was inert.
		{
			type: 'spawn',
			label: 'Spawn',
			defaults: {
				x: 0,
				y: 3,
				z: 0,
				count: 1,
				maxAlive: 32,
				interval: 0,
				spread: 0.5
			},
			inputs: ['trigger', 'at', 'source', 'position'],
			inputLabels: {
				at: 'at — offset from the template (wire a Vector 3)',
				// 31: a PLACE (the On Clap point) wins over the offset
				position: 'place — copies land exactly here (e.g. an On Clap point)',
				source: 'template — the object copies are made from'
			},
			// `count`/`maxAlive` are CLAMPED again in spawner.js (20 and 200): a param is
			// an authored value, never a limit — a peer's edited node arrives as data.
			params: [
				{ key: 'count', kind: 'range', min: 1, max: 20, step: 1, label: 'copies per fire' },
				{ key: 'maxAlive', kind: 'range', min: 1, max: 200, step: 1, label: 'max alive' },
				{ key: 'interval', kind: 'range', min: 0, max: 10, step: 0.1, label: 'min seconds between' },
				{ key: 'spread', kind: 'range', min: 0, max: 5, step: 0.1 }
			],
			// the two things that WILL be reported otherwise
			note: 'Copies exist only while the simulation runs — never saved. The host spawns; every peer receives the copy.',
			// B7: a spawner's Object Selector names the TEMPLATE it copies, not a target it
			// writes to — but the channel is the same one, so no coercion table change
			// B7: `source` is the alternative to an Object Selector edge (impulse's `target`
			// precedent); `at` is an offset, so it takes the same vector3 a force does. Every
			// range param keeps the numeric fallback, so only these three need declaring — an
			// undeclared handle types as 'number', which would refuse an Object Selector.
			// 31: + a place
			sockets: { out: 'effect', in: { trigger: 'event', at: 'vector3', source: 'object', position: 'vector3' } },
			// B7: spec-driven (named input rows, four ranges, and the catalog `note`). A new
			// node type has TWO registries and only one of them complains — a `spawn` in the
			// catalog and not here renders as UnknownNode ("install the module that ships it").
			card: 'AnimationNode'
		}
	]
};
