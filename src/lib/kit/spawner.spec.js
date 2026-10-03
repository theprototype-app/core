// 34 R2 (kit-entities) — kit.spawner v2: ONE spec -> `api.kit.spawner` AND the "Kit: Spawner"
// node group (spec.js generates both). Entities are records the authority peer writes and
// every peer draws as a copy of a TEMPLATE object (kit/entities.js, the `kitentity` wire).
// Code-only extras (not nodes): setTags, setData, get, list, onLimit.

/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'spawner',
	group: 'Kit: Spawner',
	calls: [
		{
			name: 'spawn',
			kind: 'action',
			label: 'Spawn entities',
			doc: 'Make COUNT entities of a KIND, drawn as copies of the TEMPLATE object, at a place (unwired: where the template stands). Each carries its own health and, with a speed above 0, a mover. Code: spawn({kind, template, at, count, spread, hp, speed, removeAfter, tags, data, mover}) -> ids.',
			authority: true,
			args: [
				{ key: 'kind', type: 'string', default: 'enemy' },
				{ key: 'template', type: 'object', label: 'template — the object each entity is drawn as' },
				{ key: 'at', type: 'vector3', default: null, label: 'at — where they appear' },
				{ key: 'count', type: 'number', default: 1, min: 1, max: 20, step: 1 },
				{ key: 'spread', type: 'number', default: 1, min: 0, max: 10, step: 0.1 },
				{ key: 'hp', type: 'number', default: 10, min: 1, max: 1000, step: 1 },
				{ key: 'speed', type: 'number', default: 2, min: 0, max: 20, step: 0.1 },
				{
					key: 'removeAfter',
					type: 'number',
					default: 1,
					min: 0,
					max: 30,
					step: 0.5,
					label: 'remove after death (s)'
				}
			]
		},
		{
			name: 'despawn',
			kind: 'action',
			label: 'Remove entity',
			doc: 'Remove one entity (by id).',
			authority: true,
			args: [{ key: 'entity', type: 'entity' }]
		},
		{
			name: 'clear',
			kind: 'action',
			label: 'Clear entities',
			doc: 'Remove every entity of a KIND (empty = every kind).',
			authority: true,
			args: [{ key: 'kind', type: 'string', default: '' }]
		},
		{
			name: 'count',
			kind: 'value',
			label: 'Entities alive',
			vtype: 'number',
			doc: 'How many entities of a KIND are alive (empty = every kind).',
			args: [{ key: 'kind', type: 'string', default: '' }]
		},
		{
			name: 'spawned',
			kind: 'event',
			label: 'On entity spawned',
			doc: 'An entity appeared (on every peer; the node pulses once, on the authority).'
		},
		{
			name: 'despawned',
			kind: 'event',
			label: 'On entity removed',
			doc: 'An entity left (removed, or its time after death ran out).'
		},
		{
			name: 'emptied',
			kind: 'event',
			label: 'On all entities dead',
			doc: 'The last living entity died or left — the wave is over.'
		}
	]
};
