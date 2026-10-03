// Template def `level-blockout` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { gray } = require('./_builders.cjs');

module.exports = {
	kind: 'template',
	slug: 'level-blockout',
	title: 'Level blockout',
	description: 'Greybox kit: floor, ramp to a platform, steps, walls and cover blocks',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['greybox', 'level design'],
	objects: [
		{ type: 'box', name: 'Floor', color: gray.floor, size: [24, 0.5, 24], pos: [0, -0.25, 0] },
		{ type: 'box', name: 'Platform', color: gray.block, size: [6, 0.5, 6], pos: [8, 2, -6] },
		{ type: 'box', name: 'Ramp', color: gray.block, size: [4, 0.5, 7.2], pos: [8, 1, -0.6], rot: [-0.297, 0, 0] },
		{ type: 'box', name: 'Step 1', color: gray.block, size: [2.4, 0.66, 1.2], pos: [3.6, 0.33, -6] },
		{ type: 'box', name: 'Step 2', color: gray.block, size: [2.4, 1.33, 1.2], pos: [4.4, 0.66, -6] },
		{ type: 'box', name: 'Wall west', color: gray.wall, size: [0.5, 3, 14], pos: [-10, 1.5, -2] },
		{ type: 'box', name: 'Wall north', color: gray.wall, size: [14, 3, 0.5], pos: [-3, 1.5, -11] },
		{ type: 'box', name: 'Cover A', color: gray.block, size: [2, 2, 2], pos: [-3, 1, 4] },
		{ type: 'box', name: 'Cover B', color: gray.block, size: [3, 1, 1.2], pos: [1, 0.5, 7] },
		{ type: 'cylinder', name: 'Tower', color: gray.accent, r: 1.5, h: 6, pos: [-7, 3, -7] }
	]
};
