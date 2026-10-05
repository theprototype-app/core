// 36-sim I1: BUOYANCY for rapier dynamic bodies inside a water volume (contract W1).
//
// A LEAF that imports nothing, so its maths is a vitest unit and the rapier proof in
// tests/unit/buoyancy.test.js drives the very functions physics.js calls.
//
// THE MODEL. Each body carries a fixed set of SAMPLE POINTS in its own frame (a small
// grid filling every collider, `shapeSamples`), each owning a share of the body's volume.
// Per substep a sample is a short vertical SLAB: its submerged fraction is how much of
// that slab lies under the local surface, so the force grows smoothly as the body sinks
// instead of stepping as each point crosses the line (a stepped force is what makes a
// floating crate buzz). The force on a sample is applied AT the sample, so a tipped
// crate rights itself and a long plank lies flat — no separate righting torque.
//
// WHY DENSITY AND NOT MASS. Scenes author `mass` for how a thing feels to push (the
// default is 1 kg for a 1 m crate — 1 kg/m^3, lighter than air). Deriving buoyancy from
// mass/volume would float every existing object like a soap bubble, so the body's
// density is its own knob (`floats.density`, default 500 = floats half under) and the
// force is scaled by the body's mass: F = m g (rho_water / rho_body) x submerged share.
// That makes the DRAFT depend only on the density ratio — a 1 kg and a 30 kg crate of
// "wood" sit equally deep — and `density: 'mass'` opts into the physical mass/volume.
//
// AUTHORITY. Physics is authoritative (golden rule 8): only the initiator has a world,
// so only it computes this, and every peer sees the result as the ordinary `move`
// stream. The inputs (the water volume's userData, the object's userData.physics.floats,
// the shared clock behind any waves) all replicate, so a simulator handover computes
// the same forces. Nothing here is sent.

/** @typedef {{density?: number | 'mass', multiplier?: number, off?: boolean}} FloatsConfig */

/** densities the Inspector offers (kg/m^3); the first is the default */
export const FLOAT_PRESETS = /** @type {const} */ ({
	auto: 500,
	foam: 150,
	cork: 240,
	wood: 600,
	ice: 917,
	rubber: 1100,
	stone: 2500,
	metal: 7800
});
export const DEFAULT_BODY_DENSITY = FLOAT_PRESETS.auto;
export const WATER_DENSITY = 1000;
const MIN_DENSITY = 10;
const MAX_DENSITY = 20000;
const MAX_MULTIPLIER = 10;
const HEAVE_DRAG = 4;
/** 36-fb-water F12: ADDED MASS — a body accelerating through water drags some water with it
 * (a sphere: half its displaced volume). Without it a foam block released at the pool floor
 * reached 5.7 g and left the water like a rocket (measured: 2.9 m above the surface). */
const ADDED_MASS = 0.5;

/**
 * The ONE boundary for `userData.physics.floats` (replicated bytes from a peer or a
 * file): unknown keys dropped, numbers clamped, garbage -> the default.
 * @param {any} raw
 * @returns {{off: boolean, density: number | 'mass', multiplier: number}}
 */
export function normalizeFloats(raw) {
	const out = { off: false, density: /** @type {number | 'mass'} */ (DEFAULT_BODY_DENSITY), multiplier: 1 };
	if (!raw || typeof raw !== 'object') return out;
	if (raw.off === true) out.off = true;
	if (raw.density === 'mass') out.density = 'mass';
	else if (Number.isFinite(raw.density)) out.density = Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, raw.density));
	if (Number.isFinite(raw.multiplier)) out.multiplier = Math.min(MAX_MULTIPLIER, Math.max(0, raw.multiplier));
	return out;
}

/**
 * Sample points filling one collider shape, in the SHAPE's frame (centred, axis
 * aligned; capsule/cylinder/cone stand along Y — the physics.js shapeDesc convention).
 * `res` cells per axis of the bounding box; points outside a round shape are dropped,
 * and the shape's analytic volume is shared equally by the points kept.
 * @param {string} kind box|sphere|capsule|cylinder|cone|hull
 * @param {{x: number, y: number, z: number}} he half extents (the colliderSpec measure)
 * @param {number} [res]
 * @returns {{points: number[], volume: number, cellH: number}}
 */
