// 36-sim U2b: the FLUID TANK solver — Position Based Fluids (Macklin & Müller 2013).
//
// A leaf that imports nothing: the Web Worker runs it (fluid.worker.js), the main thread
// runs it when workers are unavailable, and vitest runs it headless. Everything lives in
// the TANK's local frame (metres): the box [min, max] is the inside of the glass.
//
// WHY PBF and not plain SPH: SPH needs tiny timesteps to stay incompressible and blows up
// when a frame is late; PBF solves density as a position constraint, so it is stable at
// one 1/60 s step with three iterations — what a browser frame budget can afford for
// 1-8k particles. Viscosity is XSPH; surface tension is the artificial-pressure term
// (s_corr), which clumps a free surface into drops and a skin instead of a mist.
//
// LOCAL PER PEER (documented in MODULES/the docs fragment): the particles are never sent.
// What replicates is the tank's `userData.fluid` (count, viscosity, emitter…), so every
// peer pours the same fluid with the same settings and sees its own splash.

export const FLUID_VERSION = 1;
export const FLUID_MAX_PARTICLES = 8000;
/** wall thickness of the tank builder (m) — the fluid fills the inside of the glass */
export const TANK_WALL = 0.03;
export const FLUID_MIN_PARTICLES = 64;
const MAX_NEIGHBORS = 48;
const ITERATIONS = 3;
const RELAX = 0.05; // ε in λ = -C / (Σ|∇C|² + ε), as a fraction of a full neighbourhood's Σ|∇C|²
const MAX_SPEED = 12; // m/s: a particle never outruns this (no tunnelling through the glass)

/** @typedef {{version: number, generation: number, count: number, fill: number, viscosity: number, surfaceTension: number,
 *   gravityScale: number, color: string, clarity: number, quality: 'auto'|'high'|'points',
 *   emitter: {on: boolean, rate: number, speed: number, at: number[], dir: number[]},
 *   drain: {on: boolean, rate: number, at: number[], radius: number}}} FluidSpec */

/** the defaults a new Fluid tank is stamped with */
export const FLUID_DEFAULTS = Object.freeze({
	version: FLUID_VERSION,
	generation: 0, // bumped by "Refill": every peer restarts its tank from the fill
	count: 3000,
	fill: 0.45, // fraction of the tank filled at start
	viscosity: 0.05, // XSPH 0..1
	surfaceTension: 0.5, // 0..2 (scales s_corr)
	gravityScale: 1,
	color: '#2f8fd8',
	clarity: 0.55, // 0 murky .. 1 clear
	quality: /** @type {'auto'} */ ('auto'), // auto = screen-space on desktop, points on Quest/low tiers
	emitter: Object.freeze({ on: false, rate: 400, speed: 2, at: Object.freeze([0.2, 0.95, 0.5]), dir: Object.freeze([0.4, -1, 0]) }),
	drain: Object.freeze({ on: false, rate: 400, at: Object.freeze([0.8, 0, 0.5]), radius: 0.08 })
});

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** @param {any} a @param {readonly number[]} d @param {number} lo @param {number} hi */
const vec3 = (a, d, lo, hi) => (Array.isArray(a) && a.length === 3 ? a.map((x, i) => clampNum(x, d[i], lo, hi)) : d.slice());

/**
 * The ONE boundary for `userData.fluid` (a peer's bytes, a file): every field typed and
 * clamped; garbage takes the default.
 * @param {any} raw @returns {FluidSpec}
 */
