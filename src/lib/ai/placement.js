// 85b S2 / S3 / S4 — PLACEMENT PARAMS on create_objects and update_objects (no new tool): `at: {ping}` builds at
// a spot a person pinged, `align: 'surface'` backs the object onto the pinged surface (a painting on a wall),
// `snap: 'floor'` stands it on whatever is under it (terrain, floor, table), `face_user` turns it (yaw only) to
// face a person. Everything is worked out on the object itself and then put back, so the ONE move goes through
// the tool's own transform path (`apply`: broadcast + undo) with the right "before".
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { recentPings, pingWorld } from '$lib/pingLog.js';
import { findPing, comfortClash, COMFORT_HEAD_R } from '$lib/pingCore.js';
import { isAgentPeer } from '$lib/inviteStore.js';
import { agentRequested } from '$lib/agent/agentMode.js';
import { personWorldPosition, headsetPeople, personRow, bodyOf } from '$lib/connector/whereAreUsers.js';
import { specUsesUnits, resolveSpecUnits } from './bodyUnitsCore.js';

/** S7: never closer in front of a person than this (the comfort radius stands too) */
export const FOLLOW_MIN_AHEAD = 0.6;
/** how far ABOVE the object a floor snap still counts (a table top under a lamp placed at table height) */
export const SNAP_REACH_UP = 2;
const UP = new THREE.Vector3(0, 1, 0);

/** @param {any} spec */
export const wantsPlacement = (spec) => !!spec && (spec.at !== undefined || spec.align !== undefined || spec.snap !== undefined || spec.face_user !== undefined);

/** the object's box in its OWN frame (scale not applied) @param {any} object */
export function localBox(object) {
	const box = new THREE.Box3();
	object.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
	const m = new THREE.Matrix4();
	object.traverse((/** @type {any} */ o) => {
		if (!o.geometry) return;
		if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
		if (!o.geometry.boundingBox) return;
		box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
	});
	if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
	return box;
}

/**
 * A rotation whose +Z is `normal`, kept upright on a wall (its +Y stays as close to world up as it can).
 * @param {THREE.Vector3} normal world @returns {THREE.Quaternion}
 */
export function surfaceQuaternion(normal) {
	const z = normal.clone().normalize();
	if (Math.abs(z.dot(UP)) > 0.99) return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), z);
	const x = new THREE.Vector3().crossVectors(UP, z).normalize();
	const y = new THREE.Vector3().crossVectors(z, x);
	return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** set an object's WORLD pose (its parent's frame does the rest) @param {any} object @param {THREE.Vector3} [pos] @param {THREE.Quaternion} [quat] */
function setWorld(object, pos, quat) {
	const parent = object.parent;
	parent?.updateWorldMatrix(true, false);
	if (pos) object.position.copy(parent ? parent.worldToLocal(pos.clone()) : pos);
	if (quat) {
		const pq = parent ? parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
		object.quaternion.copy(pq.invert().multiply(quat));
	}
	object.updateWorldMatrix(true, true);
}

/** is `hit` part of `object` @param {any} hit @param {any} object */
function inside(hit, object) {
	for (let o = hit; o; o = o.parent) if (o === object) return true;
	return false;
}

/**
 * S3: the surface straight under the object — the highest hit at most SNAP_REACH_UP above its base. Null = none
 * (the caller falls back to the ground).
 * @param {any} object @param {any} group @returns {{y: number, on: any} | null}
 */
export function floorUnder(object, group) {
	const box = new THREE.Box3().setFromObject(object);
	const c = box.getCenter(new THREE.Vector3());
	const ray = new THREE.Raycaster(new THREE.Vector3(c.x, box.min.y + 1000, c.z), new THREE.Vector3(0, -1, 0));
	const hits = ray.intersectObjects(group.children, true).filter((h) => {
		const hit = /** @type {any} */ (h.object);
		if (inside(hit, object) || !hit.isMesh) return false;
		for (let o = hit; o && o !== group; o = o.parent) if (!o.visible) return false;
		return true;
	});
	const top = hits.find((h) => h.point.y <= box.min.y + SNAP_REACH_UP);
	if (!top) return null;
	let on = top.object;
	while (on.parent && on.parent !== group) on = on.parent;
	return { y: top.point.y, on };
}

