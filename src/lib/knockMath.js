import * as THREE from 'three';
// the `.js` is load-bearing: knock-physics imports this file straight into node,
// where a bare specifier does not resolve (vite accepts either)
import { velocityFromSamples, clampThrow, MAX_LINVEL } from './throwVelocity.js';

// 24-A A1: THE KNOCK, the pure half.
//
// A player's hand (a VR controller) or body (the desktop camera) is a PROBE SPHERE.
// When it overlaps a dynamic body while approaching it, the body's velocity gains
// the probe's approach speed along the contact normal, clamped, once per pass.
// This file is the arithmetic of that sentence and nothing else: THREE +
// throwVelocity, no stores, no scene, no wire — so the numbers a game feels are
// testable with no browser (the throwVelocity.test precedent), and knock.js (the
// runtime: feeds, candidates, the message, the log) is the only consumer.
//
// WHY A SPHERE-VS-SPHERE TEST AGAINST REPLICATED POSES, and not a rapier hand body:
// only the initiator has a rapier world (roadmap 24 F1). A kinematic hand body would
// knock correctly for the initiator and for nobody else, and a second path built from
// presence poses on the initiator would feel one presence interval late. The
// collectible module proved the alternative one domain over — a radius test against
// a replicated pose, "no sensor, no physics body and no initiator". So the test runs
// on the peer whose hand it is, against the poses that peer already renders, and the
// RESULT replicates as an exact velocity (the B5 `throw` model). The fidelity cost is
// stated plainly: the overlap is sphere-vs-bounding-sphere — exact for balls and
// stars, approximate for boxes.

/** the desktop probe: the character capsule's 0.3 + a margin (F9) */
export const HEAD_PROBE_RADIUS = 0.35;
/** how far back the velocity ring reaches (ms) — a hand at 60 Hz gives ~6 samples */
export const PROBE_WINDOW_MS = 100;
/** the ring never holds more than this, whatever the frame rate */
export const PROBE_SAMPLES = 6;
/** a probe must be OUT of a body's sphere this long before it may knock it again */
export const REARM_MS = 60;
/** a non-initiator's prediction that authority never confirms is withdrawn after this */
export const PREDICT_MAX_MS = 400;
/** a body's own velocity estimate off the move stream looks this far back (ms) */
export const BODY_WINDOW_MS = 200;

/**
 * @typedef {{spent: boolean, outSince: number | null}} ContactState
 * @typedef {{id: string, radius: number, external: boolean, lastAt: number,
 *   samples: {t: number, pos: THREE.Vector3, quat: THREE.Quaternion | null}[],
 *   contacts: Map<string, ContactState>}} Probe
 */

/** @param {string} id @param {number} radius @returns {Probe} */
export function createProbe(id, radius) {
	return { id, radius, external: false, lastAt: 0, samples: [], contacts: new Map() };
}

/**
 * Push one pose into the probe's ring. Trims by COUNT and by WINDOW, keeping at
 * least two samples so a slow page (a headless tab at 2.5 fps) still has a
 * velocity to read — over a longer window, which is the honest number there.
 * @param {Probe} probe @param {THREE.Vector3} pos @param {THREE.Quaternion | null} quat
 * @param {number} t ms
 */
export function pushSample(probe, pos, quat, t) {
	probe.samples.push({ t, pos: pos.clone(), quat: quat ? quat.clone() : null });
	probe.lastAt = t;
	while (probe.samples.length > PROBE_SAMPLES) probe.samples.shift();
	while (probe.samples.length > 2 && t - probe.samples[0].t > PROBE_WINDOW_MS) probe.samples.shift();
}

/** The probe's velocity over its ring — the throw estimator, so the MIN_DT guard
 * and the magnitude clamp come for free. Zero with fewer than two samples.
 * @param {Probe} probe */
export function probeVelocity(probe) {
	return velocityFromSamples(probe.samples).linvel;
}

/** @param {Probe} probe @returns {THREE.Vector3 | null} the newest sample's position */
export function probePosition(probe) {
	const last = probe.samples[probe.samples.length - 1];
	return last ? last.pos : null;
}

const _d = new THREE.Vector3();
const _rel = new THREE.Vector3();

/**
 * The contact test. `n` points FROM the probe INTO the body (it is the direction a
 * knock pushes), `approach` is how fast the probe closes on the body along it —
 * positive = closing, ~0 = resting, negative = receding or being outrun.
 *
 * With the two centres coincident there is no normal to speak of; the probe's own
 * direction of travel stands in, and a probe that is not moving cannot approach
 * anything, so `approach` is 0 there.
 * @param {THREE.Vector3} probePos @param {number} probeRadius @param {THREE.Vector3} probeVel
 * @param {THREE.Vector3} bodyCentre @param {number} bodyRadius @param {THREE.Vector3} bodyVel
 * @returns {{overlap: boolean, distance: number, n: THREE.Vector3, approach: number}}
 */
export function contactOf(probePos, probeRadius, probeVel, bodyCentre, bodyRadius, bodyVel) {
	_d.subVectors(bodyCentre, probePos);
	const distance = _d.length();
	const overlap = distance < probeRadius + bodyRadius;
	const n = new THREE.Vector3();
	if (distance > 1e-6) n.copy(_d).divideScalar(distance);
	else if (probeVel.lengthSq() > 1e-12) n.copy(probeVel).normalize();
	else return { overlap, distance, n: n.set(0, 1, 0), approach: 0 };
	_rel.subVectors(probeVel, bodyVel);
	return { overlap, distance, n, approach: _rel.dot(n) };
}

