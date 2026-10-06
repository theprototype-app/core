// Example def `water-works` (36-fb F26) — a closed loop of water on a tabletop diorama: a noria
// (a scoop wheel turned by a Rotate / Motor node) lifts pond water into an elevated head-race,
// the head-race spills into a fountain basin (a pump pipe makes the jet), the basin overflows
// down a chute back into the pond, and leaves and toy boats ride the current (Float Along
// Flow). One Fluid emitter fills it; the flow paths recycle the same particles round and round,
// so the loop costs nothing once it is full. Quest: the water surfaces + animated flow ribbons
// carry it, with the particles capped by the scene's fluid budget.
// Authored by scripts/author-templates.cjs; the def schema is the comment block at its top.

const G = 0.36; // the grass top
const STONE = 0x8d8a82;
const STONE_DARK = 0x6f6c66;
const WOOD = 0x7a5536;
const WOOD_DARK = 0x5a3d26;
const WOOD_LIGHT = 0xa47a52;

/** an open basin of five slabs (floor + walls), inside size [w, h, d], floor ON the grass
 * @param {string} name @param {number[]} c centre (x, z) @param {number[]} size @param {number} color */
function basin(name, c, size, color) {
	const [w, h, d] = size;
	const t = 0.1;
	const y = G + h / 2;
	const slab = (n, pos, s) => ({ type: 'box', name: name + ' ' + n, color, size: s, pos, roughness: 0.92, physics: { mode: 'static' } });
	return [
		slab('floor', [c[0], G + 0.02, c[1]], [w + 2 * t, 0.04, d + 2 * t]),
		slab('wall N', [c[0], y, c[1] - d / 2 - t / 2], [w + 2 * t, h, t]),
		slab('wall S', [c[0], y, c[1] + d / 2 + t / 2], [w + 2 * t, h, t]),
		slab('wall W', [c[0] - w / 2 - t / 2, y, c[1]], [t, h, d]),
		slab('wall E', [c[0] + w / 2 + t / 2, y, c[1]], [t, h, d])
	];
}

/** a U-channel along x: bottom + two sides, `tilt` radians about z @param {string} name @param {number[]} c @param {number} len @param {number} width @param {number} tilt */
function channel(name, c, len, width, tilt) {
	const rot = [0, 0, tilt];
	const off = (dz) => [c[0], c[1] + 0.08, c[2] + dz];
	return [
		{ type: 'box', name: name + ' bed', color: WOOD_LIGHT, size: [len, 0.04, width + 0.06], pos: c, rot, roughness: 0.75, physics: { mode: 'static' } },
		{ type: 'box', name: name + ' side N', color: WOOD, size: [len, 0.17, 0.03], pos: off(-width / 2 - 0.015), rot, roughness: 0.75, physics: { mode: 'static' } },
		{ type: 'box', name: name + ' side S', color: WOOD, size: [len, 0.17, 0.03], pos: off(width / 2 + 0.015), rot, roughness: 0.75, physics: { mode: 'static' } }
	];
}

/** a post from the grass up to `top` @param {string} name @param {number} x @param {number} z @param {number} top */
const post = (name, x, z, top) => ({ type: 'box', name, color: WOOD_DARK, size: [0.08, top - G, 0.08], pos: [x, (top + G) / 2, z], roughness: 0.85, physics: { mode: 'static' } });

/** the noria: hub, rim, eight scoop paddles — one group the motor turns about its local z */
function noria(pos) {
	const children = [
		{ type: 'cylinder', name: 'Noria hub', color: WOOD_DARK, r: 0.12, h: 0.42, pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0], roughness: 0.8 },
		// ONE rim and four full-diameter spokes: the Quest budget is per eye (two eyes ≤ 150 calls)
		{ type: 'torus', name: 'Noria rim', color: WOOD, r: 0.78, tube: 0.04, pos: [0, 0, 0], roughness: 0.8 }
	];
	for (let i = 0; i < 4; i++)
		children.push({ type: 'box', name: 'Noria spoke ' + (i + 1), color: WOOD_DARK, size: [1.56, 0.04, 0.05], pos: [0, 0, 0], rot: [0, 0, (i / 4) * Math.PI], roughness: 0.85 });
	for (let i = 0; i < 8; i++) {
		const a = (i / 8) * Math.PI * 2;
		// a scoop paddle at the rim, standing out along the radius
		children.push({ type: 'box', name: 'Noria paddle ' + (i + 1), color: WOOD, size: [0.26, 0.05, 0.32], pos: [Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0], rot: [0, 0, a], roughness: 0.8 });
	}
	// a sensor: the wheel's box must not be an invisible wall (a group's default collider)
	return { type: 'group', name: 'Noria wheel', pos, children, physics: { mode: 'static', sensor: true } };
}

