// Template def `make-a-mirror` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.

const { CONTEST_JUDGING, ALL_TOGETHER } = require('./_contest.cjs');

// The sculpture is CLEARLY HANDED: a staircase that spirals one way, yawed slabs, a cone
// pointing at the line, a flag on one side of its mast, a three-axis-rotated cube and a
// bent spline — so a mirror that only negates x reads wrong at a glance, and the ghost
// (built by the same code with `mirror`) shows what a reflection does to each rotation.
const MIRROR_SCULPTURE = [
	{ type: 'cylinder', name: 'Plinth', color: 0x6b7280, r: 1.3, r2: 1.5, h: 0.4, pos: [-3.2, 0.2, 0.2], roughness: 0.9 },
	{ type: 'box', name: 'Base slab', color: 0xaab2bd, size: [2.6, 0.3, 1.7], pos: [-3.2, 0.55, 0.2], rot: [0, 0.35, 0] },
	{ type: 'box', name: 'Tower', color: 0xd0a070, size: [0.8, 2.6, 0.8], pos: [-3.6, 2.0, 0.5], rot: [0, 0.35, 0] },
	{ type: 'box', name: 'Cantilever', color: 0xa3be8c, size: [2.4, 0.28, 0.5], pos: [-2.2, 3.15, 0.75], rot: [0, 0.1, 0.12] },
	{ type: 'sphere', name: 'Lamp', color: 0xffe08a, r: 0.34, pos: [-1.0, 3.45, 0.85], emissive: 0xffcf50, emissiveIntensity: 0.9, roughness: 0.4 },
	{ type: 'box', name: 'Step 1', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.9, 0.1, 1.6] },
	{ type: 'box', name: 'Step 2', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-5.0, 0.4, 0.7], rot: [0, 0.5, 0] },
	{ type: 'box', name: 'Step 3', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.7, 0.7, -0.2], rot: [0, 1.0, 0] },
	{ type: 'box', name: 'Step 4', color: 0x99a3ae, size: [0.9, 0.2, 0.9], pos: [-4.1, 1.0, -0.9], rot: [0, 1.5, 0] },
	{ type: 'box', name: 'Leaning slab', color: 0xd97706, size: [0.16, 2.2, 1.2], pos: [-1.7, 1.1, -1.5], rot: [0, 0.6, -0.3] },
	{ type: 'cylinder', name: 'Mast', color: 0x4c566a, r: 0.06, h: 3.2, pos: [-5.4, 1.6, -1.3] },
	{ type: 'box', name: 'Flag', color: 0xc2452f, size: [0.8, 0.45, 0.05], pos: [-5.0, 3.0, -1.3] },
	{ type: 'torus', name: 'Ring', color: 0x88c0d0, r: 0.55, tube: 0.09, pos: [-1.7, 2.9, 1.6], rot: [0.6, 0.4, 0] },
	{ type: 'sphere', name: 'Orb A', color: 0xb48ead, r: 0.36, pos: [-1.4, 0.36, 2.0] },
	{ type: 'sphere', name: 'Orb B', color: 0xb48ead, r: 0.26, pos: [-1.4, 0.95, 2.0] },
	{ type: 'sphere', name: 'Orb C', color: 0xb48ead, r: 0.16, pos: [-1.4, 1.35, 2.0] },
	{ type: 'box', name: 'Beam', color: 0x4c566a, size: [0.2, 0.2, 2.8], pos: [-2.5, 1.85, 0.1], rot: [0, -0.4, 0] },
	// a cone lying on its side, tip toward the line (rot z -90 deg): its mirror points back
	{ type: 'cone', name: 'Nose cone', color: 0xebcb8b, r: 0.55, h: 0.9, pos: [-0.9, 0.55, -0.6], rot: [0, 0, -1.5708] },
	{ type: 'cylinder', name: 'Dish', color: 0xe8e2d6, r: 0.75, h: 0.08, pos: [-2.0, 2.5, -1.0], rot: [0.5, 0, 0.3] },
	{ type: 'cylinder', name: 'Pillar A', color: 0x8f99a4, r: 0.15, h: 1.6, pos: [-5.6, 0.8, 1.0] },
	{ type: 'cylinder', name: 'Pillar B', color: 0x8f99a4, r: 0.15, h: 1.2, pos: [-5.6, 0.6, -0.4] },
	{ type: 'box', name: 'Lintel', color: 0x8f99a4, size: [0.3, 0.16, 1.9], pos: [-5.6, 1.65, 0.3], rot: [0.15, 0, 0] },
	{ type: 'box', name: 'Tilted cube', color: 0xbf616a, size: [0.6, 0.6, 0.6], pos: [-3.9, 3.7, 0.4], rot: [0.3, 0.8, 0.2] },
	{ type: 'cylinder', name: 'Antenna', color: 0x2e3440, r: 0.04, h: 1.1, pos: [-3.4, 3.85, 0.7] },
	{ type: 'sphere', name: 'Antenna tip', color: 0xbf616a, r: 0.1, pos: [-3.4, 4.45, 0.7] },
	{ type: 'box', name: 'Ramp', color: 0x94b07e, size: [1.5, 0.12, 0.8], pos: [-1.0, 0.4, 1.0], rot: [0, 0, 0.35] },
	{
		type: 'spline', name: 'Ribbon', color: 0xff7b3d,
		points: [
			{ pos: [-2.7, 0.7, 1.3], radius: 0.09 }, { pos: [-2.1, 1.5, 1.7], radius: 0.085 },
			{ pos: [-1.5, 2.2, 1.2], radius: 0.08 }, { pos: [-1.2, 2.8, 0.4], radius: 0.07 },
			{ pos: [-1.6, 3.4, -0.2], radius: 0.06 }
		]
	}
];

