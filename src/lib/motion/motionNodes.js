// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import {
	buildPath,
	samplePath,
	pathDistance,
	curvatureAt,
	bankRoll,
	wanderAt,
	hash01,
	waveDrive,
	forwardYaw,
	wrapAngle,
	damp,
	clampNum,
	BODY_WAVE_DEFAULTS
} from './motionCore.js';
import { normalizeSpline, isSplineObject } from '../splineTube.js';
import { normalizeFlowPath } from '../sim/flowPathCore.js';

// 40 F15 — GENERAL-PURPOSE MOTION, the THREE half: what flowRuntime.applyAnimation calls for
// `followpath`, `orientvelocity`, `wander` and `bodywave`. A LEAF beside sim/motionNodes.js — it
// imports nothing of the runtime (the history cycle), only three, the pure core and two
// import-free path readers. The maths and the rules live in motionCore.js (unit-tested).
//
// The followers (Orient to Velocity, Body Wave) read the motion the movers wrote THIS frame, so
// flowRuntime applies them after every other effect on the object (MOTION_PHASE below) — the
// node order in a graph then never decides whether a fish faces where it swims.
//
// BODY WAVE draws through the vertex shader, never through the transform (the jiggle rule: the
// transform belongs to the editor, physics and the network). Each waving mesh gets its OWN
// material clone — three re-uploads material uniforms only when the material changes between
// draws, so two fish sharing one material could not wave differently — and the original goes
// back (with any edit made meanwhile) when the wave stops. Serializers need nothing: toJSON and
// GLTF never see onBeforeCompile, the clone keeps the original's uuid and parameters.

/** the order effects apply in on one object: movers (0), then orienters (1), then deformers (2) */
export const MOTION_PHASE = /** @type {Record<string, number>} */ ({ orientvelocity: 1, bodywave: 2 });

const UP = new THREE.Vector3(0, 1, 0);
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();

// ---- shared: what a frame of motion looked like ---------------------------------------------

/**
 * Per (node, object) motion tracking in WORLD space: velocity, speed and turn rate, smoothed so
 * a single jittery frame does not snap a fish around. Keyed per node so two nodes reading one
 * object do not share a clock. LOCAL per peer (every peer converges on the same movers).
 * @type {Map<string, {pos: THREE.Vector3, t: number, vel: THREE.Vector3, speed: number, yaw: number, yawRate: number, quat: THREE.Quaternion | null, phase: number, seen: number}>}
 */
const tracks = new Map();
let frameNo = 0;

/** call once per runtime tick: forgets tracks nobody read for a while */
export function tickMotionNodes() {
	frameNo++;
	if (frameNo % 120) return;
	for (const [key, t] of tracks) if (frameNo - t.seen > 240) tracks.delete(key);
	for (const [key, w] of waves) if (frameNo - w.seen > 30) detachWave(key);
}

/**
 * Advance the tracker for `key` with the object's world position at `time` and return it.
 * @param {string} key @param {any} object @param {number} time
 */
function track(key, object, time) {
	object.updateWorldMatrix(true, false);
	const p = vA.setFromMatrixPosition(object.matrixWorld);
	let t = tracks.get(key);
	if (!t) {
		t = { pos: p.clone(), t: time, vel: new THREE.Vector3(), speed: 0, yaw: NaN, yawRate: 0, quat: null, phase: 0, seen: frameNo };
		tracks.set(key, t);
		return { t, dt: 0 };
	}
	t.seen = frameNo;
	const dt = time - t.t;
	// a pause, a scrub or a reload: re-anchor rather than read a teleport as a speed
	if (!(dt > 0) || dt > 0.5) {
		t.pos.copy(p);
		t.t = time;
		return { t, dt: 0 };
	}
	const k = damp(8, dt);
	vB.copy(p).sub(t.pos).divideScalar(dt);
	t.vel.lerp(vB, k);
	t.speed = t.vel.length();
	const flat = Math.hypot(t.vel.x, t.vel.z);
	if (flat > 0.02) {
		const yaw = Math.atan2(t.vel.x, t.vel.z);
		if (Number.isFinite(t.yaw)) t.yawRate += (wrapAngle(yaw - t.yaw) / dt - t.yawRate) * damp(4, dt);
		t.yaw = yaw;
	} else t.yawRate += (0 - t.yawRate) * damp(4, dt);
	t.pos.copy(p);
	t.t = time;
	return { t, dt };
}