export function normalizeFluid(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = FLUID_DEFAULTS;
	const e = r.emitter && typeof r.emitter === 'object' ? r.emitter : {};
	const g = r.drain && typeof r.drain === 'object' ? r.drain : {};
	return {
		version: FLUID_VERSION,
		generation: Math.round(clampNum(r.generation, 0, 0, 1e9)),
		count: Math.round(clampNum(r.count, d.count, FLUID_MIN_PARTICLES, FLUID_MAX_PARTICLES)),
		fill: clampNum(r.fill, d.fill, 0, 0.95),
		viscosity: clampNum(r.viscosity, d.viscosity, 0, 1),
		surfaceTension: clampNum(r.surfaceTension, d.surfaceTension, 0, 2),
		gravityScale: clampNum(r.gravityScale, d.gravityScale, -2, 4),
		color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
		clarity: clampNum(r.clarity, d.clarity, 0, 1),
		quality: r.quality === 'high' || r.quality === 'points' ? r.quality : 'auto',
		emitter: {
			on: e.on === true,
			rate: clampNum(e.rate, d.emitter.rate, 0, 4000),
			speed: clampNum(e.speed, d.emitter.speed, 0, 10),
			at: vec3(e.at, d.emitter.at, 0, 1),
			dir: vec3(e.dir, d.emitter.dir, -1, 1)
		},
		drain: {
			on: g.on === true,
			rate: clampNum(g.rate, d.drain.rate, 0, 4000),
			at: vec3(g.at, d.drain.at, 0, 1),
			radius: clampNum(g.radius, d.drain.radius, 0.01, 1)
		}
	};
}

/**
 * Particle spacing for `count` particles filling `fill` of a tank of inside size `size`.
 * @param {number[]} size @param {number} count @param {number} fill
 */
export function spacingFor(size, count, fill) {
	const vol = size[0] * size[1] * size[2] * Math.max(fill, 0.05);
	return Math.cbrt(vol / Math.max(count, 1));
}

/**
 * @typedef {{kind: 'box'|'sphere', center: number[], half: number[], quat: number[],
 *   vel?: number[], id?: string, dynamic?: boolean}} FluidCollider  tank-local
 */

/**
 * One tank's particles + solver. `min`/`max` = the inside of the glass (tank-local).
 */
