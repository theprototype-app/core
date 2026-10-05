// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { FluidSolver } from './fluidCore.js';
import { simHeld } from './fluidRuntime.js';
import { normalizeEmitter, capFor, domainOf, releaseCount, nozzleBatch, spawnBatch, applySinks, budgetLimits } from './fluidEmitterCore.js';
import { FluidVisual } from './fluidRender.js';
import { FluidColliderSet } from './fluidColliders.js';
import { sceneGravity, scenePhysicsState_ } from '../scenePhysics';
import { qualityOverrides, qualityState } from '../qualityGovernor';
import { simulating, applyImpulse } from '../physics';
import { normalizeFloats } from './buoyancy.js';
import { setPoolVolumes, disturbWater } from './waterQuery.js';
import { waterVolumes } from '../water/volumes.js';
import { flowFieldFor } from './flowPaths.js';
import { applyFlows } from './flowPathCore.js';

// 36-fb F23: FLUID EMITTERS — the runtime between an emitter object (`userData.fluidEmitter`,
// made by Add ▸ Water ▸ Fluid), the PBF solver (its own Web Worker — the tank runtime keeps
// its own, so the two never share a protocol and run on two threads) and the visual.
// Every peer, every frame, LOCAL (only the settings replicate):
//   · the solver box is the emitter's AREA (world-axis aligned, open but for the floor), and
//     its caps are hard: particles, lifetime, area, burst amount (fluidEmitterCore);
//   · the main thread decides how many particles to release and where (nozzleBatch), the
//     worker adds them, steps, swallows what reaches a W1 pool (sinks → a ripple each), and
//     hands the positions back;
//   · scene meshes are colliders (fluidColliders: per piece, with their motion, honouring
//     each mesh's "Fluid interaction"), and on the physics INITIATOR a pushable dynamic body
//     feels the fluid (capped like the tank);
//   · the particles' pools are published as water (waterQuery.setPoolVolumes) so a light
//     body floats on them through the ONE buoyancy model;
//   · an area off-screen (or a hidden tab) PAUSES.
// Tiers: XR presenting / the governor's low steps / quality 'points' → drops, capped at
// QUEST_EMITTER_CAP; else the screen-space surface.

/** @typedef {ReturnType<typeof normalizeEmitter>} Spec */
/** @typedef {{object: any, key: string, spec: Spec, visual: any, cap: number, gen: number, pending: boolean, sentAt: number,
 *   steps: number, ms: number, count: number, visible: boolean, center: THREE.Vector3 | null, lastSunk: number,
 *   acc: {carry: number, released: number}, rng: {seed: number}, colliders: FluidColliderSet, spare: ArrayBuffer | null,
 *   lastDt: number, released: number, sunkTotal: number, positions: Float32Array | null, mode: string, pool: any, limit: number, moving: number, flowCount: number,
 *   local?: {solver: FluidSolver}}} Emitter */

/** @type {Map<string, Emitter>} */
const emitters = new Map();
/** TEST: force the headset tier on a desktop page (the Quest fallback's numbers, headless) @type {'quest' | null} */
let forcedTier = null;
/** @param {'quest' | null} tier */
export function setFluidTierForTest(tier) {
	forcedTier = tier === 'quest' ? 'quest' : null;
}
/** S3: this frame's particle limit per emitter (the shared budget's split) @type {Map<string, number>} */
let limits = new Map();
/** @type {Worker | null | false} false = workers unavailable: simulate on the main thread */
let worker = null;
/** objectsGroup's parent — the visuals hang next to the content, never in it */
let visualParent = /** @type {any} */ (null);

