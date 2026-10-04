// 34 R2 — kit.score: the spec (api.kit.score AND the "Kit: Score" node group). See score.js.
/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'score',
	group: 'Kit: Score',
	calls: [
		{
			name: 'add',
			kind: 'action',
			label: 'Add score',
			doc: 'Adds points to the shared score and to the player who earned them (the peer whose press it was, unless a player is named). Counted ONCE however many peers saw the pulse.',
			args: [
				{ key: 'amount', type: 'number', default: 1, min: -1000, max: 1000, step: 1 },
				{ key: 'player', type: 'string', default: '' }
			],
			authority: true
		},
		{ name: 'set', kind: 'action', label: 'Set score', doc: 'Sets a player\'s score (or the shared score when no player is named) to a number.', args: [{ key: 'amount', type: 'number', default: 0, min: -100000, max: 100000, step: 1 }, { key: 'player', type: 'string', default: '' }], authority: true },
		{ name: 'reset', kind: 'action', label: 'Reset score', doc: 'Zeroes every score (a new round does this by itself).', args: [], authority: true },
		{ name: 'total', kind: 'value', label: 'Score', vtype: 'number', doc: 'The shared score of this round.', args: [] },
		{ name: 'mine', kind: 'value', label: 'My score', vtype: 'number', doc: 'This player\'s own score in this round (each peer reads its own).', args: [] },
		{ name: 'best', kind: 'value', label: 'Best score', vtype: 'number', doc: 'The best shared score this device has seen for this game (and level).', args: [] },
		{ name: 'leader', kind: 'value', label: 'Leader', vtype: 'any', doc: 'The leading player\'s name (empty with no scores).', args: [] },
		{ name: 'scored', kind: 'event', label: 'On score', doc: 'Pulses whenever points are added.', args: [] },
		{ name: 'newBest', kind: 'event', local: true, label: 'On new best', doc: 'Pulses on each device whose best score this round beat, when the round ends.', args: [] }
	]
};
