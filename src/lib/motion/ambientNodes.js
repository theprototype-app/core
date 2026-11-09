// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { applyWander } from './motionNodes.js';
import { hash01 } from './motionCore.js';
import { walkTime, nearest, fleeAmount, yawToward, angleTo, clampNum, AMBIENT_DEFAULTS } from './ambientCore.js';

// 85 N3 — AMBIENT ANIMALS, the THREE half: a deer that grazes and strolls, fish that drift and
// pause, a cat that looks up at you, birds that hop away when you come close. A LEAF beside
// motionNodes.js (whose Wander it walks on). The position is a pure function of the shared clock
// and the players' replicated positions; only the TURN is smoothed per peer (it converges).
// With `clips` on, flowRuntime hands the animal's speed to 57's Blend by Speed machinery, so a
// model with idle / walk / run clips plays them (idle while resting, run while fleeing).

const vA = new THREE.Vector3();
const mA = new THREE.Matrix4();

/** per (node, object): the smoothed heading and the last read @type {Map<string, {yaw: number, t: number, seen: number, read: any}>} */
const states = new Map();
let frameNo = 0;

/** @param {any} object @param {number[]} p world */
function setWorldPos(object, p) {
	vA.set(p[0], p[1], p[2]);
	if (object.parent) {
		object.parent.updateWorldMatrix(true, false);
		vA.applyMatrix4(mA.copy(object.parent.matrixWorld).invert());
	}
	object.position.copy(vA);
}

/**
 * Ambient Animal: wander with rests, face the way it goes, look at the nearest player while it
 * rests, shy away from one who comes within `fleeRadius`.
 * @param {any} object @param {any} base @param {any} data @param {number} time
 * @param {{root: any, key: string, players: number[][]}} ctx
 */
export function applyAmbientAnimal(object, base, data, time, ctx) {
	const d = AMBIENT_DEFAULTS;
	const seed = clampNum(data?.seed, 0, 0, 100000);
	const seed01 = seed ? hash01('seed:' + seed) : hash01(object.uuid);
	const w = walkTime(time, data, seed01);
	const wander = { ...data, ground: data?.ground !== false, rx: data?.rx ?? d.rx, ry: data?.ry ?? d.ry, rz: data?.rz ?? d.rz };
	const { p, v } = applyWander(object, base, wander, w.tau, { root: ctx.root });
	const near = nearest(p, ctx.players ?? []);
	const flee = near ? fleeAmount(near.d, clampNum(data?.fleeRadius, d.fleeRadius, 0, 50), clampNum(data?.fleeDistance, d.fleeDistance, 0, 50)) : 0;
	const forward = typeof data?.forward === 'string' ? data.forward : d.forward;
	/** @type {number | null} */
	let target = null;
	let mode = w.walking ? 'walking' : 'resting';
	if (flee > 0.02 && near) {
		let dx = p[0] - near.at[0];
		let dz = p[2] - near.at[2];
		const l = Math.hypot(dx, dz) || 1;
		dx /= l;
		dz /= l;
		p[0] += dx * flee;
		p[2] += dz * flee;
		setWorldPos(object, p);
		target = yawToward(dx, dz, forward);
		mode = 'fleeing';
	} else if (w.walking && Math.hypot(v[0], v[2]) > 1e-4) target = yawToward(v[0], v[2], forward);
	else if (!w.walking && near && near.d < clampNum(data?.lookRadius, d.lookRadius, 0, 50)) {
		target = yawToward(near.at[0] - p[0], near.at[2] - p[2], forward);
		mode = 'looking';
	}
	let s = states.get(ctx.key);
	if (!s) {
		s = { yaw: target ?? base.rot[1], t: time, seen: frameNo, read: null };
		states.set(ctx.key, s);
	}
	const dt = Math.max(0, Math.min(0.5, time - s.t));
	if (target !== null) s.yaw += angleTo(s.yaw, target) * (1 - Math.exp(-clampNum(data?.turnSpeed, d.turnSpeed, 0.1, 60) * dt));
	s.t = time;
	s.seen = frameNo;
	object.rotation.y = s.yaw;
	// the speed the clip blend reads: 0 resting, 1 walking (Blend by Speed's walk), 2.5 fleeing (run)
	const speed = mode === 'fleeing' ? 2.5 : mode === 'walking' ? 1 : 0;
	s.read = { mode, speed, flee, walking: w.walking, restLeft: w.restLeft, p };
	return s.read;
}

/** the last read for (node, object), or null (flowRuntime's clip blend) @param {string} key */
export function ambientRead(key) {
	return states.get(key)?.read ?? null;
}

/** call once per tick: forget animals nobody drove for a while */
export function tickAmbientNodes() {
	frameNo++;
	if (frameNo % 120) return;
	for (const [k, s] of states) if (frameNo - s.seen > 240) states.delete(k);
}

/** debug: the live animals */
export function ambientNodesDebug() {
	return Object.fromEntries([...states].map(([k, s]) => [k, s.read && { mode: s.read.mode, speed: s.read.speed, yaw: s.yaw }]));
}

export function resetAmbientNodes() {
	states.clear();
}
