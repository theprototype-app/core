// Template def `marble-maze` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 35 MARBLE MAZE: tilt the board, roll the marble to the gold goal. Five mazes of rising
// difficulty (gates that rise and sink on 4 and 5), holes that send you back to the start,
// three coins per maze, a timer and 1-3 stars a maze. The rules live in the CORE module
// `marble` (src/modules/marble/module.js), dormant unless the scene holds the `Marble Maze
// game` marker — the Towers precedent. This def owns the GEOMETRY:
//   · each maze is ONE group (`Maze N`) with a custom COMPOUND collider (floor strips with the
//     holes left out + the wall runs, <= 50 boxes = the 1200-float cap) — the module's
//     `marbletilt` effect turns it into a KINEMATIC platform and tilts it (±15°);
//   · the inactive mazes wait parked under the floor; the effect brings the current one up;
//   · start / goal / coins are CHILDREN of their maze (named `Start N`, `Goal N`, `Coin N.k`),
//     so they tilt with it and the module reads their local positions;
//   · the gates (`Gate N.k`) are their own top-level kinematic boxes (a child has no body),
//     posed by the same effect from their maze's tilt plus a rise/sink cycle.
// The mazes are GENERATED here from a seed (a recursive backtracker, then a few walls knocked
// out to braid the easy ones), so every one is solvable and two builds are identical.

const { graphBuilder } = require('./_builders.cjs');

/** where the board sits while you play: 0.75 m in front of the spawn, at chest height */
const BOARD = [0, 1.1, -0.75];
/** wall thickness / height, floor thickness (metres) */
const T = 0.02;
const WALL_H = 0.07;
const FLOOR_T = 0.03;
const MARBLE_R = 0.035;
const COLLIDER_BOX_CAP = 50;

/** the five mazes: cells per side, seed, extra walls knocked out (braid), holes, gates */
const MAZES = [
	{ n: 5, seed: 11, braid: 6, holes: 1, gates: 0, name: 'First roll' },
	{ n: 6, seed: 23, braid: 5, holes: 2, gates: 0, name: 'Pits' },
	{ n: 7, seed: 37, braid: 4, holes: 3, gates: 0, name: 'Labyrinth' },
	{ n: 7, seed: 41, braid: 3, holes: 3, gates: 2, name: 'Gatehouse' },
	{ n: 7, seed: 59, braid: 2, holes: 5, gates: 3, name: 'The gauntlet' }
];
/** the maze's cell size: the boards are all ~0.86 m across */
const cellSize = (/** @type {number} */ n) => +(0.84 / n).toFixed(4);

/** @param {number} seed */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** a perfect maze (recursive backtracker) then `braid` extra openings. Returns the wall flags.
 * @param {number} n @param {number} seed @param {number} braid */
function carve(n, seed, braid) {
	const rand = seeded(seed);
	// east[i][j]: a wall between (i,j) and (i+1,j); south[i][j]: between (i,j) and (i,j+1)
	const east = Array.from({ length: n }, () => Array(n).fill(true));
	const south = Array.from({ length: n }, () => Array(n).fill(true));
	const seen = Array.from({ length: n }, () => Array(n).fill(false));
	const stack = [[0, n - 1]];
	seen[0][n - 1] = true;
	while (stack.length) {
		const [i, j] = stack[stack.length - 1];
		const options = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => {
			const a = i + di;
			const b = j + dj;
			return a >= 0 && b >= 0 && a < n && b < n && !seen[a][b];
		});
		if (!options.length) {
			stack.pop();
			continue;
		}
		const [di, dj] = options[Math.floor(rand() * options.length)];
		const a = i + di;
		const b = j + dj;
		if (di === 1) east[i][j] = false;
		if (di === -1) east[a][b] = false;
		if (dj === 1) south[i][j] = false;
		if (dj === -1) south[a][b] = false;
		seen[a][b] = true;
		stack.push([a, b]);
	}
	let knocked = 0;
	for (let tries = 0; knocked < braid && tries < 500; tries++) {
		const i = Math.floor(rand() * n);
		const j = Math.floor(rand() * n);
		if (rand() < 0.5 && i < n - 1 && east[i][j]) {
			east[i][j] = false;
			knocked++;
		} else if (j < n - 1 && south[i][j]) {
			south[i][j] = false;
			knocked++;
		}
	}
	return { east, south };
}

