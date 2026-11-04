// Template def `game-plot` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 85b-int: the 1.60 starter — an empty plot for an agent to turn into a small game with the 1.60 tools (terrain,
// scatter, water, particles, sound, the HUD, sky + fog, the spawn and the play camera, then validate_scene). It holds
// only what every request in the docs page needs to land on: a ground slab, a start pad ("start the player here"),
// a finish arch ("a race HUD with a timer to the arch"), a fire pit ("make it a campfire with a crackle") and a few
// plain gems to collect. Nothing here is made with the new tools: the point is to watch them build it.

const gem = (/** @type {number} */ i, /** @type {number[]} */ pos) => ({ type: 'icosahedron', name: 'Gem ' + i, color: 0x37c6e6, r: 0.25, pos });

module.exports = {
	kind: 'template',
	slug: 'game-plot',
	title: 'Game plot',
	description:
		'An empty plot for Claude to turn into a game: ask for hills with a forest and a lake, a campfire that crackles, a race HUD and a start spot — then “check my game”.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['ai', 'agent', 'claude', 'starter', 'game'],
	objects: [
		{ type: 'box', name: 'Ground', color: 0x6f8f4e, size: [40, 0.2, 40], pos: [0, -0.1, 0] },
		{ type: 'cylinder', name: 'Start pad', color: 0xd9d2c0, r: 1.2, r2: 1.2, h: 0.1, pos: [0, 0.05, 12] },
		{
			type: 'group',
			name: 'Finish arch',
			pos: [0, 0, -12],
			children: [
				{ type: 'box', name: 'Arch left', color: 0xe8e8e8, size: [0.3, 3, 0.3], pos: [-2, 1.5, 0] },
				{ type: 'box', name: 'Arch right', color: 0xe8e8e8, size: [0.3, 3, 0.3], pos: [2, 1.5, 0] },
				{ type: 'box', name: 'Arch top', color: 0xd94a3a, size: [4.3, 0.4, 0.3], pos: [0, 3.1, 0] }
			]
		},
		{ type: 'cylinder', name: 'Fire pit', color: 0x5a5550, r: 0.7, r2: 0.8, h: 0.25, pos: [5, 0.125, 4] },
		gem(1, [-4, 0.6, 7]),
		gem(2, [3, 0.6, 2]),
		gem(3, [-2, 0.6, -3]),
		gem(4, [4, 0.6, -8]),
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xfff1d6, intensity: 3, pos: [8, 14, 6], target: [0, 0, 0] }
	],
	view: { pos: [0, 9, 24], target: [0, 0.5, 0] }
};