/** a toy boat: hull + mast + sail @param {string} name @param {number[]} pos @param {number} color */
const boat = (name, pos, color) => ({
	type: 'group', name, pos, fluid: 'none',
	children: [
		{ type: 'box', name: name + ' hull', color, size: [0.26, 0.07, 0.12], pos: [0, 0, 0], roughness: 0.6, bevel: 0.02 },
		{ type: 'box', name: name + ' sail', color: 0xfaf6ea, size: [0.12, 0.16, 0.006], pos: [0.02, 0.12, 0], roughness: 0.9 }
	],
	physics: { mode: 'static', sensor: true }
});
/** a leaf @param {string} name @param {number[]} pos @param {number} color */
const leaf = (name, pos, color) => ({ type: 'sphere', name, color, r: 0.05, pos, scale: [1, 0.18, 0.7], roughness: 0.7, fluid: 'none', physics: { mode: 'static', sensor: true } });

/** a flow graph with one node @param {string} id @param {string} type @param {any} data */
const one = (id, type, data) => ({ nodes: [{ id, type, position: { x: 40, y: 40 }, data, class: 'w-[150px]' }], edges: [] });

/** a tree: trunk + two cones @param {string} name @param {number[]} at (x, z) @param {number} s scale */
const tree = (name, at, s) => [
	{ type: 'cylinder', name: name + ' trunk', color: 0x5c3f28, r: 0.06 * s, h: 0.5 * s, pos: [at[0], G + 0.25 * s, at[1]] },
	{ type: 'cone', name: name + ' crown', color: 0x3f7a3a, r: 0.45 * s, h: 1.3 * s, pos: [at[0], G + 1.05 * s, at[1]], roughness: 0.9 }
];
const rock = (name, pos, r, rot) => ({ type: 'dodecahedron', name, color: STONE_DARK, r, pos, rot, roughness: 0.95, flatShading: true });

