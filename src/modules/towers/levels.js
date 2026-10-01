// 31-towers P2: THE TOWERS LEVELS — data and arithmetic, nothing else.
//
// A pure LEAF (imports nothing): the twelve levels, the star rule, the unlock chain, the supply
// layout on the racks, the tower measure, the verdict stepper, the gust schedule and the
// outline test are all functions of their arguments, so tests/unit/towersLevels.test.js covers
// them with no scene and no browser. The runtime (module.js) measures the SCENE (zones, racks
// and piece templates are found by NAME, so the arena lives in one place — the template def)
// and hands the numbers in.
//
// A LEVEL: {id, name, zone, supply: [{shape, count, rack?}], goal: {type, height?}, rule?,
// wind?, par: {pieces, time}, limit (seconds), lost (pieces you may lose), intro}.
//   zone  'pad' | 'pedestal' | 'wobble' — the scene objects `Build pad` / `Pedestal` /
//         `Wobble plate` (their tops are measured)
//   rack  'racks' (default: the two low racks either side of the spawn) | 'ledge' (the high
//         ledge — above your reach from the floor) | 'perch' (the star perch)
//   goal  {type: 'height', height} — the tower's top above the floor · {type: 'outline'} —
//         fill every cell of the ghost wall · {type: 'deliver', height} — the STAR on top

/** the piece shapes: the scene's template object for each, and how it may be laid on a rack
 * @type {Record<string, {template: string, label: string, stack: number}>} */
export const SHAPES = {
	cube: { template: 'Piece cube', label: 'cube', stack: 2 },
	plank: { template: 'Piece plank', label: 'plank', stack: 2 },
	beam: { template: 'Piece beam', label: 'beam', stack: 2 },
	wedge: { template: 'Piece wedge', label: 'wedge', stack: 1 },
	barrel: { template: 'Piece barrel', label: 'barrel', stack: 1 },
	arch: { template: 'Piece arch', label: 'arch', stack: 1 },
	lblock: { template: 'Piece L', label: 'L-block', stack: 1 },
	ball: { template: 'Piece ball', label: 'ball', stack: 1 },
	base: { template: 'Piece base', label: 'heavy base', stack: 1 },
	star: { template: 'Piece star', label: 'star', stack: 1 }
};

/** the zones a level builds on: the scene object's NAME and how wide a tower may stand
 * @type {Record<string, {object: string, footprint: number, yard: number}>} */
export const ZONES = {
	pad: { object: 'Build pad', footprint: 1.9, yard: 3.4 },
	pedestal: { object: 'Pedestal', footprint: 0.75, yard: 2.6 },
	wobble: { object: 'Wobble plate', footprint: 1.45, yard: 2.9 }
};

/** the supply racks, by the scene objects that carry them @type {Record<string, string[]>} */
export const RACKS = {
	racks: ['Rack west', 'Rack east'],
	ledge: ['High ledge'],
	perch: ['Star perch']
};

/** seconds a finished tower must stand still before it counts */
export const HOLD_SECONDS = 3;
/** a piece at rest moves slower than this (m/s) */
export const REST_SPEED = 0.3;
/** a tower that had reached this share of the goal... */
export const FALL_FROM = 0.6;
/** ...and drops under this share within FALL_WINDOW seconds has FALLEN */
export const FALL_TO = 0.3;
export const FALL_WINDOW = 2.5;
/** a piece resting outside the yard for this long is lost */
export const LOST_AFTER = 1.2;

