// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { inferredColliderKind } from '../colliderSpec';
import { normalizeInteraction } from './fluidEmitterCore.js';
export { FLUID_INTERACTIONS, normalizeInteraction } from './fluidEmitterCore.js';

// 36-fb F23/F25: what an open-area fluid (a Fluid emitter) collides with. Every MESH in the
// scene whose box reaches into the area — descending into groups, so a mill wheel built from
// paddle meshes is a set of paddles, not one box around the wheel — as an oriented box (or a
// sphere), with its MOTION measured from frame to frame: a turning paddle is a collider with
// `omega`, and the solver's tangential carry makes it drag water (fluidCore.carry).
//
// "FLUID INTERACTION" (Inspector, per mesh; `userData.fluidInteraction`, replicated):
//   'auto'    (absent)  collide; a dynamic physics body is also pushed (the tank's rule)
//   'none'              the fluid passes through
//   'collide'           a solid the fluid flows around, never pushed
//   'float'             collide + pushed + floats on the fluid's pools (light objects)
// A compound custom collider (a Fluid tank's glass, an authored hull set) collides as its
// pieces, so water poured INTO a tank or a basin built that way stays in it.

/** the most colliders one emitter step carries (nearest the nozzle win) */
export const MAX_COLLIDERS = 96;
/** a collider thinner than this (a Plane) is thickened DOWNWARD to it, or fast drops tunnel */
const MIN_HALF = 0.06;

/** the scene object a mesh belongs to (a direct child of the objects group) @param {any} o @param {any} root */
function topOf(o, root) {
	let t = o;
	while (t.parent && t.parent !== root) t = t.parent;
	return t;
}

/** the interaction a mesh resolves to: its own, else the nearest ancestor's @param {any} o @param {any} root */
function interactionOf(o, root) {
	for (let t = o; t && t !== root; t = t.parent) if (t.userData?.fluidInteraction) return normalizeInteraction(t.userData.fluidInteraction);
	return 'auto';
}

