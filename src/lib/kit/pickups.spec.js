// 34 R2 — kit.pickups: the spec (api.kit.pickups AND the "Kit: Pickups" node group). See pickups.js.
/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'pickups',
	group: 'Kit: Pickups',
	calls: [
		{
			name: 'collect',
			kind: 'action',
			label: 'Collect pickup',
			doc: 'Takes a pickup ONCE for everybody (wire an On Click or On Enter into it, the pickup object into "pickup"): its points go to the shared score and to the player who took it, and it comes back after "respawn" seconds (0 = never). A second take before it is back is refused.',
			args: [
				{ key: 'pickup', type: 'object' },
				{ key: 'score', type: 'number', default: 1, min: 0, max: 1000, step: 1 },
				{ key: 'respawn', type: 'number', default: 0, min: 0, max: 600, step: 1 }
			],
			authority: true
		},
		{ name: 'resetPickups', kind: 'action', label: 'Reset pickups', doc: 'Puts every pickup back (a new round does this by itself).', args: [], authority: true },
		{ name: 'available', kind: 'value', label: 'Pickup available?', vtype: 'boolean', doc: 'Is this pickup there to take (never taken, or back after its respawn)? Wire it into a Visibility node to hide a taken pickup.', args: [{ key: 'pickup', type: 'object' }] },
		{ name: 'taken', kind: 'value', label: 'Pickups taken', vtype: 'number', doc: 'How many pickups are taken right now.', args: [] },
		{ name: 'left', kind: 'value', label: 'Pickups left', vtype: 'number', doc: 'How many registered pickups are still there to take.', args: [] },
		{ name: 'collected', kind: 'event', label: 'On pickup', doc: 'Pulses when any pickup is taken.', args: [] },
		{ name: 'respawned', kind: 'event', label: 'On pickup back', doc: 'Pulses when a taken pickup comes back.', args: [] },
		{ name: 'allCollected', kind: 'event', label: 'On all pickups taken', doc: 'Pulses when the last registered pickup is taken (a "collect them all" win).', args: [] }
	]
};
