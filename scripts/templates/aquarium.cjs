// Template def `aquarium` (36-water) — one file per template (34 R4 A3). A glass tank of water on a
// stand: sand, rocks, plants, an air stone and five fish swimming loops (Path patrol in each fish's
// own graph). Authored by scripts/author-templates.cjs; the schema is the comment block there.
const { graphBuilder } = require('./_builders.cjs');

// the tank: 4 × 2 × 1.6 m, its floor on the stand top (y 0.9), water to the brim
const TANK = { w: 4, h: 2, d: 1.6, y: 0.9 };
const IN = TANK.y + 0.15; // the sand top

/** a fish: a rounded body, a tail fin and two eyes, facing +Z (Path patrol faces +Z along the path) */
function fish(name, color, size, start, next) {
	const s = size;
	return {
		type: 'group',
		name,
		// start on the path, facing along it (Path patrol takes over in the app)
		pos: start,
		rot: [0, Math.atan2(next[0] - start[0], next[2] - start[2]), 0],
		children: [
			{
				type: 'box',
				name: name + ' body',
				color,
				size: [0.12 * s, 0.16 * s, 0.34 * s],
				bevel: 0.05 * s,
				roughness: 0.45
			},
			{
				type: 'cone',
				name: name + ' tail',
				color,
				r: 0.08 * s,
				h: 0.14 * s,
				pos: [0, 0, -0.22 * s],
				rot: [-Math.PI / 2, 0, 0],
				roughness: 0.5
			},
			{
				type: 'sphere',
				name: name + ' eye L',
				color: 0x101418,
				r: 0.018 * s,
				pos: [0.058 * s, 0.03 * s, 0.1 * s]
			},
			{
				type: 'sphere',
				name: name + ' eye R',
				color: 0x101418,
				r: 0.018 * s,
				pos: [-0.058 * s, 0.03 * s, 0.1 * s]
			}
		]
	};
}

/** a closed loop inside the tank at height y (world points) */
function loop(cx, cz, rx, rz, y, wobble, n = 8) {
	const pts = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		pts.push([cx + Math.cos(a) * rx, y + Math.sin(a * 2) * wobble, cz + Math.sin(a) * rz]);
	}
	return pts;
}

const FISH = [
	{
		name: 'Fish orange',
		color: 0xff8a2a,
		size: 1.1,
		path: loop(0, 0, 1.45, 0.5, IN + 0.75, 0.12),
		speed: 0.45
	},
	{
		name: 'Fish blue',
		color: 0x3a8dff,
		size: 0.9,
		path: loop(0.4, 0.05, 1.1, 0.42, IN + 1.15, 0.1, 10).reverse(),
		speed: 0.55
	},
	{
		name: 'Fish yellow',
		color: 0xffd23a,
		size: 0.8,
		path: loop(-0.6, -0.1, 0.8, 0.35, IN + 0.45, 0.08),
		speed: 0.35
	},
	{
		name: 'Fish red',
		color: 0xe84a5f,
		size: 1.0,
		path: loop(0.7, 0, 0.9, 0.4, IN + 1.35, 0.06, 9),
		speed: 0.4
	},
	{
		name: 'Fish striped',
		color: 0xf2f2f2,
		size: 1.25,
		path: loop(-0.2, 0.1, 1.5, 0.48, IN + 0.95, 0.15, 12).reverse(),
		speed: 0.3
	}
];

/** every fish swims its own loop: one Path patrol node in its own graph (targets its owner) */
const graphs = {};
for (const f of FISH) {
	const g = graphBuilder();
	g.N('swim', 'pathpatrol', 'Swim', 0, 0, { points: f.path, speed: f.speed, mode: 'loop' });
	graphs[f.name] = g.done();
}