function ensureWorker() {
	if (worker !== null) return worker;
	try {
		worker = new Worker(new URL('./fluid.worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (e) => onFrame(e.data);
		worker.onerror = (e) => {
			console.warn('[fluid emitter] worker failed, simulating on the main thread', e?.message ?? e);
			worker = false;
			for (const em of emitters.values()) {
				em.key = '';
				em.pending = false;
			}
		};
	} catch {
		worker = false;
	}
	return worker;
}

/** @param {any} data */
function onFrame(data) {
	if (data?.op !== 'frame') return;
	const em = emitters.get(data.id);
	if (!em || data.gen !== em.gen) return;
	em.pending = false;
	em.count = data.count;
	em.ms = em.ms ? em.ms * 0.9 + data.ms * 0.1 : data.ms;
	em.steps++;
	const positions = /** @type {Float32Array} */ (data.positions);
	// a COPY: the buffer goes back to the worker on the next step (transferred = detached here)
	em.positions = positions.slice(0, data.count * 3);
	if (em.object.parent && visualParent && em.center) {
		frame.makeTranslation(em.center.x, em.center.y, em.center.z);
		em.visual.update(positions, data.count, frame, visualParent);
	}
	em.spare = /** @type {ArrayBuffer} */ (positions.buffer);
	if (data.sunk?.length) ripple(em, data.sunk);
	push(em, data.impulses);
	publishPool(em, positions, data.count);
}

const frame = new THREE.Matrix4();

/**
 * W2: a ripple where a few particles joined a pool (each peer its own; nothing sent). At most
 * one every 80 ms per emitter — a stream into a pool is a steady patter, not a storm.
 * @param {Emitter} em @param {number[]} sunk area-local [x,y,z]*
 */
function ripple(em, sunk) {
	em.sunkTotal += sunk.length / 3;
	const now = performance.now();
	if (now - em.lastSunk < 80 || !em.center) return;
	em.lastSunk = now;
	const p = { x: sunk[0] + em.center.x, y: sunk[1] + em.center.y, z: sunk[2] + em.center.z };
	const hit = waterVolumes.query(p);
	if (hit?.volume) disturbWater(hit.volume, [p.x, p.y, p.z], 0.12 + em.spec.particleSize * 2, 0.35);
}

/**
 * The fluid's push on pushable bodies, initiator-only (physics authority), capped like the
 * tank's: floating is buoyancy's job (the pools are water), the particles only stir.
 * @param {Emitter} em @param {Record<string, number[]>} impulses
 */
function push(em, impulses) {
	if (!impulses || !get(simulating)) return;
	const root = em.object.parent;
	const v = new THREE.Vector3();
	for (const [uuid, j] of Object.entries(impulses)) {
		const body = root?.getObjectByProperty?.('uuid', uuid);
		const p = body?.userData?.physics;
		if (!p) continue;
		const floats = normalizeFloats(p.floats);
		if (floats.off) continue;
		const cap = (p.mass ?? 1) * 9.81 * 0.5 * floats.multiplier * em.lastDt;
		v.set(j[0], j[1], j[2]).clampLength(0, cap);
		applyImpulse(uuid, [v.x, v.y, v.z]);
	}
}

/**
 * The pools as water: a 0.2 m column grid over the area; a column with enough particles to be
 * more than a film has a surface ≈ its lowest particle + twice the mean height above it (a
 * column of uniform water has its mean half way up) + a radius. Spray (a few drops) is no pool.
 * @param {Emitter} em @param {Float32Array} pos @param {number} n
 */
function publishPool(em, pos, n) {
	const list = [];
	for (const e of emitters.values()) if (e !== em && e.pool) list.push(e.pool);
	em.pool = null;
	if (n && em.center) {
		const size = em.spec.area.size;
		const cell = 0.2;
		const nx = Math.max(1, Math.ceil(size[0] / cell)), nz = Math.max(1, Math.ceil(size[2] / cell));
		const cnt = new Uint16Array(nx * nz);
		const lo = new Float32Array(nx * nz).fill(Infinity);
		const sum = new Float32Array(nx * nz);
		const hx = size[0] / 2, hz = size[2] / 2;
		for (let i = 0; i < n; i++) {
			const cx = Math.floor((pos[i * 3] + hx) / cell), cz = Math.floor((pos[i * 3 + 2] + hz) / cell);
			if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) continue;
			const c = cz * nx + cx;
			const y = pos[i * 3 + 1];
			cnt[c]++;
			sum[c] += y;
			if (y < lo[c]) lo[c] = y;
		}
		const minCount = Math.max(6, Math.round((cell * cell) / (em.spec.particleSize * em.spec.particleSize) * 0.5));
		const surf = new Float32Array(nx * nz).fill(NaN);
		let any = false;
		let top = -Infinity;
		const cy = em.center.y, cxW = em.center.x - hx, czW = em.center.z - hz;
		for (let c = 0; c < nx * nz; c++) {
			if (cnt[c] < minCount) continue;
			const s = lo[c] + 2 * (sum[c] / cnt[c] - lo[c]) + em.spec.particleSize * 0.5 + cy;
			surf[c] = s;
			any = true;
			if (s > top) top = s;
		}
		if (any) {
			const bottom = cy - size[1] / 2;
			const at = (/** @type {number} */ x, /** @type {number} */ z) => {
				const cx = Math.floor((x - cxW) / cell), cz = Math.floor((z - czW) / cell);
				if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return null;
				const s = surf[cz * nx + cx];
				return Number.isNaN(s) ? null : s;
			};
			em.pool = {
				uuid: em.object.uuid,
				tank: /** @type {true} */ (true),
				pool: /** @type {true} */ (true),
				surfaceY: top,
				surfaceAt: at,
				contains: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => y >= bottom && at(x, z) != null,
				spec: { density: 1000 * (1 + em.spec.viscosity * 0.4), linearDrag: 1.5 + em.spec.viscosity * 8, angularDrag: 1 + em.spec.viscosity * 4 }
			};
			list.push(em.pool);
		}
	}
	setPoolVolumes(list);
}

/** @param {Emitter} em */
function initEmitter(em) {
	const spec = em.spec;
	const { min, max, walls } = domainOf(spec);
	em.gen++;
	em.visual?.dispose();
	em.visual = new FluidVisual({ capacity: em.cap, radius: spec.particleSize * 0.62, size: spec.area.size });
	em.pending = false;
	em.count = 0;
	em.spare = null;
	em.acc = { carry: 0, released: 0 };
	em.positions = null;
	const w = ensureWorker();
	if (w) {
		w.postMessage({ op: 'init', id: em.object.uuid, gen: em.gen, min, max, capacity: em.cap, spacing: spec.particleSize, fill: 0, count: 0, walls });
		em.local = undefined;
	} else {
		const solver = new FluidSolver({ min, max, capacity: em.cap, spacing: spec.particleSize });
		solver.setWalls(walls);
		em.local = { solver };
	}
}

/** @param {Emitter} em */
function dropEmitter(em) {
	em.visual?.dispose();
	if (worker) worker.postMessage({ op: 'drop', id: em.object.uuid });
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const sphere = new THREE.Sphere();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();

/**
 * The per-frame tick (tickSim calls it once).
 * @param {any} root objectsGroup @param {any} camera @param {any} renderer @param {number} now ms
 */
export function tickFluidEmitters(root, camera, renderer, now) {
	visualParent = root?.parent ?? null;
	/** @type {Set<string>} */
	const alive = new Set();
	/** @type {any[]} */
	const found = [];
	if (root && visualParent)
		root.traverse((/** @type {any} */ o) => {
			if (o.userData?.fluidEmitter) found.push(o);
		});
	// S3: ONE budget for the scene, shared in proportion to each emitter's max particles and
	// lowered by the quality governor's level (a headset runs at most QUEST_FLUID_BUDGET)
	const xr = !!renderer?.xr?.isPresenting || forcedTier === 'quest';
	const specs = found.map((o) => normalizeEmitter(o.userData.fluidEmitter));
	limits = budgetLimits(
		found.map((o, i) => ({ uuid: o.uuid, maxParticles: specs[i].maxParticles, cap: capFor(specs[i], xr) })),
		get(scenePhysicsState_).fluidBudget,
		get(qualityState).level,
		xr
	);
	found.forEach((o) => {
		alive.add(o.uuid);
		tickEmitter(root, o, camera, renderer, now);
	});
	let dropped = false;
	for (const [uuid, em] of emitters)
		if (!alive.has(uuid)) {
			dropEmitter(em);
			emitters.delete(uuid);
			dropped = true;
		}
	if (dropped || !emitters.size) {
		const list = [];
		for (const e of emitters.values()) if (e.pool) list.push(e.pool);
		setPoolVolumes(list);
	}
}

/** @param {any} root @param {any} object @param {any} camera @param {any} renderer @param {number} now */
function tickEmitter(root, object, camera, renderer, now) {
	const spec = normalizeEmitter(object.userData.fluidEmitter);
	const xr = !!renderer?.xr?.isPresenting || forcedTier === 'quest';
	const q = get(qualityOverrides);
	// the CAPACITY changes only with the headset (a re-init); the governor's steps trim the
	// live count through the budget instead (S3), and only its post-off step drops the look
	const cap = capFor(spec, xr);
	const low = xr || q.postOff || spec.quality === 'points';
	const limit = Math.min(cap, limits.get(object.uuid) ?? cap);
	const key = [cap, spec.particleSize, spec.generation, spec.floor, ...spec.area.size].join(',');
	let em = emitters.get(object.uuid);
	if (!em) {
		em = /** @type {Emitter} */ ({
			object, key: '', spec, visual: null, cap, gen: 0, pending: false, sentAt: 0, steps: 0, ms: 0, count: 0, visible: true,
			center: null, lastSunk: 0, acc: { carry: 0, released: 0 }, rng: { seed: hashSeed(object.uuid) }, colliders: new FluidColliderSet(),
			spare: null, lastDt: 1 / 60, released: 0, sunkTotal: 0, positions: null, mode: 'points', pool: null, limit: 0, moving: 0, flowCount: 0
		});
		emitters.set(object.uuid, em);
	}
	em.object = object;
	em.spec = spec;
	em.cap = cap;
	if (em.key !== key) {
		em.key = key;
		em.center = null;
		initEmitter(em);
	}
	em.visual.setLook(spec.color, spec.clarity);
	em.mode = low && spec.quality !== 'high' ? 'points' : xr ? 'points' : 'ssf';
	em.visual.setMode(em.mode);
	if (em.visual.group.parent !== visualParent) visualParent?.add(em.visual.group);
	// the area: world-axis aligned, centred on the emitter + offset
	object.updateWorldMatrix(true, false);
	object.matrixWorld.decompose(tmpV, tmpQ, tmpS);
	const nozzleW = tmpV.clone();
	const center = nozzleW.clone().add(tmpS.set(spec.area.offset[0], spec.area.offset[1], spec.area.offset[2]));
	/** @type {number[] | null} */
	let shift = null;
	if (em.center && em.center.distanceToSquared(center) > 1e-10) shift = [center.x - em.center.x, center.y - em.center.y, center.z - em.center.z];
	// keep the visual glued between solver frames
	if (visualParent && (!em.center || shift)) {
		visualParent.updateWorldMatrix(true, false);
		em.visual.group.matrix.copy(visualParent.matrixWorld).invert().multiply(frame.makeTranslation(center.x, center.y, center.z));
		em.visual.group.matrixWorldNeedsUpdate = true;
	}
	// visible? (an area off-screen pauses: no steps, no worker traffic)
	const size = spec.area.size;
	sphere.set(center, Math.hypot(size[0], size[1], size[2]) / 2);
	projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	frustum.setFromProjectionMatrix(projView);
	const hidden = typeof document !== 'undefined' && document.hidden;
	em.visible = !hidden && frustum.intersectsSphere(sphere);
	em.visual.prepare(camera, renderer?.domElement?.height ?? 800);
	if (!em.visible || em.pending) return;
	// 36-int-125 (union of fb-water S9 + fb-fluid F23): the simulation pill's Pause holds emitters too
	if (simHeld()) {
		em.sentAt = now; // resume without a jump
		return;
	}
	const dt = em.sentAt ? Math.min((now - em.sentAt) / 1000, 1 / 30) : 1 / 60;
	em.sentAt = now;
	em.lastDt = dt;
	em.center = center;
	// release: how many, where, which way
	em.limit = limit;
	const n = releaseCount(spec, em.acc, dt, em.count, limit);
	em.released += n;
	const dirW = tmpS.set(spec.dir[0], spec.dir[1], spec.dir[2]).applyQuaternion(tmpQ).normalize();
	const nozzle = [nozzleW.x - center.x, nozzleW.y - center.y, nozzleW.z - center.z];
	const spawn = n ? nozzleBatch(n, nozzle, [dirW.x, dirW.y, dirW.z], spec.speed, spec.spread, spec.particleSize, em.rng) : null;
	const half = size.map((v) => v / 2);
	const areaW = {
		min: new THREE.Vector3(center.x - half[0], center.y - half[1], center.z - half[2]),
		max: new THREE.Vector3(center.x + half[0], center.y + half[1], center.z + half[2])
	};
	const flows = flowFieldFor(root, areaW, center);
	em.flowCount = flows?.length ?? 0;
	const colliders = spec.interact ? em.colliders.gather(root, areaW, center, nozzleW, now, get(simulating), wetBox(em, nozzleW, flows)) : [];
	em.moving = colliders.filter((c) => c.vel || c.omega).length;
	const msg = {
		op: 'step',
		id: object.uuid,
		dt,
		gravity: [0, get(sceneGravity) * spec.gravityScale, 0],
		viscosity: spec.viscosity,
		surfaceTension: spec.surfaceTension,
		cohesion: spec.cohesion,
		floorFriction: spec.friction,
		colliders,
		spec: null,
		walls: domainOf(spec).walls,
		lifetime: spec.lifetime,
		spawn,
		sinks: spec.joinPools ? sinksFor(areaW, center) : null,
		flows,
		shift,
		limit
	};
	if (em.local) {
		const t0 = performance.now();
		const s = em.local.solver;
		if (shift) for (let i = 0; i < s.count * 3; i += 3) (s.x[i] -= shift[0]), (s.x[i + 1] -= shift[1]), (s.x[i + 2] -= shift[2]);
		if (s.count > limit) s.count = limit;
		spawnBatch(s, spawn);
		s.step(dt, msg);
		if (msg.flows) applyFlows(s, msg.flows, dt);
		const sunk = applySinks(s, msg.sinks);
		s.takeEscaped();
		onFrame({ op: 'frame', id: object.uuid, gen: em.gen, count: s.count, positions: s.x, impulses: s.impulses, ms: performance.now() - t0, sunk });
		return;
	}
	const w = ensureWorker();
	if (!w) return;
	em.pending = true;
	const buffer = em.spare;
	em.spare = null;
	if (buffer) w.postMessage({ ...msg, buffer }, [buffer]);
	else w.postMessage(msg);
}

/**
 * Where the water is (world), from last frame's particles + the nozzle, padded by how far a
 * particle travels in a few frames — the colliders worth sending. Flow paths count as wet too
 * (a pipe's outlet puts water where there was none last frame).
 * @param {Emitter} em @param {THREE.Vector3} nozzleW @param {any[] | null} flows compiled, area-local
 */
function wetBox(em, nozzleW, flows) {
	const pad = 0.6;
	const lo = [nozzleW.x - pad, nozzleW.y - pad, nozzleW.z - pad];
	const hi = [nozzleW.x + pad, nozzleW.y + pad, nozzleW.z + pad];
	const p = em.positions;
	if (p && em.center)
		for (let i = 0; i + 2 < p.length; i += 3)
			for (let a = 0; a < 3; a++) {
				const v = p[i + a] + (a === 0 ? em.center.x : a === 1 ? em.center.y : em.center.z);
				if (v - pad < lo[a]) lo[a] = v - pad;
				if (v + pad > hi[a]) hi[a] = v + pad;
			}
	if (em.center && flows)
		for (const f of flows)
			for (let i = 0; i + 2 < f.pts.length; i += 3)
				for (let a = 0; a < 3; a++) {
					const v = f.pts[i + a] + (a === 0 ? em.center.x : a === 1 ? em.center.y : em.center.z);
					if (v - pad < lo[a]) lo[a] = v - pad;
					if (v + pad > hi[a]) hi[a] = v + pad;
				}
	return { min: lo, max: hi };
}

/**
 * Every W1 water volume reaching the area, as an area-local SINK box from its bottom to its
 * surface: fluid poured into a pool joins it (and ripples it) instead of piling on top.
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} areaW @param {THREE.Vector3} center
 */
function sinksFor(areaW, center) {
	/** @type {{min: number[], max: number[]}[]} */
	const out = [];
	for (const v of waterVolumes.list()) {
		const o = v.object;
		if (!o?.matrixWorld) continue;
		const b = v.bounds;
		const top = v.level;
		const lo = new THREE.Vector3(b.minX, v.shape === 'plane' ? -1e4 : b.minY, b.minZ);
		const hi = new THREE.Vector3(b.maxX, top, b.maxZ);
		const wb = new THREE.Box3(lo, hi).applyMatrix4(o.matrixWorld);
		if (!wb.intersectsBox(new THREE.Box3(areaW.min, areaW.max))) continue;
		out.push({ min: [wb.min.x - center.x, wb.min.y - center.y, wb.min.z - center.z], max: [wb.max.x - center.x, wb.max.y - center.y, wb.max.z - center.z] });
	}
	return out.length ? out : null;
}

/** @param {string} s */
function hashSeed(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (Math.abs(h) % 2147483646) + 1;
}

/** TEST/DEBUG: every emitter's live numbers */
export function fluidEmitterDebug() {
	return [...emitters.entries()].map(([uuid, e]) => ({
		uuid,
		count: e.count,
		cap: e.cap,
		limit: e.limit,
		moving: e.moving,
		flows: e.flowCount,
		released: e.released,
		sunk: e.sunkTotal,
		steps: e.steps,
		ms: Math.round(e.ms * 100) / 100,
		visible: e.visible,
		mode: e.mode,
		colliders: e.colliders.candidates.length,
		pool: e.pool ? Math.round(e.pool.surfaceY * 1000) / 1000 : null,
		worker: worker ? 'worker' : worker === false ? 'main' : 'none'
	}));
}

/** TEST/DEBUG: the particles of one emitter, world space (a copy) @param {string} uuid */
export function fluidEmitterParticles(uuid) {
	const e = emitters.get(uuid);
	if (!e?.positions || !e.center) return [];
	/** @type {number[][]} */
	const out = [];
	for (let i = 0; i < e.count; i++) out.push([e.positions[i * 3] + e.center.x, e.positions[i * 3 + 1] + e.center.y, e.positions[i * 3 + 2] + e.center.z]);
	return out;
}

/** TEST: drop everything */
export function resetFluidEmitters() {
	for (const e of emitters.values()) dropEmitter(e);
	emitters.clear();
	setPoolVolumes([]);
}