module.exports = {
	kind: 'example',
	slug: 'water-works',
	title: 'Water works',
	description:
		'A closed loop of particle water on a diorama: a scoop wheel lifts it, a head-race carries it to a fountain, a chute brings it home — leaves and boats ride along. Fluid emitter, flow paths, Rotate / Motor, Float Along Flow',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['simulation', 'fluid', 'water', 'diorama'],
	env: {
		preset: 'custom',
		base: 'studio',
		exposure: 1,
		background: { top: '#f3dcb8', bottom: '#c3d3dc' },
		sun: { color: '#ffe3bd', intensity: 2.6, dir: [0.55, 0.8, 0.45] },
		hemi: { sky: '#cfe2f2', ground: '#6e5a40', intensity: 0.55 },
		fog: null
	},
	view: { pos: [3.4, 4.4, 6.6], target: [-0.3, 0.8, 0.3] },
	thumb: {
		dress: [
			{ type: 'box', name: 'Card head-race water', color: 0x4a9fd8, size: [2.85, 0.03, 0.3], pos: [-0.2, 1.68, 0.5], roughness: 0.1, opacity: 0.85 },
			{ type: 'box', name: 'Card chute water', color: 0x4a9fd8, size: [1.45, 0.03, 0.24], pos: [0.3, 0.69, 1.4], rot: [0, 0, 0.075], roughness: 0.1, opacity: 0.85 },
			{ type: 'cylinder', name: 'Card fountain jet', color: 0xbfe3fa, r: 0.03, r2: 0.06, h: 0.7, pos: [1.8, 1.25, 0.4], roughness: 0.1, opacity: 0.7 },
			{ type: 'cylinder', name: 'Card waterfall', color: 0x8ccaf2, r: 0.12, r2: 0.16, h: 1.0, pos: [1.38, 1.15, 0.5], roughness: 0.1, opacity: 0.6 }
		]
	},
	objects: [
		// the plinth
		{ type: 'box', name: 'Plinth', color: 0x4e3826, size: [7.2, 0.3, 4.8], pos: [0, 0.15, 0], roughness: 0.75, bevel: 0.04, physics: { mode: 'static' } },
		{ type: 'box', name: 'Grass', color: 0x6f9a4a, size: [7, 0.06, 4.6], pos: [0, G - 0.03, 0], roughness: 0.95, physics: { mode: 'static' } },
		// the pond (low, front left) and its water
		...basin('Pond', [-1.6, 0.9], [2.6, 0.4, 1.6], STONE),
		{ type: 'box', name: 'Pond water', color: 0x3a7fb8, size: [2.6, 0.3, 1.6], pos: [-1.6, G + 0.04 + 0.15, 0.9], water: { preset: 'lake', waves: { amplitude: 0.006 } } },
		// the noria and its frame
		noria([-2.2, 1.22, 0.5]),
		post('Noria post N', -2.2, 0.08, 1.24),
		post('Noria post S', -2.2, 0.92, 1.24),
		// the head-race: an elevated trough from the wheel's top to the fountain basin
		...channel('Head-race', [-0.2, 1.62, 0.5], 2.9, 0.36, 0),
		post('Head-race post 1', -1.3, 0.5, 1.6),
		post('Head-race post 3', 1.0, 0.5, 1.6),
		// the fountain basin (right) with its pedestal
		...basin('Fountain basin', [1.8, 0.4], [1.6, 0.42, 1.6], STONE),
		{ type: 'box', name: 'Fountain water', color: 0x3a8fc0, size: [1.6, 0.25, 1.6], pos: [1.8, G + 0.04 + 0.125, 0.4], water: { preset: 'pool', waves: { amplitude: 0.004 } } },
		{ type: 'cylinder', name: 'Fountain pedestal', color: STONE_DARK, r: 0.12, r2: 0.18, h: 0.5, pos: [1.8, G + 0.25, 0.4], roughness: 0.9, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Fountain bowl', color: STONE, r: 0.22, r2: 0.12, h: 0.08, pos: [1.8, G + 0.54, 0.4], roughness: 0.9, physics: { mode: 'static' } },
		// the chute home: from the basin's front down into the pond
		...channel('Chute', [0.3, 0.64, 1.4], 1.5, 0.28, 0.075),
		// the flow paths (water machinery)
		{ type: 'flowpath', name: 'Noria lift', pos: [0, 0, 0], flowPath: { kind: 'pipe', points: [[-2.0, 0.48, 0.9], [-2.2, 2.05, 0.5], [-1.6, 1.8, 0.5]], width: 1.3, speed: 0.8, show: false } },
		{ type: 'flowpath', name: 'Head-race flow', pos: [0, 0, 0], flowPath: { kind: 'river', points: [[-1.65, 1.69, 0.5], [1.35, 1.69, 0.5]], width: 0.34, depth: 0.1, speed: 1.2, strength: 10, color: '#4a9fd8', opacity: 0.55 } },
		{ type: 'flowpath', name: 'Fountain pump', pos: [0, 0, 0], flowPath: { kind: 'pipe', points: [[2.3, 0.45, -0.1], [1.8, 0.45, 0.4], [1.8, 0.98, 0.4]], width: 0.6, speed: 3.0, show: false } },
		{ type: 'flowpath', name: 'Basin overflow', pos: [0, 0, 0], flowPath: { kind: 'pipe', points: [[1.55, 0.45, 0.85], [1.05, 0.8, 1.4]], width: 0.9, speed: 0.8, show: false } },
		{ type: 'flowpath', name: 'Chute flow', pos: [0, 0, 0], flowPath: { kind: 'river', points: [[1.0, 0.73, 1.4], [-0.45, 0.62, 1.4]], width: 0.26, depth: 0.12, speed: 1.0, strength: 10, color: '#4a9fd8', opacity: 0.55 } },
		{
			type: 'flowpath', name: 'Pond current', pos: [0, 0, 0],
			flowPath: { kind: 'river', points: [[-0.6, 0.66, 1.45], [-2.55, 0.66, 1.45], [-2.6, 0.66, 1.0], [-0.65, 0.66, 1.0], [-0.6, 0.66, 1.4]], width: 0.4, depth: 0.25, speed: 0.35, strength: 2, recycle: true, show: false }
		},
		// the spring that fills it all once (then the paths recycle the same water)
		{
			type: 'fluidemitter', name: 'Spring', pos: [-0.85, 1.02, 0.12], rot: [-0.5, 0, 0],
			fluidEmitter: { rate: 240, speed: 0.8, spread: 6, maxParticles: 2200, lifetime: 120, particleSize: 0.045, joinPools: false, color: '#3f93d6', clarity: 0.65,
				area: { size: [6.4, 2.4, 2.4], offset: [0.8, 0.15, 0.6] } }
		},
		{ type: 'box', name: 'Spring wall', color: STONE, size: [1.1, 0.95, 0.35], pos: [-0.85, G + 0.475, -0.18], bevel: 0.05, roughness: 0.95, physics: { mode: 'static' } },

		// floaters
		boat('Boat red', [-1.4, 0.69, 1.45], 0xc8463a),
		boat('Boat blue', [-2.4, 0.69, 1.0], 0x3d6fb6),
		leaf('Leaf 1', [-1.2, 1.9, 0.5], 0xd99a2b),
		leaf('Leaf 2', [0.6, 1.9, 0.5], 0xb85b2a),
		leaf('Leaf 3', [0.6, 0.71, 1.4], 0x7aa83a),
		// the mill house + dressing
		{ type: 'box', name: 'Mill house', color: 0xe2d4b8, size: [1.4, 1.0, 1.0], pos: [-1.9, G + 0.5, -1.45], roughness: 0.9, physics: { mode: 'static' } },
		{ type: 'block', name: 'Mill roof', shape: 'Wedge', args: [1.6, 0.5, 0.62], color: 0x9a4430, pos: [-1.9, G + 1.0, -1.14], roughness: 0.8 },
		{ type: 'block', name: 'Mill roof back', shape: 'Wedge', args: [1.6, 0.5, 0.62], color: 0x86392a, pos: [-1.9, G + 1.0, -1.76], rot: [0, Math.PI, 0], roughness: 0.8 },
		{ type: 'box', name: 'Mill door', color: 0x4a3020, size: [0.32, 0.55, 0.02], pos: [-1.55, G + 0.275, -0.94] },
		{ type: 'box', name: 'Mill window', color: 0x2e3a44, size: [0.26, 0.22, 0.02], pos: [-2.2, G + 0.62, -0.94], emissive: 0xffc070, emissiveIntensity: 0.5 },
		...tree('Tree 1', [2.7, -1.5], 1.1),
		...tree('Tree 2', [-0.5, -1.7], 0.9),
		{ type: 'sphere', name: 'Bush 1', color: 0x4f8a3e, r: 0.25, pos: [0.6, G + 0.15, -0.9], scale: [1.3, 0.8, 1], roughness: 0.95 },
		rock('Rock 1', [-0.15, G + 0.08, 1.9], 0.14, [0.3, 0.5, 0.1]),
		rock('Rock 2', [-3.15, G + 0.1, 0.1], 0.18, [0.1, 1.2, 0.4]),
		{ type: 'light', kind: 'directional', name: 'Sun', color: 0xffe3bd, intensity: 2.4, pos: [5, 8, 4.5], target: [0, 0.8, 0] }
	],
	graphs: {
		'Noria wheel': one('nr1', 'rotor', { label: 'Rotate / Motor', axis: 'z', rpm: -7, torque: 50, spinUp: 1.5, on: true }),
		'Boat red': one('fb1', 'flowfloat', { label: 'Float Along Flow', speed: 1, bob: 0.012, align: true }),
		'Boat blue': one('fb2', 'flowfloat', { label: 'Float Along Flow', speed: 1, bob: 0.012, align: true }),
		'Leaf 1': one('fl1', 'flowfloat', { label: 'Float Along Flow', speed: 1, bob: 0.005, align: true }),
		'Leaf 2': one('fl2', 'flowfloat', { label: 'Float Along Flow', speed: 1, bob: 0.005, align: true }),
		'Leaf 3': one('fl3', 'flowfloat', { label: 'Float Along Flow', speed: 1, bob: 0.005, align: true })

	}
};