/**
 * Work out the placement and hand the ONE transform to `apply` (tools.js applyAiTransform).
 * @param {any} object @param {any} spec @param {(object: any, t: {position: number[], rotation: number[]}) => void} apply
 * @returns {{placed?: any, warnings: string[]}}
 */
export function placeObject(object, spec, apply) {
	/** @type {string[]} */
	const warnings = [];
	if (!wantsPlacement(spec)) return { warnings };
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return { warnings: ['at/snap/face_user: the 3D view is not ready yet'] };
	/** @type {any} */
	const placed = {};
	const was = { pos: object.position.clone(), quat: object.quaternion.clone() };
	let moved = false;
	/** @type {THREE.Vector3 | null} */
	let normal = null;
	let surface = false;

	// S7: at a person — ahead / right / up of where they stand NOW, on their floor, facing them (each call re-anchors)
	const atUser = spec.at && typeof spec.at === 'object' && spec.at.user !== undefined;
	if (atUser) {
		const who = spec.at.user === true || spec.at.user === 'me' ? defaultPerson() : String(spec.at.user);
		const row = who ? personRow(who) : null;
		if (!row) warnings.push('at: ' + (who ? 'no live pose for "' + who + '"' : 'nobody to build around'));
		else {
			const num = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
			const ahead = Math.max(FOLLOW_MIN_AHEAD, num(spec.at.ahead, 1.5));
			const right = num(spec.at.right, 0);
			const up = num(spec.at.up, 0);
			const f = row.forwardFlat;
			const rt = row.right;
			const local = new THREE.Vector3(row.position[0] + f[0] * ahead + rt[0] * right, row.floor + up, row.position[2] + f[2] * ahead + rt[2] * right);
			const point = group.localToWorld(local);
			setWorld(object, point);
			const box = new THREE.Box3().setFromObject(object);
			setWorld(object, object.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, point.y - box.min.y, 0)));
			placed.at = 'user ' + (row.name || row.id);
			moved = true;
			if (spec.face_user === undefined) spec = { ...spec, face_user: row.you && !agentRequested() ? true : row.id };
		}
	}

	// S2: at a ping
	if (spec.at !== undefined && !atUser) {
		const ref = spec.at && typeof spec.at === 'object' ? spec.at.ping : spec.at;
		const me = /** @type {any} */ (get(peers))?.peer?.id ?? null;
		const rec = findPing(recentPings(), typeof ref === 'string' ? ref : '', agentRequested() ? null : me, (id) => isAgentPeer(id));
		if (!rec) warnings.push('at: no such ping (pings last 2 minutes; where_are_users {pings: true} lists them, or use {ping: "latest"})');
		else {
			const where = pingWorld(rec);
			if (where.on === object) warnings.push('at: that ping is on this object itself — it was not moved');
			else {
				normal = where.normal;
				placed.at = rec.id;
				if (where.on) placed.on = where.on.name || where.on.uuid;
				setWorld(object, where.point);
				moved = true;
				if (spec.align === 'surface') {
					setWorld(object, undefined, surfaceQuaternion(normal));
					const back = -localBox(object).min.z * object.getWorldScale(new THREE.Vector3()).z;
					setWorld(object, where.point.clone().addScaledVector(normal.clone().normalize(), back));
					placed.align = 'surface';
					surface = true;
				} else if (normal.y > 0.7 && spec.snap === undefined) {
					// a ping on a floor or a table top: the object stands on it, not half inside it
					const box = new THREE.Box3().setFromObject(object);
					setWorld(object, object.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, where.point.y - box.min.y, 0)));
					placed.standsOn = placed.on ?? 'the ground';
				}
			}
		}
	} else if (spec.align !== undefined) warnings.push('align: needs at: {ping} (the surface comes from the ping)');
	if (spec.align !== undefined && spec.align !== 'surface') warnings.push('align: only "surface" is known');

	// S3: stand on whatever is under it
	if (spec.snap !== undefined) {
		if (spec.snap !== 'floor') warnings.push('snap: only "floor" is known');
		else if (surface && normal && Math.abs(normal.y) < 0.7) warnings.push('snap: skipped — the object is on a wall (align: "surface")');
		else {
			const hit = floorUnder(object, group);
			const box = new THREE.Box3().setFromObject(object);
			const floorY = hit ? hit.y : group.getWorldPosition(new THREE.Vector3()).y;
			setWorld(object, object.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, floorY - box.min.y, 0)));
			placed.snapped = hit ? hit.on.name || hit.on.uuid : 'the ground';
			moved = true;
		}
	}

	// S4: turn to face a person (yaw only)
	if (spec.face_user !== undefined && spec.face_user !== false) {
		if (surface && normal && Math.abs(normal.y) < 0.7) warnings.push('face_user: skipped — the object is backed onto a wall');
		else {
			const who = spec.face_user === true ? defaultPerson() : String(spec.face_user);
			const person = who ? personWorldPosition(who) : null;
			if (!person) warnings.push('face_user: ' + (who ? 'no live pose for "' + who + '"' : 'nobody else is here to face'));
			else {
				const d = person.position.clone().sub(object.getWorldPosition(new THREE.Vector3()));
				if (Math.hypot(d.x, d.z) < 1e-4) warnings.push('face_user: the object is where that person stands');
				else {
					const e = new THREE.Euler().setFromQuaternion(object.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
					e.y = Math.atan2(d.x, d.z);
					setWorld(object, undefined, new THREE.Quaternion().setFromEuler(e));
					placed.facing = person.id ?? who;
					moved = true;
				}
			}
		}
	}

	if (!moved && !surface) return { warnings };
	const position = object.position.toArray();
	const r = new THREE.Euler().setFromQuaternion(object.quaternion, object.rotation.order);
	object.position.copy(was.pos);
	object.quaternion.copy(was.quat);
	object.updateWorldMatrix(true, true);
	apply(object, { position, rotation: [r.x, r.y, r.z] });
	return { placed, warnings };
}

