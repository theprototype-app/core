// Template def `agent-workshop` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 85a-int: the 1.56 starter — a plain room to try Claude's (or any agent's) new shape, look and undo tools on. It is
// the same room the connector's eval set runs against (tests/agent-eval/scene.json): a floor, a table with a lamp, a
// crate, a ball and a door, all plain primitives with plain colours, so every request in the docs page lands on
// something ("put a curvy vase on the table", "a handrail along the edge", "a star-shaped sign above the door",
// "give the table a real wood texture", "make the ball look like glass", "make the lamp tilt at its base",
// "undo that"). Nothing here is made with the new tools: the point is to watch them change it.

module.exports = {
	kind: 'template',
	slug: 'agent-workshop',
	title: 'Agent workshop',
	description:
		'A plain room for Claude to build in: ask for a curvy vase on the table, a handrail, a star-shaped sign above the door, a wood or glass look — then say “undo that”.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['ai', 'agent', 'claude', 'starter'],
	objects: [
		{ type: 'box', name: 'Floor', color: 0x8a8a8a, size: [10, 0.1, 10], pos: [0, -0.05, 0] },
		{ type: 'box', name: 'Table', color: 0x7a5230, size: [1.6, 0.75, 0.9], pos: [0, 0.375, 0] },
		{
			type: 'group',
			name: 'Lamp',
			pos: [0.5, 0.75, 0],
			children: [
				{ type: 'cylinder', name: 'Lamp base', color: 0x333333, r: 0.05, r2: 0.1, h: 0.4, pos: [0, 0.2, 0] },
				{ type: 'cone', name: 'Lamp shade', color: 0xf2e6c9, r: 0.2, h: 0.25, pos: [0, 0.5, 0] },
				{ type: 'light', kind: 'point', name: 'Lamp light', color: 0xffe2b0, intensity: 2, distance: 6, pos: [0, 0.45, 0] }
			]
		},
		{ type: 'box', name: 'Crate', color: 0xa0703c, size: [0.6, 0.6, 0.6], pos: [-2, 0.3, 1] },
		{ type: 'sphere', name: 'Ball', color: 0x2a6fdb, r: 0.25, pos: [-1, 1.5, 0] },
		{ type: 'box', name: 'Door', color: 0x5b3a1e, size: [1, 2.1, 0.08], pos: [0, 1.05, -5] },
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xffffff, intensity: 3, pos: [5, 10, 5], target: [0, 0, 0] }
	],
	view: { pos: [0, 2.6, 5.5], target: [0, 0.7, -0.5] }
};
