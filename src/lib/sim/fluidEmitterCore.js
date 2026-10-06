// 36-fb F23: the FLUID EMITTER — particle fluid (the 36-sim PBF solver) poured into the open
// scene instead of a glass tank. A LEAF that imports nothing: the worker, the runtime and
// vitest all use it.
//
// THE HARD CAPS (the user's ask: "so it can never run away"). Four independent bounds, each
// enough on its own:
//   · maxParticles — the solver's capacity; the emitter simply waits at the cap,
//   · lifetime     — a particle older than this expires (a closed loop's recycling resets it),
//   · area         — the simulation box; a particle that leaves it is gone (only the floor,
//                    when `floor` is on, holds water in), and the solver's neighbour grid is
//                    sized by it, so the box is clamped to MAX_CELLS cells,
//   · burst amount — a spill/leak releases `amount` particles once per generation.
// On Quest / low tiers the particle cap drops to QUEST_EMITTER_CAP (drops instead of a surface).
//
// FRAMES. The area box is WORLD-axis aligned (gravity is down, and a floor is a floor) and
// centred on the emitter's world position + `area.offset`. The nozzle direction `dir` is in
// the emitter object's LOCAL frame, so rotating the emitter aims it. The solver works in
// "area-local" coordinates = world - area centre.
//
// LOCAL PER PEER, like the tank: only `userData.fluidEmitter` replicates (objectParameters
// 'fluidEmitter', props undo); every peer pours the same fluid with the same settings.

export const EMITTER_VERSION = 1;
/** the desktop ceiling on maxParticles (the solver's own FLUID_MAX_PARTICLES is 8000) */
export const EMITTER_MAX_PARTICLES = 6000;
/** Quest / XR / the governor's low steps: drops, at most this many */
export const QUEST_EMITTER_CAP = 700;
/** the neighbour grid of an emitter never exceeds this many cells (memory + the per-step clear) */
export const MAX_CELLS = 600000;
/** any one side of the area box, metres */
export const MAX_AREA_SIDE = 16;

/** "Fluid interaction" on a mesh (fluidColliders reads it): absent = 'auto' */
export const FLUID_INTERACTIONS = /** @type {const} */ (['auto', 'none', 'collide', 'float']);
/** @param {any} v @returns {'auto'|'none'|'collide'|'float'} */
export function normalizeInteraction(v) {
	return FLUID_INTERACTIONS.includes(v) ? v : 'auto';
}

/** @typedef {{version: number, generation: number, on: boolean, mode: 'stream'|'burst', rate: number, speed: number,
 *   spread: number, amount: number, dir: number[], maxParticles: number, lifetime: number,
 *   area: {size: number[], offset: number[]}, floor: boolean, particleSize: number,
 *   viscosity: number, surfaceTension: number, cohesion: number, friction: number, gravityScale: number, color: string, clarity: number,
 *   quality: 'auto'|'high'|'points', interact: boolean, joinPools: boolean}} EmitterSpec */

/** what a new Fluid emitter is stamped with: a gentle pour onto the ground under it */
export const EMITTER_DEFAULTS = Object.freeze({
	version: EMITTER_VERSION,
	generation: 0, // bumped by "Restart": every peer empties and starts pouring again
	on: true,
	mode: /** @type {'stream'} */ ('stream'),
	rate: 260, // particles per second
	speed: 1.6, // m/s out of the nozzle
	spread: 8, // degrees, the half-angle of the nozzle cone
	amount: 900, // particles a burst (spill) releases
	dir: Object.freeze([0, -1, 0]), // nozzle direction, emitter-local
	maxParticles: 2400,
	lifetime: 20, // s
	area: Object.freeze({ size: Object.freeze([3, 2.4, 3]), offset: Object.freeze([0, -0.9, 0]) }),
	floor: true, // the area's bottom face holds water (off: it falls out and is gone)
	particleSize: 0.05, // m between particles at rest
	viscosity: 0.05,
	surfaceTension: 0.5,
	cohesion: 0.3, // 0..1: an open fluid gathers into drops and puddles (fluidCore)
	friction: 0.15, // 0..1: a puddle settles on the floor / a box instead of skating off it
	gravityScale: 1,
	color: '#3a92d8',
	clarity: 0.6,
	quality: /** @type {'auto'} */ ('auto'),
	interact: true, // collide with the scene's meshes (each mesh's "Fluid interaction" decides how)
	joinPools: true // water reaching a W1 water volume joins it (is swallowed, with a ripple)
});

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** @param {any} a @param {readonly number[]} d @param {number} lo @param {number} hi */
const vec3 = (a, d, lo, hi) => (Array.isArray(a) && a.length === 3 ? a.map((x, i) => clampNum(x, d[i], lo, hi)) : d.slice());

/**
 * THE boundary for `userData.fluidEmitter` (a peer's bytes, a file): every field typed and
 * clamped, garbage takes the default, and the area is shrunk until its grid fits MAX_CELLS.
 * @param {any} raw @returns {EmitterSpec}
 */