/** face_user: true = the person this tab acts as; on an agent page, the person who pinged last, else the first person here */
export function defaultPerson() {
	if (!agentRequested()) return 'me';
	const rec = findPing(recentPings(), 'latest', null, (id) => isAgentPeer(id));
	if (rec) return rec.peer;
	const link = /** @type {any} */ (get(peers));
	return [...(link?.openedPeers ?? [])].map(String).find((id) => !isAgentPeer(id)) ?? '';
}

/**
 * 85b S5: a headset wearer this object would be inside of (their head or body), as a refusal sentence; null = clear.
 * Only VR people: on a desktop the camera is a viewpoint, not a body.
 * @param {any} object @returns {string | null}
 */
export function comfortRefusal(object) {
	const people = headsetPeople();
	if (!people.length) return null;
	object.updateWorldMatrix(true, true);
	const box = new THREE.Box3().setFromObject(object);
	if (box.isEmpty()) return null;
	for (const person of people) {
		const where = comfortClash(box, person);
		if (where)
			return (
				'refused: it would be inside ' + (person.name || 'a person') + "'s " + (where === 'head' ? 'head space' : 'body') +
				' (they are in VR; nothing comes within ' + COMFORT_HEAD_R + ' m of a head or through a body) — place it in front of them, e.g. where_are_users inFront1_5m'
			);
	}
	return null;
}

/**
 * 85b S6: body-scale units ("hip", "0.5 reach", "2 eye") in params / position / scale / at → metres, from the
 * person the call is about (at.user, else face_user, else the default person).
 * @param {any} spec @returns {{spec: any, units?: {from: string, assumed?: true}}}
 */
export function withBodyUnits(spec) {
	if (!specUsesUnits(spec)) return { spec };
	const named = typeof spec.at?.user === 'string' && spec.at.user !== 'me' ? spec.at.user : typeof spec.face_user === 'string' ? spec.face_user : '';
	const who = named || defaultPerson() || 'me';
	const body = bodyOf(who);
	return { spec: resolveSpecUnits(spec, body), units: { from: who, ...(body.assumed ? { assumed: true } : {}) } };
}
