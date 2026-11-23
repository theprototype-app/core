// 92-input GC4a + GC4 — the play views (third person, side-scroller, top-down). LAZY: playViewSeam.js
// imports this the first time a Character Controller asks for a camera other than first person, so a
// scene that never does pays nothing. See playViewSeam.js for the rule (the PLAYER stays where it is;
// only the draw moves, for one frame at a time).
//
// FRAME ORDER: `apply` runs in the render stage, after every main-stage task. Your own body
// (AvatarRig, a main-stage task) is posed from `body`, which `apply` writes — so the body drawn this
// frame stands where the player stood LAST frame. The view therefore frames that same pose (`lastEye`)
// rather than this frame's, and body and camera agree: one frame behind the input, never apart.
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { charControl } from './charController';
import { localFeet } from './avatars/avatarState';

/** the camera never sits closer to a wall than this (m) */
const WALL_MARGIN = 0.25;
/** the third-person camera never closer to the head than this (m) */
const MIN_PULL = 0.35;
/** the body fades out below this view distance (m) and is gone at half of it */
const FADE_AT = 0.9;

const _eye = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _pq = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);
const raycaster = new THREE.Raycaster();

/** YOUR body's pose — AvatarRig's `preview` object, mutated in place (never re-set: a store write per
 * frame would re-render the component 60 times a second) */
const body = { position: [0, 1000, 0], yaw: 0, feet: /** @type {number | null} */ (null), alpha: 1, snap: true };

/** @type {{zoom: number | null, zoomFor: string, pull: number | null, ahead: number, camY: number | null, at: number, planeZ: number | null, lastEye: number[] | null, lastYaw: number, hits: number, last: any}} */
const st = { zoom: null, zoomFor: '', pull: null, ahead: 0, camY: null, at: 0, planeZ: null, lastEye: null, lastYaw: 0, hits: 0, last: null };

function reset() {
	st.zoom = null;
	st.zoomFor = '';
	st.pull = null;
	st.ahead = 0;
	st.camY = null;
	st.at = 0;
	st.planeZ = null;
	st.lastEye = null;
	body.position = [0, 1000, 0];
	body.feet = null;
	body.alpha = 1;
}

/** the zoom in force; a changed authored distance (or another camera) starts from it again @param {any} v */
function zoomOf(v) {
	const key = v.camera + ':' + v.distance;
	if (st.zoom === null || st.zoomFor !== key) {
		st.zoom = v.distance;
		st.zoomFor = key;
	}
	return Math.max(v.minZoom, Math.min(v.maxZoom, /** @type {number} */ (st.zoom)));
}

/** @param {number} deltaY @param {any} v */
function zoom(deltaY, v) {
	const z = zoomOf(v);
	st.zoom = Math.max(v.minZoom, Math.min(v.maxZoom, deltaY > 0 ? z * 1.12 : z / 1.12));
}

/** is this hit something the camera should stop at? (a visible mesh, not a trigger volume) @param {any} o */
function solid(o) {
	if (!o?.isMesh) return false;
	for (let p = o; p; p = p.parent) {
		if (p.visible === false) return false;
		if (p.userData?.physics?.sensor === true) return false;
	}
	return true;
}

/** how far along `dir` from `origin` the camera may go, up to `far` @param {any} origin @param {any} dir @param {number} far */
function clearance(origin, dir, far) {
	/** @type {any} */
	const group = get(objectsGroup);
	if (!group) return far;
	raycaster.set(origin, dir);
	raycaster.near = 0;
	raycaster.far = far + WALL_MARGIN;
	const hits = raycaster.intersectObject(group, true);
	for (const h of hits) {
		if (!solid(h.object)) continue;
		st.hits++;
		return Math.max(0, h.distance - WALL_MARGIN);
	}
	return far;
}

/** eye height above the feet the controller declares @returns {number} */
function eyeHeight() {
	const h = Number(/** @type {any} */ (get(charControl))?.eyeHeight);
	return Number.isFinite(h) && h > 0 ? h : 1.7;
}

/**
 * Put the play camera at the view's pose for one draw. @param {any} camera @param {any} v
 * @returns {() => void}
 */
