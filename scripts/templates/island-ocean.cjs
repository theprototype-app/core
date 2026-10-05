// Template def `island-ocean` (36-water) — a sandy island with palms and a jetty in an open ocean
// (a `plane` water volume: no floor, depth grows without limit), at golden hour. Authored by
// scripts/author-templates.cjs; the schema is the comment block there.

/** a palm: a leaning trunk and a crown of leaves */
function palm(name, x, z, lean, turn) {
	return [
		{
			type: 'cylinder',
			name: name + ' trunk',
			color: 0x8a6a45,
			r: 0.12,
			r2: 0.2,
			h: 4,
			pos: [x, 2.2, z],
			rot: [lean * Math.cos(turn), 0, lean * Math.sin(turn)]
		},
		...[0, 1, 2, 3, 4].map((i) => ({
			type: 'box',
			name: name + ' leaf ' + i,
			color: 0x2f8f3a,
			size: [0.35, 0.05, 2],
			pos: [
				x + Math.sin(turn) * lean * 3.8 + Math.cos((i / 5) * Math.PI * 2) * 0.8,
				4.15,
				z - Math.cos(turn) * lean * 3.8 + Math.sin((i / 5) * Math.PI * 2) * 0.8
			],
			rot: [0.35, (i / 5) * Math.PI * 2, 0]
		}))
	];
}

module.exports = {
	kind: 'example',
	slug: 'island-ocean',
	title: 'Island ocean',
	description:
		'A palm island with a jetty and a boat in an open ocean with rolling waves, at golden hour',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['water', 'showcase'],
	env: {
		preset: 'sunset',
		background: { top: '#2f4c7a', bottom: '#f3a76b' },
		fog: { color: '#e9a477', near: 60, far: 180 },
		sun: { color: '#ffb36b', intensity: 2.2, dir: [-0.6, 0.35, -0.7] },
		hemi: { sky: '#ffd2a1', ground: '#3d3a4a', intensity: 0.9 }
	},
	objects: [
		{
			type: 'box',
			name: 'Ocean',
			color: 0x2a6f8f,
			size: [220, 6, 220],
			pos: [0, -3, 0],
			water: { preset: 'ocean', shape: 'plane', waves: { amplitude: 0.35, wavelength: 14 } }
		},
		{ type: 'cylinder', name: 'Seabed', color: 0xc7b083, r: 40, r2: 60, h: 4, pos: [0, -7, 0] },
		{
			type: 'cylinder',
			name: 'Island sand',
			color: 0xe8d39a,
			r: 7,
			r2: 10,
			h: 2,
			pos: [0, -0.4, 0],
			physics: { mode: 'static' }
		},
		{
			type: 'cylinder',
			name: 'Island grass',
			color: 0x6fae4f,
			r: 4.6,
			r2: 6.4,
			h: 0.6,
			pos: [0, 0.75, -0.4],
			physics: { mode: 'static' }
		},
		{ type: 'dodecahedron', name: 'Rock', color: 0x7b7468, r: 1.1, pos: [-5.5, 0.3, 3.2] },
		...palm('Palm A', -1.5, -1.2, 0.18, 0.6),
		...palm('Palm B', 1.8, 0.6, 0.24, -1.9),
		...palm('Palm C', 0.4, -3, 0.12, 2.6),
		{
			type: 'box',
			name: 'Jetty',
			color: 0x8a6a4a,
			size: [1.4, 0.18, 9],
			pos: [5.8, 0.55, 6.5],
			rot: [0, 0.5, 0]
		},
		{
			type: 'cylinder',
			name: 'Jetty post 1',
			color: 0x5c4532,
			r: 0.12,
			h: 3,
			pos: [7.4, -0.8, 9.2]
		},
		{
			type: 'cylinder',
			name: 'Jetty post 2',
			color: 0x5c4532,
			r: 0.12,
			h: 3,
			pos: [8.6, -0.8, 8.3]
		},
		// 36-fb-water F15: the boat FLOATS — one dynamic body (the hull, a 'hull' collider of its own
		// mesh, a boat's density) carrying the stripe and the mast, so they ride its bobbing
		{
			type: 'box',
			name: 'Boat hull',
			color: 0xf2efe6,
			size: [1.3, 0.55, 3.4],
			bevel: 0.2,
			pos: [10.5, 0.1, 9.5],
			rot: [0, 0.4, 0],
			roughness: 0.5,
			physics: { mode: 'dynamic', mass: 120, collider: 'hull', friction: 0.6, floats: { density: 320 } },
			children: [
				{ type: 'box', name: 'Boat stripe', color: 0x2f6fb0, size: [1.32, 0.12, 3.42], pos: [0, 0.1, 0] },
				{ type: 'cylinder', name: 'Boat mast', color: 0xd8d2c4, r: 0.05, h: 3, pos: [0, 1.7, 0] }
			]
		},
		{ type: 'box', name: 'Hut', color: 0xc99a62, size: [2.2, 1.6, 2], pos: [-2.6, 1.85, 1.6] },
		{ type: 'cone', name: 'Hut roof', color: 0xa77d44, r: 1.9, h: 1.2, pos: [-2.6, 3.25, 1.6] }
	],
	view: { pos: [22, 7, 24], target: [0, 1, 0] },
	// 36-fb-water F15: the boat rides the swell as soon as the island opens
	physics: { simOnLoad: true }
};
