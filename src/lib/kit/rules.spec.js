// 34 R2 — kit.rules: the spec (api.kit.rules AND the "Kit: Rules" node group). See rules.js.
/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'rules',
	group: 'Kit: Rules',
	calls: [
		{
			name: 'setReach',
			kind: 'action',
			label: 'Set grab reach',
			doc: 'Limits how far from your body a player may take hold of something (metres, measured from the feet-to-eye segment); 0 removes the limit. Every grab path obeys it: desktop Play, Interact, and the VR grip.',
			args: [{ key: 'metres', type: 'number', default: 1.3, min: 0, max: 20, step: 0.1 }],
			authority: true
		},
		{
			name: 'setJump',
			kind: 'action',
			label: 'Set jump height',
			doc: 'How high a walking player jumps (metres; Space on desktop, A in VR) while a Character Controller walks; 0 = no jump.',
			args: [{ key: 'metres', type: 'number', default: 1.2, min: 0, max: 5, step: 0.1 }],
			authority: true
		},
		{
			name: 'setBounds',
			kind: 'action',
			label: 'Set play bounds',
			doc: 'The play area (a box in scene coordinates): a teleport must land inside it, and games can ask whether a point is inside.',
			args: [
				{ key: 'min', type: 'vector3', default: [-10, -1, -10] },
				{ key: 'max', type: 'vector3', default: [10, 10, 10] }
			],
			authority: true
		},
		{
			name: 'clearRules',
			kind: 'action',
			label: 'Clear rules',
			doc: "Removes the kit's reach, jump and bounds, so the scene's own play settings apply again.",
			args: [],
			authority: true
		},
		{ name: 'reach', kind: 'value', label: 'Grab reach', vtype: 'number', doc: 'The grab reach the kit sets (metres), or 0 when it sets none.', args: [] },
		{ name: 'jump', kind: 'value', label: 'Jump height', vtype: 'number', doc: 'The jump height the kit sets (metres), or 0 when it sets none.', args: [] },
		{
			name: 'refused',
			kind: 'event',
			local: true,
			label: 'On grab refused',
			doc: 'Pulses on the player whose grab was refused (too far, or a game rule said no) — only for that player, so a "too far" sound or buzz is theirs alone.',
			args: []
		}
	]
};