export function shapeSamples(kind, he, res = 3) {
	const hx = Math.max(he.x, 1e-3);
	const hy = Math.max(he.y, 1e-3);
	const hz = Math.max(he.z, 1e-3);
	/** @type {(x: number, y: number, z: number) => boolean} */
	let inside = () => true;
	let volume = 8 * hx * hy * hz;
	let bx = hx;
	let by = hy;
	let bz = hz;
	if (kind === 'sphere') {
		const r = Math.max(hx, hy, hz);
		bx = by = bz = r;
		volume = (4 / 3) * Math.PI * r * r * r;
		inside = (x, y, z) => x * x + y * y + z * z <= r * r;
	} else if (kind === 'cylinder' || kind === 'cone' || kind === 'capsule') {
		const r = Math.max(hx, hz, 0.02);
		bx = bz = r;
		if (kind === 'cylinder') {
			volume = Math.PI * r * r * 2 * hy;
			inside = (x, y, z) => x * x + z * z <= r * r;
		} else if (kind === 'cone') {
			// apex at +hy, base at -hy (rapier's cone)
			volume = (Math.PI * r * r * 2 * hy) / 3;
			inside = (x, y, z) => {
				const rr = (r * (hy - y)) / (2 * hy);
				return x * x + z * z <= rr * rr;
			};
		} else {
			const half = Math.max(hy - r, 0.01);
			by = half + r;
			volume = Math.PI * r * r * (2 * half) + (4 / 3) * Math.PI * r * r * r;
			inside = (x, y, z) => {
				const cy = Math.max(-half, Math.min(half, y));
				return x * x + (y - cy) * (y - cy) + z * z <= r * r;
			};
		}
	} else if (kind === 'hull' || kind === 'custom') {
		// a convex hull fills part of its AABB; 0.6 is a decent mean for props (a
		// cube 1.0, a sphere 0.52, a wedge 0.5) and buoyancy only needs the share
		volume *= 0.6;
	}
	const n = kind === 'sphere' || kind === 'cylinder' || kind === 'cone' || kind === 'capsule' ? res + 1 : res;
	/** @type {number[]} */
	const points = [];
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++)
			for (let k = 0; k < n; k++) {
				const x = -bx + ((i + 0.5) * 2 * bx) / n;
				const y = -by + ((j + 0.5) * 2 * by) / n;
				const z = -bz + ((k + 0.5) * 2 * bz) / n;
				if (inside(x, y, z)) points.push(x, y, z);
			}
	if (!points.length) points.push(0, 0, 0);
	return { points, volume, cellH: (2 * by) / n };
}

/** @param {number[]} q quaternion [x,y,z,w] @param {number} x @param {number} y @param {number} z @param {number[]} out */
function rotate(q, x, y, z, out) {
	const [qx, qy, qz, qw] = q;
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
	out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
	out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
	return out;
}

/**
 * Body-local samples for a whole body: each collider's shape samples rotated + moved
 * into the body frame, volumes shared per point. `parts` = the colliders as built
 * (`kind`, half extents, body-local translation + rotation).
 * @param {{kind: string, he: {x: number, y: number, z: number}, t: number[], q: number[]}[]} parts
 * @param {number} [res]
 * @returns {{points: Float32Array, weights: Float32Array, volume: number, cellH: number, span: number}}
 */
export function bodySamples(parts, res = 3) {
	/** @type {number[]} */ const pts = [];
	/** @type {number[]} */ const vols = [];
	let volume = 0;
	let cellH = Infinity;
	const v = [0, 0, 0];
	for (const part of parts) {
		const s = shapeSamples(part.kind, part.he, res);
		const each = s.volume / (s.points.length / 3);
		volume += s.volume;
		cellH = Math.min(cellH, s.cellH);
		for (let i = 0; i < s.points.length; i += 3) {
			rotate(part.q, s.points[i], s.points[i + 1], s.points[i + 2], v);
			pts.push(v[0] + part.t[0], v[1] + part.t[1], v[2] + part.t[2]);
			vols.push(each);
		}
	}
	const weights = new Float32Array(vols.length);
	for (let i = 0; i < vols.length; i++) weights[i] = volume > 0 ? vols[i] / volume : 1 / vols.length;
	// 36-fb-water F15: the hull's horizontal size (the waves shorter than it average out)
	let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
	for (const part of parts) {
		const r = Math.hypot(part.he.x, part.he.z);
		x0 = Math.min(x0, part.t[0] - r);
		x1 = Math.max(x1, part.t[0] + r);
		z0 = Math.min(z0, part.t[2] - r);
		z1 = Math.max(z1, part.t[2] + r);
	}
	const span = parts.length ? Math.max(x1 - x0, z1 - z0) * 0.75 : 0;
	return { points: new Float32Array(pts), weights, volume, cellH: Number.isFinite(cellH) ? cellH : 0.1, span };
}

/**
 * @typedef {{surfaceY: number, flow?: number[] | null, density?: number,
 *   linearDrag?: number, angularDrag?: number, heaveDrag?: number, volume?: any}} WaterHit
 */

