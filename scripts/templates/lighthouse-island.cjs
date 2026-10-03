// Template def `lighthouse-island` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

module.exports = {
	kind: 'example',
	slug: 'lighthouse-island',
	title: 'Lighthouse island',
	description: 'A small primitive-built lighthouse on an island — an example of composing simple shapes',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['showcase', 'primitives'],
	objects: [
		{ type: 'cylinder', name: 'Island', color: 0x8a9a7b, r: 7, r2: 8.5, h: 1.2, pos: [0, -0.6, 0] },
		{ type: 'cylinder', name: 'Tower base', color: 0xe8e2d6, r: 1.5, r2: 1.9, h: 3, pos: [0, 1.5, 0] },
		{ type: 'cylinder', name: 'Tower band', color: 0xc2452f, r: 1.32, r2: 1.5, h: 2.4, pos: [0, 4.2, 0] },
		{ type: 'cylinder', name: 'Tower top', color: 0xe8e2d6, r: 1.15, r2: 1.32, h: 2.4, pos: [0, 6.6, 0] },
		{ type: 'cylinder', name: 'Lamp room', color: 0x3b4652, r: 0.95, h: 1.3, pos: [0, 8.45, 0] },
		{ type: 'sphere', name: 'Lamp', color: 0xffd45e, r: 0.62, pos: [0, 8.45, 0] },
		{ type: 'cone', name: 'Roof', color: 0xc2452f, r: 1.15, h: 1.2, pos: [0, 9.7, 0] },
		{ type: 'box', name: 'Keeper house', color: 0xe8e2d6, size: [3, 1.8, 2.2], pos: [3.6, 0.9, 1.5] },
		{ type: 'box', name: 'House roof', color: 0x9a4632, size: [3.3, 0.5, 2.5], pos: [3.6, 2.05, 1.5], rot: [0, 0, 0.06] },
		{ type: 'box', name: 'Jetty', color: 0x8a6f52, size: [1.2, 0.25, 5], pos: [-1.5, 0.12, 8.5] }
	]
};