/** @type {any[]} */
export const LEVELS = [
	{
		id: 1, name: 'Stack', zone: 'pad', supply: [{ shape: 'cube', count: 6 }],
		goal: { type: 'height', height: 1.8 }, par: { pieces: 3, time: 45 }, limit: 180, lost: 2,
		intro: 'Carry cubes from the racks to the glowing pad and stack them to the ring.'
	},
	{
		id: 2, name: 'Planks', zone: 'pad', supply: [{ shape: 'plank', count: 4 }, { shape: 'beam', count: 2 }, { shape: 'cube', count: 2 }],
		goal: { type: 'height', height: 2.2 }, par: { pieces: 5, time: 70 }, limit: 180, lost: 2,
		intro: 'Long pieces make wide floors. Cross them to build a stable tower.'
	},
	{
		id: 3, name: 'Climb', zone: 'pad', supply: [{ shape: 'cube', count: 5 }, { shape: 'cube', count: 3, rack: 'ledge' }],
		goal: { type: 'height', height: 3.6 }, par: { pieces: 6, time: 120 }, limit: 240, lost: 2,
		rule: 'Above your reach: build steps and climb them. Jump (Space / A) to grab from the ledge.',
		intro: 'The ring is higher than you can reach. Build a step, climb it — and jump for the ledge.'
	},
	{
		id: 4, name: 'Wedges', zone: 'pad', supply: [{ shape: 'wedge', count: 8 }, { shape: 'cube', count: 2 }],
		goal: { type: 'height', height: 2.2 }, par: { pieces: 7, time: 100 }, limit: 210, lost: 2,
		rule: 'Two wedges face to face make a flat top.',
		intro: 'Triangles! Pair two wedges into a block before you build on them.'
	},
	{
		id: 5, name: 'Barrels', zone: 'pad', supply: [{ shape: 'barrel', count: 6 }, { shape: 'plank', count: 2 }],
		goal: { type: 'height', height: 2.4 }, par: { pieces: 5, time: 90 }, limit: 210, lost: 2,
		rule: 'Barrels roll — stand them up.',
		intro: 'Barrels stand on their ends and roll on their sides. Keep them upright.'
	},
	{
		id: 6, name: 'Arches', zone: 'pad', supply: [{ shape: 'arch', count: 3 }, { shape: 'lblock', count: 3 }, { shape: 'plank', count: 2 }],
		goal: { type: 'height', height: 2.8 }, par: { pieces: 5, time: 110 }, limit: 240, lost: 2,
		intro: 'Arches and L-blocks: odd shapes, big gains. Find how they lock together.'
	},
	{
		id: 7, name: 'Narrow base', zone: 'pedestal', supply: [{ shape: 'cube', count: 3 }, { shape: 'plank', count: 3 }, { shape: 'beam', count: 1 }],
		goal: { type: 'height', height: 2.6 }, par: { pieces: 4, time: 90 }, limit: 210, lost: 2,
		rule: 'The pedestal is small — balance every overhang.',
		intro: 'Build on the little pedestal. Every piece hangs over the edge.'
	},
	{
		id: 8, name: 'Gusts', zone: 'pad', supply: [{ shape: 'cube', count: 4 }, { shape: 'plank', count: 3 }, { shape: 'wedge', count: 2 }],
		goal: { type: 'height', height: 3.0 }, wind: { first: 8, every: 9, strength: 2 },
		par: { pieces: 7, time: 120 }, limit: 240, lost: 3,
		rule: 'A gust every 9 s — hold the top piece through it, and build wide.',
		intro: 'The wind is up. A gust every few seconds pushes the top of your tower.'
	},
	{
		id: 9, name: 'Balls', zone: 'pad', supply: [{ shape: 'ball', count: 3 }, { shape: 'wedge', count: 4 }, { shape: 'plank', count: 2 }, { shape: 'cube', count: 2 }],
		goal: { type: 'height', height: 2.4 }, par: { pieces: 6, time: 140 }, limit: 270, lost: 3,
		rule: 'Balls roll off anything flat — cradle them.',
		intro: 'Hard one. Balls will not sit still: make a cradle for each one.'
	},
	{
		id: 10, name: 'Wobble', zone: 'wobble', supply: [{ shape: 'base', count: 1 }, { shape: 'cube', count: 4 }, { shape: 'plank', count: 2 }],
		goal: { type: 'height', height: 2.4 }, par: { pieces: 5, time: 100 }, limit: 240, lost: 3,
		rule: 'The plate rocks — start with the heavy base.',
		intro: 'The wobble plate never stops rocking. A heavy base steadies it.'
	},
	{
		id: 11, name: 'Outline', zone: 'pad', supply: [{ shape: 'cube', count: 6 }, { shape: 'plank', count: 2 }],
		goal: { type: 'outline' }, par: { pieces: 6, time: 80 }, limit: 180, lost: 2,
		rule: 'Fill every cell of the ghost wall.',
		intro: 'No ring this time: fill the glowing ghost wall on the pad, every cell.'
	},
	{
		id: 12, name: 'Summit', zone: 'pad',
		supply: [
			{ shape: 'base', count: 1 }, { shape: 'cube', count: 3 }, { shape: 'plank', count: 2 }, { shape: 'arch', count: 1 },
			{ shape: 'lblock', count: 1 }, { shape: 'wedge', count: 2 }, { shape: 'barrel', count: 1 }, { shape: 'star', count: 1, rack: 'perch' }
		],
		goal: { type: 'deliver', height: 3.6 }, wind: { first: 12, every: 14, strength: 1.3 },
		par: { pieces: 9, time: 180 }, limit: 360, lost: 3,
		rule: 'Fetch the star from the perch and set it on top. Light gusts.',
		intro: 'The summit: build to 3.6 m and crown it with the star from the perch.'
	}
];