export function normalizeEmitter(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = EMITTER_DEFAULTS;
	const a = r.area && typeof r.area === 'object' ? r.area : {};
	const particleSize = clampNum(r.particleSize, d.particleSize, 0.025, 0.12);
	let dir = vec3(r.dir, d.dir, -1, 1);
	if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-3) dir = d.dir.slice();
	const size = fitArea(vec3(a.size, d.area.size, 0.3, MAX_AREA_SIDE), particleSize);
	return {
		version: EMITTER_VERSION,
		generation: Math.round(clampNum(r.generation, 0, 0, 1e9)),
		on: r.on !== false,
		mode: r.mode === 'burst' ? 'burst' : 'stream',
		rate: clampNum(r.rate, d.rate, 0, 3000),
		speed: clampNum(r.speed, d.speed, 0, 12),
		spread: clampNum(r.spread, d.spread, 0, 90),
		amount: Math.round(clampNum(r.amount, d.amount, 1, EMITTER_MAX_PARTICLES)),
		dir,
		maxParticles: Math.round(clampNum(r.maxParticles, d.maxParticles, 64, EMITTER_MAX_PARTICLES)),
		lifetime: clampNum(r.lifetime, d.lifetime, 0.5, 600),
		area: { size, offset: vec3(a.offset, d.area.offset, -MAX_AREA_SIDE, MAX_AREA_SIDE) },
		floor: r.floor !== false,
		particleSize,
		viscosity: clampNum(r.viscosity, d.viscosity, 0, 1),
		surfaceTension: clampNum(r.surfaceTension, d.surfaceTension, 0, 2),
		cohesion: clampNum(r.cohesion, d.cohesion, 0, 1),
		friction: clampNum(r.friction, d.friction, 0, 1),
		gravityScale: clampNum(r.gravityScale, d.gravityScale, -2, 4),
		color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
		clarity: clampNum(r.clarity, d.clarity, 0, 1),
		quality: r.quality === 'high' || r.quality === 'points' ? r.quality : 'auto',
		interact: r.interact !== false,
		joinPools: r.joinPools !== false
	};
}

/**
 * Shrink an area (uniformly) until its neighbour grid — cell = 2 × particleSize — fits
 * MAX_CELLS. A 16 m cube of 5 cm water would be 4 M cells: 16 MB and a per-step clear.
 * @param {number[]} size @param {number} particleSize @returns {number[]}
 */
export function fitArea(size, particleSize) {
	const cell = 2 * particleSize;
	const cells = (/** @type {number[]} */ s) => s.reduce((n, v) => n * Math.max(1, Math.ceil(v / cell)), 1);
	let s = size.slice();
	for (let i = 0; i < 40 && cells(s) > MAX_CELLS; i++) s = s.map((v) => Math.max(0.3, v * 0.9));
	return s.map((v) => Math.round(v * 1000) / 1000);
}

/** the particle cap this peer runs at @param {EmitterSpec} spec @param {boolean} low */
export function capFor(spec, low) {
	return low ? Math.min(spec.maxParticles, QUEST_EMITTER_CAP) : spec.maxParticles;
}

/**
 * The solver box (area-local) and the wall mask: open everywhere but the floor (when on).
 * @param {EmitterSpec} spec
 */
export function domainOf(spec) {
	const h = spec.area.size.map((v) => v / 2);
	return {
		min: [-h[0], -h[1], -h[2]],
		max: [h[0], h[1], h[2]],
		walls: [false, false, spec.floor, false, false, false]
	};
}

/**
 * How many particles to release this frame (rate × dt, carried between frames), never past
 * the cap, and in burst mode never past what is left of `amount` this generation.
 * @param {EmitterSpec} spec @param {{carry: number, released: number}} acc @param {number} dt @param {number} alive @param {number} cap
 */
export function releaseCount(spec, acc, dt, alive, cap) {
	if (!spec.on || spec.rate <= 0) {
		acc.carry = 0;
		return 0;
	}
	acc.carry += spec.rate * dt;
	let n = Math.floor(acc.carry);
	acc.carry -= n;
	n = Math.min(n, Math.max(0, cap - alive), 400); // never more than 400 in one frame (a stalled tab)
	if (spec.mode === 'burst') n = Math.min(n, Math.max(0, spec.amount - acc.released));
	acc.released += n;
	return Math.max(0, n);
}

/**
 * `n` new particles at the nozzle: positions in a small disc across the stream, directions
 * in a cone of half-angle `spread` around `dirW` (world, unit). Seeded so a test is exact.
 * @param {number} n @param {number[]} nozzle area-local @param {number[]} dirW @param {number} speed
 * @param {number} spread degrees @param {number} particleSize @param {{seed: number}} rng
 * @returns {Float32Array} [x,y,z,vx,vy,vz]*
 */