function apply(camera, v) {
	const now = performance.now();
	const dt = st.at ? Math.min(0.1, Math.max(0, (now - st.at) / 1000)) : 0;
	st.at = now;
	camera.updateWorldMatrix(true, false);
	camera.getWorldPosition(_eye);
	camera.getWorldQuaternion(_q);
	_euler.setFromQuaternion(_q);
	const yaw = _euler.y;
	// frame the pose the body is being drawn at (see FRAME ORDER); the first frame has none yet
	const eye = st.lastEye ? _origin.fromArray(st.lastEye) : _origin.copy(_eye);
	const feetNow = localFeet(dt * 1000);
	const feetY = feetNow ?? eye.y - eyeHeight();

	const z = zoomOf(v);
	let viewDist = z;
	if (v.camera === 'third') {
		// behind the head along the LOOK (pitch included: looking down lifts the camera), raised by `height`,
		// looking the same way — so the screen centre is the player's own aim line, lifted by `height`
		_dir.set(0, 0, -1).applyQuaternion(_q);
		_target.copy(eye).addScaledVector(UP, v.height);
		let want = z;
		if (v.collide) want = Math.max(Math.min(MIN_PULL, z), Math.min(z, clearance(_target, _pos.copy(_dir).negate(), z)));
		// a wall pulls the camera in AT ONCE; it eases back out (no pop when the wall is passed)
		st.pull = st.pull === null || want < st.pull ? want : st.pull + (want - st.pull) * (1 - Math.exp(-dt * 6));
		viewDist = st.pull;
		_pos.copy(_target).addScaledVector(_dir, -st.pull);
		// never under the floor the player stands on
		if (_pos.y < feetY + 0.2) _pos.y = feetY + 0.2;
		_pq.copy(_q);
	} else if (v.camera === 'side') {
		// the plane is the one Play started on; the camera looks along -Z at it, ahead of the facing
		const facing = -Math.sin(yaw) >= 0 ? 1 : -1;
		st.ahead += (facing * v.lookAhead - st.ahead) * (dt ? 1 - Math.exp(-dt * 3) : 1);
		const ty = eye.y - eyeHeight() * 0.4 + v.height;
		const camY = st.camY === null ? ty : st.camY + (ty - st.camY) * (dt ? 1 - Math.exp(-dt * 6) : 1);
		st.camY = camY;
		const planeZ = st.planeZ ?? eye.z;
		_target.set(eye.x + st.ahead, camY, planeZ);
		_pos.set(_target.x, _target.y, planeZ + z);
		_m.lookAt(_pos, _target, UP);
		_pq.setFromRotationMatrix(_m);
	} else {
		// top-down: a fixed angle from the horizontal, looking at the feet, eased so a step does not jolt
		const a = (v.angle * Math.PI) / 180;
		_target.set(eye.x, feetY + 0.5, eye.z);
		const wantX = _target.x;
		const wantY = _target.y + Math.sin(a) * z;
		const wantZ = _target.z + Math.cos(a) * z;
		const k = dt && st.last ? 1 - Math.exp(-dt * 12) : 1;
		const prev = st.last ?? { x: wantX, y: wantY, z: wantZ };
		_pos.set(prev.x + (wantX - prev.x) * k, prev.y + (wantY - prev.y) * k, prev.z + (wantZ - prev.z) * k);
		st.last = { x: _pos.x, y: _pos.y, z: _pos.z };
		// look at the eased point under the camera, so the angle never wobbles while it catches up
		_target.set(_pos.x, _target.y, _pos.z - Math.cos(a) * z);
		_m.lookAt(_pos, _target, UP);
		_pq.setFromRotationMatrix(_m);
	}
	if (v.camera !== 'top') st.last = { x: _pos.x, y: _pos.y, z: _pos.z };

	// the body for the NEXT frame: where the player is now
	body.position = [_eye.x, _eye.y, _eye.z];
	body.yaw = yaw;
	body.feet = feetNow;
	body.alpha = viewDist >= FADE_AT ? 1 : Math.max(0, (viewDist - FADE_AT / 2) / (FADE_AT / 2));
	st.lastEye = [_eye.x, _eye.y, _eye.z];
	st.lastYaw = yaw;

	// world pose -> the camera's local frame (Player.svelte seats it in a group at y = 0.9)
	const was = { p: camera.position.clone(), q: camera.quaternion.clone() };
	const parent = camera.parent;
	if (parent) {
		parent.updateWorldMatrix(true, false);
		parent.worldToLocal(_pos);
		parent.getWorldQuaternion(_q).invert();
		_pq.premultiply(_q);
	}
	camera.position.copy(_pos);
	camera.quaternion.copy(_pq);
	camera.updateMatrixWorld();
	return () => {
		camera.position.copy(was.p);
		camera.quaternion.copy(was.q);
		camera.updateMatrixWorld();
	};
}

/**
 * Side / top: the keys are world directions. Turn the player to face the way it goes and hand back a
 * plain "forward" — so the walker, the dungeon slide and the collision pass move it exactly as they
 * always have, and peers see the player facing where it walks.
 * @param {any} rig @param {{forward: number, backward: number, left: number, right: number}} m @param {any} v
 */
function steer(rig, m, v) {
	const x = (m.right ? 1 : 0) - (m.left ? 1 : 0);
	const zIn = v.camera === 'side' ? 0 : (m.backward ? 1 : 0) - (m.forward ? 1 : 0);
	rig.getWorldQuaternion(_q);
	_euler.setFromQuaternion(_q);
	let yaw = _euler.y;
	if (x || zIn) yaw = Math.atan2(-x, -zIn);
	else if (v.camera === 'side' && Math.abs(Math.abs(yaw) - Math.PI / 2) > 1e-3) yaw = -Math.PI / 2; // face +X
	// level: these views have no look, so the head never stays tilted from before
	_euler.set(0, yaw, 0, 'YXZ');
	_q.setFromEuler(_euler);
	const parent = rig.parent;
	if (parent) {
		parent.getWorldQuaternion(_pq).invert();
		_q.premultiply(_pq);
	}
	rig.quaternion.copy(_q);
	const go = x || zIn ? 1 : 0;
	return { ...m, forward: go, backward: 0, left: 0, right: 0 };
}

/** keep the player on the plane Play started on @param {any} rig */
function lockPlane(rig) {
	rig.updateWorldMatrix(true, false);
	rig.getWorldPosition(_pos);
	if (st.planeZ === null) st.planeZ = _pos.z;
	if (Math.abs(_pos.z - st.planeZ) > 1e-6) {
		rig.position.z += st.planeZ - _pos.z;
		rig.updateMatrixWorld();
	}
}

function debug() {
	return { zoom: st.zoom, pull: st.pull, planeZ: st.planeZ, hits: st.hits, ahead: st.ahead, camera: st.last, body: { ...body } };
}

export const playViewImpl = { apply, steer, lockPlane, zoom, reset, body, debug };
