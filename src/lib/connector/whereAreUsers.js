// 86-fix (85 S1 pulled forward) — WHERE ARE THE PEOPLE, for the Claude connector. Read-only: the tab's own
// camera (the XR headset's pose in VR) for the person Claude acts as, and every other peer from the avatar
// their camera stream poses (`moveCamera`: a scene object named by peer id, `userData.feet` / `knocked`).
// Everything comes back in the frame create_objects builds in (objectsGroup-local), so a spot can be used as
// a position as it is. `describePose` is the pure half the unit test drives.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { peers, userdata } from '../../stores/appStore.js';
import { objectsGroup, globalCamera, globalRenderer } from '../../stores/sceneStore.js';
import { localFeet } from '$lib/avatars/avatarState.js';
import { recentPings, pingWorld } from '$lib/pingLog.js';

/** a parked avatar (no live pose yet) sits this high */
export const NO_POSE_Y = 999;

const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100 + 0; // + 0: no -0 in the JSON

/**
 * One person's pose, from a camera-style matrix (looks down its local -Z) already in the build frame.
 * @param {ArrayLike<number>} e the 16 column-major elements
 * @param {number | null} floor the floor under them (build frame), null = not walking (the ground, 0)
 */
export function describePose(e, floor) {
	const p = [e[12], e[13], e[14]];
	if (!p.every(Number.isFinite) || p[1] >= NO_POSE_Y) return { note: 'no live pose yet' };
	const f = [-e[8], -e[9], -e[10]];
	const len = Math.hypot(f[0], f[1], f[2]) || 1;
	const flat = Math.hypot(f[0], f[2]);
	// looking straight up or down: no heading — fall back to the camera's up vector, which then points ahead
	const [hx, hz] = flat > 1e-6 ? [f[0] / flat, f[2] / flat] : [e[4] * -Math.sign(f[1]), e[6] * -Math.sign(f[1])];
	const hl = Math.hypot(hx, hz) || 1;
	const fx = hx / hl,
		fz = hz / hl;
	const y = Number.isFinite(floor) ? /** @type {number} */ (floor) : 0;
	const spot = (/** @type {number} */ d) => [r2(p[0] + fx * d), r2(y), r2(p[2] + fz * d)];
	return {
		position: p.map(r2),
		floor: r2(y),
		eyeHeightAboveFloor: r2(p[1] - y),
		// compass yaw: 0 = looking down -Z, 90 = +X
		yawDeg: Math.round((Math.atan2(fx, -fz) * 180) / Math.PI) + 0,
		forward: f.map((v) => r2(v / len)),
		forwardFlat: [r2(fx), 0, r2(fz)],
		right: [r2(-fz), 0, r2(fx)],
		inFront1_5m: spot(1.5),
		inFront3m: spot(3)
	};
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** @param {string} id */
function nameOf(id) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	return row?.[1] ? String(row[1]) : '';
}

/**
 * 85b S2: one ping as an agent reads it, in the build frame (it follows the object it landed on).
 * @param {import('$lib/pingCore.js').PingRecord} rec @param {any} group @param {number} now
 */
export function describePing(rec, group, now) {
	const w = pingWorld(rec);
	const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
	const p = group.worldToLocal(w.point.clone());
	const n = w.normal.clone().transformDirection(inv);
	return {
		id: rec.id,
		by: rec.peer,
		...(rec.name ? { name: rec.name } : {}),
		secondsAgo: Math.round((now - rec.time) / 100) / 10,
		position: p.toArray().map(r2),
		normal: n.toArray().map(r2),
		...(w.on ? { on: { uuid: w.on.uuid, name: w.on.name || '' } } : rec.on ? { note: 'the object it was on is gone' } : {})
	};
}

/**
 * @param {{pings?: boolean}} [args] roadmap 85 S2: `pings: true` adds the recent pings (newest first)
 * @returns {{users: any[], pings?: any[]} | {error: string}}
 */
export function whereAreUsers(args) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return { error: 'The 3D view is not ready yet.' };
	let root = group;
	while (root.parent) root = root.parent;
	group.updateWorldMatrix(true, false);
	_inv.copy(group.matrixWorld).invert();
	/** a world matrix into the build frame @param {any} m */
	const local = (m) => _m.multiplyMatrices(_inv, m).elements;
	/** a world floor height into the build frame (straight under `at`) @param {number | null} y @param {ArrayLike<number>} at */
	const floorAt = (y, at) => (y === null || !Number.isFinite(y) ? null : group.worldToLocal(_v.set(at[12], y, at[14])).y);

	const link = /** @type {any} */ (get(peers));
	const me = link?.peer?.id ?? null;
	/** @type {any[]} */
	const users = [];
	const renderer = /** @type {any} */ (get(globalRenderer));
	const inVR = !!renderer?.xr?.isPresenting;
	const cam = inVR ? renderer.xr.getCamera?.() : get(globalCamera);
	if (cam) {
		cam.updateWorldMatrix?.(true, false);
		const w = cam.matrixWorld.elements;
		users.push({ id: me, name: nameOf(me ?? ''), you: true, inVR, ...describePose(local(cam.matrixWorld), floorAt(localFeet(), w)) });
	} else users.push({ id: me, name: nameOf(me ?? ''), you: true, note: 'no camera yet' });
	for (const id of link?.openedPeers ? [...link.openedPeers].map(String) : []) {
		const m = root.getObjectByName(id);
		if (!m) {
			users.push({ id, name: nameOf(id), note: 'no live pose yet' });
			continue;
		}
		m.updateWorldMatrix(true, false);
		const w = m.matrixWorld.elements;
		const pose = w[13] >= NO_POSE_Y ? { note: 'no live pose yet' } : describePose(local(m.matrixWorld), floorAt(m.userData?.feet ?? null, w));
		users.push({ id, name: nameOf(id), ...pose, ...(m.userData?.knocked ? { idle: true } : {}) });
	}
	// 85b S2: everybody's latest ping on their own row; the whole recent list when asked
	const now = Date.now();
	const log = recentPings()
		.slice()
		.sort((a, b) => b.time - a.time);
	for (const u of users) {
		const rec = log.find((p) => p.peer === u.id);
		if (rec) u.latestPing = describePing(rec, group, now);
	}
	return args?.pings ? { users, pings: log.map((rec) => describePing(rec, group, now)) } : { users };
}

/**
 * 85b S4: one person's WORLD eye position — `me` (this tab: its camera, the headset in VR), or a peer by id or
 * by name (case-insensitive). Null when that person has no live pose.
 * @param {string} who 'me' | a peer id | a name @returns {{id: string | null, position: THREE.Vector3} | null}
 */
export function personWorldPosition(who) {
	const link = /** @type {any} */ (get(peers));
	const me = link?.peer?.id ?? null;
	if (who === 'me' || (me && who === me)) {
		const renderer = /** @type {any} */ (get(globalRenderer));
		const cam = renderer?.xr?.isPresenting ? renderer.xr.getCamera?.() : get(globalCamera);
		if (!cam) return null;
		cam.updateWorldMatrix?.(true, false);
		return { id: me, position: new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld) };
	}
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return null;
	let root = group;
	while (root.parent) root = root.parent;
	const ids = link?.openedPeers ? [...link.openedPeers].map(String) : [];
	const want = String(who).toLowerCase();
	const id = ids.find((p) => p === who) ?? ids.find((p) => nameOf(p).toLowerCase() === want);
	const m = id ? root.getObjectByName(id) : null;
	if (!m) return null;
	m.updateWorldMatrix(true, false);
	const position = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
	return position.y >= NO_POSE_Y ? null : { id: id ?? null, position };
}