/** @param {any} id @returns {any | null} */
export function levelById(id) {
	const n = Number(id);
	return LEVELS.find((l) => l.id === n) ?? null;
}

/** @param {any} id @returns {number | null} the next level's id, or null after the last */
export function nextLevelId(id) {
	const n = Number(id);
	return LEVELS.some((l) => l.id === n + 1) ? n + 1 : null;
}

/** how many pieces a level deals @param {any} level */
export function supplyCount(level) {
	return (level?.supply ?? []).reduce((/** @type {number} */ a, /** @type {any} */ s) => a + (s.count || 0), 0);
}

/** The goal height of a level in metres (an outline's is its top row). @param {any} level */
export function goalHeight(level) {
	if (!level) return 0;
	if (level.goal?.type === 'outline') return 1.4;
	return Number(level.goal?.height) || 0;
}

// ---- stars, progress, unlocks ------------------------------------------------------------------

/**
 * ★ for winning, +★ for a tower of no more than par pieces, +★ inside par time.
 * @param {any} level @param {{won: boolean, time: number, pieces: number}} result
 * @returns {number} 0..3
 */
export function starsFor(level, result) {
	if (!level || !result?.won) return 0;
	let stars = 1;
	if (Number(result.pieces) <= level.par.pieces) stars++;
	if (Number(result.time) <= level.par.time) stars++;
	return stars;
}

/** '★★☆' @param {number} n @param {number=} of */
export function starsText(n, of = 3) {
	const k = Math.max(0, Math.min(of, Math.round(Number(n) || 0)));
	return '★'.repeat(k) + '☆'.repeat(of - k);
}