/** the shortest path start -> goal over open walls (BFS) @param {number} n @param {any} w */
function solve(n, w) {
	const key = (/** @type {number} */ i, /** @type {number} */ j) => i + ',' + j;
	const start = [0, n - 1];
	const goal = [n - 1, 0];
	/** @type {Map<string, string | null>} */ const from = new Map([[key(start[0], start[1]), null]]);
	const q = [start];
	while (q.length) {
		const [i, j] = /** @type {number[]} */ (q.shift());
		if (i === goal[0] && j === goal[1]) break;
		/** @type {number[][]} */ const next = [];
		if (i < n - 1 && !w.east[i][j]) next.push([i + 1, j]);
		if (i > 0 && !w.east[i - 1][j]) next.push([i - 1, j]);
		if (j < n - 1 && !w.south[i][j]) next.push([i, j + 1]);
		if (j > 0 && !w.south[i][j - 1]) next.push([i, j - 1]);
		for (const [a, b] of next)
			if (!from.has(key(a, b))) {
				from.set(key(a, b), key(i, j));
				q.push([a, b]);
			}
	}
	/** @type {number[][]} */ const path = [];
	/** @type {string | null | undefined} */ let k = key(goal[0], goal[1]);
	while (k) {
		path.unshift(k.split(',').map(Number));
		k = from.get(k);
	}
	return path;
}

/** the eight corners of a local box, flat @param {number[]} b [x0,x1,y0,y1,z0,z1] */
const boxVerts = ([x0, x1, y0, y1, z0, z1]) => [x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1].map((v) => +v.toFixed(4));
/** a box object from extents @param {string} name @param {number[]} b @param {any} extra */
const boxOf = (name, [x0, x1, y0, y1, z0, z1], extra) => ({
	type: 'box',
	name,
	size: [+(x1 - x0).toFixed(4), +(y1 - y0).toFixed(4), +(z1 - z0).toFixed(4)],
	pos: [+((x0 + x1) / 2).toFixed(4), +((y0 + y1) / 2).toFixed(4), +((z0 + z1) / 2).toFixed(4)],
	...extra
});

const WALL_LOOK = { color: 0x7a4f2c, roughness: 0.55, physical: true, clearcoat: 0.4 };
const RIM_LOOK = { color: 0x4a2f1c, roughness: 0.5, physical: true, clearcoat: 0.6 };
const FLOOR_LOOK = { color: 0xd9c49a, roughness: 0.7 };

/** build maze k (1-based): the group (children + compound collider) and its gates
 * @param {number} k @param {number[]} at where the group stands */