export class FluidSolver {
	/**
	 * @param {{min: number[], max: number[], capacity: number, spacing: number}} o
	 */
	constructor(o) {
		this.min = o.min.slice();
		this.max = o.max.slice();
		this.capacity = Math.min(FLUID_MAX_PARTICLES, Math.max(1, o.capacity | 0));
		this.s = o.spacing;
		this.h = 2 * o.spacing;
		this.radius = o.spacing * 0.5;
		this.count = 0;
		const n = this.capacity;
		this.x = new Float32Array(n * 3);
		this.v = new Float32Array(n * 3);
		this.p = new Float32Array(n * 3);
		this.lambda = new Float32Array(n);
		this.dp = new Float32Array(n * 3);
		this.nbr = new Int32Array(n * MAX_NEIGHBORS);
		this.nbrCount = new Uint8Array(n);
		// dense grid over the tank (cell = h)
		this.cell = this.h;
		this.dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((this.max[a] - this.min[a]) / this.cell)));
		const cells = this.dims[0] * this.dims[1] * this.dims[2];
		this.cellStart = new Int32Array(cells + 1);
		this.cellOf = new Int32Array(n);
		this.sorted = new Int32Array(n);
		const h = this.h;
		this.poly6K = 315 / (64 * Math.PI * h ** 9);
		this.spikyK = -45 / (Math.PI * h ** 6);
		this.h2 = h * h;
		this.wallRho = new Float32Array(1);
		this.wallGrad = new Float32Array(1);
		this.wallBins = 1;
		this.rho0 = this.restDensity();
		this.eps = RELAX * this.restGradSum();
		this.buildWallTables();
		this.scorrW = this.poly6((0.2 * h) ** 2);
		/** @type {Record<string, number[]>} collider id -> impulse accumulated this step (tank-local, N·s per kg of particle mass) */
		this.impulses = {};
		/** particle mass in kg if the fluid were water: spacing^3 x 1000 */
		this.particleMass = 1000 * o.spacing ** 3;
	}

	/** @param {number} r2 */
	poly6(r2) {
		if (r2 >= this.h2) return 0;
		const d = this.h2 - r2;
		return this.poly6K * d * d * d;
	}

	/** density of a particle inside a perfect lattice at this spacing (mass 1) */
	restDensity() {
		let rho = 0;
		const s = this.s;
		const k = Math.ceil(this.h / s);
		for (let i = -k; i <= k; i++)
			for (let j = -k; j <= k; j++)
				for (let l = -k; l <= k; l++) rho += this.poly6((i * i + j * j + l * l) * s * s);
		return rho;
	}

	/**
	 * THE GLASS AS FLUID. A particle near a wall has half a neighbourhood, so its density
	 * never reaches rest and the column slumps (measured: a 0.36 m fill settled at 0.28).
	 * The wall instead contributes what a half-space of lattice particles beyond it would:
	 * density and the normal gradient, tabulated once by distance from the wall.
	 */
	buildWallTables() {
		const BINS = 64;
		const s = this.s;
		const h = this.h;
		const k = Math.ceil(h / s) + 1;
		this.wallRho = new Float32Array(BINS + 1);
		this.wallGrad = new Float32Array(BINS + 1);
		for (let b = 0; b <= BINS; b++) {
			const d = (b / BINS) * h; // particle height above the wall plane
			let rho = 0;
			let g = 0;
			for (let i = -k; i <= k; i++)
				for (let l = -k; l <= k; l++)
					for (let j = 0; j < k; j++) {
						const qy = -s * 0.5 - j * s; // virtual particles below the wall
						const dx = i * s, dz = l * s, dy = d - qy;
						const r2 = dx * dx + dy * dy + dz * dz;
						if (r2 >= this.h2) continue;
						rho += this.poly6(r2);
						const r = Math.sqrt(r2);
						if (r > 1e-9) g += (this.spikyK * (h - r) * (h - r) * (dy / r)) / this.rho0;
					}
			this.wallRho[b] = rho;
			this.wallGrad[b] = g; // along +normal (into the fluid); negative: points into the wall
		}
		this.wallBins = BINS;
	}

	/** @param {number} d distance above a wall @returns {number} table index (or -1 out of range) */
	wallBin(d) {
		if (d >= this.h) return -1;
		return Math.max(0, Math.min(this.wallBins, Math.round((d / this.h) * this.wallBins)));
	}

	/** Σ|∇C|² of a particle inside the perfect lattice — the scale ε is relative to */
	restGradSum() {
		const s = this.s;
		const h = this.h;
		const k = Math.ceil(h / s);
		let gx = 0, sum2 = 0;
		for (let i = -k; i <= k; i++)
			for (let j = -k; j <= k; j++)
				for (let l = -k; l <= k; l++) {
					const r = Math.sqrt(i * i + j * j + l * l) * s;
					if (r < 1e-9 || r >= h) continue;
					const w = (this.spikyK * (h - r) * (h - r)) / this.rho0;
					sum2 += w * w;
					gx += w * (i * s / r);
				}
		return sum2 + gx * gx;
	}

	/**
	 * Fill the bottom `fill` of the tank with a jittered lattice (seeded: the same tank
	 * starts the same on every peer, though it then diverges — the sim is local).
	 * @param {number} fill @param {number} count
	 */
	fillBlock(fill, count) {
		const s = this.s;
		const r = this.radius;
		let seed = 1234567;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2 * s;
		const top = this.min[1] + (this.max[1] - this.min[1]) * fill;
		this.count = 0;
		for (let y = this.min[1] + r; y < this.max[1] - r && this.count < count; y += s) {
			for (let z = this.min[2] + r; z < this.max[2] - r && this.count < count; z += s)
				for (let x = this.min[0] + r; x < this.max[0] - r && this.count < count; x += s) {
					if (y > top + s * 4) break;
					const i = this.count++ * 3;
					this.x[i] = x + rand();
					this.x[i + 1] = y + rand();
					this.x[i + 2] = z + rand();
					this.v[i] = this.v[i + 1] = this.v[i + 2] = 0;
				}
		}
		return this.count;
	}

	/** add one particle (an emitter) @param {number[]} at @param {number[]} vel */
	spawn(at, vel) {
		if (this.count >= this.capacity) return false;
		const i = this.count++ * 3;
		for (let a = 0; a < 3; a++) {
			this.x[i + a] = Math.min(this.max[a] - this.radius, Math.max(this.min[a] + this.radius, at[a]));
			this.v[i + a] = vel[a];
		}
		return true;
	}

	/** swap-remove particle i @param {number} i */
	remove(i) {
		const last = --this.count;
		if (i !== last)
			for (let a = 0; a < 3; a++) {
				this.x[i * 3 + a] = this.x[last * 3 + a];
				this.v[i * 3 + a] = this.v[last * 3 + a];
			}
	}

	/** counting-sort the predicted positions into the dense grid, then gather neighbours */
	buildNeighbors() {
		const { p, dims, cell, min, count, cellStart, cellOf, sorted, nbr, nbrCount, h2 } = this;
		const cells = dims[0] * dims[1] * dims[2];
		cellStart.fill(0);
		for (let i = 0; i < count; i++) {
			const cx = Math.min(dims[0] - 1, Math.max(0, Math.floor((p[i * 3] - min[0]) / cell)));
			const cy = Math.min(dims[1] - 1, Math.max(0, Math.floor((p[i * 3 + 1] - min[1]) / cell)));
			const cz = Math.min(dims[2] - 1, Math.max(0, Math.floor((p[i * 3 + 2] - min[2]) / cell)));
			const c = (cz * dims[1] + cy) * dims[0] + cx;
			cellOf[i] = c;
			cellStart[c + 1]++;
		}
		for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
		const fillAt = cellStart.slice(0, cells);
		for (let i = 0; i < count; i++) sorted[fillAt[cellOf[i]]++] = i;
		for (let i = 0; i < count; i++) {
			const c = cellOf[i];
			const cx = c % dims[0];
			const cy = Math.floor(c / dims[0]) % dims[1];
			const cz = Math.floor(c / (dims[0] * dims[1]));
			const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2];
			let n = 0;
			const base = i * MAX_NEIGHBORS;
			for (let dz = -1; dz <= 1; dz++) {
				const z = cz + dz;
				if (z < 0 || z >= dims[2]) continue;
				for (let dy = -1; dy <= 1; dy++) {
					const y = cy + dy;
					if (y < 0 || y >= dims[1]) continue;
					for (let dx = -1; dx <= 1; dx++) {
						const x = cx + dx;
						if (x < 0 || x >= dims[0]) continue;
						const cc = (z * dims[1] + y) * dims[0] + x;
						for (let k = cellStart[cc]; k < cellStart[cc + 1] && n < MAX_NEIGHBORS; k++) {
							const j = sorted[k];
							if (j === i) continue;
							const rx = px - p[j * 3], ry = py - p[j * 3 + 1], rz = pz - p[j * 3 + 2];
							if (rx * rx + ry * ry + rz * rz < h2) nbr[base + n++] = j;
						}
					}
				}
			}
			nbrCount[i] = n;
		}
	}

	/**
	 * Keep a predicted position inside the glass and outside every collider. Dynamic
	 * colliders take the reaction (momentum the particle lost) into `impulses`.
	 * @param {number} i @param {FluidCollider[]} colliders @param {number} dt
	 */
	collide(i, colliders, dt) {
		const p = this.p;
		const r = this.radius;
		const k = i * 3;
		for (let a = 0; a < 3; a++) {
			if (p[k + a] < this.min[a] + r) p[k + a] = this.min[a] + r;
			else if (p[k + a] > this.max[a] - r) p[k + a] = this.max[a] - r;
		}
		for (const c of colliders) {
			// into the collider's frame (inverse quat)
			const qx = -c.quat[0], qy = -c.quat[1], qz = -c.quat[2], qw = c.quat[3];
			const lx0 = p[k] - c.center[0], ly0 = p[k + 1] - c.center[1], lz0 = p[k + 2] - c.center[2];
			if (c.kind === 'sphere') {
				const rr = c.half[0] + r;
				const d2 = lx0 * lx0 + ly0 * ly0 + lz0 * lz0;
				if (d2 >= rr * rr || d2 < 1e-12) continue;
				const d = Math.sqrt(d2);
				const push = (rr - d) / d;
				p[k] += lx0 * push;
				p[k + 1] += ly0 * push;
				p[k + 2] += lz0 * push;
				if (c.dynamic && c.id) this.react(c.id, -lx0 * push, -ly0 * push, -lz0 * push, dt);
				continue;
			}
			// box: rotate into box space
			let [lx, ly, lz] = rotq(qx, qy, qz, qw, lx0, ly0, lz0);
			const ex = c.half[0] + r, ey = c.half[1] + r, ez = c.half[2] + r;
			if (Math.abs(lx) >= ex || Math.abs(ly) >= ey || Math.abs(lz) >= ez) continue;
			// out along the axis of least penetration
			const px = ex - Math.abs(lx), py = ey - Math.abs(ly), pz = ez - Math.abs(lz);
			let ox = 0, oy = 0, oz = 0;
			if (px <= py && px <= pz) ox = lx > 0 ? px : -px;
			else if (py <= pz) oy = ly > 0 ? py : -py;
			else oz = lz > 0 ? pz : -pz;
			const [wx, wy, wz] = rotq(c.quat[0], c.quat[1], c.quat[2], c.quat[3], ox, oy, oz);
			p[k] += wx;
			p[k + 1] += wy;
			p[k + 2] += wz;
			if (c.dynamic && c.id) this.react(c.id, -wx, -wy, -wz, dt);
		}
	}

	/** @param {string} id @param {number} dx @param {number} dy @param {number} dz @param {number} dt */
	react(id, dx, dy, dz, dt) {
		const j = (this.impulses[id] ??= [0, 0, 0]);
		// the particle's momentum change, pushed back into the body (kg·m/s)
		const m = this.particleMass / dt;
		j[0] += dx * m;
		j[1] += dy * m;
		j[2] += dz * m;
	}

	/**
	 * One frame. `gravity` is tank-local (the tank may be tilted). Returns the active count.
	 * @param {number} dt
	 * @param {{gravity: number[], viscosity: number, surfaceTension: number, colliders?: FluidCollider[]}} o
	 */
	step(dt, o) {
		const { x, v, p, lambda, dp, nbr, nbrCount } = this;
		const n = this.count;
		const colliders = o.colliders ?? [];
		// the reaction on dynamic bodies is counted once, in the final pass
		const quiet = colliders.map((c) => (c.dynamic ? { ...c, dynamic: false } : c));
		this.impulses = {};
		if (!n) return 0;
		dt = Math.min(dt, 1 / 30);
		const g = o.gravity;
		// 1. predict
		for (let i = 0; i < n; i++) {
			const k = i * 3;
			v[k] += g[0] * dt;
			v[k + 1] += g[1] * dt;
			v[k + 2] += g[2] * dt;
			const sp = Math.hypot(v[k], v[k + 1], v[k + 2]);
			if (sp > MAX_SPEED) {
				const f = MAX_SPEED / sp;
				v[k] *= f;
				v[k + 1] *= f;
				v[k + 2] *= f;
			}
			p[k] = x[k] + v[k] * dt;
			p[k + 1] = x[k + 1] + v[k + 1] * dt;
			p[k + 2] = x[k + 2] + v[k + 2] * dt;
		}
		// 2. neighbours on the predicted positions
		this.buildNeighbors();
		const rho0 = this.rho0;
		const h = this.h;
		const sk = this.spikyK;
		const p6k = this.poly6K;
		const h2 = this.h2;
		const scorrK = 0.0012 * o.surfaceTension * this.h2;
		const invScorrW = 1 / this.scorrW;
		// 3. density constraint iterations
		for (let it = 0; it < ITERATIONS; it++) {
			for (let i = 0; i < n; i++) {
				const k = i * 3;
				let rho = p6k * h2 * h2 * h2;
				let gx = 0, gy = 0, gz = 0, sum2 = 0;
				const base = i * MAX_NEIGHBORS;
				for (let q = 0; q < nbrCount[i]; q++) {
					const j = nbr[base + q] * 3;
					const rx = p[k] - p[j], ry = p[k + 1] - p[j + 1], rz = p[k + 2] - p[j + 2];
					const r2 = rx * rx + ry * ry + rz * rz;
					if (r2 >= h2) continue;
					const d6 = h2 - r2;
					rho += p6k * d6 * d6 * d6;
					const r = Math.sqrt(r2);
					if (r > 1e-9 && r < h) {
						const w = (sk * (h - r) * (h - r)) / (r * rho0);
						const wx = w * rx, wy = w * ry, wz = w * rz;
						gx += wx;
						gy += wy;
						gz += wz;
						sum2 += wx * wx + wy * wy + wz * wz;
					}
				}
				// the six walls of the glass (an open top is still a wall: the lid is the
				// tank's top face; the fluid never reaches it in a sane fill)
				for (let a = 0; a < 3; a++) {
					const lo = this.wallBin(p[k + a] - this.min[a]);
					if (lo >= 0) {
						rho += this.wallRho[lo];
						const w = this.wallGrad[lo];
						if (a === 0) gx += w; else if (a === 1) gy += w; else gz += w;
					}
					const hi = this.wallBin(this.max[a] - p[k + a]);
					if (hi >= 0) {
						rho += this.wallRho[hi];
						const w = -this.wallGrad[hi];
						if (a === 0) gx += w; else if (a === 1) gy += w; else gz += w;
					}
				}
				sum2 += gx * gx + gy * gy + gz * gz;
				// clamped: a free surface is under-dense, and letting C go negative pulls it
				// together into a boiling skin (measured mean |v| 0.5 m/s at rest unclamped,
				// 0.09 clamped); the surface-tension term below is what holds drops together
				const C = Math.max(rho / rho0 - 1, 0);
				lambda[i] = -C / (sum2 + this.eps);
			}
			for (let i = 0; i < n; i++) {
				const k = i * 3;
				let dx = 0, dy = 0, dz = 0;
				const base = i * MAX_NEIGHBORS;
				for (let q = 0; q < nbrCount[i]; q++) {
					const jj = nbr[base + q];
					const j = jj * 3;
					const rx = p[k] - p[j], ry = p[k + 1] - p[j + 1], rz = p[k + 2] - p[j + 2];
					const r2 = rx * rx + ry * ry + rz * rz;
					const r = Math.sqrt(r2);
					if (r <= 1e-9 || r >= h) continue;
					const d6 = h2 - r2;
					const ratio = p6k * d6 * d6 * d6 * invScorrW;
					const scorr = -scorrK * ratio * ratio * ratio * ratio;
					const w = ((lambda[i] + lambda[jj] + scorr) * sk * (h - r) * (h - r)) / (r * rho0);
					dx += w * rx;
					dy += w * ry;
					dz += w * rz;
				}
				// the walls push back with the particle's own λ (a mirrored neighbour)
				for (let a = 0; a < 3; a++) {
					const lo = this.wallBin(p[k + a] - this.min[a]);
					const hi = this.wallBin(this.max[a] - p[k + a]);
					let w = 0;
					if (lo >= 0) w += this.wallGrad[lo];
					if (hi >= 0) w -= this.wallGrad[hi];
					if (!w) continue;
					const push = 2 * lambda[i] * w;
					if (a === 0) dx += push; else if (a === 1) dy += push; else dz += push;
				}
				dp[k] = dx;
				dp[k + 1] = dy;
				dp[k + 2] = dz;
			}
			const last = it === ITERATIONS - 1;
			for (let i = 0; i < n; i++) {
				const k = i * 3;
				p[k] += dp[k];
				p[k + 1] += dp[k + 1];
				p[k + 2] += dp[k + 2];
				this.collide(i, last ? colliders : quiet, dt);
			}
		}
		// 4. velocity from the corrected positions, then XSPH viscosity
		const inv = 1 / dt;
		for (let i = 0; i < n; i++) {
			const k = i * 3;
			v[k] = (p[k] - x[k]) * inv;
			v[k + 1] = (p[k + 1] - x[k + 1]) * inv;
			v[k + 2] = (p[k + 2] - x[k + 2]) * inv;
		}
		const visc = o.viscosity * 0.5;
		if (visc > 0) {
			const w0 = 1 / this.poly6(0);
			for (let i = 0; i < n; i++) {
				const k = i * 3;
				let ax = 0, ay = 0, az = 0;
				const base = i * MAX_NEIGHBORS;
				for (let q = 0; q < nbrCount[i]; q++) {
					const j = nbr[base + q] * 3;
					const rx = p[k] - p[j], ry = p[k + 1] - p[j + 1], rz = p[k + 2] - p[j + 2];
					const w = this.poly6(rx * rx + ry * ry + rz * rz) * w0;
					ax += (v[j] - v[k]) * w;
					ay += (v[j + 1] - v[k + 1]) * w;
					az += (v[j + 2] - v[k + 2]) * w;
				}
				// stored in dp (free now) so every particle reads the same old velocities
				dp[k] = ax;
				dp[k + 1] = ay;
				dp[k + 2] = az;
			}
			const c = Math.min(visc, 0.5) / Math.max(1, MAX_NEIGHBORS / 8);
			for (let i = 0; i < n * 3; i++) v[i] += c * dp[i];
		}
		x.set(p.subarray(0, n * 3));
		return n;
	}
}

