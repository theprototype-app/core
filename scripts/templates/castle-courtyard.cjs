// Level def `castle-courtyard` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, H, COLLIDERS, TRUNKS, namer, rng, piece, walkGraph, playPhysics, lookPost, DYNAMIC } = require('./_level-kit.cjs');

// ---- 1. Castle Courtyard ---------------------------------------------------------------
//
// A 16 × 20 m walled courtyard: curtain walls on the grid lines x = ±8, z = 6 and z = -14,
// round towers three storeys tall on the two north corners, a rampart terrace (a stone
// platform 3 m up behind the north wall, battlements for a parapet) reached by a staircase
// through an archway, a paved avenue from the gate to the well, a market stall with its
// crates and sacks, and trees on the earth either side. The gate (oak double doors between
// two pillars) is behind you when you spawn; you look north down the avenue.
function castleObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	// curtain walls ------------------------------------------------------------------
	for (const x of [-5, -3, -1, 1, 3, 5]) o.push(piece(A, 'WallStone', n('North wall'), [x, 0, -14]));
	for (const z of [-11, -9, -7, -5, -3, -1, 1, 3, 5]) {
		o.push(piece(A, 'WallStone', n('West wall'), [-8, 0, z], H));
		// the east wall has one DOOR (to a storeroom — the Door leaf is shut)
		if (z === -7) {
			o.push(piece(A, 'WallStoneDoor', 'Storeroom doorway', [8, 0, z], -H, { physics: COLLIDERS.doorway }));
			o.push(piece(A, 'Door', 'Storeroom door', [8, 0, z], -H));
		} else o.push(piece(A, 'WallStone', n('East wall'), [8, 0, z], H));
	}
	for (const x of [-7, -5, -3, -1, 3, 5, 7]) o.push(piece(A, 'WallStone', n('South wall'), [x, 0, 6]));
	// the gate: oak double doors in a 2 m gap, a pillar either side, a battlement over it
	o.push(piece(A, 'Gate', 'Castle gate', [1, 0, 6]));
	o.push(piece(A, 'Pillar', n('Gate pillar'), [0, 0, 6]));
	o.push(piece(A, 'Pillar', n('Gate pillar'), [2, 0, 6]));
	o.push(piece(A, 'CornerPostStone', n('Corner post'), [-8, 0, 6]));
	o.push(piece(A, 'CornerPostStone', n('Corner post'), [8, 0, 6]));
	// battlements along every wall top (the north ones are the rampart's parapet)
	for (const x of [-5, -3, -1, 1, 3, 5]) o.push(piece(A, 'Battlement', n('Battlement'), [x, 3, -14]));
	for (const z of [-11, -9, -7, -5, -3, -1, 1, 3, 5]) {
		o.push(piece(A, 'Battlement', n('Battlement'), [-8, 3, z], H));
		o.push(piece(A, 'Battlement', n('Battlement'), [8, 3, z], H));
	}
	for (const x of [-7, -5, -3, -1, 1, 3, 5, 7]) o.push(piece(A, 'Battlement', n('Battlement'), [x, 3, 6]));
	// two round towers, three storeys, on the north corners
	for (const x of [-8, 8]) for (const y of [0, 3, 6]) o.push(piece(A, 'Tower', n(x < 0 ? 'West tower' : 'East tower'), [x, y, -14]));
	// the rampart: a solid platform 3 m up behind the north wall (three courses of blocks)
	for (const x of [-5, -3, -1, 1, 3, 5]) for (const y of [0, 1, 2]) o.push(piece(A, 'Block', n('Rampart block'), [x, y, -13]));
	// its railing along the courtyard edge — open at x = -5, where the stairs arrive
	for (const x of [-3, -1, 1, 3, 5]) o.push(piece(A, 'Railing', n('Rampart railing'), [x, 3, -12.08]));
	// the staircase up to it, entered through an archway
	o.push(piece(A, 'Stairs', 'Rampart stairs', [-5, 0, -10], 0, { physics: COLLIDERS.stairs }));
	o.push(piece(A, 'Arch', 'Stair archway', [-5, 0, -7], 0, { physics: COLLIDERS.arch }));
	// the avenue: flagstones from the gate to the rampart
	for (const x of [-3, -1, 1, 3]) for (const z of [5, 3, 1, -1, -3, -5, -7, -9, -11]) o.push(piece(A, 'FloorStone', n('Flagstone'), [x, 0, z]));
	// the well in the middle of the avenue
	o.push(piece(P, 'Well', 'Well', [0, 0.1, -4]));
	// the market on the east side, facing the avenue
	o.push(piece(P, 'MarketStall', 'Market stall', [6, 0, -2], -H));
	o.push(piece(P, 'CrateStack', 'Crate stack', [6.4, 0, 1.4], -H));
	o.push(piece(P, 'Crate', n('Crate'), [4.9, 0, 0.9], 0.3, { physics: DYNAMIC(15) }));
	o.push(piece(P, 'CrateTeal', n('Crate'), [5.1, 0, -4.8], -0.2, { physics: DYNAMIC(12) }));
	o.push(piece(P, 'Barrel', n('Barrel'), [6.9, 0, -4.6], 0, { physics: DYNAMIC(30) }));
	o.push(piece(P, 'BarrelSmall', n('Barrel'), [6.3, 0, -5.4], 0, { physics: DYNAMIC(12) }));
	o.push(piece(P, 'Sacks', 'Grain sacks', [6.7, 0, 3.5], -2.4));
	o.push(piece(P, 'Lantern', n('Lantern'), [6.4, 1.05, 1.1], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Signpost', 'Signpost', [3.3, 0, 4.4], -0.5));
	o.push(piece(P, 'Chest', 'Treasure chest', [5, 0, -11], -0.3));
	// wall torches on the inner faces (a wall face is 0.125 off its grid line)
	for (const z of [-9, 3]) o.push(piece(P, 'WallTorch', n('Wall torch'), [7.875, 1.5, z], -H, { physics: COLLIDERS.sensor }));
	for (const z of [-1, -9]) o.push(piece(P, 'WallTorch', n('Wall torch'), [-7.875, 1.5, z], H, { physics: COLLIDERS.sensor }));
	// the west garden: trees, a bench, bushes, flowers on the earth
	o.push(piece(N, 'Oak', 'Courtyard oak', [-6, 0, 3], 0.7, { physics: TRUNKS.Oak }));
	o.push(piece(N, 'Birch', 'Courtyard birch', [-6.2, 0, -3.5], 2.1, { physics: TRUNKS.Birch }));
	o.push(piece(P, 'Bench', 'Garden bench', [-5, 0, 0.2], H));
	for (const [x, z, yaw] of [[-7.1, 0.6, 0.3], [-7.2, -5.6, 1.9], [4.9, 4.9, 0.8]]) o.push(piece(N, 'Bush', n('Bush'), [x, 0, z], yaw));
	for (const [x, z] of [[-4.9, 4.6], [-6.9, -1.4], [4.8, -8.6]]) o.push(piece(N, 'FlowerPatch', n('Flowers'), [x, 0, z], x, { physics: COLLIDERS.sensor }));
	const rand = rng(1701);
	for (let i = 0; i < 14; i++) {
		const west = i % 2 === 0;
		const x = west ? -7.3 + rand() * 2.8 : 4.6 + rand() * 2.8;
		const z = west ? -6 + rand() * 10.5 : -9 + rand() * 13.5;
		o.push(piece(N, i % 3 ? 'GrassTuft' : 'GrassTuftDry', n('Grass'), [x, 0, z], rand() * 6, { physics: COLLIDERS.sensor }));
	}
	// pines outside the walls, so the skyline is not empty
	for (const [x, z, s] of [[-12, -18, 1.1], [-14, -9, 1], [-13, 2, 0.9], [12.5, -19, 1.05], [14, -6, 1.1], [13, 4, 0.95], [-3, -20, 1.2], [4, -21, 1]])
		o.push(piece(N, 'Pine', n('Pine'), [x, 0, z], x * 0.37, { scale: s, physics: TRUNKS.Pine }));
	return o;
}

const CASTLE_DEF = {
	kind: 'template',
	seed: false,
	slug: 'castle-courtyard',
	title: 'Castle Courtyard',
	description:
		'A walled courtyard built from the kits: towers, a gate, a rampart up a stair through an archway, a market stall and a well. Press Play to walk it.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'castle', 'walkable'],
	objects: castleObjects(),
	// a lit afternoon: a high warm sun from the south-west, a blue sky fading to haze, the
	// packed-earth ground, and a far fog so the horizon softens
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#4f86c6', bottom: '#dfe8ee' },
		fog: { color: '#dfe8ee', near: 35, far: 130 },
		ground: { color: '#7a6446', roughness: 0.95 },
		sun: { color: '#fff1d6', intensity: 2.6, dir: [-0.55, 0.62, 0.55] },
		hemi: { sky: '#d3e6ff', ground: '#7a6446', intensity: 1.25 }
	},
	// just inside the gate, looking up the avenue at the well and the rampart
	physics: playPhysics([1, 0.3, 4.6], 0),
	post: lookPost(0.5),
	graphs: { scene: walkGraph() },
	view: { pos: [9.5, 9, 13], target: [0, 2, -5] },
	thumb: {}
};

module.exports = CASTLE_DEF;