function buildMaze(k, at) {
	const m = MAZES[k - 1];
	const n = m.n;
	const s = cellSize(n);
	const w = carve(n, m.seed, m.braid);
	const path = solve(n, w);
	const onPath = new Set(path.map(([i, j]) => i + ',' + j));
	const rand = seeded(m.seed * 7 + 3);
	const bx = (/** @type {number} */ kk) => -n * s / 2 + kk * s; // boundary kk (0..n) -> local x / z
	const cx = (/** @type {number} */ i) => bx(i) + s / 2; // cell centre
	// the char grid: odd = cells, even = boundaries; '#' = wall
	const G = 2 * n + 1;
	const grid = Array.from({ length: G }, () => Array(G).fill(false));
	for (let c = 0; c < G; c++) {
		grid[0][c] = grid[G - 1][c] = grid[c][0] = grid[c][G - 1] = true;
	}
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			if (i < n - 1 && w.east[i][j]) grid[2 * j + 1][2 * i + 2] = true;
			if (j < n - 1 && w.south[i][j]) grid[2 * j + 2][2 * i + 1] = true;
		}
	for (let r = 0; r < G; r += 2)
		for (let c = 0; c < G; c += 2) {
			const near = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([a, b]) => a >= 0 && b >= 0 && a < G && b < G && grid[a][b]);
			if (near) grid[r][c] = true;
		}
	const lo = (/** @type {number} */ c) => (c % 2 === 0 ? bx(c / 2) - T / 2 : bx((c - 1) / 2) + T / 2);
	const hi = (/** @type {number} */ c) => (c % 2 === 0 ? bx(c / 2) + T / 2 : bx((c + 1) / 2) - T / 2);
	/** @type {number[][]} */ const walls = [];
	// horizontal runs on even rows, vertical runs on even columns (corners overlap, harmless)
	for (let r = 0; r < G; r += 2) {
		let a = -1;
		for (let c = 0; c <= G; c++) {
			const on = c < G && grid[r][c];
			if (on && a < 0) a = c;
			if (!on && a >= 0) {
				if (c - 1 > a) walls.push([lo(a), hi(c - 1), 0, WALL_H, lo(r), hi(r)]);
				a = -1;
			}
		}
	}
	for (let c = 0; c < G; c += 2) {
		let a = -1;
		for (let r = 0; r <= G; r++) {
			const on = r < G && grid[r][c] && !(r % 2 === 0 && covered(r, c));
			if (on && a < 0) a = r;
			if (!on && a >= 0) {
				walls.push([lo(c), hi(c), 0, WALL_H, lo(a), hi(r - 1)]);
				a = -1;
			}
		}
	}
	/** an even-row corner already inside a horizontal run AND with no vertical wall either side
	 * @param {number} r @param {number} c */
	function covered(r, c) {
		const up = r > 0 && grid[r - 1][c];
		const down = r < G - 1 && grid[r + 1][c];
		return !up && !down;
	}
	// the outer rim stands a little proud of the walls
	const H = n * s / 2 + T / 2;
	const rim = [
		[-H - 0.02, H + 0.02, 0, WALL_H + 0.02, -H - 0.02, -H + T],
		[-H - 0.02, H + 0.02, 0, WALL_H + 0.02, H - T, H + 0.02],
		[-H - 0.02, -H + T, 0, WALL_H + 0.02, -H, H],
		[H - T, H + 0.02, 0, WALL_H + 0.02, -H, H]
	];
	// holes: cells next to the path but not on it (an overshoot drops you), never start/goal
	/** @type {Set<string>} */ const holes = new Set();
	const candidates = [];
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			if (onPath.has(i + ',' + j)) continue;
			const nearPath = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => onPath.has(i + a + ',' + (j + b)));
			candidates.push({ i, j, score: (nearPath ? 0 : 1) + rand() });
		}
	candidates.sort((a, b) => a.score - b.score);
	for (const c of candidates.slice(0, m.holes)) holes.add(c.i + ',' + c.j);
	// coins: three dead-end-ish cells off the path (a detour), else path cells far from start
	const coinCells = candidates
		.filter((c) => !holes.has(c.i + ',' + c.j))
		.sort((a, b) => b.score - a.score)
		.slice(0, 2)
		.map((c) => [c.i, c.j]);
	coinCells.push(path[Math.floor(path.length / 2)]);
	// floor: hole-free rows merge into one slab; a row with holes is split around them
	/** @type {number[][]} */ const floor = [];
	let slabStart = -1;
	const flush = (/** @type {number} */ j1) => {
		if (slabStart >= 0) floor.push([-H, H, -FLOOR_T, 0, slabStart === 0 ? -H : bx(slabStart), j1 === n ? H : bx(j1)]);
		slabStart = -1;
	};
	for (let j = 0; j < n; j++) {
		const rowHoles = [...holes].map((h) => h.split(',').map(Number)).filter(([, hj]) => hj === j).map(([hi2]) => hi2).sort((a, b) => a - b);
		if (!rowHoles.length) {
			if (slabStart < 0) slabStart = j;
			continue;
		}
		flush(j);
		let x0 = -H;
		for (const hi2 of rowHoles) {
			if (bx(hi2) > x0 + 1e-6) floor.push([x0, bx(hi2), -FLOOR_T, 0, j === 0 ? -H : bx(j), j === n - 1 ? H : bx(j + 1)]);
			x0 = bx(hi2 + 1);
		}
		if (H > x0 + 1e-6) floor.push([x0, H, -FLOOR_T, 0, j === 0 ? -H : bx(j), j === n - 1 ? H : bx(j + 1)]);
	}
	flush(n);
	const pieces = [...floor, ...walls, ...rim];
	if (pieces.length > COLLIDER_BOX_CAP) throw new Error('marble-maze: maze ' + k + ' needs ' + pieces.length + ' collider boxes (cap ' + COLLIDER_BOX_CAP + ') — change its seed or braid');
	const colliderVerts = [];
	const colliderPieces = [];
	for (const b of pieces) {
		colliderPieces.push([colliderVerts.length, 24]);
		colliderVerts.push(...boxVerts(b));
	}
	const tag = (/** @type {string} */ what, /** @type {number} */ i) => what + ' ' + k + '.' + i;
	const children = [
		...floor.map((b, i) => boxOf(tag('Floor', i + 1), b, { ...FLOOR_LOOK, shadow: true })),
		...walls.map((b, i) => boxOf(tag('Wall', i + 1), b, WALL_LOOK)),
		...rim.map((b, i) => boxOf(tag('Rim', i + 1), b, RIM_LOOK)),
		// the pit under the floor that a hole shows (no collider: a child has no body)
		boxOf('Pit ' + k, [-H + T, H - T, -0.12, -0.105, -H + T, H - T], { color: 0x1a120c, roughness: 1, shadow: false }),
		// the grips: a handle either side, for both hands in VR
		{ type: 'cylinder', name: 'Handle ' + k + ' left', r: 0.022, h: 0.36, pos: [-H - 0.07, 0.02, 0], rot: [Math.PI / 2, 0, 0], color: 0x2b2f3a, metalness: 0.6, roughness: 0.35, physical: true },
		{ type: 'cylinder', name: 'Handle ' + k + ' right', r: 0.022, h: 0.36, pos: [H + 0.07, 0.02, 0], rot: [Math.PI / 2, 0, 0], color: 0x2b2f3a, metalness: 0.6, roughness: 0.35, physical: true },
		{ type: 'box', name: 'Handle ' + k + ' arm left', size: [0.07, 0.025, 0.06], pos: [-H - 0.035, 0.02, 0], color: 0x2b2f3a, metalness: 0.6, roughness: 0.35 },
		{ type: 'box', name: 'Handle ' + k + ' arm right', size: [0.07, 0.025, 0.06], pos: [H + 0.035, 0.02, 0], color: 0x2b2f3a, metalness: 0.6, roughness: 0.35 },
		// start pad + goal (markers, no collider)
		{ type: 'cylinder', name: 'Start ' + k, r: s * 0.32, h: 0.004, pos: [cx(0), 0.002, cx(n - 1)], color: 0x6fe3a0, emissive: 0x2fcf70, emissiveIntensity: 0.9, shadow: false, pick: 'through' },
		{ type: 'torus', name: 'Goal ' + k, r: s * 0.3, tube: 0.008, pos: [cx(n - 1), 0.01, cx(0)], rot: [-Math.PI / 2, 0, 0], color: 0xfff0b8, emissive: 0xffc640, emissiveIntensity: 2.6, shadow: false, pick: 'through' },
		{ type: 'cylinder', name: 'Goal cup ' + k, r: s * 0.26, h: 0.003, pos: [cx(n - 1), 0.002, cx(0)], color: 0xffd45e, emissive: 0xffb830, emissiveIntensity: 1.2, shadow: false, pick: 'through' },
		// three coins, standing up
		...coinCells.map(([i, j], c) => ({
			type: 'cylinder', name: tag('Coin', c + 1), r: 0.024, h: 0.008, pos: [cx(i), 0.032, cx(j)], rot: [Math.PI / 2, 0, 0],
			color: 0xffd34d, emissive: 0xffa800, emissiveIntensity: 0.8, metalness: 0.8, roughness: 0.25, physical: true, shadow: false, pick: 'through'
		}))
	];
	const group = {
		type: 'group',
		name: 'Maze ' + k,
		pos: at,
		children,
		physics: { mode: 'static', collider: 'custom', colliderVerts, colliderPieces, friction: 0.35, restitution: 0.15 }
	};
	// gates on 4/5: on the PATH, across it, rising and sinking out of phase
	/** @type {any[]} */ const gates = [];
	for (let g = 0; g < m.gates; g++) {
		const idx = Math.floor(((g + 1) * path.length) / (m.gates + 1));
		const [i, j] = path[Math.max(1, Math.min(path.length - 2, idx))];
		const [ni, nj] = path[Math.max(1, Math.min(path.length - 2, idx)) + 1];
		// a gate across the corridor: perpendicular to the step to the next path cell
		const alongX = nj !== j; // moving in z -> the gate lies along x
		const lx = alongX ? cx(i) : (cx(i) + cx(ni)) / 2;
		const lz = alongX ? (cx(j) + cx(nj)) / 2 : cx(j);
		gates.push({
			type: 'box',
			name: 'Gate ' + k + '.' + (g + 1),
			size: alongX ? [s - T, WALL_H, T] : [T, WALL_H, s - T],
			pos: [at[0] + lx, at[1] + WALL_H / 2, at[2] + lz],
			color: 0xd94a4a, emissive: 0xff3a2a, emissiveIntensity: 0.6, physical: true, roughness: 0.4, clearcoat: 0.6,
			physics: { mode: 'static', friction: 0.3 },
			gate: { maze: k, lx, lz, phase: g * 0.5 }
		});
	}
	return { group, gates, size: n, cell: s, path: path.length, holes: [...holes], coins: coinCells };
}

