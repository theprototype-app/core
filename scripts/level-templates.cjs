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
// 33-scenes: the round-33 kits — furniture and trims (Interiors), the street (Town & Market),
// pieces that OPEN (Interactive: doors with their frames, chests, a lever, shutters — placed
// through the Explorer's own import path, see author-templates' kit branch) and the Wizard's
// Tower hero props (Arcane Study)
const I = 'interior-kit';
const TK = 'town-kit';
const X = 'interactive-kit';
const AR = 'arcane-kit';
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
	view: { pos: [9.5, 9, 13], target: [0, 2, -5] },
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
	view: { pos: [-6, 7.5, 12], target: [3, 1, -6] },
	thumb: {}
};

// ---- shared: a 4 × 4 m cottage -------------------------------------------------------------
//
// kit.md's cottage (architecture kit), centred on its own origin so it can be dropped and turned
// anywhere: walls on the lines x = ±2 and z = ±2, the doorway and a window on its FRONT (+Z,
// local), a window on its +X side, a gable roof with a chimney. `at` [x, z] and `yaw` (a multiple
// of 90°) place it; `door` is 'open' (the Interactive Kit's DoorWood — it opens), 'shut' (the
// architecture kit's static Door) or 'none'; `inside(add)` furnishes it in LOCAL coordinates.
/**
 * @param {any[]} o the object list @param {(s: string) => string} n the namer
 * @param {{at: number[], yaw?: number, name: string, plaster?: boolean, door?: 'open'|'shut'|'none',
 *   shutters?: boolean, inside?: (add: (pack: string, item: string, name: string, p: number[], yaw?: number, extra?: any) => void) => void}} c
 */
function cottage(o, n, c) {
	const yaw = c.yaw ?? 0;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	const [ox, oz] = c.at;
	/** local -> world (three's rotation.y: x' = x cos + z sin, z' = -x sin + z cos) */
	const add = (/** @type {string} */ pack, /** @type {string} */ item, /** @type {string} */ name, /** @type {number[]} */ p, ry = 0, extra = {}) =>
		o.push(piece(pack, item, name, [ox + p[0] * cos + p[2] * sin, p[1], oz - p[0] * sin + p[2] * cos], ry + yaw, extra));
	const wall = c.plaster === false ? 'WallStone' : 'WallPlaster';
	const tag = c.name;
	for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(A, 'FloorWood', n(tag + ' floor'), [x, 0, z]);
	// the front (+Z): the doorway at x -1, a window at x 1
	add(A, wall + 'Door', tag + ' doorway', [-1, 0, 2], 0, { physics: COLLIDERS.doorway });
	if (c.door === 'open') add(X, 'DoorWood', tag + ' door', [-1, 0, 2]);
	else if (c.door !== 'none') add(A, 'Door', tag + ' door', [-1, 0, 2]);
	add(A, wall + 'Window', n(tag + ' window wall'), [1, 0, 2]);
	if (c.shutters) add(X, 'Shutters', n(tag + ' shutters'), [1, 0, 2]);
	else add(A, 'Window', n(tag + ' window'), [1, 0, 2]);
	// the back and the sides; a window on the +X side
	for (const x of [-1, 1]) add(A, wall, n(tag + ' wall'), [x, 0, -2], PI);
	add(A, wall, n(tag + ' wall'), [-2, 0, -1], -H);
	add(A, wall, n(tag + ' wall'), [-2, 0, 1], -H);
	add(A, wall, n(tag + ' wall'), [2, 0, 1], H);
	add(A, wall + 'Window', n(tag + ' window wall'), [2, 0, -1], H);
	add(A, 'Window', n(tag + ' window'), [2, 0, -1], H);
	for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) add(A, 'CornerPostStone', n(tag + ' corner'), [x, 0, z]);
	for (const x of [-1, 1]) {
		add(A, 'RoofSlope', n(tag + ' roof'), [x, 3, 1]);
		add(A, 'RoofSlope', n(tag + ' roof'), [x, 3, -1], PI);
	}
	for (const x of [-2, 2]) {
		add(A, wall + 'Gable', n(tag + ' gable'), [x, 3, 1], H);
		add(A, wall + 'Gable', n(tag + ' gable'), [x, 3, -1], -H);
	}
	add(A, 'Chimney', tag + ' chimney', [1, 3.7, -1]);
	c.inside?.(add);
}

/** a street along X between `x0` and `x1` (tile centres every 2 m), its near sidewalk's inner
 * edge on `z0`: sidewalk / curb / road / curb / sidewalk (town-kit kit.md's layout), with an
 * optional pedestrian crossing at `crossAt` @param {any[]} o @param {(s: string) => string} n
 * @param {{x0: number, x1: number, z0: number, crossAt?: number}} s */
function street(o, n, s) {
	for (let x = s.x0; x <= s.x1; x += 2) {
		o.push(piece(TK, 'Sidewalk', n('Sidewalk'), [x, 0, s.z0 + 1]));
		o.push(piece(TK, 'RoadCurb', n('Curb'), [x, 0, s.z0 + 3], PI));
		o.push(piece(TK, x === s.crossAt ? 'RoadCrossing' : 'Road', n('Road'), [x, 0, s.z0 + 5]));
		o.push(piece(TK, 'RoadCurb', n('Curb'), [x, 0, s.z0 + 7]));
		o.push(piece(TK, 'Sidewalk', n('Sidewalk'), [x, 0, s.z0 + 9]));
	}
}

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

module.exports = { LEVEL_DEFS: [CASTLE_DEF, FOREST_DEF, TAVERN_DEF, WIZARD_DEF, MARKET_DEF], COLLIDERS, TRUNKS, BRIDGE_DECK, HILL_RINGS };
