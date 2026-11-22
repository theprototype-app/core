// 102b-hud (row 4): the official games' `info` reads as core Game Value nodes. ONE table, used by
// the template defs (sky-run, escape-room) AND scripts/game-value-swap.cjs (which rewrites a saved
// scene the same way), so a regenerated scene and a swapped one cannot drift.
// Each entry: info node type -> read -> the Game Value node's data. The module publishes the raw
// value under `name` (api.values.set), the node writes the words around it.

/** @type {Record<string, Record<string, Record<string, any>>>} */
const GAME_VALUE_SWAPS = {
	skyruninfo: {
		title: { read: 'published', name: 'title', format: 'text' },
		clock: { read: 'published', name: 'time', format: 'time', decimals: 1 },
		coins: { read: 'published', name: 'coins', format: 'fraction', prefix: 'Coins ' },
		checkpoint: { read: 'published', name: 'flag', prefix: 'Flag ', empty: 'No flag yet' },
		best: { read: 'published', name: 'best', format: 'time', decimals: 1, prefix: 'Best ', empty: 'Best —' },
		result: { read: 'published', name: 'result', format: 'text' },
		resultLine: { read: 'published', name: 'resultLine', format: 'text' },
		countdown: { read: 'published', name: 'countdown', format: 'text' },
		// stageBest takes the info node's `level` (1..3)
		stageBest: { read: 'published', name: 'stageBest{level}', format: 'time', decimals: 1, prefix: 'best ', empty: 'not cleared yet' }
	},
	escapeinfo: {
		room: { read: 'published', name: 'room', format: 'text' },
		clock: { read: 'clock', format: 'time' },
		inventory: { read: 'published', name: 'inventory', format: 'text', prefix: 'Carrying: ', empty: 'Carrying: nothing' },
		gems: { read: 'published', name: 'gems', format: 'fraction', prefix: 'Gems ' },
		goal: { read: 'published', name: 'goal', format: 'text' },
		result: { read: 'published', name: 'escapeTime', format: 'time', prefix: 'You escaped in ' },
		best: { read: 'published', name: 'best', format: 'time', prefix: 'Best escape on this device: ', empty: ' ' },
		menuBest: { read: 'published', name: 'best', format: 'time', prefix: 'Your best escape: ', empty: 'Three rooms. Three gems. One way out.' }
	}
};

const DEFAULTS = { read: 'score', name: '', format: 'number', decimals: 0, max: 0, prefix: '', suffix: '', empty: '' };

/**
 * The Game Value data for one info node's data, or null when the read has no swap.
 * @param {string} type @param {any} data
 */
function gameValueData(type, data) {
	const row = GAME_VALUE_SWAPS[type]?.[String(data?.read ?? '')];
	if (!row) return null;
	const out = { ...DEFAULTS, ...row };
	out.name = String(out.name).replace('{level}', String(data?.level ?? '1'));
	if (data?.label) out.label = String(data.label).replace(/^(Sky Run|Escape): /, 'Game value: ');
	return out;
}

module.exports = { GAME_VALUE_SWAPS, gameValueData };
