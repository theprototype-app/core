// 34 R2 — kit.round: the spec (api.kit.round AND the "Kit: Round" node group). See round.js.
/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'round',
	group: 'Kit: Round',
	calls: [
		{
			name: 'configure',
			kind: 'action',
			label: 'Round setup',
			doc: 'How a round runs: an intro countdown before play (seconds), a time limit (0 = none), what the clock running out means (lose, or win for a survive-the-timer game), and how long the won/lost moment lasts before the results.',
			args: [
				{ key: 'intro', type: 'number', default: 3, min: 0, max: 30, step: 1 },
				{ key: 'limit', type: 'number', default: 0, min: 0, max: 3600, step: 5 },
				{ key: 'timeout', type: 'string', options: ['lose', 'win'] },
				{ key: 'outro', type: 'number', default: 2, min: 0, max: 30, step: 0.5 }
			],
			authority: true
		},
		{ name: 'start', kind: 'action', label: 'Start round', doc: 'Starts a round from the menu or the results (the intro countdown, then play). Pressed again while a round runs it does nothing, so two players pressing Start start ONE round.', args: [], authority: true },
		{ name: 'restart', kind: 'action', label: 'Restart round', doc: 'A fresh round right now, whatever is running — no reset-then-delay-then-play chain needed.', args: [], authority: true },
		{ name: 'pause', kind: 'action', label: 'Pause round', doc: 'Pauses the shared round (the clock stops for everyone).', args: [], authority: true },
		{ name: 'resume', kind: 'action', label: 'Resume round', doc: 'Resumes a paused round.', args: [], authority: true },
		{ name: 'win', kind: 'action', label: 'Win round', doc: 'Ends the running round as won, with an optional reason the results can show.', args: [{ key: 'reason', type: 'string', default: '' }], authority: true },
		{ name: 'lose', kind: 'action', label: 'Lose round', doc: 'Ends the running round as lost, with an optional reason.', args: [{ key: 'reason', type: 'string', default: '' }], authority: true },
		{ name: 'extend', kind: 'action', label: 'Add time', doc: 'Adds seconds to the running round\'s time limit (golden goal, a bonus pickup).', args: [{ key: 'seconds', type: 'number', default: 10, min: 1, max: 600, step: 1 }], authority: true },
		{ name: 'toMenu', kind: 'action', label: 'Back to menu', doc: 'Ends the round and goes back to the menu.', args: [], authority: true },
		{ name: 'phase', kind: 'value', label: 'Round phase', vtype: 'any', doc: 'The phase: menu, intro, playing, paused, won, lost or results — wire it into HUD Text or a Select.', args: [] },
		{ name: 'playing', kind: 'value', label: 'Round playing?', vtype: 'boolean', doc: 'True while the round is in play (not in the intro, not paused, not over).', args: [] },
		{ name: 'elapsed', kind: 'value', label: 'Round time', vtype: 'number', doc: 'Seconds of play in this round (the intro and pauses do not count); every peer reads the same number.', args: [] },
		{ name: 'remaining', kind: 'value', label: 'Time left', vtype: 'number', doc: 'Seconds left on the time limit (0 with no limit).', args: [] },
		{ name: 'countdown', kind: 'value', label: 'Intro countdown', vtype: 'number', doc: 'Whole seconds left in the intro (3, 2, 1), else 0.', args: [] },
		{ name: 'number', kind: 'value', label: 'Round number', vtype: 'number', doc: 'Which round this is (1, 2, 3…) in this session.', args: [] },
		{ name: 'outcome', kind: 'value', label: 'Round outcome', vtype: 'any', doc: 'Why the last round ended (the reason given to Win/Lose, or "time").', args: [] },
		{ name: 'started', kind: 'event', label: 'On round start', doc: 'Pulses when a round starts (its intro begins).', args: [] },
		{ name: 'go', kind: 'event', label: 'On go', doc: 'Pulses when the intro ends and play begins.', args: [] },
		{ name: 'paused', kind: 'event', label: 'On round paused', doc: 'Pulses when the round pauses.', args: [] },
		{ name: 'resumed', kind: 'event', label: 'On round resumed', doc: 'Pulses when a paused round resumes.', args: [] },
		{ name: 'won', kind: 'event', label: 'On round won', doc: 'Pulses when the round is won.', args: [] },
		{ name: 'lost', kind: 'event', label: 'On round lost', doc: 'Pulses when the round is lost (including the clock running out).', args: [] },
		{ name: 'results', kind: 'event', label: 'On results', doc: 'Pulses when the results screen is due (after the won/lost moment).', args: [] },
		{ name: 'menu', kind: 'event', label: 'On back to menu', doc: 'Pulses when the game goes back to the menu.', args: [] }
	]
};
