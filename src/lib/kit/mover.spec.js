// 34 R2 (kit-entities) — kit.mover: steering for kit entities (seek / arrive / patrol,
// separation, STUCK detection + recovery, knock-back re-seat — kit/moverCore.js). ONE spec ->
// `api.kit.mover` AND the "Kit: Mover" node group. The authority steps every mover; peers are
// told where entities are. Code-only extras: seek, arrive, patrol, stop, setSpeed, state.

/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'mover',
	group: 'Kit: Mover',
	calls: [
		{
			name: 'chase',
			kind: 'action',
			label: 'Chase',
			doc: 'Every living entity of a KIND (empty = all) chases a TARGET object (unwired: the nearest player), steering round walls and each other.',
			authority: true,
			args: [
				{ key: 'kind', type: 'string', default: '' },
				{ key: 'target', type: 'object', label: 'target — unwired: the nearest player' }
			]
		},
		{
			name: 'halt',
			kind: 'action',
			label: 'Stop moving',
			doc: 'Every living entity of a KIND (empty = all) stops where it is.',
			authority: true,
			args: [{ key: 'kind', type: 'string', default: '' }]
		},
		{
			name: 'knock',
			kind: 'action',
			label: 'Knock back',
			doc: 'Throw one entity with a velocity (m/s); it comes back to rest on the ground, inside the level, out of walls.',
			authority: true,
			args: [
				{ key: 'entity', type: 'entity' },
				{ key: 'force', type: 'vector3', default: [0, 0, 3] }
			]
		},
		{
			name: 'stuck',
			kind: 'event',
			label: 'On entity stuck',
			doc: 'An entity made no headway and started a recovery (a sidestep or a new route).'
		}
	]
};