/**
 * The response: v' = v_body + n * approach * gain. The hand is treated as INFINITE
 * MASS with no restitution, so a puffy star and a football both leave at hand
 * speed along the normal — mass still matters afterwards, through damping and
 * every collision that follows.
 *
 * SPIN: a sphere-vs-sphere contact is ALWAYS central, so the "off-centre offset"
 * that curls a ball is not the normal push (r_contact x delta-v is zero by
 * construction there) — it is the TANGENTIAL slip of the hand across the surface.
 * The surface point at -n*r is dragged with that slip: omega += spin * (r_c x v_t) / r^2.
 * A probe brushing up the left side of a ball spins it about -z, which is the
 * direction that carries that surface point upward with the hand (checked in
 * knock-physics section 0).
 *
 * Then ONE clamp: clampThrow (the throw's own ceiling, MAX_LINVEL/MAX_ANGVEL) and
 * the scene's `maxSpeed` BELOW it, so a game can keep a ball hittable.
 * @param {{bodyVel: THREE.Vector3, bodyAngvel: THREE.Vector3, probeVel: THREE.Vector3,
 *   n: THREE.Vector3, approach: number, bodyRadius: number,
 *   gain: number, spin: number, maxSpeed: number}} args
 * @returns {{linvel: THREE.Vector3, angvel: THREE.Vector3}}
 */
export function knockResponse(args) {
	const { bodyVel, bodyAngvel, probeVel, n, approach, bodyRadius, gain, spin, maxSpeed } = args;
	const linvel = bodyVel.clone().addScaledVector(n, approach * gain);
	const angvel = bodyAngvel.clone();
	if (spin > 0 && bodyRadius > 1e-4) {
		const rel = probeVel.clone().sub(bodyVel);
		const tangential = rel.addScaledVector(n, -rel.dot(n));
		const rc = n.clone().multiplyScalar(-bodyRadius);
		angvel.add(rc.cross(tangential).multiplyScalar(spin / (bodyRadius * bodyRadius)));
	}
	const clamped = clampThrow(linvel, angvel);
	const cap = Math.min(Number.isFinite(maxSpeed) ? maxSpeed : MAX_LINVEL, MAX_LINVEL);
	if (clamped.linvel.length() > cap) clamped.linvel.setLength(cap);
	return clamped;
}

/**
 * ONE KNOCK PER PASS. Per (probe, body): after a hit the pair is SPENT, and it
 * re-arms only once the probe has been OUT of the body's sphere for REARM_MS —
 * a follow-through that stays inside the ball adds nothing, and a pose that
 * flickers out and back inside the hysteresis has not left. Returns whether a
 * hit MAY fire this tick (the caller still needs overlap + approach).
 * @param {Probe} probe @param {string} uuid @param {boolean} overlap @param {number} now
 */
export function cooldownStep(probe, uuid, overlap, now) {
	let state = probe.contacts.get(uuid);
	if (!state) {
		state = { spent: false, outSince: null };
		probe.contacts.set(uuid, state);
	}
	if (!overlap) {
		if (state.outSince == null) state.outSince = now;
		return false;
	}
	if (state.spent) {
		if (state.outSince != null && now - state.outSince >= REARM_MS) {
			state.spent = false;
			state.outSince = null;
			return true;
		}
		state.outSince = null; // re-entered too soon, or never left: leave again
		return false;
	}
	state.outSince = null;
	return true;
}

/** A hit fired for this pair: spend it. @param {Probe} probe @param {string} uuid */
export function markSpent(probe, uuid) {
	const state = probe.contacts.get(uuid);
	if (state) {
		state.spent = true;
		state.outSince = null;
	}
}

/** Forget pairs whose body is gone. @param {Probe} probe @param {Set<string>} live */
export function pruneContacts(probe, live) {
	for (const uuid of [...probe.contacts.keys()]) if (!live.has(uuid)) probe.contacts.delete(uuid);
}

const _box = new THREE.Box3();
const _childBox = new THREE.Box3();
const _rel4 = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/**
 * A body's bounding sphere in its OWN local frame (before its scale): a mesh's
 * geometry sphere, or the union box of a group's meshes each carried into the
 * group's frame. `radius` is unscaled — the caller multiplies by the object's
 * largest scale component and carries `center` through `object.matrix`, which is
 * what makes one cached answer good for every frame until the shape changes.
 * @param {any} object
 * @returns {{center: THREE.Vector3, radius: number}}
 */
export function localBoundsOf(object) {
	const geometry = object?.geometry;
	if (geometry) {
		if (!geometry.boundingSphere) geometry.computeBoundingSphere();
		const sphere = geometry.boundingSphere;
		return { center: sphere.center.clone(), radius: sphere.radius };
	}
	_box.makeEmpty();
	object.updateWorldMatrix(true, true);
	_inv.copy(object.matrixWorld).invert();
	object.traverse((/** @type {any} */ child) => {
		if (!child.geometry) return;
		if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
		_rel4.multiplyMatrices(_inv, child.matrixWorld);
		_childBox.copy(child.geometry.boundingBox).applyMatrix4(_rel4);
		_box.union(_childBox);
	});
	if (_box.isEmpty()) return { center: new THREE.Vector3(), radius: 0.5 };
	_box.getBoundingSphere(_sphere);
	return { center: _sphere.center.clone(), radius: _sphere.radius };
}

/** The scale factor a local radius takes into the parent frame. @param {any} object */
export function radiusScaleOf(object) {
	const s = object?.scale;
	if (!s) return 1;
	return Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1;
}
