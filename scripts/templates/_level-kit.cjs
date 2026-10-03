// The level kit: what every General-tab kit level shares (34 R4 A3: split out of level-templates.cjs —
// the levels are one file each beside this one, listed by scripts/level-templates.cjs).

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

module.exports = { A, N, P, I, TK, X, AR, PI, H, compound, box, wedge, COLLIDERS, BRIDGE_DECK, bridgeCollider, HILL_RINGS, hillCollider, TRUNKS, namer, rng, r3, piece, walkGraph, playPhysics, lookPost, DYNAMIC, cottage, street };
