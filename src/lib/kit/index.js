// 34 R2 (T3) — THE KIT, piece by piece: ONE table, one row per piece.
//
// A row is `{name, piece}` where `piece` = `{spec, initial, normalize?, ops, tick?, make}` (see
// core.js). The row ORDER is the order of `api.kit`'s keys and of the palette groups. A new piece
// is a new pair of files (`<piece>.js` + `<piece>.spec.js`) plus ONE row here — the sdk/index.js
// rule. 34-kit-core owns this file and kit-core's rows; 34-kit-entities ADDS rows (spawner,
// health, mover) and owns those files.

import { spawnerPiece } from './spawner.js';
import { healthPiece } from './health.js';
import { moverPiece } from './mover.js';

/** @type {{name: string, piece: any}[]} */
export const KIT_PIECES = [
	// 34-kit-entities (one runtime shared through kit/entityHub.js; spawner is the primary row)
	{ name: 'spawner', piece: spawnerPiece },
	{ name: 'health', piece: healthPiece },
	{ name: 'mover', piece: moverPiece }
];
