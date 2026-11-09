// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 85 I1 — GRABBABLES THAT RETURN OR STAY, without a simulation. playInteract carries a Grabbable
// object kinematically (its existing carry, streamed as `move` at 20 Hz); on release this leaf
// glides it back to where it was picked up (`return`) after a delay, streaming the same moves, or
// leaves it where it was put down (`stay`). The peer that let go drives the glide, so the others
// see one stream and nothing fights. A LEAF: three only (playInteract hands in the sender).

/** @typedef {{object: any, from: {pos: THREE.Vector3, quat: THREE.Quaternion}, home: {pos: THREE.Vector3, quat: THREE.Quaternion}, start: number, duration: number, lastSent: number}} Glide */

/** uuid -> its glide home @type {Map<string, Glide>} */
const glides = new Map();
const SEND_MS = 50; // 20 Hz, the carry's cadence

/** smooth in-out @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The release rule of a Grabbable: what a node's data asks for, clamped.
 * @param {any} data @returns {{release: 'stay' | 'return', delay: number, duration: number}}
 */
export function grabRule(data) {
	const n = (/** @type {any} */ v, /** @type {number} */ f, /** @type {number} */ lo, /** @type {number} */ hi) => {
		const x = Number(v);
		return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : f;
	};
	return {
		release: data?.release === 'return' ? 'return' : 'stay',
		delay: n(data?.returnAfter, 1, 0, 600),
		duration: n(data?.returnTime, 0.6, 0.05, 30)
	};
}

/**
 * Start gliding `object` home (its pose when it was picked up).
 * @param {any} object @param {{pos: number[], quat: number[]}} home @param {{delay: number, duration: number}} rule @param {number} now ms
 */
export function startGlide(object, home, rule, now) {
	glides.set(object.uuid, {
		object,
		from: { pos: object.position.clone(), quat: object.quaternion.clone() },
		home: { pos: new THREE.Vector3().fromArray(home.pos), quat: new THREE.Quaternion().fromArray(home.quat) },
		start: now + rule.delay * 1000,
		duration: rule.duration * 1000,
		lastSent: 0
	});
}

/** a new grab of the object cancels its glide (the person caught it on the way) @param {string} uuid */
export function cancelGlide(uuid) {
	glides.delete(uuid);
}

/** @param {string} uuid */
export function gliding(uuid) {
	return glides.has(uuid);
}

/**
 * Advance every glide to `now` (ms) and stream its pose through `send(object, final)` at 20 Hz
 * (and once more on arrival, so every peer lands exactly home).
 * @param {number} now @param {(object: any, final: boolean) => void} send @param {(object: any) => boolean} [alive]
 */
export function stepGlides(now, send, alive = () => true) {
	for (const [uuid, g] of glides) {
		if (!alive(g.object)) {
			glides.delete(uuid);
			continue;
		}
		if (now < g.start) continue;
		const u = smooth((now - g.start) / g.duration);
		g.object.position.lerpVectors(g.from.pos, g.home.pos, u);
		g.object.quaternion.slerpQuaternions(g.from.quat, g.home.quat, u);
		g.object.updateMatrixWorld();
		const done = u >= 1;
		if (done || now - g.lastSent >= SEND_MS) {
			g.lastSent = now;
			send(g.object, done);
		}
		if (done) glides.delete(uuid);
	}
}

/** debug / suites */
export function grabReturnDebug() {
	return [...glides.keys()];
}
