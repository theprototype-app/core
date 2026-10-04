// Level def `tavern-interior` — one file per template (34 R4 A3). Built from the kit in ./_level-kit.cjs;
// listed by scripts/level-templates.cjs (LEVEL_DEFS) and authored by scripts/author-templates.cjs.

const { A, N, P, I, TK, X, PI, H, box, COLLIDERS, TRUNKS, namer, piece, walkGraph, playPhysics, lookPost, DYNAMIC, cottage, street } = require('./_level-kit.cjs');

// ---- 3. Tavern Interior (the architecture shell) ---------------------------------------
//
// A two-storey tavern 12 × 10 m on a market street: the HALL (x -6..2) rises the full 6 m with
// a BALCONY along its north wall, the KITCHEN (x 2..6) sits behind a partition and has a LOFT
// above it that opens onto the balcony. An oak staircase climbs the west wall to the balcony.
// 33-scenes: the shell's doors WORK — the front door (DoorWood) and the kitchen door
// (DoorStudded) open with a click in Interact or Play, the street window's shutters close, the
// loft chest and drawers open — and it is furnished from the Interiors kit (a bar counter and
// back-bar under the balcony, a stone fireplace, a tavern table set and a dining set, a
// chandelier, a kitchen run, a double bed and a wardrobe in the loft, teal wainscot). Outside,
// a cobbled street from the Town & Market kit (sidewalks, curbs, a crossing, lamp posts, a
// cart) with two cottages across it. You arrive on the sidewalk, facing the front door.
function tavernObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	const XS = [-5, -3, -1, 1, 3, 5];
	const ZS = [-5, -3, -1, 1, 3];
	// ground floor, ceiling, balcony and loft ------------------------------------------
	for (const x of XS) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Floor'), [x, 0, z]));
	// the hall is open to the roof (its slopes and beams are the ceiling); the loft keeps one
	for (const x of [3, 5]) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Ceiling'), [x, 6, z]));
	for (const x of [-5, -3, -1, 1]) o.push(piece(A, 'FloorWood', n('Balcony'), [x, 3, -5]));
	for (const x of [3, 5]) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Loft'), [x, 3, z]));
	// outer walls, two storeys: sandstone below, plaster above --------------------------
	/** @param {number} y @param {string} solid @param {string} winWall */
	const shell = (y, solid, winWall) => {
		// a window's shutters are its FRONT (+Z): every wall of the shell is turned so its
		// front faces OUT (kit.md: the Window shares its wall's position and rotation)
		for (const x of XS) {
			// north wall z = -6, turned to face -Z
			if (y === 3 && x === -1) {
				o.push(piece(A, winWall, n('Window wall'), [x, y, -6], PI));
				o.push(piece(A, 'Window', n('Window'), [x, y, -6], PI));
			} else o.push(piece(A, solid, n('Wall'), [x, y, -6], PI));
			// south wall z = 4 (the front: the door, and windows)
			if (y === 0 && x === -3) {
				// the doorway takes its jambs-and-lintel collider (the walker comes in from the
				// street now), and the DOOR opens (the Interactive Kit's door + frame)
				o.push(piece(A, 'WallStoneDoor', 'Front doorway', [x, y, 4], 0, { physics: COLLIDERS.doorway }));
				o.push(piece(X, 'DoorWood', 'Front door', [x, y, 4]));
			} else if (y === 0 && x === 1) {
				// the street window: shutters that close (placed open, flat against the wall)
				o.push(piece(A, winWall, n('Window wall'), [x, y, 4]));
				o.push(piece(X, 'Shutters', 'Street window shutters', [x, y, 4]));
			} else if ((y === 0 && x === 5) || (y === 3 && x === -3)) {
				o.push(piece(A, winWall, n('Window wall'), [x, y, 4]));
				o.push(piece(A, 'Window', n('Window'), [x, y, 4]));
			} else o.push(piece(A, solid, n('Wall'), [x, y, 4]));
		}
		for (const z of ZS) {
			if (y === 0 && z === 1) {
				o.push(piece(A, winWall, n('Window wall'), [-6, y, z], -H));
				o.push(piece(A, 'Window', n('Window'), [-6, y, z], -H));
			} else o.push(piece(A, solid, n('Wall'), [-6, y, z], -H));
			if (y === 0 && z === -1) {
				o.push(piece(A, winWall, n('Window wall'), [6, y, z], H));
				o.push(piece(A, 'Window', n('Window'), [6, y, z], H));
			} else o.push(piece(A, solid, n('Wall'), [6, y, z], H));
		}
		for (const [x, z] of [[-6, -6], [6, -6], [-6, 4], [6, 4]]) o.push(piece(A, 'CornerPostStone', n('Corner post'), [x, y, z]));
	};
	shell(0, 'WallStone', 'WallStoneWindow');
	shell(3, 'WallPlaster', 'WallPlasterWindow');
	// the slate roof (33-scenes: the street sees the building now): a gable roof with its ridge
	// along X over the 10 m depth — two rows of slopes a side (2 m run, 1.5 m rise each), a 2 m
	// flat ridge of slate slabs at y 9, and the end walls closed with half walls + gables
	for (const x of XS) {
		o.push(piece(A, 'RoofSlope', n('Roof'), [x, 6, -5], PI));
		o.push(piece(A, 'RoofSlope', n('Roof'), [x, 7.5, -3], PI));
		o.push(piece(A, 'RoofSlope', n('Roof'), [x, 6, 3]));
		o.push(piece(A, 'RoofSlope', n('Roof'), [x, 7.5, 1]));
		o.push(piece(A, 'FloorSlate', n('Ridge'), [x, 8.9, -1]));
	}
	for (const x of [-6, 6]) {
		for (const z of [-3, -1, 1]) o.push(piece(A, 'WallPlasterHalf', n('End wall'), [x, 6, z], H));
		o.push(piece(A, 'WallPlasterHalf', n('End wall'), [x, 7.5, -1], H));
		o.push(piece(A, 'WallPlasterGable', n('Gable'), [x, 6, 3], H));
		o.push(piece(A, 'WallPlasterGable', n('Gable'), [x, 6, -5], -H));
		o.push(piece(A, 'WallPlasterGable', n('Gable'), [x, 7.5, 1], H));
		o.push(piece(A, 'WallPlasterGable', n('Gable'), [x, 7.5, -3], -H));
	}
	o.push(piece(A, 'Chimney', 'Chimney', [-1, 7.6, 1.1]));
	// the partition between hall and kitchen (x = 2): a doorway at z = 1 with a door that opens
	for (const z of ZS) {
		if (z === 1) {
			o.push(piece(A, 'WallPlasterDoor', 'Kitchen doorway', [2, 0, z], H, { physics: COLLIDERS.doorway }));
			o.push(piece(X, 'DoorStudded', 'Kitchen door', [2, 0, z], H));
		} else o.push(piece(A, 'WallPlaster', n('Partition'), [2, 0, z], H));
	}
	// the staircase up the west wall to the balcony, rails along the open edges ----------
	o.push(piece(A, 'StairsWood', 'Balcony stairs', [-5, 0.1, -2], 0, { physics: COLLIDERS.stairs }));
	for (const x of [-3, -1, 1]) o.push(piece(A, 'Railing', n('Balcony railing'), [x, 3.1, -3.92]));
	for (const z of [-3, -1, 1, 3]) o.push(piece(A, 'Railing', n('Loft railing'), [2.08, 3.1, z], H));
	o.push(piece(A, 'Column', n('Column'), [2, 0.1, -4]));
	o.push(piece(A, 'Column', n('Column'), [-2, 0.1, -4]));
	for (const x of [-3, -1, 1]) o.push(piece(A, 'Beam', n('Balcony beam'), [x, 2.7, -4]));
	for (const x of [-5, -3, -1, 1]) o.push(piece(A, 'Beam', n('Ceiling beam'), [x, 5.7, -0.5]));
	// the bar under the balcony (Interiors kit: two counter sections, the back-bar on the north
	// wall's room face — a wall-line piece takes the wall's line and faces into the room) ----
	for (const x of [-2.2, -0.2]) {
		o.push(piece(I, 'BarCounter', n('Bar counter'), [x, 0.1, -3.4]));
		o.push(piece(I, 'BackBar', n('Back-bar'), [x, 0.1, -6]));
	}
	for (const x of [-2.8, -1.7, -0.6, 0.5]) o.push(piece(I, 'BarStool', n('Bar stool'), [x, 0.1, -2.75], x));
	for (const [x, z] of [[-3.75, -5.3], [-3.8, -4.55], [1.4, -5.2]]) o.push(piece(P, 'Barrel', n('Barrel'), [x, 0.1, z], x, { physics: DYNAMIC(30) }));
	o.push(piece(P, 'Candles', n('Candles'), [-1.6, 1.2, -3.4], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Lantern', n('Lantern'), [-0.2, 1.2, -3.4], 0, { physics: COLLIDERS.sensor }));
	for (const x of [-3.6, 1.2]) o.push(piece(I, 'WallSconce', n('Sconce'), [x, 1.75, -6]));
	// the hall: a tavern table set and a dining set, a fireplace on the front wall, a chandelier
	o.push(piece(I, 'TavernTableSet', 'Tavern table', [-2.1, 0.1, 0.9]));
	o.push(piece(I, 'DiningSet', 'Dining table', [0.35, 0.1, -0.7], H));
	o.push(piece(P, 'Candles', n('Candles'), [0.35, 0.88, -0.7], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(I, 'Fireplace', 'Fireplace', [-1, 0.1, 4], PI));
	o.push(piece(I, 'Chandelier', 'Chandelier', [-2, 5.75, -0.5], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(I, 'Plant', n('Plant'), [1.55, 0.1, 3.45]));
	o.push(piece(P, 'PottedPlant', n('Plant'), [-5.3, 0.1, 3.3]));
	o.push(piece(P, 'CrateTeal', n('Crate'), [-4.9, 0.1, 1.9], 0.2, { physics: DYNAMIC(12) }));
	// teal wainscot on the hall's free walls (same line + rotation as the wall's room face).
	// Pass-through: a trim's default collider is its bounding box, which for the DOORWAY trim
	// spans the gap it leaves for the door — the walker stopped at the threshold of an open
	// front door (measured, z 4.22); the wall behind a trim already holds the walker
	const TRIM = { physics: COLLIDERS.sensor };
	for (const x of [-5, 1]) o.push(piece(I, 'Wainscot', n('Wainscot'), [x, 0.1, 4], PI, TRIM));
	o.push(piece(I, 'WainscotDoorway', 'Front wainscot', [-3, 0.1, 4], PI, TRIM));
	for (const z of [1, 3]) o.push(piece(I, 'Wainscot', n('Wainscot'), [-6, 0.1, z], H, TRIM));
	// the kitchen: a counter / range / counter run on the north wall, a long table, stores -----
	o.push(piece(I, 'KitchenCounter', n('Kitchen counter'), [3.0, 0.1, -6]));
	o.push(piece(I, 'Stove', 'Range', [3.95, 0.1, -6]));
	o.push(piece(I, 'KitchenCounter', n('Kitchen counter'), [4.9, 0.1, -6]));
	o.push(piece(I, 'LongTable', 'Kitchen table', [4.1, 0.1, -2.4], H));
	for (const z of [-3.1, -1.7]) o.push(piece(I, 'Stool', n('Kitchen stool'), [3.35, 0.1, z]));
	o.push(piece(I, 'CrateGoods', n('Fruit'), [5.5, 0.1, -4.3], 0.3));
	o.push(piece(P, 'CrateStack', 'Kitchen crates', [4.6, 0.1, 3.2]));
	o.push(piece(P, 'Sacks', 'Kitchen sacks', [5.2, 0.1, 1.4], 1.9));
	o.push(piece(P, 'BarrelSmall', n('Barrel'), [2.6, 0.1, -4.6], 0, { physics: DYNAMIC(10) }));
	// the loft: a double bed and a wardrobe on its walls, a chest and drawers that open -----
	o.push(piece(I, 'DoubleBed', 'Loft bed', [6, 3.1, -4], -H));
	o.push(piece(I, 'Wardrobe', 'Loft wardrobe', [3.2, 3.1, -6]));
	o.push(piece(X, 'Chest', 'Loft chest', [5.3, 3.1, 2.9], -H));
	o.push(piece(X, 'Drawers', 'Loft drawers', [5.625, 3.1, -1.4], -H));
	o.push(piece(P, 'Rug', 'Loft rug', [4.1, 3.1, -0.5], H, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Tapestry', n('Tapestry'), [5.875, 3.9, 0.9], -H, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Tapestry', n('Tapestry'), [-3, 3.9, -5.875], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'PottedPlant', n('Plant'), [1.3, 3.1, -5.3]));
	// the street outside the front (its sidewalk starts at the wall's outer face) ----------
	street(o, n, { x0: -10, x1: 10, z0: 4.125, crossAt: -3 });
	for (const [x, z] of [[-6.5, 5.6], [3.5, 5.6], [-1, 12.7], [8, 12.7]]) o.push(piece(TK, 'LampPost', n('Lamp post'), [x, 0.35, z]));
	for (const x of [-4.1, -1.9]) o.push(piece(P, 'WallTorch', n('Door torch'), [x, 1.6, 4.125], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(TK, 'BarrelCluster', 'Street barrels', [0.6, 0.35, 4.75]));
	o.push(piece(TK, 'FlowerBox', n('Flower box'), [5, 1.0, 4.29]));
	o.push(piece(TK, 'ParkBench', 'Street bench', [2.8, 0.35, 5.3], PI));
	o.push(piece(TK, 'LoadedCart', 'Cart', [6.5, 0.2, 9.4], 0.08));
	// across the street: two cottages, their fronts to the street (shut — scenery)
	// (on the kit's grid: a cottage's centre on even metres, so its walls stand on grid lines)
	cottage(o, n, { at: [-6, 18], yaw: PI, name: 'Cottage A', door: 'shut' });
	cottage(o, n, { at: [4, 18], yaw: PI, name: 'Cottage B', door: 'shut', plaster: false });
	for (const x of [-6, 4]) o.push(piece(TK, 'FlowerBox', n('Flower box'), [x - 1, 1.0, 15.715], PI));
	// trees behind them and at the street's ends, so its ends fade into green, not the void
	for (const [item, x, z, s] of [['Oak', -12, 23, 1], ['Birch', -1, 23, 1], ['Oak', 9, 23, 1.1], ['Pine', -14, 9, 1.1], ['Pine', 14, 8, 1.05], ['Birch', -13, -2, 1], ['Oak', 12, -4, 1]])
		o.push(piece(N, /** @type {string} */ (item), n(/** @type {string} */ (item)), [/** @type {number} */ (x), 0, /** @type {number} */ (z)], /** @type {number} */ (x) * 0.4, { scale: s, physics: TRUNKS[/** @type {string} */ (item)] }));
	// light: the hall and the kitchen (the chandelier and the fire glow carry the rest)
	o.push({ type: 'light', name: 'Hall lamp', pos: [-1.4, 3.6, 0.4], color: 0xffb060, intensity: 16, distance: 16, decay: 2 });
	o.push({ type: 'light', name: 'Kitchen lamp', pos: [4, 2.4, -2.5], color: 0xffb060, intensity: 8, distance: 11, decay: 2 });
	return o;
}

const TAVERN_DEF = {
	kind: 'template',
	seed: false,
	slug: 'tavern-interior',
	title: 'Tavern Interior',
	description:
		'A two-storey tavern on a market street: the doors open, the shutters close, the loft chest lifts its lid. A bar and back-bar, a fireplace, a kitchen and a loft, furnished from the Interiors kit. Press Play and walk in.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'interior', 'walkable', 'doors'],
	objects: tavernObjects(),
	// an early evening: a low warm sun down the street, a warm hemisphere so the corners inside
	// never go black, a haze that swallows the ends of the street
	env: {
		preset: 'sunset',
		exposure: 1.1,
		background: { top: '#3f4a78', bottom: '#f0a766' },
		fog: { color: '#e3a87c', near: 22, far: 60 },
		ground: { color: '#5b5040', roughness: 1 },
		sun: { color: '#ffb06a', intensity: 1.8, dir: [0.7, 0.35, 0.6] },
		hemi: { sky: '#ffd9ae', ground: '#6b5236', intensity: 1.35 }
	},
	// on the road, the tavern's front and its door ahead
	physics: playPhysics([-3, 0.3, 10.4], 0),
	post: lookPost(0.7),
	graphs: { scene: walkGraph() },
	// the card: inside, from the kitchen doorway's corner, down the hall to the bar
	view: { pos: [1.3, 2.3, 3.2], target: [-2.4, 1.2, -2.8] },
	thumb: {}
};

module.exports = TAVERN_DEF;
