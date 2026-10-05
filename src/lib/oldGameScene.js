// 36 (U10, 36-int-123) — a game SAVED BEFORE 1.23 whose engine no longer carries its rules.
//
// In 1.23 the five core games' rules moved out of their modules into a "<Game> rules" behaviour
// on the Main graph; each module kept only its ENGINE (api.kit.provide → `kit.<piece>.*`). A copy
// of one of these games saved on 1.20-1.22 has the game's marker object but no rules node, so the
// 2.0 engine loads, nothing listens to it, and the game silently never starts (Mini Golf's old
// `golfinfo` nodes also read as "needs a module"). Upgrading such a copy in place would mean
// rewiring its HUD and graph — roadmap 37. Until then the loading peer SAYS so, once, and points at
// the Games tab, where the same game opens with its readable rules.
//
// A LEAF: pure functions over a session payload (no stores), so the detection is unit-tested.

/** marker object name → the game, and the engine piece its rules call */
export const RULES_GAMES = [
	{ marker: 'Mini golf game', name: 'Mini Golf', piece: 'golf' },
	{ marker: 'Escape game', name: "The Alchemist's Escape", piece: 'escape' },
	{ marker: 'Sky Run game', name: 'Sky Run', piece: 'skyrun' },
	{ marker: 'Target Toss game', name: 'Target Toss', piece: 'toss' },
	{ marker: 'Marble Maze game', name: 'Marble Maze', piece: 'marble' }
];

/** node types that existed only to show an old engine's state (gone with the engine's rules) */
export const RETIRED_GAME_NODES = new Set(['golfinfo']);

/** @param {any} object three.js JSON object @param {Set<string>} out */
function collectNames(object, out) {
	if (!object || typeof object !== 'object') return;
	if (typeof object.name === 'string') out.add(object.name);
	for (const child of Array.isArray(object.children) ? object.children : []) collectNames(child, out);
}

/**
 * The game a payload holds an OLD (pre-1.23) copy of, else null: its marker object is there and
 * no behaviour node in any of its graphs calls that game's engine piece (`kit.<piece>.`).
 * @param {any} payload a session payload (objects + graphs)
 * @returns {{marker: string, name: string, piece: string} | null}
 */
export function oldRulesGame(payload) {
	const names = new Set();
	for (const row of Array.isArray(payload?.objects) ? payload.objects : []) collectNames(row?.object ?? row, names);
	const game = RULES_GAMES.find((g) => names.has(g.marker));
	if (!game) return null;
	const needle = 'kit.' + game.piece + '.';
	for (const graph of Object.values(payload?.graphs ?? {})) {
		for (const node of /** @type {any} */ (graph)?.nodes ?? []) {
			if (node?.type === 'behaviour' && String(node?.data?.code ?? '').includes(needle)) return null;
		}
	}
	return game;
}