/**
 * The world orientation that points a model's nose along `dir` with its top leaning `roll`
 * radians into the turn (+ = leans left). `pitch` false keeps the nose level.
 * @param {THREE.Vector3} dir world @param {number} roll @param {boolean} pitch @param {string} forward @param {THREE.Quaternion} out
 */
function headingQuat(dir, roll, pitch, forward, out) {
	const z = vB.copy(dir);
	if (!pitch) z.y = 0;
	if (z.lengthSq() < 1e-10) return false;
	z.normalize();
	// a straight-up/down heading has no horizontal: keep the basis finite
	const x = vC.crossVectors(UP, z);
	if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
	x.normalize();
	const y = vA.crossVectors(z, x);
	mA.makeBasis(x, y, z);
	out.setFromRotationMatrix(mA);
	// lean into the turn about the nose (+roll = top to the LEFT, which is the +x side here)
	if (roll) out.multiply(qB.setFromAxisAngle(vC.set(0, 0, 1), -roll));
	// the model's own nose axis
	const fy = forwardYaw(forward);
	if (fy) out.multiply(qB.setFromAxisAngle(UP, fy));
	return true;
}

/** write a WORLD quaternion onto an object as its local one @param {any} object @param {THREE.Quaternion} world */
function setWorldQuat(object, world) {
	const parent = object.parent;
	if (!parent) {
		object.quaternion.copy(world);
		return;
	}
	parent.updateWorldMatrix(true, false);
	parent.getWorldQuaternion(qA);
	object.quaternion.copy(qA.invert().multiply(world));
}

/** write a WORLD position onto an object as its local one @param {any} object @param {number[]} p */
function setWorldPos(object, p) {
	const parent = object.parent;
	vA.set(p[0], p[1], p[2]);
	if (parent) {
		parent.updateWorldMatrix(true, false);
		parent.worldToLocal(vA);
	}
	object.position.copy(vA);
}

/** @param {any} v */
const on = (v) => v !== false && v !== 0 && v !== 'false';

// ---- Follow Path ---------------------------------------------------------------------------

/** @type {Map<string, {sig: string, path: ReturnType<typeof buildPath>}>} */
const pathCache = new Map();

/**
 * The world-space control points (and whether they close) a Follow Path node rides: the wired
 * Spline or Flow path object, else its own clicked waypoints (already world).
 * @param {any} root @param {any} data
 * @returns {{points: number[][], closed: boolean, smooth: boolean} | null}
 */
export function pathSourceOf(root, data) {
	if (typeof data.path === 'string' && data.path && data.path !== '-None-') {
		const o = root?.getObjectByProperty('uuid', data.path);
		if (o) {
			o.updateWorldMatrix(true, false);
			if (isSplineObject(o)) {
				const s = normalizeSpline(o.userData.spline);
				return {
					points: s.points.map((/** @type {any} */ p) => vA.fromArray(p.pos).applyMatrix4(o.matrixWorld).toArray()),
					closed: !!s.closed,
					smooth: true
				};
			}
			if (o.userData?.flowPath) {
				const f = normalizeFlowPath(o.userData.flowPath);
				return {
					points: f.points.map((/** @type {number[]} */ p) => vA.fromArray(p).applyMatrix4(o.matrixWorld).toArray()),
					closed: false,
					smooth: on(data.smooth)
				};
			}
		}
	}
	const pts = Array.isArray(data.points) ? data.points : [];
	if (pts.length < 2) return null;
	return { points: pts, closed: on(data.closed ?? true), smooth: on(data.smooth) };
}

