// 30c level design — three GENERAL-tab templates built from the round-3 kits (the
// Modular Architecture Kit, Nature & Terrain, Props & Interiors), authored by
// author-templates.cjs through its `kit` object type (a pack piece as a REFERENCE — core
// src/lib/packRefs.js — so a level of ~150 pieces is a ~100 KB file whose bytes come from
// the pack CDN).
//
// Every level is a PLAYABLE walk: a Character Controller node in walk mode, the simulation
// starting on Play (the walker only collides while a world exists — charController.js), a
// spawn point (scenePhysics play.spawn), and colliders that match the pieces: walls and
// props keep their measured box, and the pieces a box gets wrong take CUSTOM compound
// shapes — a doorway is two jambs and a lintel, a staircase a wedge, a tree its trunk, a
// footbridge its deck and rails. Grass, flowers, rugs and water are sensors (pass-through).
//
// THE GRID (kit.md): walls stand ON grid lines, centred on them, pivot bottom-centre, 2 m
// long; floor tiles fill the 2 × 2 cells; storeys are 3 m. Every position below is on that
// grid unless it is a prop.
//
// Numbers the colliders use were MEASURED from the shipped GLBs (see the handover's
// probe): the arch opening, the footbridge deck profile, the tree trunks, the mound.

const A = 'architecture-kit';
const N = 'nature-kit';
const P = 'props-kit';
const PI = Math.PI;
const H = PI / 2;

// ---- colliders ------------------------------------------------------------------------

/** A custom compound collider from convex pieces, each a flat vertex list (object-local,
 * the root's pivot). @param {number[][][]} pieces each a list of [x,y,z] */
function compound(pieces, extra = {}) {
	/** @type {number[]} */
	const verts = [];
	/** @type {number[][]} */
	const ranges = [];
	for (const piece of pieces) {
		ranges.push([verts.length, piece.length * 3]);
		for (const v of piece) verts.push(...v.map((n) => Math.round(n * 1000) / 1000));
	}
	if (verts.length > 1200) throw new Error('collider over the 1200-float cap: ' + verts.length);
	return { mode: 'static', collider: 'custom', colliderVerts: verts, colliderPieces: ranges, ...extra };
}

/** the 8 corners of an axis-aligned box @param {number[]} min @param {number[]} max */
function box(min, max) {
	const out = [];
	for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
	return out;
}

/** a ramp rising toward -Z from `z0` (low, y0) to `z1` (high, y1), `w` wide
 * @param {number} w @param {number} z0 @param {number} z1 @param {number} y0 @param {number} y1 */
function wedge(w, z0, z1, y0, y1) {
	const x = w / 2;
	return [
		[-x, y0, z0],
		[x, y0, z0],
		[-x, y0, z1],
		[x, y0, z1],
		[-x, y1, z1],
		[x, y1, z1]
	];
}

const COLLIDERS = {
	// the Arch: 2 × 3 × 0.5, its opening MEASURED at ±0.408 m and 2.05 m high — two jambs
	// and a lintel, so the walker passes through the opening and not the stone. The jambs sit
	// 6 cm INSIDE the stone: the 0.82 m opening leaves a 0.3 m capsule 11 cm a side, and a walk
	// that grazed a jamb corner slid off it and stopped (measured, 1 run in 2); the eye walks the
	// centre line, so nothing visibly clips
	arch: compound([box([-1, 0, -0.25], [-0.47, 3, 0.25]), box([0.47, 0, -0.25], [1, 3, 0.25]), box([-1, 2.05, -0.25], [1, 3, 0.25])]),
	// a doorway wall: kit.md's exact 1.0 × 2.2 m opening, centred, in a 0.25 m wall
	doorway: compound([box([-1, 0, -0.125], [-0.5, 3, 0.125]), box([0.5, 0, -0.125], [1, 3, 0.125]), box([-1, 2.2, -0.125], [1, 3, 0.125])]),
	// Stairs (2 × 3 × 4, bottom step at +Z): a wedge 36.9° — under the walker's 50° climb
	stairs: compound([wedge(2, 2, -2, 0, 3)]),
	/** a trunk: a square column of half-width r about (cx, cz), h tall — the canopy stays
	 * walk-under @param {number} r @param {number} [cx] @param {number} [cz] @param {number} [h] */
	trunk: (r, cx = 0, cz = 0, h = 3) => compound([box([cx - r, 0, cz - r], [cx + r, h, cz + r])]),
	/** a sandstone Ramp (2 × 1 × 2, low edge at +Z) squashed to `rise` metres */
	ramp: (/** @type {number} */ rise) => compound([wedge(2, 1, -1, 0, rise)]),
	sensor: { sensor: true }
};

