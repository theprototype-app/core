// Level def `market-square` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, I, TK, X, PI, H, box, TRUNKS, namer, piece, walkGraph, playPhysics, lookPost, DYNAMIC, cottage } = require('./_level-kit.cjs');

// ---- 5. Market Town Square ---------------------------------------------------------------
//
// 33-scenes: a paved square in a market town (Town & Market kit + the architecture kit + nature):
// a fountain in the middle, three market stalls with their goods, a well, benches, lamp posts,
// a notice board, banner poles, a clock tower on the corner, a road along the south side with a
// cart, cottages round the edges and trees beyond. The BAKERY on the north side is the one you
// walk into: its door and shutters open, and inside a kitchen run, a table, a chest of drawers.
function marketObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	// the square: flagstones 16 × 16 m on ODD centres, so the fountain in the middle stands on
	// four tiles (town-kit kit.md's plaza) and the square's edges fall on the architecture kit's
	// grid lines (x/z ±8), where the buildings round it stand
	const S8 = [-7, -5, -3, -1, 1, 3, 5, 7];
	for (const x of S8) for (const z of S8) o.push(piece(TK, 'Sidewalk', n('Paving'), [x, 0, z]));
	o.push(piece(TK, 'Fountain', 'Fountain', [0, 0.35, 0]));
	// the road along the south side (curb, cobbles, curb) and a cart on it
	for (let x = -13; x <= 13; x += 2) {
		o.push(piece(TK, 'RoadCurb', n('Curb'), [x, 0, 9], PI));
		o.push(piece(TK, 'Road', n('Road'), [x, 0, 11]));
		o.push(piece(TK, 'RoadCurb', n('Curb'), [x, 0, 13]));
	}
	o.push(piece(TK, 'LoadedCart', 'Cart', [5.5, 0.2, 11.2], 0.05));
	// the market: three stalls on the east side facing the fountain, goods beside them
	for (const z of [-4, -0.6, 2.8]) o.push(piece(TK, 'MarketStall', n('Market stall'), [5.2, 0.35, z], -H));
	o.push(piece(I, 'CrateGoods', n('Fruit'), [6.6, 0.35, -2.3], 0.4));
	o.push(piece(TK, 'SacksBarrel', 'Sacks', [6.5, 0.35, 1.1], -H));
	o.push(piece(TK, 'BarrelCluster', 'Barrels', [6.4, 0.35, 4.9]));
	o.push(piece(TK, 'HayStack', 'Hay', [3.4, 0.35, 6.2], 0.6));
	// loose goods you can pick up and throw (the square's dynamic bodies: a level with none
	// would start no simulation on Play, and the walker only collides while one runs)
	for (const [item, x, z, mass] of [['Crate', 6.9, -5.7, 15], ['CrateTeal', 4.2, -2.2, 12], ['Barrel', 4.1, 4.4, 30], ['BarrelSmall', -3.6, 5.2, 12]])
		o.push(piece(P, /** @type {string} */ (item), n('Goods'), [/** @type {number} */ (x), 0.35, /** @type {number} */ (z)], /** @type {number} */ (x), { physics: DYNAMIC(/** @type {number} */ (mass)) }));
	// the west side: the well, the notice board; benches round the fountain; lamps on the corners
	o.push(piece(TK, 'Well', 'Well', [-4.6, 0.35, 3.6]));
	o.push(piece(TK, 'NoticeBoard', 'Notice board', [-6.2, 0.35, -2.6], H));
	o.push(piece(TK, 'ParkBench', n('Bench'), [0, 0.35, 3.1], PI));
	o.push(piece(TK, 'ParkBench', n('Bench'), [-3.1, 0.35, 0], -H));
	for (const [x, z] of [[-7.4, -7.4], [7.4, -7.4], [-7.4, 7.4], [7.4, 7.4]]) o.push(piece(TK, 'LampPost', n('Lamp post'), [x, 0.35, z]));
	for (const x of [-2.6, 2.6]) o.push(piece(TK, 'BannerPole', n('Banner pole'), [x, 0.35, 7.4]));
	o.push(piece(TK, 'FlowerBoxLong', n('Flowers'), [0.4, 0.35, -7.4]));
	// the BAKERY: a plaster cottage on the north side, its front to the square — the door and the
	// shutters open; inside a kitchen run on the back wall, a table, drawers, a plant
	cottage(o, n, {
		at: [-4, -10],
		yaw: 0,
		name: 'Bakery',
		door: 'open',
		shutters: true,
		inside: (add) => {
			add(I, 'KitchenCounter', n('Bakery counter'), [-1.3, 0.1, -2]);
			add(I, 'Stove', 'Bakery oven', [-0.35, 0.1, -2]);
			add(I, 'KitchenCounter', n('Bakery counter'), [0.6, 0.1, -2]);
			add(I, 'RoundTable', 'Bakery table', [0.6, 0.1, 0.5]);
			add(I, 'Stool', n('Bakery stool'), [1.2, 0.1, 0.9]);
			add(I, 'Stool', n('Bakery stool'), [0.0, 0.1, 0.9]);
			add(X, 'Drawers', 'Bakery drawers', [-1.625, 0.1, 0.4], H);
			add(I, 'CrateGoods', n('Fruit'), [1.5, 0.1, -0.7]);
			add(I, 'Plant', n('Plant'), [-1.55, 0.1, 1.55]);
			add(I, 'Picture', 'Bakery picture', [-2, 1.4, -0.6], H);
		}
	});
	o.push(piece(TK, 'FlowerBox', n('Flower box'), [-3, 1.0, -7.715]));
	// the clock tower on the north-east corner: two storeys of sandstone, the clock top on them
	{
		const cx = 6;
		const cz = -10;
		for (const y of [0, 3]) {
			for (const d of [-1, 1]) {
				o.push(piece(A, y === 0 && d === -1 ? 'WallStoneDoor' : 'WallStone', n('Tower wall'), [cx + d, y, cz + 2]));
				o.push(piece(A, 'WallStone', n('Tower wall'), [cx + d, y, cz - 2], PI));
				o.push(piece(A, 'WallStone', n('Tower wall'), [cx - 2, y, cz + d], -H));
				o.push(piece(A, 'WallStone', n('Tower wall'), [cx + 2, y, cz + d], H));
			}
			for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) o.push(piece(A, 'CornerPostStone', n('Tower corner'), [cx + dx, y, cz + dz]));
		}
		o.push(piece(A, 'Door', 'Tower door', [cx - 1, 0, cz + 2]));
		o.push(piece(TK, 'ClockTowerTop', 'Clock', [cx, 6, cz]));
	}
	// cottages round the square (shut — the scenery that makes it a town)
	cottage(o, n, { at: [-10, -2], yaw: H, name: 'West cottage', door: 'shut', plaster: false });
	cottage(o, n, { at: [-10, 4], yaw: H, name: 'Corner cottage', door: 'shut' });
	cottage(o, n, { at: [10, 2], yaw: -H, name: 'East cottage', door: 'shut' });
	// trees beyond, so the edges of the town fade into green
	for (const [item, x, z, s] of [['Oak', -15, -9, 1.1], ['Pine', -16, 6, 1.1], ['Birch', 15, -6, 1], ['Oak', 16, 8, 1.05], ['Pine', -4, -17, 1.15], ['Pine', 10, -17, 1.1], ['Oak', -12, 16, 1], ['Birch', 12, 16, 1]])
		o.push(piece(N, /** @type {string} */ (item), n(/** @type {string} */ (item)), [/** @type {number} */ (x), 0, /** @type {number} */ (z)], /** @type {number} */ (x) * 0.3, { scale: s, physics: TRUNKS[/** @type {string} */ (item)] }));
	o.push({ type: 'light', name: 'Bakery lamp', pos: [-4, 2.4, -10.2], color: 0xffc080, intensity: 6, distance: 7, decay: 2 });
	return o;
}

const MARKET_DEF = {
	kind: 'template',
	seed: false,
	slug: 'market-square',
	title: 'Market Town Square',
	description:
		'A market square built from the Town & Market kit: a fountain, stalls, a well, a clock tower and cottages round it — and a bakery whose door and shutters open. Press Play to walk it.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'town', 'walkable', 'doors'],
	objects: marketObjects(),
	// a bright morning: a high sun from the south-east, a pale sky, a haze past the town
	env: {
		preset: 'daylight',
		exposure: 1.05,
		background: { top: '#5a8fd0', bottom: '#e3ebef' },
		fog: { color: '#e3ebef', near: 26, far: 80 },
		ground: { color: '#6d7f45', roughness: 1 },
		sun: { color: '#fff1d6', intensity: 2.5, dir: [0.5, 0.7, 0.45] },
		hemi: { sky: '#d3e6ff', ground: '#6d7f45', intensity: 1.25 }
	},
	// on the south side of the square, the fountain and the bakery ahead
	physics: playPhysics([0, 0.45, 6.3], 0),
	post: lookPost(0.5),
	graphs: { scene: walkGraph() },
	view: { pos: [16, 11.5, 19], target: [0, 2.6, -3] },
	thumb: {}
};

module.exports = MARKET_DEF;