/** the built path for a source, cached by its numbers @param {string} key @param {{points: number[][], closed: boolean, smooth: boolean}} src */
function pathFor(key, src) {
	let sig = (src.closed ? 'c' : 'o') + (src.smooth ? 's' : 'p');
	for (const p of src.points) sig += '|' + (+p[0]).toFixed(4) + ',' + (+p[1]).toFixed(4) + ',' + (+p[2]).toFixed(4);
	const hit = pathCache.get(key);
	if (hit && hit.sig === sig) return hit.path;
	const path = buildPath(src.points, { closed: src.closed, smooth: src.smooth });
	pathCache.set(key, { sig, path });
	return path;
}

/**
 * Follow Path: a pure function of (path, data, shared time) — every peer computes the same pose.
 * @param {any} object @param {any} base @param {any} data @param {number} time @param {{root: any, key: string}} ctx
 * @returns {{s: number, yawRate: number} | null} where it is (for tests and the readout)
 */
export function applyFollowPath(object, base, data, time, ctx) {
	const src = pathSourceOf(ctx.root, data);
	if (!src) return null;
	const path = pathFor(ctx.key, src);
	if (!path) return null;
	const speed = clampNum(data.speed, 0.5, -20, 20);
	const mode = data.mode === 'pingpong' || data.mode === 'once' ? data.mode : 'loop';
	const { s, dir } = pathDistance(time, speed, path.total, mode, clampNum(data.offset, 0, 0, 1));
	const here = samplePath(path, s);
	setWorldPos(object, here.p);
	const kappa = curvatureAt(path, s);
	const moving = mode !== 'once' || (s > 0 && s < path.total);
	const yawRate = moving ? kappa * Math.abs(speed) * dir : 0;
	if (on(data.align ?? true)) {
		const travel = vC.set(here.t[0] * dir, here.t[1] * dir, here.t[2] * dir);
		const roll = bankRoll(yawRate, clampNum(data.bank, 0.5, 0, 1), clampNum(data.maxBank, 30, 0, 85));
		const q = new THREE.Quaternion();
		if (headingQuat(travel.clone(), roll, on(data.pitch ?? true), data.forward ?? '+z', q)) setWorldQuat(object, q);
	}
	return { s, yawRate };
}

// ---- Wander ---------------------------------------------------------------------------------

const box = new THREE.Box3();

/**
 * The box a wanderer stays in, in WORLD space: the wired area object's bounds shrunk by
 * `margin`, else a box of half-extents (rx, ry, rz) around where it was placed.
 * @param {any} object @param {any} base @param {any} data @param {any} root
 * @returns {{center: [number, number, number], half: [number, number, number]}}
 */
export function wanderBox(object, base, data, root) {
	if (typeof data.area === 'string' && data.area && data.area !== '-None-') {
		const o = root?.getObjectByProperty('uuid', data.area);
		if (o) {
			o.updateWorldMatrix(true, true);
			box.setFromObject(o);
			if (!box.isEmpty()) {
				const m = clampNum(data.margin, 0.2, 0, 50);
				const c = box.getCenter(vA);
				const sz = box.getSize(vB);
				return {
					center: [c.x, c.y, c.z],
					half: [Math.max(0, sz.x / 2 - m), Math.max(0, sz.y / 2 - m), Math.max(0, sz.z / 2 - m)]
				};
			}
		}
	}
	const parent = object.parent;
	vA.fromArray(base.pos);
	if (parent) {
		parent.updateWorldMatrix(true, false);
		vA.applyMatrix4(parent.matrixWorld);
	}
	return {
		center: [vA.x, vA.y, vA.z],
		half: [clampNum(data.rx, 1, 0, 50), clampNum(data.ry, 0.3, 0, 50), clampNum(data.rz, 1, 0, 50)]
	};
}