export function nozzleBatch(n, nozzle, dirW, speed, spread, particleSize, rng) {
	const out = new Float32Array(n * 6);
	const rand = () => ((rng.seed = (rng.seed * 16807) % 2147483647) / 2147483647);
	// an orthonormal basis around the direction
	const [dx, dy, dz] = dirW;
	const ax = Math.abs(dx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	let ux = dy * ax[2] - dz * ax[1], uy = dz * ax[0] - dx * ax[2], uz = dx * ax[1] - dy * ax[0];
	const ul = Math.hypot(ux, uy, uz) || 1;
	ux /= ul; uy /= ul; uz /= ul;
	const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
	const tanS = Math.tan((Math.min(spread, 89) * Math.PI) / 180);
	const discR = particleSize * 1.2;
	for (let i = 0; i < n; i++) {
		const a = rand() * Math.PI * 2;
		const r = Math.sqrt(rand());
		const ca = Math.cos(a), sa = Math.sin(a);
		const t = tanS * r;
		let ex = dx + (ux * ca + vx * sa) * t, ey = dy + (uy * ca + vy * sa) * t, ez = dz + (uz * ca + vz * sa) * t;
		const el = Math.hypot(ex, ey, ez) || 1;
		const sp = speed * (0.9 + 0.2 * rand());
		const k = i * 6;
		out[k] = nozzle[0] + (ux * ca + vx * sa) * discR * r;
		out[k + 1] = nozzle[1] + (uy * ca + vy * sa) * discR * r;
		out[k + 2] = nozzle[2] + (uz * ca + vz * sa) * discR * r;
		out[k + 3] = (ex / el) * sp;
		out[k + 4] = (ey / el) * sp;
		out[k + 5] = (ez / el) * sp;
	}
	return out;
}

/**
 * Add a batch of [x,y,z,vx,vy,vz]* to a solver (the worker's half of an emitter step).
 * @param {{spawn: (at: number[], vel: number[]) => boolean}} solver @param {Float32Array | number[] | null | undefined} batch
 */
export function spawnBatch(solver, batch) {
	if (!batch) return 0;
	let made = 0;
	const at = [0, 0, 0], vel = [0, 0, 0];
	for (let k = 0; k + 5 < batch.length; k += 6) {
		at[0] = batch[k]; at[1] = batch[k + 1]; at[2] = batch[k + 2];
		vel[0] = batch[k + 3]; vel[1] = batch[k + 4]; vel[2] = batch[k + 5];
		if (!solver.spawn(at, vel)) break;
		made++;
	}
	return made;
}

/**
 * SINKS: area-local boxes that swallow particles — a W1 water volume (the fluid joins the
 * pool) or a drain. Returns where a few of them went in (for a ripple each), at most `cap`.
 * @param {{count: number, x: Float32Array, remove: (i: number) => void}} solver
 * @param {{min: number[], max: number[]}[] | null | undefined} sinks @param {number} cap
 * @returns {number[]} [x,y,z]* of up to `cap` swallowed particles
 */
export function applySinks(solver, sinks, cap = 8) {
	/** @type {number[]} */
	const hits = [];
	if (!sinks?.length) return hits;
	const x = solver.x;
	for (let i = solver.count - 1; i >= 0; i--) {
		const k = i * 3;
		const px = x[k], py = x[k + 1], pz = x[k + 2];
		for (const s of sinks) {
			if (px < s.min[0] || px > s.max[0] || py < s.min[1] || py > s.max[1] || pz < s.min[2] || pz > s.max[2]) continue;
			if (hits.length < cap * 3) hits.push(px, py, pz);
			solver.remove(i);
			break;
		}
	}
	return hits;
}

// ---------------------------------------------------------------- S3: ONE scene-wide budget

/** the scene's particle budget across ALL Fluid emitters when it sets none */
export const DEFAULT_FLUID_BUDGET = 8000;
export const MIN_FLUID_BUDGET = 200;
export const MAX_FLUID_BUDGET = 20000;
/** a headset's total, whatever the scene allows (drops, every eye renders them) */
export const QUEST_FLUID_BUDGET = 1400;

/** @param {any} v @returns {number} the scene budget (scenePhysics.fluidBudget) */
export function normalizeFluidBudget(v) {
	return Math.round(clampNum(v, DEFAULT_FLUID_BUDGET, MIN_FLUID_BUDGET, MAX_FLUID_BUDGET));
}

/**
 * The quality governor's share of the budget at `level` (0 = everything): it gives particles
 * up gradually as frames drop, never below a fifth.
 * @param {number} level
 */
export function governorFactor(level) {
	return Math.max(0.2, 1 - Math.max(0, level || 0) * 0.09);
}

/**
 * Split ONE budget over every emitter in proportion to its own max particles, never giving an
 * emitter more than its cap. Pure: every peer with the same scene, level and tier computes the
 * same limits.
 * @param {{uuid: string, maxParticles: number, cap: number}[]} list @param {number} budget
 * @param {number} level the governor level @param {boolean} xr a headset
 * @returns {Map<string, number>}
 */
export function budgetLimits(list, budget, level, xr) {
	const total = Math.floor(Math.min(normalizeFluidBudget(budget) * governorFactor(level), xr ? QUEST_FLUID_BUDGET : Infinity));
	const want = list.reduce((n, e) => n + e.maxParticles, 0);
	/** @type {Map<string, number>} */
	const out = new Map();
	for (const e of list) out.set(e.uuid, Math.max(0, Math.min(e.cap, want > total ? Math.floor((total * e.maxParticles) / want) : e.maxParticles)));
	return out;
}
