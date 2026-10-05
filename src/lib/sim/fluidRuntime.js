// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { FluidSolver, pourAndDrain, normalizeFluid, spacingFor, FLUID_MAX_PARTICLES, TANK_WALL } from './fluidCore.js';
import { FluidVisual } from './fluidRender.js';
import { sceneGravity } from '../scenePhysics';
import { qualityOverrides, settleQuality } from '../qualityGovernor';
import { simulating, simPaused, remoteSimPaused, applyImpulse } from '../physics';

/** 36-fb-water S9: the scene's simulation is paused (here or by the peer running it) — the
 * local sims (tanks, drops) hold still with the bodies */
export function simHeld() {
	return (get(simulating) && get(simPaused)) || get(remoteSimPaused);
}
import { inferredColliderKind } from '../colliderSpec';
import { normalizeFloats } from './buoyancy.js';
import { setTankVolumes } from './waterQuery.js';
import { noteSimplified } from '../water/simplifiedNotice.js';
/** 36-fb-water F27: a tank this frame draws drops instead of its smooth surface BECAUSE OF QUALITY */
let qualityLowered = false;
import { spillDrops } from '../water/pourDrops.js';

// 36-fb-water F16: a tank's walls with the TOP open (fluidCore wall mask [xlo,xhi,ylo,yhi,zlo,zhi])
const OPEN_TOP = [true, true, true, false, true, true];
const ALL_WALLS = [true, true, true, true, true, true]; // the solver keeps the last mask: always send one

// 36-sim U2b: FLUID TANKS — the runtime between a tank object (`userData.fluid`, made by
// Create ▸ Simulation ▸ Fluid tank), the solver (a Web Worker running fluidCore) and the
// visual (fluidRender). Every peer, every frame, LOCAL:
//   · the particles are each peer's own: only `userData.fluid` replicates (objectParameters
//     'fluid', undo kind 'props'), so every peer pours the same fluid with the same settings;
//   · a tank off-screen (or in a hidden tab) is PAUSED — no steps, no worker traffic;
//   · moving the tank sloshes it (the tank's acceleration is folded into gravity);
//   · objects inside the tank are colliders the fluid flows around, and on the physics
//     INITIATOR a dynamic body inside gets the fluid's push as rapier impulses (authority:
//     the initiator's fluid decides, every peer sees the body through the move stream).
// Tiers: XR presenting, the governor's "post off"/"fewer particles" steps or quality
// 'points' -> the points tier capped at QUEST_CAP particles; else screen-space fluid.

export const QUEST_CAP = 1500;

/** @typedef {{object: any, key: string, spec: ReturnType<typeof normalizeFluid>, visual: FluidVisual, capacity: number,
 *   pending: boolean, sentAt: number, steps: number, ms: number, count: number, visible: boolean,
 *   min: number[], max: number[], frame: THREE.Matrix4, frameQuat: THREE.Quaternion, prevPos: THREE.Vector3 | null,
 *   prevVel: THREE.Vector3, accel: THREE.Vector3, lastAt: number, lastDt: number, surfaceLocal?: number | null, gen?: number, local?: {solver: FluidSolver, acc: {carry: number, drainCarry: number}},
 *   spare: ArrayBuffer | null, spilled?: number}} Tank */

/** @type {Map<string, Tank>} */
const tanks = new Map();
/** @type {Worker | null | false} false = workers unavailable, run on the main thread */
let worker = null;