/**
 * Wander: drift around a smooth, seeded noise target inside a box. Pure of (box, data, time).
 * `seed` 0 = derive from the object's uuid, so one Wander node driving several objects (or a
 * prefab duplicated five times) never moves them in step.
 * @param {any} object @param {any} base @param {any} data @param {number} time @param {{root: any}} ctx
 */
export function applyWander(object, base, data, time, ctx) {
	const { center, half } = wanderBox(object, base, data, ctx.root);
	const seed = clampNum(data.seed, 0, 0, 100000);
	const seed01 = seed ? hash01('seed:' + seed) : hash01(object.uuid);
	const { p, v } = wanderAt(time, center, half, clampNum(data.speed, 0.3, 0, 5), seed01);
	setWorldPos(object, p);
	return { p, v };
}

// ---- Orient to Velocity ---------------------------------------------------------------------

/**
 * Orient to Velocity: face the direction the object moved this frame, turning at most
 * `turnSpeed` (1/s, exponential) and leaning into turns. Holds its last heading while still.
 * @param {any} object @param {any} base @param {any} data @param {number} time @param {{key: string}} ctx
 */
export function applyOrientVelocity(object, base, data, time, ctx) {
	const { t, dt } = track(ctx.key, object, time);
	const minSpeed = clampNum(data.minSpeed, 0.02, 0, 10);
	const pitch = on(data.pitch ?? true);
	if (t.speed > minSpeed) {
		const roll = bankRoll(t.yawRate, clampNum(data.bank, 0.5, 0, 1), clampNum(data.maxBank, 30, 0, 85));
		const want = new THREE.Quaternion();
		if (headingQuat(t.vel.clone(), roll, pitch, data.forward ?? '+z', want)) {
			if (!t.quat) t.quat = want.clone();
			else t.quat.slerp(want, dt > 0 ? damp(clampNum(data.turnSpeed, 4, 0.1, 60), dt) : 1);
		}
	}
	// the base restore put the authored rotation back: re-assert the held heading every frame
	if (t.quat) setWorldQuat(object, t.quat);
	return t;
}

// ---- Body Wave ------------------------------------------------------------------------------

const WAVE_DECL = /* glsl */ `
uniform mat4 bwToRoot;
uniform mat3 bwFromRoot;
uniform vec3 bwAxis;
uniform vec3 bwSide;
uniform vec2 bwRange;
uniform vec4 bwShape;
uniform vec3 bwDrive;
`;
// u: 0 at the nose, 1 at the tail; the envelope and the travelling sine are motionCore's
// waveOffset verbatim (k = 1/wavelength in bwShape.x, dir in bwShape.w, drive in body lengths
// already multiplied by the length on the CPU)
const WAVE_VERTEX = /* glsl */ `
#include <begin_vertex>
{
	vec3 bwR = (bwToRoot * vec4(transformed, 1.0)).xyz;
	float bwU = clamp((bwRange.x - dot(bwR, bwAxis)) / max(bwRange.y, 1e-4), 0.0, 1.0);
	float bwX = clamp((bwU - bwShape.y) / max(1.0 - bwShape.y, 1e-3), 0.0, 1.0);
	float bwEnv = pow(bwX, bwShape.z);
	float bwOff = bwDrive.x * bwEnv * sin(6.2831853 * (bwU * bwShape.x - bwShape.w * bwDrive.z)) + bwDrive.y * bwU * bwU;
	transformed += bwFromRoot * (bwSide * bwOff);
}
`;

/** @typedef {{mesh: any, original: any, clone: any, uniforms: any}} WaveMesh */
/** @type {Map<string, {object: any, meshes: WaveMesh[], count: number, front: number, len: number, axis: THREE.Vector3, side: THREE.Vector3, sig: string, seen: number}>} */
const waves = new Map();

