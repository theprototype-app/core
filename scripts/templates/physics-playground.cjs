// Template def `physics-playground` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

module.exports = {
	kind: 'template',
	slug: 'physics-playground',
	title: 'Physics playground',
	description: 'Static floor and ramp, a dynamic cube pyramid, dominos and a bouncy ball — press P to simulate',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'sandbox'],
	objects: [
		{
			type: 'box', name: 'Floor', color: 0x7e8a97, size: [20, 0.5, 20], pos: [0, -0.25, 0],
			physics: { mode: 'static', friction: 0.8 }
		},
		{
			type: 'box', name: 'Ramp', color: 0x99a3ae, size: [8, 0.4, 4], pos: [-5, 1.55, 0], rot: [0, 0, 0.42],
			physics: { mode: 'static', friction: 0.3 }
		},
		{
			type: 'sphere', name: 'Bouncy ball', color: 0xd97706, r: 0.75, pos: [-8.2, 4.6, 0],
			physics: { mode: 'dynamic', mass: 2, restitution: 0.7, friction: 0.4 }
		},
		// 3-2-1 cube pyramid
		{ type: 'box', name: 'Crate 1', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, -1.2], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		{ type: 'box', name: 'Crate 2', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, 0], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		{ type: 'box', name: 'Crate 3', color: 0xc0885a, size: [1, 1, 1], pos: [3, 0.5, 1.2], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		{ type: 'box', name: 'Crate 4', color: 0xb0784a, size: [1, 1, 1], pos: [3, 1.55, -0.6], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		{ type: 'box', name: 'Crate 5', color: 0xb0784a, size: [1, 1, 1], pos: [3, 1.55, 0.6], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		{ type: 'box', name: 'Crate 6', color: 0xa06a3e, size: [1, 1, 1], pos: [3, 2.6, 0], physics: { mode: 'dynamic', mass: 1, restitution: 0.15 } },
		// domino run
		{ type: 'box', name: 'Domino 1', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [0, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
		{ type: 'box', name: 'Domino 2', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [1, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
		{ type: 'box', name: 'Domino 3', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [2, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } },
		{ type: 'box', name: 'Domino 4', color: 0x9aa7b4, size: [0.2, 1.6, 0.8], pos: [3, 0.8, 5], physics: { mode: 'dynamic', mass: 0.5 } }
	]
};