function ensureWorker() {
	if (worker !== null) return worker;
	try {
		worker = new Worker(new URL('./fluid.worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (e) => onFrame(e.data);
		worker.onerror = (e) => {
			console.warn('[fluid] worker failed, simulating on the main thread', e?.message ?? e);
			worker = false;
			for (const t of tanks.values()) {
				t.key = ''; // re-init locally
				t.pending = false;
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
	const tank = tanks.get(data.id);
	if (!tank) return;
	// a frame from the solver BEFORE a re-init (count/fill/size changed) is a different
	// capacity: drop it (measured: 'offset is out of bounds' copying 3000 into 1500)
	if (data.gen !== tank.gen) return;
	tank.pending = false;
	tank.count = data.count;
	tank.ms = tank.ms ? tank.ms * 0.9 + data.ms * 0.1 : data.ms;
	tank.steps++;
	const positions = /** @type {Float32Array} */ (data.positions);
	if (tank.object.parent) tank.visual.update(positions, data.count, tank.frame, visualParentOf(tank.object));
	tank.spare = /** @type {ArrayBuffer} */ (positions.buffer);
	tank.surfaceLocal = surfaceOf(positions, data.count, tank);
	applyPush(tank, data.impulses);
	// 36-fb-water F16: what left over the rim falls on as drops (splash, settle, dry up)
	if (data.escaped?.length) {
		tank.spilled = (tank.spilled ?? 0) + data.escaped.length / 6;
		spillDrops(tank.object, data.escaped, tank.frame, tank.frameQuat, { ...tank.spec.spill, color: tank.spec.color, size: (tank.visual?.radius ?? 0.02) * 2 });
	}
}

/**
 * The fluid's free surface in the tank frame: the 92nd percentile of particle heights (a
 * spray of drops above the body of water must not count) plus a particle radius. A
 * 64-bin histogram, not a sort — this runs every solver frame.
 * @param {Float32Array} pos @param {number} n @param {Tank} tank
 */
function surfaceOf(pos, n, tank) {
	if (!n) return tank.min[1];
	const lo = tank.min[1];
	const span = Math.max(tank.max[1] - lo, 1e-3);
	const bins = new Uint32Array(64);
	for (let i = 0; i < n; i++) bins[Math.min(63, Math.max(0, Math.floor(((pos[i * 3 + 1] - lo) / span) * 64)))]++;
	let acc = 0;
	const want = n * 0.92;
	for (let b = 0; b < 64; b++) {
		acc += bins[b];
		if (acc >= want) return lo + ((b + 1) / 64) * span + tank.visual.radius * 0.5;
	}
	return tank.max[1];
}

/** every live tank as a water volume for buoyancy (waterQuery) */
function publishTankVolumes() {
	/** @type {any[]} */
	const list = [];
	for (const t of tanks.values()) {
		if (!t.count || t.surfaceLocal == null) continue;
		const inv = t.frame.clone().invert();
		const p = new THREE.Vector3();
		const surfaceY = new THREE.Vector3(0, t.surfaceLocal, 0).applyMatrix4(t.frame).y;
		const { min, max } = t;
		list.push({
			uuid: t.object.uuid,
			tank: true,
			surfaceY,
			spec: { density: 1000 * Math.max(0.2, 1 + t.spec.viscosity * 0.4), linearDrag: 1.5 + t.spec.viscosity * 8, angularDrag: 1 + t.spec.viscosity * 4 },
			contains: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
				p.set(x, y, z).applyMatrix4(inv);
				return p.x >= min[0] && p.x <= max[0] && p.z >= min[2] && p.z <= max[2] && p.y >= min[1];
			}
		});
	}
	setTankVolumes(list);
}

/**
 * The fluid's push on dynamic bodies, initiator-only (physics authority).
 *
 * CAPPED. The solver's reaction is honest for water-mass particles, but scene masses are
 * authored for feel (1 kg for a 1 m crate), so the raw sum launched a 0.5 kg ball 25 m out
 * of the tank, and a buoyancy-sized cap still threw foam ducks over the glass (both
 * measured). Floating is now I1's job — the tank publishes itself as a water volume — and
 * the particles only stir: at most half the body's weight per step.
 * @param {Tank} tank @param {Record<string, number[]>} impulses
 */
function applyPush(tank, impulses) {
	if (!impulses || !get(simulating)) return;
	const v = new THREE.Vector3();
	const root = tank.object.parent;
	for (const [uuid, j] of Object.entries(impulses)) {
		const body = root?.getObjectByProperty?.('uuid', uuid);
		const p = body?.userData?.physics;
		if (!p) continue;
		const floats = normalizeFloats(p.floats);
		if (floats.off) continue;
		// floating itself is buoyancy's job (the tank is a water volume, publishTankVolumes);
		// the particles only STIR: at most half the body's weight, sideways or up
		const cap = (p.mass ?? 1) * 9.81 * 0.5 * floats.multiplier * tank.lastDt;
		v.set(j[0], j[1], j[2]).applyQuaternion(tank.frameQuat).clampLength(0, cap);
		applyImpulse(uuid, [v.x, v.y, v.z]);
	}
}

/** objectsGroup's parent (the scene, or the VR world rig): the visual hangs NEXT TO the
 * content, never inside it (saves, picking and physics read objectsGroup) */
let visualParent = /** @type {any} */ (null);
function visualParentOf(/** @type {any} */ _object) {
	return visualParent;
}

const box = new THREE.Box3();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const sphere = new THREE.Sphere();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const invFrame = new THREE.Matrix4();

/**
 * The tank's inside, in its own frame (metres; rotation and position, no scale).
 * @param {any} object
 */
function interiorOf(object) {
	const g = object.geometry;
	if (g && !g.boundingBox) g.computeBoundingBox();
	const bb = g?.boundingBox ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
	object.matrixWorld.decompose(tmpV, tmpQ, tmpS);
	const sx = Math.abs(tmpS.x), sy = Math.abs(tmpS.y), sz = Math.abs(tmpS.z);
	const c = bb.getCenter(new THREE.Vector3());
	const half = [((bb.max.x - bb.min.x) / 2) * sx - TANK_WALL, ((bb.max.y - bb.min.y) / 2) * sy - TANK_WALL / 2, ((bb.max.z - bb.min.z) / 2) * sz - TANK_WALL];
	const yShift = TANK_WALL / 2; // the floor is a wall, the top is open
	const center = new THREE.Vector3(c.x * sx, c.y * sy + yShift, c.z * sz);
	return {
		min: [-half[0], -half[1], -half[2]].map((v) => Math.min(v, -0.02)),
		max: half.map((v) => Math.max(v, 0.02)),
		center,
		pos: tmpV.clone(),
		quat: tmpQ.clone()
	};
}

/** @param {Tank} tank @param {number} count */
function initTank(tank, count) {
	const size = [0, 1, 2].map((a) => tank.max[a] - tank.min[a]);
	const spacing = spacingFor(size, count, tank.spec.fill || 0.4);
	tank.capacity = count;
	tank.gen = (tank.gen ?? 0) + 1;
	tank.visual?.dispose();
	tank.visual = new FluidVisual({ capacity: count, radius: spacing * 0.62, size });
	tank.visual.setLook(tank.spec.color, tank.spec.clarity);
	tank.pending = false;
	tank.count = 0;
	tank.spare = null;
	const w = ensureWorker();
	const init = { op: 'init', id: tank.object.uuid, gen: tank.gen, min: tank.min, max: tank.max, capacity: count, spacing, fill: tank.spec.fill, count };
	if (w) {
		w.postMessage(init);
		tank.local = undefined;
	} else {
		const solver = new FluidSolver({ min: tank.min, max: tank.max, capacity: count, spacing });
		solver.fillBlock(tank.spec.fill, count);
		tank.local = { solver, acc: { carry: 0, drainCarry: 0 } };
	}
}

/** @param {Tank} tank */
function dropTank(tank) {
	tank.visual?.dispose();
	const w = worker;
	if (w) w.postMessage({ op: 'drop', id: tank.object.uuid });
}

/**
 * Colliders for one tank: every other object whose bounds reach into it, as a box (or a
 * sphere) in the tank frame. Dynamic bodies are marked so the fluid pushes them back.
 * @param {any} root @param {Tank} tank @param {THREE.Vector3} tankCenterW @param {number} tankRadius
 */
function collidersFor(root, tank, tankCenterW, tankRadius) {
	/** @type {any[]} */
	const out = [];
	const pushing = get(simulating);
	for (const o of root.children) {
		if (o === tank.object || o.userData?.fluid || o.userData?.water || !o.visible) continue;
		const g = o.geometry;
		if (!g) continue;
		if (!g.boundingBox) g.computeBoundingBox();
		if (!g.boundingBox) continue;
		o.matrixWorld.decompose(tmpV, tmpQ, tmpS);
		const lc = g.boundingBox.getCenter(new THREE.Vector3());
		const half = g.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5).multiply(tmpS.set(Math.abs(tmpS.x), Math.abs(tmpS.y), Math.abs(tmpS.z)));
		const cw = lc.applyMatrix4(o.matrixWorld);
		if (cw.distanceTo(tankCenterW) > tankRadius + half.length()) continue;
		const cl = cw.clone().applyMatrix4(invFrame);
		const ql = tank.frameQuat.clone().invert().multiply(tmpQ);
		const sphereKind = inferredColliderKind(o) === 'sphere' || o.userData?.physics?.collider === 'sphere';
		out.push({
			kind: sphereKind ? 'sphere' : 'box',
			center: [cl.x, cl.y, cl.z],
			half: sphereKind ? [Math.max(half.x, half.y, half.z)] : [half.x, half.y, half.z],
			quat: [ql.x, ql.y, ql.z, ql.w],
			dynamic: pushing && o.userData?.physics?.mode === 'dynamic',
			id: o.uuid
		});
		if (out.length >= 16) break; // a tank full of props: the 16 nearest-in-list are plenty
	}
	return out;
}

/**
 * The per-frame tick (tickSim).
 * @param {any} root objectsGroup @param {any} camera @param {any} renderer @param {number} now ms
 */
export function tickFluid(root, camera, renderer, now) {
	/** @type {Set<string>} */
	const alive = new Set();
	visualParent = root?.parent ?? null;
	qualityLowered = false;
	if (root && visualParent)
		for (const o of root.children) {
			if (!o.userData?.fluid) continue;
			alive.add(o.uuid);
			tickTank(root, o, camera, renderer, now);
		}
	for (const [uuid, tank] of tanks)
		if (!alive.has(uuid)) {
			dropTank(tank);
			tanks.delete(uuid);
		}
	publishTankVolumes();
	noteSimplified('fluid', qualityLowered);
}

/** @param {any} root @param {any} object @param {any} camera @param {any} renderer @param {number} now */
function tickTank(root, object, camera, renderer, now) {
	const spec = normalizeFluid(object.userData.fluid);
	const xr = !!renderer?.xr?.isPresenting;
	const q = get(qualityOverrides);
	const low = xr || q.postOff || q.particlesCapped || spec.quality === 'points';
	if (!xr && spec.quality === 'auto' && (q.postOff || q.particlesCapped)) qualityLowered = true;
	const count = Math.min(spec.count, low ? QUEST_CAP : FLUID_MAX_PARTICLES);
	object.updateWorldMatrix(true, false);
	const inside = interiorOf(object);
	const key = [count, spec.fill, spec.generation, ...inside.min.map((v) => v.toFixed(3)), ...inside.max.map((v) => v.toFixed(3))].join(',');
	let tank = tanks.get(object.uuid);
	if (!tank) {
		tank = /** @type {Tank} */ ({
			object, key: '', spec, visual: /** @type {any} */ (null), capacity: 0, pending: false, sentAt: 0, steps: 0, ms: 0,
			count: 0, visible: true, min: inside.min, max: inside.max, frame: new THREE.Matrix4(), frameQuat: new THREE.Quaternion(),
			prevPos: null, prevVel: new THREE.Vector3(), accel: new THREE.Vector3(), lastAt: 0, lastDt: 1 / 60, spare: null
		});
		tanks.set(object.uuid, tank);
	}
	tank.object = object;
	tank.spec = spec;
	tank.min = inside.min;
	tank.max = inside.max;
	if (tank.key !== key) {
		// 36-fb-water F27: a re-init after load (the tier's particle cap changed) restarts the solver
		// and rebuilds the visual — its hitch is not the scene's cost
		if (tank.key) settleQuality();
		tank.key = key;
		initTank(tank, count);
	}
	tank.visual.setLook(spec.color, spec.clarity);
	const mode = low && spec.quality !== 'high' ? 'points' : xr ? 'points' : 'ssf';
	if (tank.visual.mode !== mode && tank.steps > 0) settleQuality(); // F27: SSF passes compile on first use
	tank.visual.setMode(mode);
	// the tank frame: position + rotation, metres (scale is in the interior already)
	const centerW = inside.center.clone().applyQuaternion(inside.quat).add(inside.pos);
	tank.frame.compose(centerW, inside.quat, tmpS.set(1, 1, 1));
	tank.frameQuat.copy(inside.quat);
	invFrame.copy(tank.frame).invert();
	const parent = visualParentOf(object);
	if (tank.visual.group.parent !== parent) parent?.add(tank.visual.group);
	// keep the visual glued to the tank even between solver frames
	if (parent) {
		parent.updateWorldMatrix(true, false);
		tank.visual.group.matrix.copy(parent.matrixWorld).invert().multiply(tank.frame);
		tank.visual.group.matrixWorldNeedsUpdate = true;
	}
	// visible? (off-screen tanks pause)
	const radius = Math.hypot(tank.max[0] - tank.min[0], tank.max[1] - tank.min[1], tank.max[2] - tank.min[2]) / 2;
	sphere.set(centerW, radius);
	projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	frustum.setFromProjectionMatrix(projView);
	const hidden = typeof document !== 'undefined' && document.hidden;
	tank.visible = !hidden && frustum.intersectsSphere(sphere);
	tank.visual.prepare(camera, renderer?.domElement?.height ?? 800);
	// the tank's own acceleration sloshes the fluid (measured per frame)
	const dtFrame = tank.lastAt ? Math.min((now - tank.lastAt) / 1000, 1 / 20) : 0;
	tank.lastAt = now;
	if (tank.prevPos && dtFrame > 0) {
		const vel = centerW.clone().sub(tank.prevPos).divideScalar(dtFrame);
		if (vel.length() > 30) vel.set(0, 0, 0); // a teleport, not a motion
		// smoothed: frame-to-frame differencing of a dragged gizmo is noisy
		tank.accel.lerp(vel.clone().sub(tank.prevVel).divideScalar(dtFrame), 0.5);
		tank.prevVel.copy(vel);
	}
	tank.prevPos = centerW.clone();
	if (!tank.visible || tank.pending) return;
	if (simHeld()) {
		tank.sentAt = now; // resume without a jump
		return;
	}
	const dt = tank.sentAt ? Math.min((now - tank.sentAt) / 1000, 1 / 30) : 1 / 60;
	tank.sentAt = now;
	tank.lastDt = dt;
	const gw = new THREE.Vector3(0, get(sceneGravity) * spec.gravityScale, 0).sub(tank.accel.clampLength(0, 40));
	const gl = gw.applyQuaternion(tank.frameQuat.clone().invert());
	const msg = {
		op: 'step',
		id: object.uuid,
		dt,
		gravity: [gl.x, gl.y, gl.z],
		viscosity: spec.viscosity,
		surfaceTension: spec.surfaceTension,
		colliders: collidersFor(root, tank, centerW, radius),
		spec: { ...spec, count },
		// 36-fb-water F16: the top is open when the tank may spill (it only matters once tipped:
		// upright, nothing climbs a smoothing length above the rim)
		walls: spec.spill.on ? OPEN_TOP : ALL_WALLS
	};
	if (tank.local) {
		const t0 = performance.now();
		pourAndDrain(tank.local.solver, msg.spec, dt, tank.local.acc);
		tank.local.solver.step(dt, msg);
		const escaped = tank.local.solver.escapedCount ? tank.local.solver.takeEscaped() : null;
		onFrame({ op: 'frame', id: object.uuid, gen: tank.gen, count: tank.local.solver.count, positions: tank.local.solver.x, impulses: tank.local.solver.impulses, ms: performance.now() - t0, ...(escaped ? { escaped } : {}) });
		return;
	}
	const w = ensureWorker();
	if (!w) return; // switched to local: next frame re-inits
	tank.pending = true;
	const buffer = tank.spare;
	tank.spare = null;
	if (buffer) w.postMessage({ ...msg, buffer }, [buffer]);
	else w.postMessage(msg);
}

/** TEST/DEBUG: every tank's live numbers */
export function fluidDebug() {
	return [...tanks.entries()].map(([uuid, t]) => ({
		uuid,
		count: t.count,
		capacity: t.capacity,
		steps: t.steps,
		ms: Math.round(t.ms * 100) / 100,
		visible: t.visible,
		mode: t.visual?.mode,
		ssfRuns: t.visual?.passStats?.runs ?? 0,
		spilled: Math.round(t.spilled ?? 0),
		worker: worker ? 'worker' : worker === false ? 'main' : 'none'
	}));
}

/** TEST: drop everything */
export function resetFluid() {
	for (const t of tanks.values()) dropTank(t);
	tanks.clear();
}