/**
 * One substep of buoyancy + drag for one body. Pure: reads the state handed in and
 * writes the result into `out` (no allocation on the hot path).
 * @param {{pos: number[], quat: number[], com: number[], linvel: number[], angvel: number[],
 *   mass: number, gravity: number, dt: number}} body  rapier state (world frame)
 * @param {{points: Float32Array, weights: Float32Array, volume: number, cellH: number, span?: number}} samples
 * @param {(x: number, y: number, z: number, span?: number) => WaterHit | null} query  W1's waterVolumes.query, adapted
 * @param {{off: boolean, density: number | 'mass', multiplier: number}} floats normalized
 * @param {{impulse: number[], torque: number[], linvel: number[], angvel: number[],
 *   submerged: number, volume: any, surfaceY: number}} out
 * @returns {boolean} false when the body is nowhere in water (out untouched beyond submerged = 0)
 */
export function buoyancyStep(body, samples, query, floats, out) {
	out.submerged = 0;
	out.volume = null;
	if (floats.off || !(body.mass > 0)) return false;
	const g = Math.abs(body.gravity);
	const rhoBody =
		floats.density === 'mass' ? Math.max(MIN_DENSITY, body.mass / Math.max(samples.volume, 1e-6)) : floats.density;
	const pts = samples.points;
	const p = [0, 0, 0];
	let ix = 0, iy = 0, iz = 0;
	let tx = 0, ty = 0, tz = 0;
	let fx = 0, fy = 0, fz = 0; // submerged-weighted flow
	let linDrag = 0, angDrag = 0, heave = 0;
	let submerged = 0;
	/** @type {WaterHit | null} */ let lastHit = null;
	for (let i = 0, s = 0; i < pts.length; i += 3, s++) {
		rotate(body.quat, pts[i], pts[i + 1], pts[i + 2], p);
		const wx = p[0] + body.pos[0];
		const wy = p[1] + body.pos[1];
		const wz = p[2] + body.pos[2];
		// the sample is a slab cellH tall centred on the point: ask about its BOTTOM, so
		// a slab whose centre is still dry but whose lower half is wet counts (W1's query
		// answers null above the surface)
		const hit = query(wx, wy - samples.cellH * 0.5, wz, samples.span ?? 0);
		if (!hit) continue;
		const frac = Math.min(1, Math.max(0, (hit.surfaceY - wy) / samples.cellH + 0.5));
		if (frac <= 0) continue;
		const share = samples.weights[s] * frac;
		submerged += share;
		lastHit = hit;
		const rhoWater = hit.density ?? WATER_DENSITY;
		const j = body.mass * g * (rhoWater / rhoBody) * share * floats.multiplier * body.dt;
		iy += j;
		// torque about the centre of mass: r x (0, j, 0)
		const rx = wx - body.com[0];
		const rz = wz - body.com[2];
		tx += -rz * j;
		tz += rx * j;
		const flow = hit.flow;
		if (flow) {
			fx += flow[0] * share;
			fy += flow[1] * share;
			fz += flow[2] * share;
		}
		linDrag += (hit.linearDrag ?? 1) * share;
		heave += (hit.linearDrag ?? 1) * (hit.heaveDrag ?? HEAVE_DRAG) * share;
		angDrag += (hit.angularDrag ?? 1) * share;
	}
	// ADDED MASS (36-fb-water): the net vertical acceleration is g (rS - 1) / (1 + Ca rS), not
	// g (rS - 1) — r = rho_water / rho_body, S = the submerged share. Rapier adds -g itself, so the
	// buoyant impulse is scaled by (1 + Ca) / (1 + Ca rS): exactly 1 at rest (the draft is
	// unchanged), < 1 for a light body (it rises slower), > 1 for a heavy one (it sinks slower).
	if (submerged > 0 && lastHit) {
		const rS = ((lastHit.density ?? WATER_DENSITY) / rhoBody) * submerged * floats.multiplier;
		const f = (1 + ADDED_MASS) / (1 + ADDED_MASS * rS);
		iy *= f;
		tx *= f;
		tz *= f;
	}
	out.impulse[0] = ix;
	out.impulse[1] = iy;
	out.impulse[2] = iz;
	out.torque[0] = tx;
	out.torque[1] = ty;
	out.torque[2] = tz;
	out.submerged = submerged;
	if (submerged <= 0 || !lastHit) {
		out.linvel[0] = body.linvel[0];
		out.linvel[1] = body.linvel[1];
		out.linvel[2] = body.linvel[2];
		out.angvel[0] = body.angvel[0];
		out.angvel[1] = body.angvel[1];
		out.angvel[2] = body.angvel[2];
		return false;
	}
	out.volume = lastHit.volume ?? null;
	out.surfaceY = lastHit.surfaceY;
	// DRAG toward the water's velocity (flow = the drift of a river). The share-weighted
	// coefficients mean half-submerged = half the drag. Exponential decay, so a huge
	// coefficient at a big dt converges on the flow instead of overshooting it.
	const flowX = fx / submerged;
	const flowY = fy / submerged;
	const flowZ = fz / submerged;
	const kl = 1 - Math.exp(-linDrag * body.dt);
	// HEAVE is damped harder than sliding: a floating body bobbing up and down pushes
	// water out of the way (added mass + the waves it radiates), and with the plain drag
	// a crate kept bouncing for ten seconds. HEAVE_DRAG x the drag puts a 1 m crate near
	// critical damping (ω = sqrt(g / draft) ≈ 4 rad/s).
	// (36-fb-water: the water's own "Bob damping" scales it; the default is HEAVE_DRAG)
	const kv = 1 - Math.exp(-heave * body.dt);
	out.linvel[0] = body.linvel[0] + (flowX - body.linvel[0]) * kl;
	out.linvel[1] = body.linvel[1] + (flowY - body.linvel[1]) * kv;
	out.linvel[2] = body.linvel[2] + (flowZ - body.linvel[2]) * kl;
	const ka = Math.exp(-angDrag * body.dt);
	out.angvel[0] = body.angvel[0] * ka;
	out.angvel[1] = body.angvel[1] * ka;
	out.angvel[2] = body.angvel[2] * ka;
	return true;
}