/** m:ss @param {number} seconds */
export function formatTime(seconds) {
	const s = Math.max(0, Math.ceil(Number(seconds) || 0));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * The saved progress at the storage boundary: only known level ids, finite numbers, stars 0..3.
 * @param {any} raw @returns {{levels: Record<string, {stars: number, time: number, pieces: number}>}}
 */
export function normalizeProgress(raw) {
	/** @type {Record<string, {stars: number, time: number, pieces: number}>} */
	const levels = {};
	const src = raw && typeof raw === 'object' && raw.levels && typeof raw.levels === 'object' ? raw.levels : {};
	for (const level of LEVELS) {
		const row = src[level.id] ?? src[String(level.id)];
		if (!row || typeof row !== 'object') continue;
		const stars = Math.max(0, Math.min(3, Math.round(Number(row.stars) || 0)));
		if (!stars) continue;
		const time = Number(row.time);
		const pieces = Number(row.pieces);
		levels[String(level.id)] = {
			stars,
			time: Number.isFinite(time) && time > 0 ? time : 0,
			pieces: Number.isFinite(pieces) && pieces > 0 ? Math.round(pieces) : 0
		};
	}
	return { levels };
}

/**
 * Fold one finished level into the progress: the BEST of each number (most stars, fastest time,
 * fewest pieces), never a worse run over a better one. A loss changes nothing.
 * @param {any} progress @param {number} levelId @param {{stars: number, time: number, pieces: number}} result
 */
export function mergeResult(progress, levelId, result) {
	const out = normalizeProgress(progress);
	if (!(result?.stars > 0)) return out;
	const key = String(levelId);
	const was = out.levels[key];
	out.levels[key] = was
		? {
				stars: Math.max(was.stars, result.stars),
				time: was.time > 0 ? Math.min(was.time, result.time) : result.time,
				pieces: was.pieces > 0 ? Math.min(was.pieces, result.pieces) : result.pieces
			}
		: { stars: result.stars, time: result.time, pieces: result.pieces };
	return normalizeProgress(out);
}

/** Level 1 is always open; every other one opens with a star on the level before it.
 * @param {any} progress @param {number} levelId */
export function isUnlocked(progress, levelId) {
	const n = Number(levelId);
	if (!levelById(n)) return false;
	if (n === 1) return true;
	return (normalizeProgress(progress).levels[String(n - 1)]?.stars ?? 0) > 0;
}

/** total stars earned @param {any} progress */
export function totalStars(progress) {
	return Object.values(normalizeProgress(progress).levels).reduce((a, r) => a + r.stars, 0);
}

// ---- the supply layout -------------------------------------------------------------------------

/**
 * Where a level's pieces are dealt: slots along each rack's LONG axis, a piece turned so its
 * longest side lies across the rack when it fits, flat pieces stacked two high. Racks fill in
 * order; a rack that is full passes the rest to the next. Pure: the rack boxes and the piece sizes
 * come from the scene.
 * @param {any} level
 * @param {Record<string, {min: number[], max: number[]}>} rackBoxes world AABBs by rack object name
 * @param {Record<string, number[]>} sizes world size [x, y, z] of each shape's template, by shape
 * @returns {{shape: string, pos: number[], yaw: number}[]}
 */
export function layoutSupply(level, rackBoxes, sizes) {
	/** @type {{shape: string, pos: number[], yaw: number}[]} */
	const out = [];
	const GAP = 0.12;
	/** per rack name: how far along its long axis we have filled */
	/** @type {Record<string, number>} */
	const used = {};
	for (const entry of level?.supply ?? []) {
		const names = RACKS[entry.rack ?? 'racks'] ?? RACKS.racks;
		const size = sizes[entry.shape];
		if (!size) continue;
		const stackable = SHAPES[entry.shape]?.stack ?? 1;
		let left = entry.count;
		for (const name of names) {
			const box = rackBoxes[name];
			if (!box || left <= 0) continue;
			const dx = box.max[0] - box.min[0];
			const dz = box.max[2] - box.min[2];
			const alongZ = dz >= dx; // the rack's long axis
			const across = alongZ ? dx : dz;
			const length = alongZ ? dz : dx;
			// turn the piece so its longest horizontal side lies ACROSS the rack when it fits
			const long = Math.max(size[0], size[2]);
			const short = Math.min(size[0], size[2]);
			const turned = long <= across - 0.05;
			const along = turned ? short : long;
			// the yaw that puts the piece's long side across: size[0] is x at yaw 0
			const xIsLong = size[0] >= size[2];
			const acrossIsX = alongZ;
			const yaw = turned === (xIsLong === acrossIsX) ? 0 : Math.PI / 2;
			while (left > 0) {
				const start = used[name] ?? 0;
				if (start + along > length + 1e-6) break;
				const mid = start + along / 2;
				const layers = Math.min(stackable, left);
				for (let k = 0; k < layers; k++) {
					const x = alongZ ? (box.min[0] + box.max[0]) / 2 : box.min[0] + mid;
					const z = alongZ ? box.min[2] + mid : (box.min[2] + box.max[2]) / 2;
					const y = box.max[1] + size[1] * (k + 0.5) + 0.02 + k * 0.02;
					out.push({ shape: entry.shape, pos: [round(x), round(y), round(z)], yaw });
				}
				left -= layers;
				used[name] = start + along + GAP;
			}
		}
	}
	return out;
}

/** @param {number} n */
function round(n) {
	return Math.round(n * 1000) / 1000;
}

// ---- measuring the tower -----------------------------------------------------------------------

/**
 * The pieces that make the TOWER: resting, not held, their centre over the zone's footprint.
 * @param {{uuid: string, pos: number[], top: number, speed: number, held: boolean}[]} pieces
 * @param {{center: number[], footprint: number}} zone
 */
export function towerPieces(pieces, zone) {
	return pieces.filter(
		(p) =>
			!p.held &&
			p.speed < REST_SPEED &&
			Math.hypot(p.pos[0] - zone.center[0], p.pos[2] - zone.center[2]) <= zone.footprint
	);
}

/** the tower's top (metres above the floor): the highest top of its pieces, else the zone's
 * own surface @param {any[]} pieces @param {{center: number[], footprint: number, top: number}} zone */
export function towerTop(pieces, zone) {
	let top = zone.top ?? 0;
	for (const p of towerPieces(pieces, zone)) if (p.top > top) top = p.top;
	return top;
}

/** Is this resting piece LOST — on the floor, outside the yard, off every rack?
 * @param {{pos: number[], bottom: number, speed: number, held: boolean}} piece
 * @param {{center: number[], yard: number}} zone
 * @param {{min: number[], max: number[]}[]} rackBoxes */
export function isOutside(piece, zone, rackBoxes) {
	if (piece.held || piece.speed >= REST_SPEED) return false;
	if (piece.bottom > 0.9) return false; // up on something — a rack, the ledge, the tower
	if (Math.hypot(piece.pos[0] - zone.center[0], piece.pos[2] - zone.center[2]) <= zone.yard) return false;
	for (const b of rackBoxes)
		if (piece.pos[0] >= b.min[0] && piece.pos[0] <= b.max[0] && piece.pos[2] >= b.min[2] && piece.pos[2] <= b.max[2]) return false;
	return true;
}

// ---- the outline goal --------------------------------------------------------------------------

/** the ghost wall's cells: 3 wide x 2 high, 0.6 m, standing on the zone's surface, facing +Z
 * @param {{center: number[], top: number}} zone @returns {number[][]} cell centres */
export function outlineCells(zone) {
	const cells = [];
	for (let row = 0; row < 2; row++)
		for (let col = -1; col <= 1; col++)
			cells.push([round(zone.center[0] + col * 0.6), round((zone.top ?? 0) + 0.3 + row * 0.6), round(zone.center[2])]);
	return cells;
}

/** how many cells a resting piece's box holds @param {number[][]} cells
 * @param {{min: number[], max: number[], held?: boolean, speed?: number}[]} boxes */
export function cellsFilled(cells, boxes) {
	let n = 0;
	for (const c of cells) {
		const hit = boxes.some(
			(b) =>
				!b.held &&
				(b.speed ?? 0) < REST_SPEED &&
				c[0] >= b.min[0] - 0.05 && c[0] <= b.max[0] + 0.05 &&
				c[1] >= b.min[1] - 0.05 && c[1] <= b.max[1] + 0.05 &&
				c[2] >= b.min[2] - 0.05 && c[2] <= b.max[2] + 0.05
		);
		if (hit) n++;
	}
	return n;
}

// ---- the wind ----------------------------------------------------------------------------------

/**
 * The gust schedule: gust n comes `first + n * every` seconds into the round, from a direction
 * that turns by the golden angle each time (so two gusts rarely push the same way). Every peer
 * computes the same schedule from the replicated round clock — only the stepping peer PUSHES.
 * @param {any} level @param {number} elapsed seconds into the round
 * @returns {{index: number, at: number, dir: number[], strength: number} | null} the most
 *   recent gust at or before `elapsed`, or null before the first / with no wind
 */
export function gustAt(level, elapsed) {
	const w = level?.wind;
	if (!w || !(elapsed >= w.first)) return null;
	const index = Math.floor((elapsed - w.first) / w.every);
	return gust(level, index);
}

/** gust `index` of a level @param {any} level @param {number} index */
export function gust(level, index) {
	const w = level.wind;
	const angle = (index * 2.39996323 + level.id * 0.7) % (Math.PI * 2);
	return {
		index,
		at: w.first + index * w.every,
		dir: [round(Math.cos(angle)), 0, round(Math.sin(angle))],
		strength: w.strength
	};
}

/** a compass word for a gust direction (where it blows FROM) @param {number[]} dir */
export function windFrom(dir) {
	// the wind blows along dir, so it comes FROM -dir. Scene: -Z is north, +X east.
	const x = -dir[0];
	const z = -dir[2];
	const deg = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
	return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
}

// ---- the verdict -------------------------------------------------------------------------------

/**
 * ONE STEP of the round's judge — pure, so the rules are tested frame by frame. The runtime keeps
 * the returned `memo` and hands it back next time.
 * @param {any} level
 * @param {{elapsed: number, top: number, filled?: number, cells?: number, star?: {top: number, inTower: boolean} | null,
 *   anyHeld: boolean, lost: number, starLost?: boolean}} now
 * @param {{holdSince: number | null, peak: number, peakAt: number} | null} memo
 * @returns {{verdict: null | 'won' | 'time' | 'fell' | 'lost' | 'star', hold: number, memo: any}}
 *   `hold` = whole seconds left of the hold countdown (0 = not holding)
 */
export function judge(level, now, memo) {
	const m = { holdSince: memo?.holdSince ?? null, peak: memo?.peak ?? 0, peakAt: memo?.peakAt ?? 0 };
	const goal = goalHeight(level);
	if (now.top > m.peak) {
		m.peak = now.top;
		m.peakAt = now.elapsed;
	}
	if (now.starLost) return { verdict: 'star', hold: 0, memo: m };
	if (now.lost > level.lost) return { verdict: 'lost', hold: 0, memo: m };
	// a COLLAPSE: the tower had got well up and came down fast (taking pieces off one at a time
	// is slower than the window, so rebuilding is not a fall)
	if (goal > 0 && m.peak >= goal * FALL_FROM && now.top < goal * FALL_TO && now.elapsed - m.peakAt <= FALL_WINDOW && !now.anyHeld)
		return { verdict: 'fell', hold: 0, memo: m };
	let met = false;
	if (level.goal?.type === 'outline') met = (now.cells ?? 0) > 0 && (now.filled ?? 0) >= (now.cells ?? 0);
	else if (level.goal?.type === 'deliver') met = !!now.star?.inTower && now.star.top >= goal;
	else met = now.top >= goal;
	if (met && !now.anyHeld) {
		if (m.holdSince == null) m.holdSince = now.elapsed;
		const held = now.elapsed - m.holdSince;
		if (held >= HOLD_SECONDS) return { verdict: 'won', hold: 0, memo: m };
		// a new peak keeps the collapse window honest, but holding still is not a fall
		return { verdict: null, hold: Math.max(1, Math.ceil(HOLD_SECONDS - held)), memo: m };
	}
	m.holdSince = null;
	if (now.elapsed >= level.limit) return { verdict: 'time', hold: 0, memo: m };
	return { verdict: null, hold: 0, memo: m };
}

/** the words for a verdict @param {string} verdict */
export function verdictTitle(verdict) {
	return (
		{
			won: 'Level complete!',
			time: 'Out of time',
			fell: 'The tower fell',
			lost: 'Out of pieces',
			star: 'The star was lost'
		}[verdict] ?? ''
	);
}

/** the numeric status the game variable carries (0 = no round) */
export const STATUS = { none: 0, playing: 1, won: 2, time: 3, fell: 4, lost: 5, star: 6 };
/** @param {number} code @returns {string} */
export function statusName(code) {
	return Object.keys(STATUS).find((k) => STATUS[/** @type {keyof typeof STATUS} */ (k)] === code) ?? 'none';
}
