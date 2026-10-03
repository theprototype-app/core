// 34 R2 (kit-entities) — kit.health: hit points on kit entities, promoted from the `health`
// module (its per-enemy counter chains become one field the authority writes). ONE spec ->
// `api.kit.health` AND the "Kit: Health" node group. Damage asked on any peer reaches the
// authority (and is credited to the peer that asked). Code-only extras: max, fraction, alive.

/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'health',
	group: 'Kit: Health',
	calls: [
		{
			name: 'damage',
			kind: 'action',
			label: 'Damage entity',
			doc: 'Take AMOUNT hit points from one entity; at 0 it dies (a dead entity takes no more). Code: damage(id, amount).',
			authority: true,
			args: [
				{ key: 'entity', type: 'entity' },
				{ key: 'amount', type: 'number', default: 1, min: 0, max: 1000, step: 1 }
			]
		},
		{
			name: 'damageArea',
			kind: 'action',
			label: 'Damage in area',
			doc: 'Damage every living entity of a KIND (empty = all) within RADIUS of a place — a blast, a stomp, a sweep.',
			authority: true,
			args: [
				{ key: 'at', type: 'vector3' },
				{ key: 'radius', type: 'number', default: 2, min: 0, max: 50, step: 0.1 },
				{ key: 'amount', type: 'number', default: 1, min: 0, max: 1000, step: 1 },
				{ key: 'kind', type: 'string', default: '' }
			]
		},
		{
			name: 'heal',
			kind: 'action',
			label: 'Heal entity',
			doc: 'Give AMOUNT hit points back (never above max; a dead entity needs Revive).',
			authority: true,
			args: [
				{ key: 'entity', type: 'entity' },
				{ key: 'amount', type: 'number', default: 1, min: 0, max: 1000, step: 1 }
			]
		},
		{
			name: 'revive',
			kind: 'action',
			label: 'Revive entity',
			doc: 'Bring a dead entity back at full health.',
			authority: true,
			args: [{ key: 'entity', type: 'entity' }]
		},
		{
			name: 'hp',
			kind: 'value',
			label: 'Entity health',
			vtype: 'number',
			doc: 'An entity’s hit points now (0 when it is gone).',
			args: [{ key: 'entity', type: 'entity' }]
		},
		{
			name: 'damaged',
			kind: 'event',
			label: 'On entity damaged',
			doc: 'An entity lost hit points.'
		},
		{
			name: 'healed',
			kind: 'event',
			label: 'On entity healed',
			doc: 'An entity got hit points back.'
		},
		{
			name: 'died',
			kind: 'event',
			label: 'On entity died',
			doc: 'An entity reached 0 hit points.'
		},
		{ name: 'revived', kind: 'event', label: 'On entity revived', doc: 'A dead entity came back.' }
	]
};
