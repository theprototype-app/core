// Template def `aquarium` (36-water; 40 F14-F16) — one file per template (34 R4 A3). A glass tank of
// water on a stand: sand, rocks, coral, plants, an air stone and six reef fish. Authored by
// scripts/author-templates.cjs; the schema is the comment block there.
//
// 40: the fish, the coral and the plants are REAL MODELS from the aquarium-kit pack (Meshy, CC0),
// each drawn through a FALLBACK LOD group: the object itself is the simple primitive model the
// scene always had, and it stays on screen while the pack file loads (or when it cannot be
// reached); the pack model and its LOD files are levels 1..n. The fish swim with core's
// GENERAL-PURPOSE motion nodes, no fish-specific code: clownfish WANDER inside the water volume
// and ORIENT TO VELOCITY, tangs and angelfish FOLLOW PATH loops with banking, and every fish
// carries a BODY WAVE whose beat follows its speed and bends into its turns. Their stand-ins wear
// the thin-film look of the "Fish scales" preset (iridescence), as the pack models do.
const { graphBuilder } = require('./_builders.cjs');

// the tank: 4 × 2 × 1.6 m, its floor on the stand top (y 0.9), water to the brim
const TANK = { w: 4, h: 2, d: 1.6, y: 0.9 };
const IN = TANK.y + 0.15; // the sand top

/** the pack folder of an aquarium-kit item @param {string} item @param {string} file */
const kitFile = (item, file) => 'aquarium-kit/' + item + '/glTF-Binary/' + file;

/**
 * A FALLBACK LOD group block: LOD0 = the object's own primitives (the stand-in), then the pack
 * model (closest), then its LOD files. Thresholds are screen-height shares (lodGroupCore).
 * @param {string} item @param {string} base file name without .glb @param {number} lods LOD files
 * @param {number[]} [sizes] the screen sizes after which each real level gives way to the next
 */
function fallbackLod(item, base, lods, sizes = [0.05, 0.02, 0.008]) {
	const levels = [{ source: 'self', screenSize: 0.9 }, { source: 'pack', ref: kitFile(item, base + '.glb'), screenSize: sizes[0] }];
	for (let i = 1; i <= lods; i++) levels.push({ source: 'pack', ref: kitFile(item, base + '.lod' + i + '.glb'), screenSize: sizes[i] ?? sizes[sizes.length - 1] / (i + 1) });
	return { fallback: true, levels };
}

/** the thin-film look of the "Fish scales" preset, on a stand-in part @param {number|string} color */
const scales = (color) => ({ color, roughness: 0.32, metalness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.25, iridescence: 0.9 });

/**
 * A stand-in fish, nose +Z (what Follow Path / Orient to Velocity / Body Wave expect): a rounded
 * body, a tail fin, a dorsal fin, optional stripes and two eyes — sized to the pack model's body.
 * @param {string} name @param {{body: number[], color: number, fin: number, stripe?: number, stripes?: number[]}} look
 */
function fishParts(name, look) {
	const [w, h, l] = look.body;
	/** @type {any[]} */
	const parts = [
		{ type: 'box', name: name + ' body', size: [w, h, l * 0.78], bevel: Math.min(w, h) * 0.45, ...scales(look.color) },
		{ type: 'cone', name: name + ' tail', r: h * 0.42, h: l * 0.26, pos: [0, 0, -l * 0.42], rot: [-Math.PI / 2, 0, 0], ...scales(look.fin), side: 'double' },
		{ type: 'cone', name: name + ' dorsal', r: w * 0.25, h: h * 0.45, pos: [0, h * 0.55, -l * 0.05], ...scales(look.fin) },
		{ type: 'sphere', name: name + ' eye L', color: 0x101418, r: h * 0.09, pos: [w * 0.45, h * 0.12, l * 0.28] },
		{ type: 'sphere', name: name + ' eye R', color: 0x101418, r: h * 0.09, pos: [-w * 0.45, h * 0.12, l * 0.28] }
	];
	for (const [i, z] of (look.stripes ?? []).entries())
		parts.push({ type: 'box', name: name + ' stripe ' + (i + 1), size: [w * 1.04, h * 1.02, l * 0.06], bevel: Math.min(w, h) * 0.45, pos: [0, 0, z * l], color: look.stripe ?? 0xffffff, roughness: 0.4 });
	return parts;
}

