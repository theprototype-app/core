// Level def `forest-clearing` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, PI, H, COLLIDERS, bridgeCollider, hillCollider, TRUNKS, namer, rng, r3, piece, walkGraph, playPhysics, lookPost, DYNAMIC } = require('./_level-kit.cjs');

// ---- 2. Forest Clearing ----------------------------------------------------------------
//
// A clearing in a ring of trees under a cliff: a stone path runs north from where you stand,
// turns east over a footbridge where a pond narrows, and ends at a small plaster hut built
// from the architecture kit (four walls, a doorway, a window, a slate roof). A mound to the
// west is walkable; logs, a stump, mushrooms, ferns and flowers dress the floor.
function forestObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	// the path north, then east over the bridge to the hut
	for (const z of [4, 2, 0, -2, -4, -6]) o.push(piece(N, 'PathTile', n('Path'), [0, 0, z], 0));
	// the crossing, west to east: a ramp up, the footbridge (turned so its walk runs along X),
	// a ramp down — the Ramp is architecture-kit sandstone squashed to the deck's 0.85 m
	o.push(piece(A, 'Ramp', n('Bridge ramp'), [2, 0, -6], -H, { scale: [1, 0.85, 1], physics: COLLIDERS.ramp(1) }));
	o.push(piece(N, 'Bridge', 'Footbridge', [4, 0, -6], H, { physics: bridgeCollider() }));
	o.push(piece(A, 'Ramp', n('Bridge ramp'), [6, 0, -6], H, { scale: [1, 0.85, 1], physics: COLLIDERS.ramp(1) }));
	o.push(piece(N, 'PathTile', n('Path'), [8, 0, -6], 0));
	// the pond: its body to the north-east, a narrow neck running under the bridge
	o.push(piece(N, 'PondWater', 'Pond', [4.8, 0.02, -10.8], 0.35, { scale: 1.7, physics: COLLIDERS.sensor }));
	o.push(piece(N, 'PondWater', 'Pond neck', [4, 0.025, -6], H, { scale: [1.5, 1, 0.85], physics: COLLIDERS.sensor }));
	for (const [x, z, yaw] of [[1.3, -8.4, 0.2], [7.6, -11.6, 1.2], [2.2, -11.9, 2.4], [6.8, -7.9, 0.9]]) o.push(piece(N, 'Reeds', n('Reeds'), [x, 0, z], yaw, { physics: COLLIDERS.sensor }));
	for (const [x, z, yaw] of [[1.5, -10.5, 0.4], [7.9, -9.6, 2.2], [4.6, -12.7, 1.1]]) o.push(piece(N, 'FlatRock', n('Pond rock'), [x, 0, z], yaw));
	for (const [x, z] of [[1.9, -7.7], [5.4, -12.6], [7.3, -8.3]]) o.push(piece(N, 'RockSmall', n('Pebble'), [x, 0, z], x));
	// the hut: a 4 × 4 m plaster cottage (kit.md's recipe, moved to x 10..14, z -9..-5),
	// its doorway facing the path, a window to the south
	const hx = 10;
	const hz = -9;
	for (const [dx, dz] of [[1, 1], [3, 1], [1, 3], [3, 3]]) o.push(piece(A, 'FloorWood', n('Hut floor'), [hx + dx, 0, hz + dz]));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx + 1, 0, hz]));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx + 3, 0, hz]));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx + 1, 0, hz + 4]));
	o.push(piece(A, 'WallPlasterWindow', 'Hut window wall', [hx + 3, 0, hz + 4]));
	o.push(piece(A, 'Window', 'Hut window', [hx + 3, 0, hz + 4]));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx, 0, hz + 1], H));
	o.push(piece(A, 'WallPlasterDoor', 'Hut doorway', [hx, 0, hz + 3], H, { physics: COLLIDERS.doorway }));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx + 4, 0, hz + 1], H));
	o.push(piece(A, 'WallPlaster', n('Hut wall'), [hx + 4, 0, hz + 3], H));
	for (const [dx, dz] of [[0, 0], [4, 0], [0, 4], [4, 4]]) o.push(piece(A, 'CornerPostStone', n('Hut corner'), [hx + dx, 0, hz + dz]));
	for (const dx of [1, 3]) {
		o.push(piece(A, 'RoofSlope', n('Hut roof'), [hx + dx, 3, hz + 3]));
		o.push(piece(A, 'RoofSlope', n('Hut roof'), [hx + dx, 3, hz + 1], PI));
	}
	for (const dx of [0, 4]) {
		o.push(piece(A, 'WallPlasterGable', n('Hut gable'), [hx + dx, 3, hz + 3], H));
		o.push(piece(A, 'WallPlasterGable', n('Hut gable'), [hx + dx, 3, hz + 1], -H));
	}
	o.push(piece(A, 'Chimney', 'Hut chimney', [hx + 3, 3.7, hz + 1]));
	// inside the hut
	o.push(piece(P, 'Bed', 'Hut bed', [hx + 2.8, 0.1, hz + 1.25], H));
	o.push(piece(P, 'Table', 'Hut table', [hx + 2.9, 0.1, hz + 3], 0, { scale: [0.7, 1, 0.8] }));
	o.push(piece(P, 'Chair', 'Hut chair', [hx + 2.9, 0.1, hz + 2.2], PI));
	o.push(piece(P, 'Rug', 'Hut rug', [hx + 1.6, 0.1, hz + 2.1], 0, { scale: 0.8, physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Lantern', n('Lantern'), [hx + 2.9, 0.88, hz + 3], 0, { physics: COLLIDERS.sensor }));
	o.push({ type: 'light', name: 'Hut lamp', pos: [hx + 2, 2.2, hz + 2], color: 0xffb468, intensity: 6, distance: 8, decay: 2 });
	o.push(piece(P, 'Barrel', n('Barrel'), [hx - 0.8, 0, hz + 1.6], 0, { physics: DYNAMIC(25) }));
	o.push(piece(P, 'Crate', n('Crate'), [hx - 0.9, 0, hz + 0.6], 0.4, { physics: DYNAMIC(15) }));
	// the cliff behind everything, and the walkable mound to the west
	for (const x of [-10, -6, -2, 2, 6, 10]) o.push(piece(N, 'Cliff', n('Cliff'), [x, 0, -19], x > 0 ? PI * 0.02 : 0));
	o.push(piece(N, 'Hill', 'Grassy mound', [-9, 0, -3], 0.4, { physics: hillCollider() }));
	// trees round the clearing
	const trees = [
		['Oak', -6, -9, 1.0], ['OakAutumn', -11, 4, 1.05], ['Pine', -14, -12, 1.1], ['Pine', -4, -15, 1.15], ['Birch', -3.5, -10.5, 1],
		['Pine', 11, -15, 1.1], ['Birch', 8.5, 2.8, 1], ['Oak', 15.5, -3, 1.1], ['DeadTree', -12.5, -6, 1], ['Pine', 16, -10, 1.2],
		['Birch', -8, 7.5, 0.95], ['Pine', 6, 10, 1.1], ['OakAutumn', 13, 5.5, 0.9], ['Pine', -15, 3, 1.05], ['Oak', 2, -15.5, 1.05]
	];
	// an outer ring of pines closes the clearing in (and hides the edge of the world)
	const ring = rng(99);
	for (let i = 0; i < 16; i++) {
		const a = (i / 16) * 2 * PI + ring() * 0.25;
		const r = 20 + ring() * 5;
		trees.push([i % 5 === 2 ? 'Oak' : 'Pine', r3(2 + Math.cos(a) * r), r3(-3 + Math.sin(a) * r), r3(1 + ring() * 0.3)]);
	}
	for (const [item, x, z, s] of trees)
		o.push(piece(N, /** @type {string} */ (item), n(/** @type {string} */ (item)), [/** @type {number} */ (x), 0, /** @type {number} */ (z)], /** @type {number} */ (x) * 0.61, { scale: s, physics: TRUNKS[/** @type {string} */ (item)] }));
	// the floor of the clearing
	o.push(piece(N, 'Log', 'Fallen log', [-3.4, 0, -1.2], 0.45));
	o.push(piece(N, 'Stump', 'Stump', [-4.2, 0, -4.6], 0.8));
	o.push(piece(N, 'Mushrooms', n('Mushrooms'), [-3.3, 0, -5.3], 1.3, { physics: COLLIDERS.sensor }));
	o.push(piece(N, 'Mushrooms', n('Mushrooms'), [-6.8, 0, -7.8], 2.6, { physics: COLLIDERS.sensor }));
	o.push(piece(N, 'BoulderCluster', 'Boulders', [-9.5, 0, -13.5], 0.9));
	o.push(piece(N, 'RockLarge', 'Big rock', [9.5, 0, 0.5], 2.2));
	o.push(piece(N, 'RockMedium', n('Rock'), [-1.8, 0, 7.5], 0.5));
	o.push(piece(P, 'Signpost', 'Signpost', [1.6, 0, -3.4], -0.6));
	o.push(piece(N, 'Stump', 'Seat stump', [-1.9, 0, 1.6], 2.0, { scale: 0.7 }));
	const rand = rng(4242);
	const clear = (/** @type {number} */ x, /** @type {number} */ z) => Math.abs(x) < 1.6 && z > -7.5 && z < 6.5; // the path
	for (let i = 0; i < 16; i++) {
		const a = rand() * 2 * PI;
		const r = 4 + rand() * 9;
		const x = r3(Math.cos(a) * r);
		const z = r3(Math.sin(a) * r * 0.9 - 3);
		if (clear(x, z) || (x > 0.8 && x < 14.5 && z > -13 && z < -3.5) || z < -16) continue; // path, bridge, pond, hut, cliff
		const kind = i % 4 === 0 ? 'Fern' : i % 4 === 1 ? 'Bush' : i % 4 === 2 ? 'FlowerPatch' : 'BushAutumn';
		o.push(piece(N, kind, n(kind), [x, 0, z], rand() * 6, kind === 'FlowerPatch' || kind === 'Fern' ? { physics: COLLIDERS.sensor } : {}));
	}
	for (let i = 0; i < 26; i++) {
		const x = r3(-12 + rand() * 26);
		const z = r3(-14 + rand() * 22);
		if (clear(x, z) || (x > 0.8 && x < 14.5 && z > -13 && z < -3.5) || z < -16) continue;
		o.push(piece(N, i % 4 ? 'GrassTuft' : 'Flowers', n('Grass'), [x, 0, z], rand() * 6, { physics: COLLIDERS.sensor }));
	}
	for (const [x, z, yaw] of [[-2.6, -2.8, 0.2], [2.4, 1.5, 1.4], [-5.5, 2.5, 2.9]]) o.push(piece(N, 'FallenLeaves', n('Leaves'), [x, 0.01, z], yaw, { physics: COLLIDERS.sensor }));
	return o;
}

const FOREST_DEF = {
	kind: 'template',
	seed: false,
	slug: 'forest-clearing',
	title: 'Forest Clearing',
	description:
		'A clearing under a cliff: a stone path, a footbridge over the neck of a pond and a little plaster hut, ringed by oaks, pines and birches. Press Play to walk it.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'nature', 'walkable'],
	objects: forestObjects(),
	// late morning in the woods: a clear sky, a green ground, a warm sun through the trees
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#5d93cf', bottom: '#dfe8e0' },
		// the fog closes in past the tree line, so the flat ground fades into haze instead of
		// ending in a band at the horizon (the Towers finding)
		fog: { color: '#dfe8e0', near: 18, far: 62 },
		ground: { color: '#5f7d3f', roughness: 1 },
		sun: { color: '#fff3d8', intensity: 2.5, dir: [0.45, 0.72, 0.5] },
		hemi: { sky: '#d9ecff', ground: '#5f7d3f', intensity: 1.3 }
	},
	physics: playPhysics([0, 0.35, 5], 0),
	post: lookPost(0.5),
	graphs: { scene: walkGraph() },
	view: { pos: [-6, 7.5, 12], target: [3, 1, -6] },
	thumb: {}
};

module.exports = FOREST_DEF;