/** a fresh `out` for buoyancyStep */
export function buoyancyOut() {
	return { impulse: [0, 0, 0], torque: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0], submerged: 0, volume: null, surfaceY: 0 };
}

/**
 * The equilibrium draft of a floating box: depth under the surface at rest. A box of
 * density rho_b in water rho_w sinks to h x rho_b / rho_w (a body denser than water
 * has no draft — it sinks). For the headless proof and the Inspector hint.
 * @param {number} height @param {number} rhoBody @param {number} [rhoWater] @param {number} [multiplier]
 */
export function expectedDraft(height, rhoBody, rhoWater = WATER_DENSITY, multiplier = 1) {
	const ratio = rhoBody / (rhoWater * Math.max(multiplier, 1e-6));
	return ratio >= 1 ? null : height * ratio;
}

const scratchState = { pos: [0, 0, 0], quat: [0, 0, 0, 1], com: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0], mass: 0, gravity: -9.81, dt: 1 / 60 };

/**
 * Apply one substep to a live RAPIER body (duck-typed: translation/rotation/worldCom/
 * linvel/angvel/mass + the setters) — the ONE integration both physics.js and the
 * headless proof call, so the proof measures the shipped path.
 * @param {any} rb rapier RigidBody
 * @param {{points: Float32Array, weights: Float32Array, volume: number, cellH: number, span?: number}} samples
 * @param {(x: number, y: number, z: number, span?: number) => WaterHit | null} query
 * @param {{off: boolean, density: number | 'mass', multiplier: number}} floats
 * @param {number} gravity world gravity Y (negative)
 * @param {number} dt substep seconds
 * @param {ReturnType<typeof buoyancyOut>} out
 * @returns {boolean} the body is (partly) in water
 */
export function applyBuoyancy(rb, samples, query, floats, gravity, dt, out) {
	const t = rb.translation();
	const r = rb.rotation();
	const c = rb.worldCom ? rb.worldCom() : t;
	const lv = rb.linvel();
	const av = rb.angvel();
	const s = scratchState;
	s.pos[0] = t.x; s.pos[1] = t.y; s.pos[2] = t.z;
	s.quat[0] = r.x; s.quat[1] = r.y; s.quat[2] = r.z; s.quat[3] = r.w;
	s.com[0] = c.x; s.com[1] = c.y; s.com[2] = c.z;
	s.linvel[0] = lv.x; s.linvel[1] = lv.y; s.linvel[2] = lv.z;
	s.angvel[0] = av.x; s.angvel[1] = av.y; s.angvel[2] = av.z;
	s.mass = rb.mass();
	s.gravity = gravity;
	s.dt = dt;
	if (!buoyancyStep(s, samples, query, floats, out)) return false;
	rb.setLinvel({ x: out.linvel[0], y: out.linvel[1], z: out.linvel[2] }, true);
	rb.setAngvel({ x: out.angvel[0], y: out.angvel[1], z: out.angvel[2] }, true);
	rb.applyImpulse({ x: out.impulse[0], y: out.impulse[1], z: out.impulse[2] }, true);
	rb.applyTorqueImpulse({ x: out.torque[0], y: out.torque[1], z: out.torque[2] }, true);
	return true;
}
