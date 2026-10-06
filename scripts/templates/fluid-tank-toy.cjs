// Example def `fluid-tank-toy` (36-sim U2b) — two Fluid tanks: water pouring and draining in a
// loop with floating ducks, and a slow viscous one. Press P and the ducks bob on the fluid.
// Authored by scripts/author-templates.cjs; the def schema is the comment block at its top.

/** a rubber duck: body + head, floats like foam @param {string} name @param {number[]} pos */
const duck = (name, pos) => ({
	type: 'sphere', name, color: 0xf6c934, r: 0.13, pos, roughness: 0.4,
	physics: { mode: 'dynamic', mass: 0.3, collider: 'sphere', restitution: 0.3, floats: { density: 150 } }
});

module.exports = {
	kind: 'example',
	slug: 'fluid-tank-toy',
	title: 'Fluid tank toy',
	description: 'Particle fluid in glass tanks — a pour-and-drain loop with floating ducks, and a slow honey tank. Move a tank to slosh it',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['simulation', 'fluid', 'toy'],
	env: { preset: 'studio', background: { top: '#dfeaf2', bottom: '#c9d7e2' } },
	view: { pos: [0, 2.6, 4.4], target: [0, 0.9, 0] },
	// 36-fb-water F14: a simulation scene runs when it opens (Configure Scene ▸ Start simulation on load)
	physics: { simOnLoad: true },
	// the card is rendered offscreen before any fluid exists (it is each peer's runtime
	// simulation): dress the picture with the two fills, never written into the file
	thumb: {
		dress: [
			{ type: 'box', name: 'Card water', color: 0x2f8fd8, size: [1.52, 0.34, 0.82], pos: [-1, 0.81, 0], roughness: 0.15, opacity: 0.85 },
			{ type: 'box', name: 'Card honey', color: 0xd89a1c, size: [0.82, 0.38, 0.82], pos: [1.4, 0.83, 0], roughness: 0.25, opacity: 0.9 }
		]
	},
	objects: [
		{ type: 'box', name: 'Table', color: 0x8a6a4c, size: [5, 0.12, 2], pos: [0, 0.54, 0], roughness: 0.7, physics: { mode: 'static' } },
		{ type: 'box', name: 'Table leg 1', color: 0x6d5139, size: [0.12, 0.5, 0.12], pos: [-2.3, 0.25, -0.85], physics: { mode: 'static' } },
		{ type: 'box', name: 'Table leg 2', color: 0x6d5139, size: [0.12, 0.5, 0.12], pos: [2.3, 0.25, -0.85], physics: { mode: 'static' } },
		{ type: 'box', name: 'Table leg 3', color: 0x6d5139, size: [0.12, 0.5, 0.12], pos: [-2.3, 0.25, 0.85], physics: { mode: 'static' } },
		{ type: 'box', name: 'Table leg 4', color: 0x6d5139, size: [0.12, 0.5, 0.12], pos: [2.3, 0.25, 0.85], physics: { mode: 'static' } },
		{
			type: 'fluidtank', name: 'Water tank', size: [1.6, 0.9, 0.9], pos: [-1, 1.05, 0],
			fluid: { count: 3000, fill: 0.4, color: '#2f8fd8', clarity: 0.6, emitter: { on: true, rate: 220, speed: 1.6, at: [0.15, 0.95, 0.5], dir: [0.5, -1, 0] }, drain: { on: true, rate: 220, at: [0.88, 0, 0.5], radius: 0.1 } }
		},
		{
			type: 'fluidtank', name: 'Honey tank', size: [0.9, 0.9, 0.9], pos: [1.4, 1.05, 0],
			fluid: { count: 2000, fill: 0.45, viscosity: 0.9, surfaceTension: 1.2, color: '#d89a1c', clarity: 0.35 }
		},
		duck('Duck 1', [-1.3, 1.6, 0.1]),
		duck('Duck 2', [-0.8, 1.7, -0.15]),
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xffffff, intensity: 2, pos: [4, 7, 5], target: [0, 1, 0] }
	]
};