// the footbridge, MEASURED (the GLB's own vertices): it is walked along its LOCAL Z (2 m),
// its deck a flat 0.85 m up across |x| < 1.45, and its posts and rails fill 1.45 < |x| < 2
// up to 2.06 m. The deck has no approach of its own (a 0.85 m step either end), so the level
// kitbashes a squashed sandstone Ramp onto each end.
const BRIDGE_DECK = { deckY: 0.85, halfW: 1.45, railY: 2.06 };
function bridgeCollider() {
	const d = BRIDGE_DECK;
	return compound([
		box([-d.halfW, 0, -1], [d.halfW, d.deckY, 1]),
		box([-2, 0, -1], [-d.halfW, d.railY, 1]),
		box([d.halfW, 0, -1], [2, d.railY, 1])
	]);
}

// the grassy mound (8 × 1.2 × 8): its convex hull, from MEASURED rings of (radius, height)
// (its mesh ends in a 0.37 m lip, over the walker's 0.3 m step, so the hull's foot runs out
// to 4.3 m at ground level: a 31° slope where the lip is)
const HILL_RINGS = [
	[0, 1.2],
	[1.5, 1.15],
	[2, 1.01],
	[2.5, 0.85],
	[3, 0.68],
	[3.5, 0.49]
];
function hillCollider() {
	/** @type {number[][]} */
	const verts = [];
	for (const [r, y] of HILL_RINGS) {
		if (r === 0) {
			verts.push([0, y, 0]);
			continue;
		}
		for (let i = 0; i < 12; i++) verts.push([Math.cos((i / 12) * 2 * PI) * r, y, Math.sin((i / 12) * 2 * PI) * r]);
	}
	verts.push(...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => [Math.cos((i / 12) * 2 * PI) * 4.3, 0, Math.sin((i / 12) * 2 * PI) * 4.3]));
	return compound([verts]);
}

// the trunks, MEASURED between 0.3 and 1.2 m up (radius about the trunk's own centre, which
// is off the pivot on the pine, the birch and the dead tree); the oak's reading includes its
// root flare, so it takes the trunk proper
/** @type {Record<string, any>} */
const TRUNKS = {
	Oak: COLLIDERS.trunk(0.6, -0.05, 0.04),
	OakAutumn: COLLIDERS.trunk(0.6, -0.05, 0.04),
	Pine: COLLIDERS.trunk(0.4, -0.24, -0.14),
	Birch: COLLIDERS.trunk(0.25, 0.01, -0.24),
	DeadTree: COLLIDERS.trunk(0.4, 0.36, 0.5)
};

// ---- helpers --------------------------------------------------------------------------

/** a counter per name prefix, so every object has a unique readable name */
function namer() {
	/** @type {Record<string, number>} */
	const seen = {};
	return (/** @type {string} */ base) => {
		seen[base] = (seen[base] ?? 0) + 1;
		return base + ' ' + seen[base];
	};
}

/** a deterministic PRNG (mulberry32), so a re-author is byte-stable @param {number} seed */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const r3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/** one kit piece @param {string} pack @param {string} item @param {string} name
 * @param {number[]} pos @param {number} [yaw] @param {any} [extra] */
function piece(pack, item, name, pos, yaw = 0, extra = {}) {
	return { type: 'kit', pack, item, name, pos: pos.map(r3), ...(yaw ? { rot: [0, r3(yaw), 0] } : {}), ...extra };
}

/** the walk: ONE Character Controller node in walk mode — the whole of a level's logic */
function walkGraph() {
	return {
		nodes: [
			{
				id: 'walk',
				type: 'charcontroller',
				position: { x: 40, y: 40 },
				data: { label: 'Character Controller', mode: 'walk', speed: 0.08, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true },
				class: 'w-[150px]'
			}
		],
		edges: []
	};
}

/** the shared play physics: ground on, respawn below, grab props, the sim starts on Play so
 * the walker has a world to collide with; `spawn` = where desktop play starts */
function playPhysics(/** @type {number[]} */ spawn, /** @type {number} */ yaw) {
	return {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -20, action: 'respawn' },
		damping: { linear: 0.1, angular: 0.4 },
		play: { interaction: 'grab', grounded: false, simOnPlay: true, spawn: { position: spawn, yaw } }
	};
}

/** the house look: AO, AgX, a soft bloom (flames, lanterns), SMAA */
function lookPost(bloom = 0.6) {
	return {
		enabled: true,
		effects: [
			{ id: 'ao', kind: 'ao', enabled: true, params: {} },
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: bloom, luminanceThreshold: 0.85 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	};
}

const DYNAMIC = (/** @type {number} */ mass) => ({ mode: 'dynamic', mass });

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
	view: { position: [9.5, 9, 13], target: [0, 2, -5] },
	thumb: {}
};

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
	view: { position: [-6, 7.5, 12], target: [3, 1, -6] },
	thumb: {}
};