const SPECIES = {
	clown: { item: 'FishClown', file: 'fish-clown', lods: 2, look: { body: [0.13, 0.14, 0.32], color: 0xff7a1a, fin: 0xff9a3a, stripe: 0xfafafa, stripes: [0.22, 0.02, -0.2] } },
	tang: { item: 'FishTang', file: 'fish-tang', lods: 1, look: { body: [0.09, 0.2, 0.42], color: 0x1f5bff, fin: 0xffd23a } },
	angel: { item: 'FishAngel', file: 'fish-angel', lods: 1, look: { body: [0.08, 0.24, 0.42], color: 0x2a3fb8, fin: 0xffc93a, stripe: 0xffd84a, stripes: [0.12, -0.02, -0.16] } }
};

/** a fish object: a top-level group of stand-in parts, its fallback LOD naming the pack model
 * @param {string} name @param {keyof typeof SPECIES} kind @param {number[]} pos @param {number} [yaw] */
function fish(name, kind, pos, yaw = 0) {
	const sp = SPECIES[kind];
	return { type: 'group', name, pos, rot: [0, yaw, 0], children: fishParts(name, sp.look), lod: fallbackLod(sp.item, sp.file, sp.lods) };
}

/** a closed loop inside the tank (world points): an oval at height y, rising and falling */
function loop(cx, cz, rx, rz, y, wobble, n = 8) {
	const pts = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		pts.push([cx + Math.cos(a) * rx, y + Math.sin(a * 2) * wobble, cz + Math.sin(a) * rz]);
	}
	return pts;
}

/** a figure of eight across the tank, dipping at the crossing */
function eight(cx, cz, rx, rz, y, dip, n = 12) {
	const pts = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		pts.push([cx + Math.sin(a) * rx, y - Math.abs(Math.cos(a)) * dip, cz + Math.sin(a * 2) * rz]);
	}
	return pts;
}

const TANG_PATH = loop(0.1, 0.05, 1.45, 0.5, IN + 1.05, 0.15, 10);
const ANGEL_PATH = eight(-0.1, 0, 1.3, 0.42, IN + 1.45, 0.45);

const FISH = [
	{ name: 'Clownfish 1', kind: 'clown', pos: [-0.9, IN + 0.55, 0.2] },
	{ name: 'Clownfish 2', kind: 'clown', pos: [-0.6, IN + 0.45, -0.1] },
	{ name: 'Blue tang 1', kind: 'tang', pos: TANG_PATH[0] },
	{ name: 'Blue tang 2', kind: 'tang', pos: TANG_PATH[5] },
	{ name: 'Angelfish 1', kind: 'angel', pos: ANGEL_PATH[0] },
	{ name: 'Angelfish 2', kind: 'angel', pos: ANGEL_PATH[6] }
];

// every fish's own graph (its owner is the fish): movers, then the followers that read them
const graphs = {};
for (const f of FISH) {
	const g = graphBuilder();
	if (f.kind === 'clown') {
		// clownfish potter about inside the water volume, turning to face where they go
		g.N('wander', 'wander', 'Wander', 0, 0, { area: 'Aquarium water', margin: 0.4, speed: 0.22, seed: 0 });
		g.N('face', 'orientvelocity', 'Orient to Velocity', 0, 160, { turnSpeed: 2.5, bank: 0.6, maxBank: 30, pitch: true, minSpeed: 0.02 });
		g.N('wave', 'bodywave', 'Body Wave', 0, 320, { amplitude: 0.07, wavelength: 1, frequency: 2.2, stiffness: 0.3, falloff: 2, speedGain: 4, ampGain: 1, turnBend: 0.35 });
	} else {
		const tang = f.kind === 'tang';
		g.N('swim', 'followpath', 'Follow Path', 0, 0, {
			points: tang ? TANG_PATH : ANGEL_PATH,
			closed: true,
			smooth: true,
			speed: tang ? 0.42 : 0.3,
			offset: f.name.endsWith('2') ? 0.5 : 0,
			mode: 'loop',
			align: true,
			pitch: true,
			bank: tang ? 0.7 : 0.5,
			maxBank: tang ? 35 : 25
		});
		g.N('wave', 'bodywave', 'Body Wave', 0, 200, {
			amplitude: tang ? 0.06 : 0.05,
			wavelength: tang ? 1 : 1.2,
			frequency: tang ? 1.8 : 1.2,
			stiffness: tang ? 0.35 : 0.45,
			falloff: 2,
			speedGain: 3,
			ampGain: 0.6,
			turnBend: 0.4
		});
	}
	graphs[f.name] = g.done();
}

