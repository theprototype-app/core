// Template def `starter-recipes` — 78 F27: a small yard that shows the four starter recipes at work
// (node search ▸ Recipes): a door you click, a door that opens when you walk up, a bell and a guard on
// a patrol loop. The recipes are inserted by the REAL `insertStarterRecipe` (generate {recipe, on}), so
// the scene holds exactly what a person gets from the menu. One file per template (34 R4 A3).

const { gray } = require('./_builders.cjs');

module.exports = {
	kind: 'template',
	slug: 'starter-recipes',
	title: 'Doors, a bell and a guard',
	description: 'The starter recipes at work: click a door, walk up to the other, ring the bell, and keep away from the guard',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['game', 'recipes', 'nodes'],
	objects: [
		{ type: 'box', name: 'Yard floor', color: gray.floor, size: [24, 0.5, 24], pos: [0, -0.25, 0], physics: { mode: 'static' } },
		// the click door, in a frame
		{ type: 'box', name: 'Frame left', color: gray.wall, size: [0.2, 2.4, 0.3], pos: [-6.6, 1.2, -6], physics: { mode: 'static' } },
		{ type: 'box', name: 'Frame right', color: gray.wall, size: [0.2, 2.4, 0.3], pos: [-5.4, 1.2, -6], physics: { mode: 'static' } },
		{ type: 'box', name: 'Door', color: gray.accent, size: [1, 2.2, 0.1], pos: [-6, 1.1, -6] },
		// the walk-up door
		{ type: 'box', name: 'Gate frame left', color: gray.wall, size: [0.2, 2.4, 0.3], pos: [5.4, 1.2, -6], physics: { mode: 'static' } },
		{ type: 'box', name: 'Gate frame right', color: gray.wall, size: [0.2, 2.4, 0.3], pos: [6.6, 1.2, -6], physics: { mode: 'static' } },
		{ type: 'box', name: 'Gate', color: gray.accent, size: [1, 2.2, 0.1], pos: [6, 1.1, -6] },
		// the bell on a post
		{ type: 'cylinder', name: 'Bell post', color: gray.wall, r: 0.08, h: 2.6, pos: [0, 1.3, -8], physics: { mode: 'static' } },
		{ type: 'cone', name: 'Bell', color: 0xc9a227, r: 0.35, h: 0.5, pos: [0, 2.2, -7.7] },
		// the guard, patrolling the middle of the yard
		{ type: 'capsule', name: 'Guard', color: 0x8a3b3b, r: 0.3, h: 1, pos: [0, 0.8, 3] }
	],
	generate: [
		{ recipe: 'door', on: 'Door', waitMs: 600 },
		{ recipe: 'door-walk', on: 'Gate', waitMs: 600 },
		{ recipe: 'bell', on: 'Bell', waitMs: 600 },
		{ recipe: 'guard', on: 'Guard', waitMs: 1200 }
	],
	physics: { play: { spawn: { position: [0, 0, 9], yaw: 0 } } },
	view: { pos: [0, 10, 16], target: [0, 1, -3] }
};