/** is this object part of a fluid emitter / water (never a collider) @param {any} o @param {any} root */
function skipped(o, root) {
	for (let t = o; t && t !== root; t = t.parent) {
		const u = t.userData;
		if (!t.visible || u?.fluidEmitter || u?.water || u?.__fluidVisual || u?.flowPath) return true;
	}
	return false;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const box = new THREE.Box3();
const axisW = new THREE.Vector3();

/**
 * The gatherer for ONE fluid domain: remembers last frame's pose of every piece so it can
 * report motion. `candidates` is re-walked every `rescanEvery` frames (a scene walk per frame
 * per emitter is waste); poses are read every frame.
 */
export class FluidColliderSet {
	constructor() {
		/** @type {{mesh: any, piece: number[] | null, key: string}[]} */
		this.candidates = [];
		this.frame = 0;
		this.rescanEvery = 30;
		/** @type {Map<string, {c: THREE.Vector3, q: THREE.Quaternion, at: number}>} */
		this.prev = new Map();
	}

	/**
	 * @param {any} root objectsGroup
	 * @param {{min: THREE.Vector3, max: THREE.Vector3}} areaW the area's world AABB
	 * @param {THREE.Vector3} centerW the area centre (the solver's origin; the area is world-axis aligned)
	 * @param {THREE.Vector3} nozzleW nearest-first ordering point
	 * @param {number} now ms
	 * @param {boolean} simulating a physics sim is running (dynamic bodies can be pushed)
	 * @param {{min: number[], max: number[]} | null} [wet] where the water is (world), last frame: a
	 *   collider nowhere near it is skipped — a diorama has more meshes than the cap, and ranking
	 *   by distance to the nozzle alone dropped the far end of a trough (measured: a leak)
	 * @returns {any[]} FluidCollider[] in area-local coordinates
	 */
	gather(root, areaW, centerW, nozzleW, now, simulating, wet = null) {
		if (this.frame++ % this.rescanEvery === 0) this.rescan(root, areaW);
		/** @type {{d: number, c: any}[]} */
		const found = [];
		const seen = new Set();
		for (const cand of this.candidates) {
			const m = cand.mesh;
			if (!m.parent || skipped(m, root)) continue;
			const mode = interactionOf(m, root);
			if (mode === 'none') continue;
			const g = m.geometry;
			if (!g.boundingBox) g.computeBoundingBox();
			m.updateWorldMatrix(true, false);
			m.matrixWorld.decompose(tmpV, tmpQ, tmpS);
			const sx = Math.abs(tmpS.x), sy = Math.abs(tmpS.y), sz = Math.abs(tmpS.z);
			// the piece (compound collider) or the whole geometry box, mesh-local
			let lc, lh;
			if (cand.piece) {
				lc = new THREE.Vector3(cand.piece[0], cand.piece[1], cand.piece[2]);
				lh = new THREE.Vector3(cand.piece[3], cand.piece[4], cand.piece[5]);
			} else {
				lc = g.boundingBox.getCenter(new THREE.Vector3());
				lh = g.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
			}
			lh.set(lh.x * sx, lh.y * sy, lh.z * sz);
			const cw = lc.clone().applyMatrix4(m.matrixWorld);
			// thin pieces grow DOWN (away from whatever their top face looks at)
			for (let a = 0; a < 3; a++) {
				const h = a === 0 ? lh.x : a === 1 ? lh.y : lh.z;
				if (h >= MIN_HALF) continue;
				axisW.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(tmpQ);
				const up = axisW.y;
				if (Math.abs(up) > 0.3) cw.addScaledVector(axisW, -Math.sign(up) * (MIN_HALF - h));
				if (a === 0) lh.x = MIN_HALF; else if (a === 1) lh.y = MIN_HALF; else lh.z = MIN_HALF;
			}
			const reach = lh.length();
			if (wet && (cw.x + reach < wet.min[0] || cw.x - reach > wet.max[0] || cw.y + reach < wet.min[1] || cw.y - reach > wet.max[1] || cw.z + reach < wet.min[2] || cw.z - reach > wet.max[2])) continue;
			if (cw.x + reach < areaW.min.x || cw.x - reach > areaW.max.x || cw.y + reach < areaW.min.y || cw.y - reach > areaW.max.y || cw.z + reach < areaW.min.z || cw.z - reach > areaW.max.z) continue;
			// motion since last frame (a teleport is not a motion)
			const top = topOf(m, root);
			const p = this.prev.get(cand.key);
			/** @type {number[] | undefined} */ let vel;
			/** @type {number[] | undefined} */ let omega;
			if (p && now > p.at) {
				const dt = Math.min((now - p.at) / 1000, 0.1);
				const v = tmpC.copy(cw).sub(p.c).divideScalar(dt);
				if (v.lengthSq() > 1e-6 && v.length() < 20) vel = [v.x, v.y, v.z];
				// dq = q · prev⁻¹ → axis × angle / dt
				const dq = tmpQ.clone().multiply(p.q.clone().invert());
				if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
				const s = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
				if (s > 1e-5) {
					const ang = 2 * Math.atan2(s, dq.w);
					const k = ang / dt / s;
					if (ang / dt < 60) omega = [dq.x * k, dq.y * k, dq.z * k];
				}
			}
			if (p) {
				p.c.copy(cw);
				p.q.copy(tmpQ);
				p.at = now;
			} else this.prev.set(cand.key, { c: cw.clone(), q: tmpQ.clone(), at: now });
			seen.add(cand.key);
			const body = top.userData?.physics;
			const pushable = simulating && (mode === 'float' || mode === 'auto') && body?.mode === 'dynamic';
			const sphere = !cand.piece && (inferredColliderKind(m) === 'sphere' || body?.collider === 'sphere') && m === top;
			found.push({
				d: cw.distanceToSquared(nozzleW),
				c: {
					kind: sphere ? 'sphere' : 'box',
					center: [cw.x - centerW.x, cw.y - centerW.y, cw.z - centerW.z],
					half: sphere ? [Math.max(lh.x, lh.y, lh.z)] : [lh.x, lh.y, lh.z],
					quat: [tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w],
					...(vel ? { vel } : {}),
					...(omega ? { omega } : {}),
					dynamic: pushable,
					id: top.uuid
				}
			});
		}
		for (const k of [...this.prev.keys()]) if (!seen.has(k)) this.prev.delete(k);
		found.sort((a, b) => a.d - b.d);
		return found.slice(0, MAX_COLLIDERS).map((f) => f.c);
	}

	/** find the meshes whose world box reaches the area @param {any} root @param {{min: THREE.Vector3, max: THREE.Vector3}} areaW */
	rescan(root, areaW) {
		this.candidates = [];
		if (!root) return;
		const area = new THREE.Box3(areaW.min.clone(), areaW.max.clone()).expandByScalar(0.5);
		root.traverse((/** @type {any} */ o) => {
			if (!o.isMesh || !o.geometry || o === root) return;
			if (skipped(o, root)) return;
			o.updateWorldMatrix(true, false);
			if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
			box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
			if (!box.intersectsBox(area)) return;
			const pieces = compoundPieces(o);
			if (pieces) pieces.forEach((piece, i) => this.candidates.push({ mesh: o, piece, key: o.uuid + ':' + i }));
			else this.candidates.push({ mesh: o, piece: null, key: o.uuid });
		});
	}
}

/**
 * A compound custom collider (`userData.physics` colliderVerts + colliderPieces, the Fluid
 * tank's glass) as local boxes [cx, cy, cz, hx, hy, hz] — one per piece, from its vertices.
 * @param {any} o @returns {number[][] | null}
 */
export function compoundPieces(o) {
	const p = o.userData?.physics;
	if (p?.collider !== 'custom' || !Array.isArray(p.colliderVerts) || !Array.isArray(p.colliderPieces) || p.colliderPieces.length < 2) return null;
	const v = p.colliderVerts;
	/** @type {number[][]} */
	const out = [];
	for (const piece of p.colliderPieces) {
		const [start, n] = piece;
		if (typeof start !== 'number' || typeof n !== 'number') continue;
		let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (let i = start; i < start + n && i + 2 < v.length; i += 3)
			for (let a = 0; a < 3; a++) {
				lo[a] = Math.min(lo[a], v[i + a]);
				hi[a] = Math.max(hi[a], v[i + a]);
			}
		if (!Number.isFinite(lo[0])) continue;
		out.push([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2]);
	}
	return out.length ? out : null;
}