/** maze 1 stands at the board (the card and the editor show it); 2-5 wait under the floor */
const parkOf = (/** @type {number} */ k) => (k === 1 ? BOARD : [(k - 3) * 1.2, -4, 2]);
const BUILT = MAZES.map((_, i) => buildMaze(i + 1, parkOf(i + 1)));

const HUD_PANEL = { bg: 'rgba(20, 14, 10, 0.9)', radius: 18, border: '1px solid rgba(255, 212, 94, 0.3)' };
const BTN = { size: 17, weight: '600', bg: '#c4792d', color: '#ffffff', radius: 10 };

function marbleGraph() {
	const g = graphBuilder();
	const { N, E } = g;
	N('click', 'gamesound', 'Button click', 520, 40, { sound: 'click' });
	const button = (/** @type {string} */ id, /** @type {string} */ element, /** @type {string} */ label, /** @type {number} */ x, /** @type {number} */ y) => {
		N(id, 'hudbutton', label, x, y, { element });
		E(id, 'click', 'trigger');
	};
	for (let i = 1; i <= MAZES.length; i++) button('lvl' + i, 'lvl-' + i, 'Maze ' + i + ' button', 40, 40 + (i - 1) * 70);
	button('bstart', 'start-btn', 'Start button', 40, 420);
	button('bnext', 'next-btn', 'Next maze button', 40, 490);
	button('bretry', 'retry-btn', 'Retry button', 40, 560);
	button('blevels', 'levels-btn', 'Mazes button', 40, 630);
	// the HUD's words, from the module's Marble info node into HUD Text's FORMAT
	const text = (/** @type {string} */ id, /** @type {string} */ read, /** @type {string} */ element, /** @type {number} */ x, /** @type {number} */ y, extra = {}) => {
		N(id + 'i', 'marbleinfo', 'Marble: ' + read, x, y, { read, ...extra });
		N(id + 't', 'hudtext', 'HUD ' + element, x + 240, y, { element, format: '', decimals: 0, value: 0 });
		E(id + 'i', id + 't', 'format');
	};
	text('mline', 'menuLine', 'mm-menu-line', 800, 40);
	for (let i = 1; i <= MAZES.length; i++) text('ls' + i, 'levelStars', 'lvl-' + i + '-stars', 800, 110 + (i - 1) * 70, { level: i });
	text('title', 'title', 'mm-title', 1300, 40);
	text('clock', 'clock', 'mm-clock', 1300, 110);
	text('coins', 'coins', 'mm-coins', 1300, 180);
	text('falls', 'falls', 'mm-falls', 1300, 250);
	text('hint', 'hint', 'mm-hint', 1300, 320);
	text('result', 'result', 'mm-result', 1300, 410);
	text('rstars', 'resultStars', 'mm-stars', 1300, 480);
	text('rline', 'resultLine', 'mm-line', 1300, 550);
	text('rbest', 'resultBest', 'mm-best', 1300, 620);
	N('music', 'gamemusic', 'Puzzle music', 40, 760, { preset: 'puzzle', volume: 0.35, while: 'always' });
	// the boards and gates: the module's tilt effect, one per object (a KINEMATIC platform each)
	let y = 860;
	for (let k = 1; k <= MAZES.length; k++) {
		N('tilt' + k, 'marbletilt', 'Maze ' + k + ' tilts', 40, y, { maze: k, gate: false, lx: 0, lz: 0, phase: 0 });
		N('seltilt' + k, 'objectselector', 'Maze ' + k, 280, y, { selected: 'Maze ' + k });
		E('tilt' + k, 'seltilt' + k);
		y += 80;
		for (const gate of BUILT[k - 1].gates) {
			const id = gate.name.replace(/[^a-z0-9]/gi, '');
			N('tilt' + id, 'marbletilt', gate.name + ' rises', 40, y, { maze: k, gate: true, lx: gate.gate.lx, lz: gate.gate.lz, phase: gate.gate.phase });
			N('sel' + id, 'objectselector', gate.name, 280, y, { selected: gate.name });
			E('tilt' + id, 'sel' + id);
			y += 80;
		}
	}
	return g.done();
}

