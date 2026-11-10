// Template def `two-levels` — 93: a starter game with TWO LEVELS in one scene, a portal between them, a
// checkpoint on the way, a kept score and a loading screen. One file per template (34 R4 A3); authored by
// scripts/author-templates.cjs (the def schema is the comment block at its top); the table is ./index.cjs.

const { gray } = require('./_builders.cjs');
const { walkGraph } = require('./_level-kit.cjs');

module.exports = {
	kind: 'template',
	slug: 'two-levels',
	title: 'Two levels and a portal',
	description: 'A starter game: a courtyard and a tower top in one scene, a portal between them, a checkpoint and a score that carries across',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['game', 'levels', 'portal'],
	objects: [
		// level 1: the courtyard
		{ type: 'box', name: 'Courtyard floor', color: gray.floor, size: [24, 0.5, 30], pos: [0, -0.25, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall west', color: gray.wall, size: [0.5, 3, 30], pos: [-12, 1.5, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Wall east', color: gray.wall, size: [0.5, 3, 30], pos: [12, 1.5, 0], physics: { mode: 'static' } },
		{ type: 'box', name: 'Crate A', color: gray.block, size: [1.6, 1.6, 1.6], pos: [-4, 0.8, 2], physics: { mode: 'static' } },
		{ type: 'box', name: 'Crate B', color: gray.block, size: [1.6, 1.6, 1.6], pos: [5, 0.8, -3], physics: { mode: 'static' } },
		{ type: 'checkpoint', name: 'Start pad', pos: [0, 0, 11], checkpoint: { show: false } },
		{ type: 'checkpoint', name: 'Gate', pos: [0, 0, 0], checkpoint: { label: 'Halfway there' } },
		{ type: 'portal', name: 'To the tower', pos: [0, 0, -11], portal: { level: 'tower-top', transition: 'iris' } },
		// level 2: the tower top, high up and away from the courtyard
		{ type: 'box', name: 'Tower top', color: gray.accent, size: [12, 0.5, 12], pos: [40, 9.75, 0], physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Tower', color: gray.wall, r: 4, h: 9.5, pos: [40, 4.75, 0], physics: { mode: 'static' } },
		{ type: 'checkpoint', name: 'Tower pad', pos: [40, 10, 4], checkpoint: { show: false } },
		{ type: 'portal', name: 'Back down', pos: [40, 10, -4], portal: { level: 'courtyard', transition: 'fade' } }
	],
	physics: {
		play: { spawn: { position: [0, 0, 11], yaw: 0 } },
		levels: {
			list: [
				{ id: 'courtyard', name: 'Courtyard', spawn: 'Start pad', goal: 'Walk through the portal at the far end' },
				{ id: 'tower-top', name: 'Tower top', spawn: 'Tower pad', goal: 'You made it to the top' }
			],
			keep: ['score'],
			unlock: 'all',
			loading: { preset: 'bar', title: 'Two levels', tips: ['Portals take you to the next level', 'Step on a checkpoint to save your place'] }
		}
	},
	// 78-int (device-lab A5): the player WALKS: a Character Controller (walk) stands them on the tower top after the
	// portal hop. Without it walk mode is the eye-height pin over the ground plane (1.64 holds the default walker
	// back), which put the player inside the tower. All-static, so Play starts its world by itself (78 F11).
	graphs: { scene: walkGraph() },
	view: { pos: [16, 12, 22], target: [6, 1, -2] }
};