// a real floor grid in objects (the app's own grid is a local pref, so it may be off)
const MIRROR_FLOOR = [
	{ type: 'box', name: 'Floor left', color: 0x7e8a97, size: [8, 0.2, 10], pos: [-4, -0.1, 0], roughness: 0.95 },
	{ type: 'box', name: 'Floor right', color: 0x8b959f, size: [8, 0.2, 10], pos: [4, -0.1, 0], roughness: 0.95 },
	...[-4, -2, 0, 2, 4].map((z) => ({ type: 'box', name: 'Grid line z' + z, color: 0x5d6673, size: [16, 0.03, 0.04], pos: [0, 0.015, z] })),
	...[-6, -4, -2, 2, 4, 6].map((x) => ({ type: 'box', name: 'Grid line x' + x, color: 0x5d6673, size: [0.04, 0.03, 10], pos: [x, 0.015, 0] }))
];

const MIRROR_DEF = {
	kind: 'contest',
	slug: 'make-a-mirror',
	title: 'Make a mirror',
	description:
		'Rebuild the sculpture on the left as its mirror image on the right of the glowing line. The faint ghost is the answer — hide it to test yourself.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['contest', 'primitives', 'co-op'],
	env: { preset: 'studio', exposure: 1 },
	post: {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	// the editor opens on a 3/4 view that shows both halves and the line between them
	view: { pos: [6.5, 5.2, 13], target: [0, 1.6, 0] },
	thumb: { camera: 'Judge' },
	objects: [
		{ type: 'group', name: 'Floor grid', children: MIRROR_FLOOR },
		// the mirror plane: emissive, translucent, at x = 0 exactly
		{ type: 'box', name: 'Mirror plane', color: 0x9ee6ff, size: [0.04, 4.8, 10], pos: [0, 2.4, 0], emissive: 0x4fc3f7, emissiveIntensity: 1.1, opacity: 0.4, roughness: 0.3, shadow: false },
		{ type: 'group', name: 'Sculpture', children: MIRROR_SCULPTURE },
		// THE GHOST: every sculpture piece reflected, 15% opacity, one group so one click
		// hides it. Locks are live session state (lockedObjects), not part of a file —
		// see the PR: the starter cannot ship it locked, only as a single, hide-able group.
		{ type: 'mirror', name: 'Ghost', of: 'Sculpture', opacity: 0.15, prefix: 'Ghost ' },
		{ type: 'camera', name: 'Front', pos: [0, 2.6, 12.5], lookAt: [0, 1.8, 0], fov: 45 },
		{ type: 'camera', name: 'Judge', pos: [7.5, 4.4, 8.8], lookAt: [-0.4, 1.6, 0.2], fov: 42 }
	],
	contest: {
		brief:
			'Build the mirror image of the sculpture on the right side of the glowing line. Use the ' +
			'ghost as a guide, or hide it to test yourself (select the **Ghost** group and hide it). ' +
			'Every piece is a primitive: mirror its position across the line and mind the rotations — ' +
			'a reflection turns a left-handed twist into a right-handed one.\n\n' +
			ALL_TOGETHER +
			'\n\nJudged on accuracy and on what you add: lighting, a look, a motion.',
		rules:
			'- Primitives and your own assets — no duplicating the ghost.\n' +
			'- The **Ghost** group must be hidden or removed in the entry.\n' +
			'- One entry per person (or per co-built session); updates allowed until the contest closes.',
		durationDays: 14,
		opensAfterDays: 0,
		judging: CONTEST_JUDGING,
		credits: []
	}
};

module.exports = MIRROR_DEF;
