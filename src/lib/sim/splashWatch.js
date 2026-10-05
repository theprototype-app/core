// 36-sim I1: SPLASHES — a body crossing a water surface ripples it (contract W2).
//
// Runs on EVERY peer from the poses it sees, not inside the physics step: physics only
// steps on the initiator, and W2 ripples are each peer's own visual. The inputs (the
// object's pose — a physics `move` stream on a watcher, the world on the initiator — and
// the water volume) are shared, so every peer ripples at the same place at the same
// moment without a message. Cheap: a bounding sphere per watched object, one W1 query.

import { waterActive, waterSurfaceAt, disturbWater } from './waterQuery.js';

/** a crossing slower than this (m/s) is a wade, not a splash */
export const SPLASH_MIN_SPEED = 0.6;
/** @type {Map<string, {y: number, wet: boolean, t: number}>} uuid -> last sample */
const seen = new Map();

/**
 * Should this object be watched? Dynamic bodies (the Inspector mode) and anything the
 * fluid tank or a module flagged as a floater.
 * @param {any} o
 */
function watched(o) {
	const p = o.userData?.physics;
	return !!p && p.mode === 'dynamic' && !o.userData?.water;
}

/**
 * @param {any} root the scene objects group
 * @param {number} now ms
 * @returns {number} splashes made this frame (for tests)
 */
export function tickSplashes(root, now) {
	if (!root || !waterActive()) {
		if (seen.size) seen.clear();
		return 0;
	}
	let made = 0;
	/** @type {Set<string>} */
	const alive = new Set();
	for (const o of root.children) {
		if (!watched(o)) continue;
		alive.add(o.uuid);
		const radius = radiusOf(o);
		const x = o.position.x;
		const y = o.position.y;
		const z = o.position.z;
		const hit = waterSurfaceAt(x, y - radius, z);
		const wet = !!hit && y - radius * 0.5 < hit.surfaceY;
		const last = seen.get(o.uuid);
		if (last && hit && wet !== last.wet) {
			const dt = Math.max((now - last.t) / 1000, 1 / 240);
			const vy = (y - last.y) / dt;
			const speed = Math.abs(vy);
			if (speed >= SPLASH_MIN_SPEED) {
				// entering hits harder than climbing out
				const strength = Math.min(1, speed / 6) * (wet ? 1 : 0.4);
				disturbWater(hit.volume, [x, hit.surfaceY, z], Math.max(0.2, radius * 1.5), strength);
				made++;
			}
		}
		seen.set(o.uuid, { y, wet, t: now });
	}
	for (const uuid of seen.keys()) if (!alive.has(uuid)) seen.delete(uuid);
	return made;
}

/** the object's bounding radius in world metres (geometry sphere x largest scale) @param {any} o */
function radiusOf(o) {
	const g = o.geometry;
	let r = 0.5;
	if (g) {
		if (!g.boundingSphere) g.computeBoundingSphere?.();
		if (g.boundingSphere) r = g.boundingSphere.radius;
	}
	const s = o.scale;
	return r * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
}

/** TEST: forget every sample */
export function resetSplashes() {
	seen.clear();
}