/** a plant or coral: a top-level group on the sand, its stand-in primitives inside, the pack model
 * as its real level @param {string} name @param {number[]} pos @param {any[]} parts @param {any} lod @param {number} [yaw] */
const planted = (name, pos, parts, lod, yaw = 0) => ({ type: 'group', name, pos, rot: [0, yaw, 0], children: parts, lod });

module.exports = {
	kind: 'example',
	slug: 'aquarium',
	title: 'Aquarium',
	description:
		'A reef tank: clownfish, blue tangs and angelfish swimming with the motion nodes (Follow Path, Wander, Body Wave) among coral, plants and an air stone',
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
		{ type: 'dodecahedron', name: 'Rock big', color: 0x7a7f86, r: 0.32, pos: [-1.3, IN + 0.18, -0.35] },
		{ type: 'dodecahedron', name: 'Rock small', color: 0x8d8478, r: 0.18, pos: [-0.95, IN + 0.1, -0.5] },
		{ type: 'icosahedron', name: 'Rock flat', color: 0x6b6f75, r: 0.22, pos: [1.35, IN + 0.08, 0.35] },
		// the eelgrass along the back glass (was Plants 1-3: capsules)
		planted('Eelgrass 1', [-1.6, IN, -0.5], [{ type: 'capsule', name: 'Eelgrass 1 stand-in', color: 0x2e9b4f, r: 0.05, h: 0.9, pos: [0, 0.5, 0], rot: [0.08, 0, 0.12] }], fallbackLod('PlantEelgrass', 'plant-eelgrass', 0, [0.02])),
		planted('Eelgrass 2', [-1.2, IN, -0.6], [{ type: 'capsule', name: 'Eelgrass 2 stand-in', color: 0x3cb85c, r: 0.04, h: 1.2, pos: [0, 0.65, 0], rot: [-0.06, 0, -0.1] }], fallbackLod('PlantEelgrass', 'plant-eelgrass', 0, [0.02]), 1.3),
		planted('Eelgrass 3', [1.65, IN, -0.5], [{ type: 'capsule', name: 'Eelgrass 3 stand-in', color: 0x27864a, r: 0.05, h: 0.7, pos: [0, 0.4, 0], rot: [0.05, 0, -0.15] }], fallbackLod('PlantEelgrass', 'plant-eelgrass', 0, [0.02]), 2.4),
		// the Amazon swords (was Plants 4-5: cones)
		planted('Amazon sword 1', [1.15, IN, -0.55], [{ type: 'cone', name: 'Amazon sword 1 stand-in', color: 0x4fbf6a, r: 0.12, h: 0.8, pos: [0, 0.4, 0] }], fallbackLod('PlantSword', 'plant-sword', 0, [0.02])),
		planted('Amazon sword 2', [0.45, IN, -0.6], [{ type: 'cone', name: 'Amazon sword 2 stand-in', color: 0x2e9b4f, r: 0.1, h: 1.05, pos: [0, 0.52, 0] }], fallbackLod('PlantSword', 'plant-sword', 0, [0.02]), 0.7),
		// the reef rock arch a fish can swim through (was the torus "Coral ring")
		planted('Coral arch', [0.2, IN, 0.3], [{ type: 'torus', name: 'Coral arch stand-in', color: 0xd9a77e, r: 0.3, tube: 0.1, pos: [0, 0.3, 0] }], fallbackLod('CoralArch', 'coral-arch', 1, [0.04, 0.015])),
		planted('Staghorn coral', [1.0, IN, 0.15], [
			{ type: 'cone', name: 'Staghorn coral stand-in 1', color: 0xf3c9b5, r: 0.06, h: 0.45, pos: [0, 0.22, 0], rot: [0, 0, 0.25] },
			{ type: 'cone', name: 'Staghorn coral stand-in 2', color: 0xf0b3c8, r: 0.05, h: 0.38, pos: [0.08, 0.19, 0.05], rot: [0.2, 0, -0.3] },
			{ type: 'cone', name: 'Staghorn coral stand-in 3', color: 0xf6d6c4, r: 0.05, h: 0.32, pos: [-0.07, 0.16, -0.04], rot: [-0.25, 0, 0.1] }
		], fallbackLod('CoralBranch', 'coral-branch', 0, [0.02])),
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
		...FISH.map((f) => fish(f.name, /** @type {any} */ (f.kind), f.pos))
	],
	graphs,
	view: { pos: [3.4, 2.7, 4.6], target: [0, 1.75, 0] }
};
