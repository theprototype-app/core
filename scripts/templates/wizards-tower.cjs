// Level def `wizards-tower` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, I, TK, X, AR, PI, H, COLLIDERS, TRUNKS, namer, piece, walkGraph, playPhysics, lookPost, DYNAMIC } = require('./_level-kit.cjs');

// ---- 4. Wizard's Tower ------------------------------------------------------------------
//
// 33-scenes: a three-storey stone tower, 8 × 8 m, on a dusk hillside. Every storey is one room
// and a staircase climbs to the next (they alternate sides, so each floor has a hole on one side
// and a stair on the other): the ALCHEMY LAB on the ground (an alchemist's table, a shelf of
// potions, a cauldron, a crystal ball, a trapdoor to the cellar, a chest, a lever), the STUDY
// above (a rune rug, a lectern with an open spellbook, a desk, an armillary sphere, a chest of
// drawers that opens, shutters that close), the BEDCHAMBER on top (a bed and a wardrobe that
// opens), and a ROOF TERRACE behind battlements with a telescope. A path runs to the door
// (it opens) through a garden gate (it opens). The hero props are the Arcane Study Kit's.
function wizardObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	const P4 = [-3, -1, 1, 3];
	// floors: stone on the ground, oak above, stone on the roof; each skips its stairwell
	/** @param {number} y @param {string} item @param {string} name @param {number[][]} holes */
	const floor = (y, item, name, holes) => {
		for (const x of P4) for (const z of P4) if (!holes.some(([hx, hz]) => hx === x && hz === z)) o.push(piece(A, item, n(name), [x, y, z]));
	};
	floor(0, 'FloorStone', 'Lab floor', []);
	floor(3, 'FloorWood', 'Study floor', [[-3, -1], [-3, 1]]);
	floor(6, 'FloorWood', 'Bedchamber floor', [[3, -1], [3, 1]]);
	floor(9, 'FloorStone', 'Roof', [[-3, -1], [-3, 1]]);
	// three storeys of sandstone walls (fronts out), windows on every side, the door south
	/** @param {number} y @param {Record<string, string>} openings key 'side:pos' -> 'window' | 'shutters' | 'door' */
	const storey = (y, openings) => {
		/** @param {string} key @param {number[]} p @param {number} rot */
		const panel = (key, p, rot) => {
			const kind = openings[key];
			if (kind === 'door') {
				o.push(piece(A, 'WallStoneDoor', 'Tower doorway', p, rot, { physics: COLLIDERS.doorway }));
				o.push(piece(X, 'DoorStudded', 'Tower door', p, rot));
			} else if (kind === 'window' || kind === 'shutters') {
				o.push(piece(A, 'WallStoneWindow', n('Window wall'), p, rot));
				o.push(kind === 'shutters' ? piece(X, 'Shutters', n('Shutters'), p, rot) : piece(A, 'Window', n('Window'), p, rot));
			} else o.push(piece(A, 'WallStone', n('Tower wall'), p, rot));
		};
		for (const x of P4) {
			panel('n:' + x, [x, y, -4], PI);
			panel('s:' + x, [x, y, 4], 0);
		}
		for (const z of P4) {
			panel('w:' + z, [-4, y, z], -H);
			panel('e:' + z, [4, y, z], H);
		}
		for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) o.push(piece(A, 'CornerPostStone', n('Tower corner'), [x, y, z]));
	};
	storey(0, { 's:1': 'door', 'e:-1': 'window', 'w:-3': 'window', 'n:1': 'window' });
	storey(3, { 'n:-1': 'shutters', 'e:1': 'window', 's:-1': 'window', 'w:-3': 'window' });
	storey(6, { 's:-1': 'window', 'w:1': 'window', 'e:-3': 'window', 'n:1': 'window' });
	// battlements round the roof terrace
	for (const x of P4) {
		o.push(piece(A, 'Battlement', n('Battlement'), [x, 9, -4], PI));
		o.push(piece(A, 'Battlement', n('Battlement'), [x, 9, 4]));
	}
	for (const z of P4) {
		o.push(piece(A, 'Battlement', n('Battlement'), [-4, 9, z], -H));
		o.push(piece(A, 'Battlement', n('Battlement'), [4, 9, z], H));
	}
	// the stairs: up the west side to the study, the east side to the bedchamber, the west
	// again to the roof (kit.md: pivot at the centre of the 2 × 4 slot, rising towards -Z)
	o.push(piece(A, 'StairsWood', 'Stairs to the study', [-3, 0.1, 0], 0, { physics: COLLIDERS.stairs }));
	o.push(piece(A, 'StairsWood', 'Stairs to the bedchamber', [3, 3.1, 0], PI, { physics: COLLIDERS.stairs }));
	o.push(piece(A, 'StairsWood', 'Stairs to the roof', [-3, 6.1, 0], 0, { physics: COLLIDERS.stairs }));
	// rails along each stairwell's open side
	o.push(piece(A, 'Railing', n('Stairwell rail'), [-1.92, 3.1, -1], H));
	o.push(piece(A, 'Railing', n('Stairwell rail'), [-1.92, 3.1, 1], H));
	o.push(piece(A, 'Railing', n('Stairwell rail'), [1.92, 6.1, -1], H));
	o.push(piece(A, 'Railing', n('Stairwell rail'), [1.92, 6.1, 1], H));
	o.push(piece(A, 'Railing', n('Stairwell rail'), [-1.92, 9.1, -1], H));
	o.push(piece(A, 'Railing', n('Stairwell rail'), [-1.92, 9.1, 1], H));
	// the ALCHEMY LAB --------------------------------------------------------------------
	o.push(piece(AR, 'AlchemyTable', 'Alchemist’s table', [0.6, 0.1, -3.43]));
	o.push(piece(AR, 'PotionShelf', n('Potion shelf'), [3.655, 0.1, -2.6], -H));
	o.push(piece(P, 'Cauldron', 'Cauldron', [-0.6, 0.1, -0.6], 0.6));
	o.push(piece(I, 'RoundTable', 'Scrying table', [2.5, 0.1, 0.4]));
	o.push(piece(AR, 'CrystalBall', 'Crystal ball', [2.5, 0.86, 0.4]));
	o.push(piece(X, 'Trapdoor', 'Cellar trapdoor', [-0.4, 0.1, 1.9]));
	o.push(piece(X, 'Chest', 'Lab chest', [3.4, 0.1, 2.9], -H));
	o.push(piece(X, 'Lever', 'Lever', [-1.6, 0.1, -3.3]));
	o.push(piece(P, 'Barrel', n('Barrel'), [3.4, 0.1, -0.7], 0.4, { physics: DYNAMIC(30) }));
	for (const [x, z, yaw] of [[-1.6, 3.875, PI], [3.875, 1.6, -H]]) o.push(piece(P, 'WallTorch', n('Wall torch'), [x, 1.55, z], yaw, { physics: COLLIDERS.sensor }));
	// the STUDY ----------------------------------------------------------------------------
	o.push(piece(AR, 'RuneRug', 'Rune rug', [0.3, 3.1, 0.6], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(AR, 'Lectern', 'Lectern', [0.3, 3.1, 0.6], PI * 0.85));
	o.push(piece(I, 'Desk', 'Study desk', [0.2, 3.1, -3.3]));
	o.push(piece(I, 'Stool', n('Stool'), [0.2, 3.1, -2.5]));
	o.push(piece(P, 'Candles', n('Candles'), [0.6, 3.86, -3.3], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(I, 'WallShelfBooks', 'Book shelf', [-1.6, 4.2, -4]));
	o.push(piece(AR, 'Armillary', 'Armillary sphere', [1.6, 3.1, -2.3], 0.4));
	o.push(piece(X, 'Drawers', 'Study drawers', [-0.2, 3.1, 3.625], PI));
	o.push(piece(I, 'Armchair', 'Study armchair', [1.4, 3.1, 2.6], PI * 0.8));
	o.push(piece(P, 'Bookcase', n('Bookcase'), [-1.6, 3.1, 3.55], PI));
	// the BEDCHAMBER -----------------------------------------------------------------------
	o.push(piece(I, 'DoubleBed', 'Wizard’s bed', [-0.4, 6.1, -4]));
	o.push(piece(X, 'Cabinet', 'Wardrobe', [-1.4, 6.1, 3.625], PI));
	o.push(piece(AR, 'PotionShelf', n('Potion shelf'), [0.6, 6.1, 3.655], PI));
	o.push(piece(P, 'Rug', 'Bedchamber rug', [-0.2, 6.1, 0.4], H, { physics: COLLIDERS.sensor }));
	o.push(piece(I, 'Plant', n('Plant'), [1.4, 6.1, -3.4]));
	// the ROOF TERRACE ---------------------------------------------------------------------
	o.push(piece(AR, 'Telescope', 'Telescope', [1.4, 9.1, 1.6], -0.6));
	o.push(piece(P, 'Crate', n('Crate'), [2.9, 9.1, 2.9], 0.3, { physics: DYNAMIC(15) }));
	// outside: torches either side of the door, a banner stirring above it (the Interactive
	// Kit's one AMBIENT piece here: it loops on its own, in Interact and Play only)
	for (const x of [0.1, 1.9]) o.push(piece(P, 'WallTorch', n('Door torch'), [x, 1.6, 4.125], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(X, 'Banner', 'Tower banner', [1, 3.4, 4.125]));
	// a path to the door through a garden gate, a hillside of trees and stones -------------
	for (const z of [5.5, 7.5, 9.5, 11.5]) o.push(piece(N, 'PathTile', n('Path'), [1, 0, z]));
	for (const x of [-5, -3, -1, 3, 5]) o.push(piece(TK, 'Fence', n('Garden fence'), [x, 0, 10.5]));
	o.push(piece(TK, 'FenceGate', 'Garden gate', [1, 0, 10.5]));
	for (const [item, x, z, s] of [['Pine', -8, -5, 1.1], ['Pine', -10, 3, 1], ['DeadTree', 8, -6, 1], ['Oak', 9, 5, 1], ['Pine', 6, -12, 1.15], ['Pine', -6, -12, 1.05], ['Birch', -9, 9, 1], ['Pine', 12, 12, 1.1], ['Pine', -13, -1, 1.1]])
		o.push(piece(N, /** @type {string} */ (item), n(/** @type {string} */ (item)), [/** @type {number} */ (x), 0, /** @type {number} */ (z)], /** @type {number} */ (x) * 0.5, { scale: s, physics: TRUNKS[/** @type {string} */ (item)] }));
	for (const [item, x, z, yaw] of [['RockLarge', -6.5, 6.5, 0.4], ['RockMedium', 6.2, 7.5, 2], ['BoulderCluster', -7, -8, 1.1], ['Stump', 5, 2.5, 0.3]]) o.push(piece(N, /** @type {string} */ (item), n(/** @type {string} */ (item)), [/** @type {number} */ (x), 0, /** @type {number} */ (z)], /** @type {number} */ (yaw)));
	for (const [x, z] of [[-2.8, 6.8], [4.3, 8.4], [-4.2, 8.9], [3.2, 5.6]]) o.push(piece(N, x < 0 ? 'Mushrooms' : 'FlowerPatch', n('Garden'), [x, 0, z], x, { physics: COLLIDERS.sensor }));
	for (const [x, z] of [[-5.5, 5], [6, 4.8], [-2, 12.5], [5, 12]]) o.push(piece(N, 'Bush', n('Bush'), [x, 0, z], z));
	// light: the lab and the study (the crystal ball, the torches and the moon do the rest)
	o.push({ type: 'light', name: 'Lab lamp', pos: [0.8, 2.3, 0], color: 0xffa868, intensity: 9, distance: 10, decay: 2 });
	o.push({ type: 'light', name: 'Study lamp', pos: [0.4, 5.3, 0], color: 0xc9a2ff, intensity: 9, distance: 11, decay: 2 });
	return o;
}

const WIZARD_DEF = {
	kind: 'template',
	seed: false,
	slug: 'wizards-tower',
	title: 'Wizard’s Tower',
	description:
		'A three-storey stone tower at dusk: an alchemy lab with a trapdoor and a chest, a study with a lectern and drawers, a bedchamber, and a roof terrace with a telescope. Doors, lids and shutters open. Press Play and climb it.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'interior', 'walkable', 'doors', 'fantasy'],
	objects: wizardObjects(),
	// dusk: a violet sky over a warm horizon, a low cool moon, a soft haze past the trees
	env: {
		preset: 'sunset',
		exposure: 1.1,
		background: { top: '#2b2752', bottom: '#d09272' },
		fog: { color: '#a98a96', near: 20, far: 60 },
		ground: { color: '#4f6436', roughness: 1 },
		sun: { color: '#c8c4ff', intensity: 1.5, dir: [-0.5, 0.55, 0.65] },
		hemi: { sky: '#cbb8ff', ground: '#4f6436', intensity: 1.3 }
	},
	// on the path, the garden gate and the tower door ahead
	physics: playPhysics([1, 0.3, 13], 0),
	post: lookPost(0.8),
	graphs: { scene: walkGraph() },
	view: { pos: [11, 8, 17], target: [0, 4.5, 0] },
	thumb: {}
};

module.exports = WIZARD_DEF;
