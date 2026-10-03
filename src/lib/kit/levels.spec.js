// 34 R2 — kit.levels: the spec (api.kit.levels AND the "Kit: Levels" node group). See levels.js.
/** @type {import('./spec.js').KitSpec} */
export default {
	piece: 'levels',
	group: 'Kit: Levels',
	calls: [
		{ name: 'select', kind: 'action', label: 'Go to level', doc: 'Makes a level the current one for everybody (a locked level is refused, with the reason).', args: [{ key: 'level', type: 'string', default: '1' }], authority: true },
		{ name: 'next', kind: 'action', label: 'Next level', doc: 'Moves everybody to the level after the current one, if it is unlocked.', args: [], authority: true },
		{
			name: 'complete',
			kind: 'action',
			label: 'Finish level',
			doc: 'Records the current level as finished: won or not, a score, and the time (the round clock when left at 0). Stars follow the game\'s rule; a win unlocks the next level and is saved on every player\'s device.',
			args: [
				{ key: 'won', type: 'boolean', default: true },
				{ key: 'score', type: 'number', default: 0, min: 0, max: 100000, step: 1 },
				{ key: 'time', type: 'number', default: 0, min: 0, max: 36000, step: 1 }
			],
			authority: true
		},
		{ name: 'setMode', kind: 'action', label: 'Set game mode', doc: 'Switches the game\'s mode (a globe and a board, easy and hard) and KEEPS the current level: progress belongs to the level, whichever mode reached it.', args: [{ key: 'mode', type: 'string', default: '' }], authority: true },
		{ name: 'current', kind: 'value', label: 'Current level', vtype: 'any', doc: 'The current level\'s id (empty in the level select).', args: [] },
		{ name: 'currentLabel', kind: 'value', label: 'Level name', vtype: 'any', doc: 'The current level\'s label, for a HUD title.', args: [] },
		{ name: 'index', kind: 'value', label: 'Level number', vtype: 'number', doc: 'The current level\'s position in the list (1, 2, 3…), 0 when none.', args: [] },
		{ name: 'starsOf', kind: 'value', label: 'Level stars', vtype: 'number', doc: 'The best stars this device holds for a level (0..3), counting this session\'s results.', args: [{ key: 'level', type: 'string', default: '1' }] },
		{ name: 'unlocked', kind: 'value', label: 'Level unlocked?', vtype: 'boolean', doc: 'Is a level unlocked (by the game\'s rule, on this device\'s progress)?', args: [{ key: 'level', type: 'string', default: '1' }] },
		{ name: 'totalStars', kind: 'value', label: 'Total stars', vtype: 'number', doc: 'All the stars earned across the levels, on this device.', args: [] },
		{ name: 'mode', kind: 'value', label: 'Game mode', vtype: 'any', doc: 'The current mode (empty when the game has none).', args: [] },
		{ name: 'selected', kind: 'event', label: 'On level chosen', doc: 'Pulses when a level becomes current.', args: [] },
		{ name: 'completed', kind: 'event', label: 'On level finished', doc: 'Pulses when a level is recorded as finished (won or not).', args: [] },
		{ name: 'unlockedNext', kind: 'event', label: 'On level unlocked', doc: 'Pulses when a win opens a level that was locked.', args: [] }
	]
};