/** rotate (x,y,z) by quaternion (qx,qy,qz,qw) @returns {[number, number, number]} */
function rotq(/** @type {number} */ qx, /** @type {number} */ qy, /** @type {number} */ qz, /** @type {number} */ qw, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

/**
 * Emitter + drain for one frame (spawns at the emitter, swallows near the drain), in
 * normalized tank coordinates (0..1 of the inside box).
 * @param {FluidSolver} s @param {FluidSpec} spec @param {number} dt @param {{carry: number, drainCarry: number}} acc
 */
export function pourAndDrain(s, spec, dt, acc) {
	const size = [0, 1, 2].map((a) => s.max[a] - s.min[a]);
	const at = (/** @type {number[]} */ u) => u.map((t, a) => s.min[a] + t * size[a]);
	let made = 0;
	let gone = 0;
	if (spec.emitter.on && s.count < Math.min(spec.count, s.capacity)) {
		acc.carry += spec.emitter.rate * dt;
		const e = at(spec.emitter.at);
		const d = spec.emitter.dir;
		const len = Math.hypot(d[0], d[1], d[2]) || 1;
		const vel = d.map((c) => (c / len) * spec.emitter.speed);
		let k = 0;
		while (acc.carry >= 1 && s.count < Math.min(spec.count, s.capacity)) {
			acc.carry -= 1;
			// a small disc of nozzles so a stream has a width
			const ang = k * 2.39996;
			const rad = s.s * 0.9 * Math.sqrt((k % 7) + 1);
			s.spawn([e[0] + Math.cos(ang) * rad, e[1], e[2] + Math.sin(ang) * rad], vel);
			k++;
			made++;
		}
	} else acc.carry = 0;
	if (spec.drain.on) {
		acc.drainCarry += spec.drain.rate * dt;
		const d = at(spec.drain.at);
		const r2 = spec.drain.radius * spec.drain.radius;
		for (let i = s.count - 1; i >= 0 && acc.drainCarry >= 1; i--) {
			const k = i * 3;
			const dx = s.x[k] - d[0], dy = s.x[k + 1] - d[1], dz = s.x[k + 2] - d[2];
			if (dx * dx + dy * dy + dz * dz < r2 + s.s * s.s) {
				s.remove(i);
				acc.drainCarry -= 1;
				gone++;
			}
		}
		if (acc.drainCarry > spec.drain.rate) acc.drainCarry = spec.drain.rate; // nothing near the drain: no backlog
	} else acc.drainCarry = 0;
	return { made, gone };
}