module.exports = {
	kind: 'example',
	slug: 'aquarium',
	title: 'Aquarium',
	description:
		'A glass tank of water with fish swimming loops, plants, rocks and bubbles rising from an air stone',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['water', 'showcase'],
	env: { preset: 'daylight', background: { top: '#9cc7e8', bottom: '#e6eef4' }, fog: null },
	objects: [
		{ type: 'box', name: 'Floor', color: 0xb9a68a, size: [12, 0.2, 9], pos: [0, -0.1, 0] },
		{ type: 'box', name: 'Back wall', color: 0xd8d0c4, size: [12, 5, 0.2], pos: [0, 2.5, -2.6] },
		{
			type: 'box',
			name: 'Stand',
			color: 0x5b3d2a,
			size: [TANK.w + 0.3, TANK.y, TANK.d + 0.3],
			pos: [0, TANK.y / 2, 0],
			roughness: 0.6
		},
		{
			type: 'box',
			name: 'Aquarium water',
			color: 0x88c0d0,
			size: [TANK.w, TANK.h, TANK.d],
			pos: [0, TANK.y + TANK.h / 2, 0],
			water: { preset: 'aquarium', bubbles: { spread: 0.08, rate: 6 } }
		},
		{
			type: 'box',
			name: 'Tank rim',
			color: 0x2b2f36,
			size: [TANK.w + 0.08, 0.06, TANK.d + 0.08],
			pos: [0, TANK.y + TANK.h + 0.03, 0],
			roughness: 0.4,
			metalness: 0.4
		},
		{
			type: 'box',
			name: 'Sand',
			color: 0xe3cf9a,
			size: [TANK.w - 0.04, 0.15, TANK.d - 0.04],
			pos: [0, TANK.y + 0.075, 0]
		},
		{
			type: 'dodecahedron',
			name: 'Rock big',
			color: 0x7a7f86,
			r: 0.32,
			pos: [-1.3, IN + 0.18, -0.35]
		},
		{
			type: 'dodecahedron',
			name: 'Rock small',
			color: 0x8d8478,
			r: 0.18,
			pos: [-0.95, IN + 0.1, -0.5]
		},
		{
			type: 'icosahedron',
			name: 'Rock flat',
			color: 0x6b6f75,
			r: 0.22,
			pos: [1.35, IN + 0.08, 0.35]
		},
		{
			type: 'capsule',
			name: 'Plant 1',
			color: 0x2e9b4f,
			r: 0.05,
			h: 0.9,
			pos: [-1.6, IN + 0.5, -0.55],
			rot: [0.08, 0, 0.12]
		},
		{
			type: 'capsule',
			name: 'Plant 2',
			color: 0x3cb85c,
			r: 0.04,
			h: 1.2,
			pos: [-1.45, IN + 0.65, -0.62],
			rot: [-0.06, 0, -0.1]
		},
		{
			type: 'capsule',
			name: 'Plant 3',
			color: 0x27864a,
			r: 0.05,
			h: 0.7,
			pos: [1.6, IN + 0.4, -0.55],
			rot: [0.05, 0, -0.15]
		},
		{
			type: 'cone',
			name: 'Plant 4',
			color: 0x4fbf6a,
			r: 0.12,
			h: 0.8,
			pos: [1.25, IN + 0.4, -0.6]
		},
		{
			type: 'cone',
			name: 'Plant 5',
			color: 0x2e9b4f,
			r: 0.1,
			h: 1.05,
			pos: [0.55, IN + 0.52, -0.62]
		},
		{
			type: 'torus',
			name: 'Coral ring',
			color: 0xff6f91,
			r: 0.14,
			tube: 0.05,
			pos: [0.2, IN + 0.12, 0.45],
			rot: [-Math.PI / 2, 0, 0]
		},
		{
			type: 'cylinder',
			name: 'Air stone',
			color: 0x9aa3ad,
			r: 0.06,
			h: 0.05,
			pos: [-0.5, IN + 0.03, 0.3],
			bubbles: {
				rate: 14,
				count: 60,
				spread: 0.06,
				sizeMin: 0.01,
				sizeMax: 0.03,
				riseSpeed: 0.5,
				wobble: 0.6
			}
		},
		...FISH.map((f) => fish(f.name, f.color, f.size, f.path[0], f.path[1]))
	],
	graphs,
	view: { pos: [3.4, 2.7, 4.6], target: [0, 1.75, 0] }
};