/** the side (bend) axis for a nose axis: horizontal = up × nose (a fish), vertical = up (a whale) @param {THREE.Vector3} axis @param {string} side */
function sideAxis(axis, side) {
	if (side === 'vertical') {
		const v = new THREE.Vector3(0, 1, 0);
		return Math.abs(axis.y) > 0.9 ? v.set(1, 0, 0) : v;
	}
	const v = new THREE.Vector3().crossVectors(UP, axis);
	return v.lengthSq() < 1e-8 ? v.set(1, 0, 0) : v.normalize();
}

/** meshes under an object (its own subtree), the jiggle traversal @param {any} object */
function meshesOf(object) {
	/** @type {any[]} */
	const out = [];
	object.traverse((/** @type {any} */ o) => {
		if (o.isMesh && o.geometry && o.material && !Array.isArray(o.material) && o.visible !== false) out.push(o);
	});
	return out;
}

/** @param {any} mesh @param {any} object */
function attachWaveMesh(mesh, object) {
	const original = mesh.material;
	const clone = original.clone();
	// the SAME uuid: a save taken mid-wave serializes a material identical to the original
	clone.uuid = original.uuid;
	const uniforms = {
		bwToRoot: { value: new THREE.Matrix4() },
		bwFromRoot: { value: new THREE.Matrix3() },
		bwAxis: { value: new THREE.Vector3(0, 0, 1) },
		bwSide: { value: new THREE.Vector3(1, 0, 0) },
		bwRange: { value: new THREE.Vector2(0, 1) },
		bwShape: { value: new THREE.Vector4(1, 0.3, 2, 1) },
		bwDrive: { value: new THREE.Vector3() }
	};
	const previous = original.onBeforeCompile;
	clone.onBeforeCompile = (/** @type {any} */ shader, /** @type {any} */ renderer) => {
		if (typeof previous === 'function' && previous !== THREE.Material.prototype.onBeforeCompile) previous(shader, renderer);
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = WAVE_DECL + shader.vertexShader.replace('#include <begin_vertex>', WAVE_VERTEX);
	};
	const baseKey = original.customProgramCacheKey?.() ?? '';
	clone.customProgramCacheKey = () => baseKey + '|bodywave1';
	mesh.material = clone;
	return { mesh, original, clone, uniforms };
}

/** @param {WaveMesh} m */
function detachWaveMesh(m) {
	if (m.mesh.material !== m.clone) return; // something else replaced it since; leave it
	const { onBeforeCompile, customProgramCacheKey, uuid } = m.original;
	m.original.copy(m.clone);
	m.original.uuid = uuid;
	m.original.onBeforeCompile = onBeforeCompile;
	m.original.customProgramCacheKey = customProgramCacheKey;
	m.original.userData = { ...(m.clone.userData ?? {}) };
	m.original.needsUpdate = true;
	m.mesh.material = m.original;
	m.clone.dispose();
}

/** @param {string} key */
function detachWave(key) {
	const w = waves.get(key);
	if (!w) return;
	for (const m of w.meshes) detachWaveMesh(m);
	waves.delete(key);
}

/**
 * (Re)build a wave's mesh list and body frame when the subtree or the axes changed — a pack
 * model arriving in place of its fallback, a LOD swap, a forward-axis edit.
 * @param {string} key @param {any} object @param {any} data
 */
