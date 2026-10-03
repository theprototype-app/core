// 34 R2 (T3) — THE KIT, piece by piece: ONE table, one row per piece.
//
// A row is `{name, piece}` where `piece` = `{spec, initial, normalize?, ops, tick?, make}` (see
// core.js). The row ORDER is the order of `api.kit`'s keys and of the palette groups. A new piece
// is a new pair of files (`<piece>.js` + `<piece>.spec.js`) plus ONE row here — the sdk/index.js
// rule. 34-kit-core owns this file and kit-core's rows; 34-kit-entities ADDS rows (spawner,
// health, mover) and owns those files.

import rules from './rules.js';
import round from './round.js';
import levels from './levels.js';
import score from './score.js';

/** @type {{name: string, piece: any}[]} */
export const KIT_PIECES = [
	{ name: 'rules', piece: rules }, // reach, jump, bounds, the grab veto
	{ name: 'round', piece: round }, // the phase machine menu -> intro -> playing <-> paused -> won/lost -> results
	{ name: 'levels', piece: levels }, // the level table, unlocks, stars, per-device progress, modes
	{ name: 'score', piece: score } // the shared score, per-player rows, device best, leaderboard
];