// ---- 3. Tavern Interior ----------------------------------------------------------------
//
// A two-storey room 12 × 10 m: the HALL (x -6..2) rises the full 6 m with a BALCONY along its
// north wall, the KITCHEN (x 2..6) sits behind a partition with a doorway and has a LOFT above
// it that opens onto the balcony. An oak staircase climbs the west wall to the balcony; a bar
// runs under it; tables, benches, barrels and a hearth fill the rooms, and lanterns and wall
// torches light it warm. The front door is shut: you are inside.
function tavernObjects() {
	const n = namer();
	/** @type {any[]} */
	const o = [];
	const XS = [-5, -3, -1, 1, 3, 5];
	const ZS = [-5, -3, -1, 1, 3];
	// ground floor, ceiling, balcony and loft ------------------------------------------
	for (const x of XS) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Floor'), [x, 0, z]));
	for (const x of XS) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Ceiling'), [x, 6, z]));
	for (const x of [-5, -3, -1, 1]) o.push(piece(A, 'FloorWood', n('Balcony'), [x, 3, -5]));
	for (const x of [3, 5]) for (const z of ZS) o.push(piece(A, 'FloorWood', n('Loft'), [x, 3, z]));
	// outer walls, two storeys: sandstone below, plaster above --------------------------
	/** @param {number} y @param {string} solid @param {string} win @param {string} winWall */
	const shell = (y, solid, win, winWall) => {
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
				o.push(piece(A, 'WallStoneDoor', 'Front doorway', [x, y, 4]));
				o.push(piece(A, 'Door', 'Front door', [x, y, 4]));
			} else if ((y === 0 && (x === 1 || x === 5)) || (y === 3 && x === -3)) {
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
	shell(0, 'WallStone', 'Window', 'WallStoneWindow');
	shell(3, 'WallPlaster', 'Window', 'WallPlasterWindow');
	// the partition between hall and kitchen (x = 2), a doorway at z = 1 --------------------
	for (const z of ZS) {
		if (z === 1) o.push(piece(A, 'WallPlasterDoor', 'Kitchen doorway', [2, 0, z], H, { physics: COLLIDERS.doorway }));
		else o.push(piece(A, 'WallPlaster', n('Partition'), [2, 0, z], H));
	}
	// the staircase up the west wall to the balcony, rails along the open edges ----------
	o.push(piece(A, 'StairsWood', 'Balcony stairs', [-5, 0.1, -2], 0, { physics: COLLIDERS.stairs }));
	for (const x of [-3, -1, 1]) o.push(piece(A, 'Railing', n('Balcony railing'), [x, 3.1, -3.92]));
	for (const z of [-3, -1, 1, 3]) o.push(piece(A, 'Railing', n('Loft railing'), [2.08, 3.1, z], H));
	o.push(piece(A, 'Column', n('Column'), [2, 0.1, -4]));
	o.push(piece(A, 'Column', n('Column'), [-2, 0.1, -4]));
	for (const x of [-3, -1, 1]) o.push(piece(A, 'Beam', n('Balcony beam'), [x, 2.7, -4]));
	for (const x of [-5, -3, -1, 1]) o.push(piece(A, 'Beam', n('Ceiling beam'), [x, 5.7, -0.5]));
	// the bar, under the balcony: half walls (scaled to counter height) with a trim top --
	for (const x of [-2.2, -0.2]) {
		o.push(piece(A, 'WallStoneHalf', n('Bar'), [x, 0.1, -2.6], 0, { scale: [1, 0.72, 1] }));
		o.push(piece(A, 'Trim', n('Bar top'), [x, 1.18, -2.6]));
	}
	o.push(piece(P, 'Bookcase', n('Shelf'), [-1.2, 0.1, -5.5]));
	o.push(piece(P, 'Bookcase', n('Shelf'), [0.4, 0.1, -5.5]));
	for (const [x, z] of [[-3.4, -5.2], [-3.6, -4.4], [1.4, -5.2]]) o.push(piece(P, 'Barrel', n('Barrel'), [x, 0.1, z], x, { physics: DYNAMIC(30) }));
	o.push(piece(P, 'Candles', n('Candles'), [-1.6, 1.38, -2.6], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Lantern', n('Lantern'), [-0.2, 1.38, -2.6], 0, { physics: COLLIDERS.sensor }));
	for (const x of [-2.4, -1.2, 0]) o.push(piece(P, 'Chair', n('Bar stool'), [x, 0.1, -1.7], PI));
	// the hall: two long tables with benches, a rug, a plant --------------------------
	for (const [x, z] of [[-2.6, 1.2], [-0.2, 0.6]]) {
		o.push(piece(P, 'Table', n('Table'), [x, 0.1, z], H));
		o.push(piece(P, 'Bench', n('Bench'), [x - 0.75, 0.1, z], H));
		o.push(piece(P, 'Bench', n('Bench'), [x + 0.75, 0.1, z], H));
		o.push(piece(P, 'Candles', n('Candles'), [x, 0.88, z], 0, { physics: COLLIDERS.sensor }));
	}
	o.push(piece(P, 'Rug', 'Hall rug', [-1.2, 0.1, 1.0], H, { scale: 1.2, physics: COLLIDERS.sensor }));
	o.push(piece(P, 'PottedPlant', n('Plant'), [1.4, 0.1, 3.3]));
	o.push(piece(P, 'PottedPlant', n('Plant'), [-5.3, 0.1, 3.3]));
	o.push(piece(P, 'CrateTeal', n('Crate'), [-4.9, 0.1, 1.9], 0.2, { physics: DYNAMIC(12) }));
	// the kitchen: a hearth, a cauldron, a workbench, stores -----------------------------
	o.push(piece(A, 'Chimney', 'Hearth', [5.4, 0.1, -5.4]));
	o.push(piece(P, 'Cauldron', 'Cauldron', [4.4, 0.1, -5], 0.4));
	o.push(piece(P, 'Workbench', 'Workbench', [5.45, 0.1, -1.5], -H));
	o.push(piece(P, 'Candles', n('Candles'), [5.45, 1.02, -1.2], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'CrateStack', 'Kitchen crates', [4.6, 0.1, 3.2]));
	o.push(piece(P, 'Sacks', 'Kitchen sacks', [5.2, 0.1, 1.4], 1.9));
	o.push(piece(P, 'BarrelSmall', n('Barrel'), [3.1, 0.1, -5.3], 0, { physics: DYNAMIC(10) }));
	// the loft: a bed, a chest, a rug, a tapestry, a plant --------------------------------
	o.push(piece(P, 'Bed', 'Loft bed', [5, 3.1, -4.4]));
	o.push(piece(P, 'Chest', 'Loft chest', [5.2, 3.1, 2.8], -H));
	o.push(piece(P, 'Rug', 'Loft rug', [4.1, 3.1, -0.5], H, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Tapestry', n('Tapestry'), [5.875, 3.9, 0.5], -H, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'Tapestry', n('Tapestry'), [-3, 3.9, -5.875], 0, { physics: COLLIDERS.sensor }));
	o.push(piece(P, 'PottedPlant', n('Plant'), [1.3, 3.1, -5.3]));
	// wall torches and lights ----------------------------------------------------------
	for (const [x, z, yaw] of [[-5.875, 0.7, H], [-5.875, 2.8, H], [1.875, -1.8, -H], [-0.8, 3.875, PI], [5.875, 2, -H]])
		o.push(piece(P, 'WallTorch', n('Wall torch'), [x, 1.55, z], yaw, { physics: COLLIDERS.sensor }));
	for (const [x, y, z, i] of [[-3, 2.5, 1.2, 9], [0.2, 2.5, 1, 9], [-1, 2.4, -3.2, 7], [4, 2.4, -2.5, 8], [4, 5.2, -1, 8], [-2, 5.2, -5, 6], [-4.2, 2.3, -1, 5]])
		o.push({ type: 'light', name: n('Lamp'), pos: [x, y, z], color: 0xffb060, intensity: i, distance: 11, decay: 2 });
	return o;
}

const TAVERN_DEF = {
	kind: 'template',
	seed: false,
	slug: 'tavern-interior',
	title: 'Tavern Interior',
	description:
		'A two-storey tavern: a hall with a bar under the balcony, a kitchen with a hearth, and a loft up the oak stairs, lit warm by lanterns and torches. Press Play to walk it.',
	author: 'theprototype',
	license: 'CC0-1.0',
	tags: ['level design', 'kits', 'interior', 'walkable'],
	objects: tavernObjects(),
	// an early evening outside the windows; inside, the warm lamps do the work and a warm
	// hemisphere keeps the corners from going black
	env: {
		preset: 'sunset',
		exposure: 1.1,
		background: { top: '#3f4a78', bottom: '#f0a766' },
		fog: null,
		ground: { color: '#5b5040', roughness: 1 },
		sun: { color: '#ffb06a', intensity: 1.6, dir: [0.7, 0.35, 0.6] },
		hemi: { sky: '#ffd9ae', ground: '#6b5236', intensity: 1.2 }
	},
	// by the front door, the bar and the stairs ahead
	physics: playPhysics([-1.4, 0.3, 3.3], -0.2),
	post: lookPost(0.7),
	graphs: { scene: walkGraph() },
	view: { position: [0.5, 2.1, 3.3], target: [-1.5, 1.6, -3] },
	thumb: {}
};

module.exports = { LEVEL_DEFS: [CASTLE_DEF, FOREST_DEF, TAVERN_DEF], COLLIDERS, TRUNKS, BRIDGE_DECK, HILL_RINGS };