/** a maze button + its stars line @param {number} i 1..5 */
const levelCell = (i) => {
	const x = -232 + (i - 1) * 116;
	return [
		{ id: 'lvl-' + i, kind: 'button', anchor: 'center', x, y: 46, w: 106, h: 52, z: 1, label: i + ' · ' + MAZES[i - 1].name, enabled: true, style: { ...BTN, size: 13 }, wrap: true },
		{ id: 'lvl-' + i + '-stars', kind: 'text', anchor: 'center', x, y: 86, w: 106, h: 18, z: 1, label: '', style: { size: 13, weight: '600', color: '#ffd45e', align: 'center' } }
	];
};

const MARBLE_DEF = {
	kind: 'game',
	slug: 'marble-maze',
	title: 'Marble Maze',
	description:
		'Tilt the wooden board and roll the marble to the gold goal. Five mazes, holes that send you back, coins to collect and gates that rise and sink. Mouse or WASD on a desktop; in VR grab both handles and twist. 1-3 stars a maze.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['physics', 'puzzle', 'tilt', 'vr'],
	modules: [],
	env: {
		preset: 'custom',
		base: 'sunset',
		exposure: 1.15,
		background: { top: '#2a3550', bottom: '#d9a877' },
		fog: { color: '#e0c7a8', near: 10, far: 45 },
		ground: { color: '#5b4a3c', roughness: 0.95 }
	},
	physics: {
		ground: { enabled: true, height: 0, friction: 0.8, restitution: 0 },
		bounds: { limit: -10, action: 'respawn' },
		material: { friction: 0.5, restitution: 0.1 },
		damping: { linear: 0.15, angular: 0.2 },
		ccd: true,
		play: { interaction: 'click', grounded: false, simOnPlay: true, cursor: 'free', spawn: { position: [0, 0, 0.3], yaw: 0 } }
	},
	post: {
		enabled: true,
		effects: [
			{ id: 'tone', kind: 'tonemapping', enabled: true, params: { mode: 'AGX' } },
			{ id: 'bloom', kind: 'bloom', enabled: true, params: { intensity: 0.6, luminanceThreshold: 0.85 } },
			{ id: 'aa', kind: 'smaa', enabled: true, params: {} }
		],
		changedAt: 0
	},
	view: { pos: [0.9, 1.9, 0.6], target: [0, 1.1, -0.75] },
	thumb: { camera: 'Card camera' },
	graphs: { scene: marbleGraph() },
	hud: {
		scene: {
			active: '',
			changedAt: 0,
			screens: [
				{
					id: 'menu',
					name: 'Mazes',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'menu-panel', kind: 'panel', anchor: 'center', x: 0, y: 10, w: 640, h: 440, z: 0, label: '', style: HUD_PANEL },
						{ id: 'title', kind: 'text', anchor: 'center', x: 0, y: -170, w: 520, h: 50, z: 1, label: 'MARBLE MAZE', style: { size: 40, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'subtitle', kind: 'text', anchor: 'center', x: 0, y: -116, w: 580, h: 44, z: 1, label: 'Tilt the board to roll the marble to the gold ring. Holes send you back to the start. Grab the three coins and beat the par time for three stars.', style: { size: 13, color: '#e9dfd0', align: 'center' }, wrap: true },
						{ id: 'mm-menu-line', kind: 'text', anchor: 'center', x: 0, y: -74, w: 420, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#9ee6ff', align: 'center' } },
						{ id: 'start-btn', kind: 'button', anchor: 'center', x: 0, y: -26, w: 240, h: 46, z: 1, label: 'Start', enabled: true, style: BTN },
						...Array.from({ length: MAZES.length }, (_, k) => levelCell(k + 1)).flat(),
						{ id: 'menu-hint', kind: 'text', anchor: 'center', x: 0, y: 138, w: 600, h: 34, z: 1, label: 'Desktop: WASD / arrows tilt · or hold the mouse and drag · Esc menu', style: { size: 12, color: '#b5a898', align: 'center' }, wrap: true },
						{ id: 'menu-hint-vr', kind: 'text', anchor: 'center', x: 0, y: 166, w: 600, h: 34, z: 1, label: 'VR: grip both handles and twist the board · or tilt with the left stick', style: { size: 12, color: '#b5a898', align: 'center' }, wrap: true }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					input: 'game',
					elements: [
						{ id: 'mm-title', kind: 'text', anchor: 'top-center', x: 0, y: 12, w: 360, h: 28, z: 1, label: '', style: { size: 19, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'mm-coins', kind: 'text', anchor: 'top-center', x: 0, y: 42, w: 420, h: 22, z: 1, label: '', style: { size: 14, weight: '600', color: '#ffffff', align: 'center' } },
						{ id: 'mm-clock', kind: 'text', anchor: 'top-left', x: 16, y: 14, w: 240, h: 26, z: 1, label: '', style: { size: 20, weight: '700', color: '#e5e9f0', align: 'left' } },
						{ id: 'mm-falls', kind: 'text', anchor: 'top-left', x: 16, y: 44, w: 200, h: 20, z: 1, label: '', style: { size: 13, weight: '600', color: '#ffb0a0', align: 'left' } },
						{ id: 'mm-hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 620, h: 20, z: 1, label: '', style: { size: 12, color: '#e5e9f0', align: 'center' } }
					]
				},
				{
					id: 'over',
					name: 'Results',
					showWhile: 'over',
					input: 'menu',
					elements: [
						{ id: 'over-panel', kind: 'panel', anchor: 'center', x: 0, y: 0, w: 480, h: 360, z: 0, label: '', style: HUD_PANEL },
						{ id: 'mm-result', kind: 'text', anchor: 'center', x: 0, y: -130, w: 440, h: 40, z: 1, label: '', style: { size: 28, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'mm-stars', kind: 'text', anchor: 'center', x: 0, y: -84, w: 300, h: 46, z: 1, label: '', style: { size: 38, weight: '700', color: '#ffd45e', align: 'center' } },
						{ id: 'mm-line', kind: 'text', anchor: 'center', x: 0, y: -36, w: 440, h: 40, z: 1, label: '', style: { size: 13, color: '#e5e9f0', align: 'center' }, wrap: true },
						{ id: 'mm-best', kind: 'text', anchor: 'center', x: 0, y: -4, w: 440, h: 20, z: 1, label: '', style: { size: 12, color: '#9ee6ff', align: 'center' } },
						{ id: 'next-btn', kind: 'button', anchor: 'center', x: 0, y: 50, w: 240, h: 46, z: 1, label: 'Next maze', enabled: true, style: BTN },
						{ id: 'retry-btn', kind: 'button', anchor: 'center', x: -64, y: 110, w: 116, h: 40, z: 1, label: 'Retry', enabled: true, style: { ...BTN, size: 15, bg: '#4c9e6a' } },
						{ id: 'levels-btn', kind: 'button', anchor: 'center', x: 64, y: 110, w: 116, h: 40, z: 1, label: 'Mazes', enabled: true, style: { size: 15, weight: '500', bg: '#3a4150', color: '#e5e9f0', radius: 10 } }
					]
				}
			]
		}
	},
	objects: [
		// the marker that wakes the core `marble` module (an empty: no body, no draw)
		{ type: 'empty', name: 'Marble Maze game' },
		// the room: a wooden floor, a low back wall, the table the board hovers over
		{ type: 'box', name: 'Room floor', color: 0x9a8670, size: [12, 0.2, 12], pos: [0, -0.098, -1], roughness: 0.85, physics: { mode: 'static', friction: 0.9 } },
		{ type: 'cylinder', name: 'Rug', color: 0x2f5d73, r: 1.6, h: 0.01, pos: [0, 0.006, -0.6], roughness: 1, shadow: false, physics: { mode: 'static', sensor: true } },
		{ type: 'box', name: 'Back wall', color: 0xd8c7ad, size: [12, 3, 0.2], pos: [0, 1.5, -5], roughness: 0.9, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Table column', color: 0x3a2a1e, r: 0.09, h: 0.8, pos: [0, 0.4, -0.75], metalness: 0.4, roughness: 0.4, physical: true, physics: { mode: 'static' } },
		{ type: 'cylinder', name: 'Table foot', color: 0x3a2a1e, r: 0.35, h: 0.04, pos: [0, 0.02, -0.75], metalness: 0.4, roughness: 0.4, physical: true, physics: { mode: 'static' } },
		{ type: 'sphere', name: 'Gimbal', color: 0x2b2f3a, r: 0.07, pos: [0, 0.86, -0.75], metalness: 0.7, roughness: 0.3, physical: true, physics: { mode: 'static', sensor: true } },
		// warm lamps over the board
		{ type: 'light', name: 'Board lamp', kind: 'spot', color: 0xfff1d8, intensity: 18, distance: 6, angle: 0.6, penumbra: 0.5, pos: [0.4, 3, 0.2], target: [0, 1.1, -0.75], shadowMapSize: 1024 },
		{ type: 'light', name: 'Fill', kind: 'hemisphere', color: 0xffe2c0, groundColor: 0x3a2a20, intensity: 0.9 },
		// the marble: steel, rolls on the board's compound collider
		{
			type: 'sphere', name: 'Marble', r: MARBLE_R, color: 0xdfe6ef, metalness: 0.9, roughness: 0.12, physical: true, clearcoat: 1,
			pos: [BOARD[0] + BUILT[0].group.children.find((c) => c.name === 'Start 1').pos[0], BOARD[1] + MARBLE_R + 0.01, BOARD[2] + BUILT[0].group.children.find((c) => c.name === 'Start 1').pos[2]],
			physics: { mode: 'dynamic', mass: 0.12, collider: 'sphere', friction: 0.4, restitution: 0.15 }
		},
		...BUILT.flatMap((b) => [b.group, ...b.gates.map((/** @type {any} */ gate) => {
			const { gate: _g, ...rest } = gate;
			return rest;
		})]),
		// the card's camera: over the player's shoulder onto the board
		{ type: 'camera', name: 'Card camera', pos: [0.75, 1.95, 0.45], lookAt: [0, 1.08, -0.8], fov: 45 }
	]
};

module.exports = MARBLE_DEF;
// the solution paths in each maze's LOCAL frame (board centre, floor top = 0) — the suite's
// autopilot rolls the marble along one through real physics. NOT enumerable: the runner and the
// lint read the def's own keys only.
Object.defineProperty(module.exports, 'solutionPaths', {
	enumerable: false,
	value: MAZES.map((m) => {
		const s = cellSize(m.n);
		const c = (/** @type {number} */ i) => -m.n * s / 2 + i * s + s / 2;
		return solve(m.n, carve(m.n, m.seed, m.braid)).map(([i, j]) => [+c(i).toFixed(4), +c(j).toFixed(4)]);
	})
});