function waveFor(key, object, data) {
	const meshes = meshesOf(object);
	const forward = data.forward ?? BODY_WAVE_DEFAULTS.forward;
	const side = data.side === 'vertical' ? 'vertical' : 'horizontal';
	const sig = forward + side + meshes.map((m) => m.uuid + ':' + m.geometry.uuid).join(',');
	let w = waves.get(key);
	if (w && w.sig === sig && w.object === object) {
		// a material swapped under us (an Inspector edit through applyMaterials): re-wrap
		for (let i = 0; i < w.meshes.length; i++) {
			const m = w.meshes[i];
			if (m.mesh.material !== m.clone && m.mesh.material && !Array.isArray(m.mesh.material)) w.meshes[i] = attachWaveMesh(m.mesh, object);
		}
		return w;
	}
	if (w) detachWave(key);
	// the body frame: the nose axis in the OBJECT's local frame, the extent along it over every mesh
	const axis = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, -forwardYaw(forward)).normalize();
	const sideV = sideAxis(axis, side);
	object.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
	let lo = Infinity;
	let hi = -Infinity;
	for (const m of meshes) {
		if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
		const bb = m.geometry.boundingBox;
		mA.copy(inv).multiply(m.matrixWorld);
		for (let i = 0; i < 8; i++) {
			vA.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mA);
			const d = vA.dot(axis);
			lo = Math.min(lo, d);
			hi = Math.max(hi, d);
		}
	}
	if (!Number.isFinite(lo)) return null;
	w = {
		object,
		meshes: meshes.map((m) => attachWaveMesh(m, object)),
		count: meshes.length,
		front: hi,
		len: Math.max(1e-3, hi - lo),
		axis,
		side: sideV,
		sig,
		seen: frameNo
	};
	waves.set(key, w);
	return w;
}

/**
 * Body Wave: a travelling bend along the body, driven by how fast and how hard the object turns.
 * @param {any} object @param {any} base @param {any} data @param {number} time @param {{key: string}} ctx
 */
export function applyBodyWave(object, base, data, time, ctx) {
	const w = waveFor(ctx.key, object, data);
	if (!w) return null;
	w.seen = frameNo;
	const { t, dt } = track(ctx.key, object, time);
	const drive = waveDrive(data, t.speed, t.yawRate);
	if (dt > 0) t.phase = (t.phase + drive.frequency * dt) % 1000;
	const d = BODY_WAVE_DEFAULTS;
	const k = 1 / Math.max(0.05, clampNum(data.wavelength, d.wavelength, 0.05, 8));
	const stiff = clampNum(data.stiffness, d.stiffness, 0, 0.95);
	const fall = clampNum(data.falloff, d.falloff, 0.25, 6);
	const dir = data.reverse ? -1 : 1;
	object.updateWorldMatrix(true, true);
	const inv = mA.copy(object.matrixWorld).invert();
	for (const m of w.meshes) {
		const u = m.uniforms;
		u.bwToRoot.value.copy(inv).multiply(m.mesh.matrixWorld);
		u.bwFromRoot.value.setFromMatrix4(u.bwToRoot.value).invert();
		u.bwAxis.value.copy(w.axis);
		u.bwSide.value.copy(w.side);
		u.bwRange.value.set(w.front, w.len);
		u.bwShape.value.set(k, stiff, fall, dir);
		u.bwDrive.value.set(drive.amplitude * w.len, drive.bend * w.len, t.phase);
	}
	return { drive, phase: t.phase, len: w.len, meshes: w.meshes.length };
}

/** the wave nodes no longer driving an object stand down (flowRuntime's restore loop) @param {Set<string>} liveKeys */
export function pruneBodyWaves(liveKeys) {
	for (const key of [...waves.keys()]) if (!liveKeys.has(key)) detachWave(key);
}

/** put every original material back (a serializer's park, a scene clear) */
export function resetMotionNodes() {
	for (const key of [...waves.keys()]) detachWave(key);
	tracks.clear();
	pathCache.clear();
}

/** debug: what the motion runtime holds */
export function motionNodesDebug() {
	return {
		tracks: tracks.size,
		paths: pathCache.size,
		waves: [...waves.entries()].map(([key, w]) => ({
			key,
			meshes: w.meshes.length,
			cloned: w.meshes.every((m) => m.mesh.material === m.clone),
			len: w.len
		}))
	};
}
