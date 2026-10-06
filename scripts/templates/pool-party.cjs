// Template def `pool-party` (36-water) — a sunny deck around a pool with floating toys. The toys are
// dynamic bodies sitting on the surface: with 1.22's buoyancy (36-sim) they bob and drift when the
// simulation runs. Authored by scripts/author-templates.cjs; the schema is the comment block there.
const POOL = { w: 8, h: 1.6, d: 5 };
const LEVEL = 0; // the water surface sits at deck height
const toy = (mass) => ({ mode: 'dynamic', mass, restitution: 0.5, friction: 0.4 });

module.exports = {
	kind: 'example',
	slug: 'pool-party',
	title: 'Pool party',
	description: 'A pool on a sunny deck with a beach ball, rings and a lilo floating on the water',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['water', 'physics', 'showcase'],
	env: {
		preset: 'daylight',
		background: { top: '#6fb2ec', bottom: '#d9ecf9' },
		fog: null,
		sun: { color: '#fff2d6', intensity: 2.6, dir: [0.5, 1, 0.35] }
	},
	objects: [
		// the deck: four slabs around the pool cut-out (top at y 0)
		{
			type: 'box',
			name: 'Deck north',
			color: 0xd9c9a8,
			size: [16, 0.3, 4],
			pos: [0, -0.15, -(POOL.d / 2 + 2)]
		},
		{
			type: 'box',
			name: 'Deck south',
			color: 0xd9c9a8,
			size: [16, 0.3, 4],
			pos: [0, -0.15, POOL.d / 2 + 2]
		},
		{
			type: 'box',
			name: 'Deck west',
			color: 0xd9c9a8,
			size: [4, 0.3, POOL.d],
			pos: [-(POOL.w / 2 + 2), -0.15, 0]
		},
		{
			type: 'box',
			name: 'Deck east',
			color: 0xd9c9a8,
			size: [4, 0.3, POOL.d],
			pos: [POOL.w / 2 + 2, -0.15, 0]
		},
		{
			type: 'box',
			name: 'Pool floor',
			color: 0x5fb8d6,
			size: [POOL.w, 0.2, POOL.d],
			pos: [0, LEVEL - POOL.h - 0.1, 0],
			physics: { mode: 'static' }
		},
		{
			type: 'box',
			name: 'Pool wall N',
			color: 0xf2f6f8,
			size: [POOL.w, POOL.h, 0.2],
			pos: [0, LEVEL - POOL.h / 2, -POOL.d / 2 - 0.1],
			physics: { mode: 'static' }
		},
		{
			type: 'box',
			name: 'Pool wall S',
			color: 0xf2f6f8,
			size: [POOL.w, POOL.h, 0.2],
			pos: [0, LEVEL - POOL.h / 2, POOL.d / 2 + 0.1],
			physics: { mode: 'static' }
		},
		{
			type: 'box',
			name: 'Pool wall W',
			color: 0xf2f6f8,
			size: [0.2, POOL.h, POOL.d + 0.4],
			pos: [-POOL.w / 2 - 0.1, LEVEL - POOL.h / 2, 0],
			physics: { mode: 'static' }
		},
		{
			type: 'box',
			name: 'Pool wall E',
			color: 0xf2f6f8,
			size: [0.2, POOL.h, POOL.d + 0.4],
			pos: [POOL.w / 2 + 0.1, LEVEL - POOL.h / 2, 0],
			physics: { mode: 'static' }
		},
		{
			type: 'box',
			name: 'Pool water',
			color: 0x6cc7e0,
			size: [POOL.w, POOL.h, POOL.d],
			pos: [0, LEVEL - POOL.h / 2, 0],
			water: { preset: 'pool', waves: { amplitude: 0.02 }, look: { caustics: 0.9 } }
		},
		// floating toys (dynamic; buoyancy lifts them once the sim runs)
		{
			type: 'sphere',
			name: 'Beach ball',
			color: 0xff4f4f,
			r: 0.35,
			pos: [-1.6, LEVEL + 0.2, 0.6],
			physics: toy(0.3),
			roughness: 0.4
		},
		{
			type: 'torus',
			name: 'Swim ring red',
			color: 0xff5a36,
			r: 0.45,
			tube: 0.16,
			pos: [1.4, LEVEL + 0.02, -0.8],
			rot: [-Math.PI / 2, 0, 0],
			physics: toy(0.5),
			roughness: 0.35
		},
		{
			type: 'torus',
			name: 'Swim ring yellow',
			color: 0xffd23a,
			r: 0.4,
			tube: 0.14,
			pos: [2.6, LEVEL + 0.02, 1.1],
			rot: [-Math.PI / 2, 0, 0],
			physics: toy(0.4),
			roughness: 0.35
		},
		{
			type: 'box',
			name: 'Lilo',
			color: 0x3ab0ff,
			size: [0.8, 0.18, 1.9],
			bevel: 0.08,
			pos: [-0.2, LEVEL + 0.05, -1.2],
			rot: [0, 0.4, 0],
			physics: toy(1.5),
			roughness: 0.35
		},
		{
			type: 'box',
			name: 'Rubber duck',
			color: 0xffe14a,
			size: [0.3, 0.26, 0.36],
			bevel: 0.1,
			pos: [0.9, LEVEL + 0.1, 1.5],
			physics: toy(0.2),
			roughness: 0.4
		},
		// deck furniture
		{
			type: 'box',
			name: 'Lounger 1',
			color: 0xffffff,
			size: [0.8, 0.35, 2],
			pos: [-4, 0.18, 4.8],
			rot: [0, 0.15, 0]
		},
		{
			type: 'box',
			name: 'Lounger 2',
			color: 0xffffff,
			size: [0.8, 0.35, 2],
			pos: [-2.6, 0.18, 4.9],
			rot: [0, -0.1, 0]
		},
		{
			type: 'cylinder',
			name: 'Umbrella pole',
			color: 0xdddddd,
			r: 0.04,
			h: 2.6,
			pos: [-3.3, 1.3, 6.1]
		},
		{ type: 'cone', name: 'Umbrella', color: 0xff6b6b, r: 1.5, h: 0.6, pos: [-3.3, 2.75, 6.1] },
		{
			type: 'box',
			name: 'Diving board',
			color: 0x2f77d1,
			size: [0.7, 0.1, 2.2],
			pos: [0, 0.6, -(POOL.d / 2 + 0.6)]
		},
		{
			type: 'box',
			name: 'Board stand',
			color: 0xcfd6dd,
			size: [0.5, 0.6, 0.5],
			pos: [0, 0.3, -(POOL.d / 2 + 1.4)]
		}
	],
	view: { pos: [7.5, 5.2, 9], target: [0, -0.3, 0] },
	// 36-fb-water F14: a simulation scene runs when it opens (Configure Scene ▸ Start simulation on load)
	physics: { simOnLoad: true }
};
