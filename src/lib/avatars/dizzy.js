// 37-avatar-fix R22 — the "knocked off" idle. A peer that has given no input for a while (Settings ▸
// Avatars, default 20 s) carries `knocked: 1` on its camera stream; every viewer animates this LOCALLY:
//  · small stars orbit above the head,
//  · the head sways on a VERTICAL figure-8 (a lemniscate turned 90°, in the head's own XY plane),
//  · the eyes become stars (they read at 2-5 m and in a headset, on the character's own head, a
//    stylised head, a photo card and the classic floating head alike).
// ONE InstancedMesh per character: 5 orbiting stars + 2 eye stars = one extra draw call, none at all
// while awake (the mesh is hidden). The star is a flat 5-point shape — no texture, crisp at any size.
// Nothing here replicates: the flag is the only thing on the wire.

import * as THREE from 'three';

export const DIZZY_STARS = 5;
export const DIZZY_EYES = 2;
/** seconds for the blend in/out (time constant) */
export const DIZZY_BLEND = 0.45;
/** one trip round the figure-8 (s) */
export const SWAY_PERIOD = 2.6;
/** how far the head travels on the figure-8 (head-frame units: across, up) and how far it tilts (rad) */
export const SWAY = { x: 0.07, y: 0.05, roll: 0.2 };

const STAR_COLOR = new THREE.Color('#ffd23f');
const EYE_COLOR = new THREE.Color('#ffb21f');

/** @type {THREE.BufferGeometry | null} */
let starGeometry = null;
/** @type {THREE.MeshBasicMaterial | null} */
let starMaterial = null;

/** a unit 5-point star in the XY plane, facing +Z (shared by every character) */
export function sharedStarGeometry() {
	if (starGeometry) return starGeometry;
	const shape = new THREE.Shape();
	for (let i = 0; i < 10; i++) {
		const r = i % 2 ? 0.45 : 1;
		const a = Math.PI / 2 + (i * Math.PI) / 5;
		if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
		else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
	}
	shape.closePath();
	starGeometry = new THREE.ShapeGeometry(shape);
	return starGeometry;
}

function sharedStarMaterial() {
	if (starMaterial) return starMaterial;
	// unlit + not tone-mapped: a bright sticker that reads in a dark scene and through post
	starMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
	return starMaterial;
}

/**
 * Where the head is on the figure-8 at phase `t` (radians), scaled by `w` (the blend). A
 * lemniscate of Bernoulli turned 90°: the lobes stack vertically, so the head draws an "8".
 * @param {number} t @param {number} w
 * @returns {{x: number, y: number, roll: number}} head-frame offset + a woozy tilt
 */
export function swayAt(t, w) {
	const s = Math.sin(t);
	const c = Math.cos(t);
	const d = 1 + s * s;
	// horizontal ∞: (cos t, sin t cos t) / d — turned 90°: swap the axes
	const across = (s * c) / d;
	const up = c / d;
	return { x: SWAY.x * across * w, y: SWAY.y * up * w, roll: -SWAY.roll * across * 2 * w };
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qz = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _w = new THREE.Vector3();
const _look = new THREE.Matrix4();
const _pq = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class DizzyFx {
	constructor() {
		this.mesh = new THREE.InstancedMesh(sharedStarGeometry(), sharedStarMaterial(), DIZZY_STARS + DIZZY_EYES);
		this.mesh.name = 'avatar-dizzy-stars';
		this.mesh.frustumCulled = false; // instances move every frame; 7 tiny quads
		this.mesh.visible = false;
		this.mesh.castShadow = false;
		for (let i = 0; i < DIZZY_STARS + DIZZY_EYES; i++) this.mesh.setColorAt(i, i < DIZZY_STARS ? STAR_COLOR : EYE_COLOR);
		/** 0 awake .. 1 fully knocked off (eased) */
		this.weight = 0;
		/** the effect's own clock (s): runs only while it shows, so it always starts on the same beat */
		this.t = 0;
	}

	/** ease toward the wanted state; returns the weight @param {boolean} knocked @param {number} dt */
	step(knocked, dt) {
		const k = 1 - Math.exp(-Math.max(0, dt) / DIZZY_BLEND);
		this.weight += ((knocked ? 1 : 0) - this.weight) * k;
		if (!knocked && this.weight < 0.002) this.weight = 0;
		if (this.weight > 0) this.t += dt;
		else this.t = 0;
		this.mesh.visible = this.weight > 0;
		return this.weight;
	}

	/** the head's figure-8 right now */
	sway() {
		return swayAt((this.t * Math.PI * 2) / SWAY_PERIOD, this.weight);
	}

	/**
	 * Pose the instances. Everything is in the MESH PARENT's frame.
	 * @param {THREE.Matrix4} head the head CENTRE's matrix (its frame: X right, Y up, Z out of the face)
	 * @param {{ring: number, lift: number, size: number}} dims ring radius / height above the centre / star size
	 * @param {THREE.Vector3[] | null} eyes two eye points in the head-centre frame (null = no eyes)
	 * @param {THREE.Vector3 | null} viewerLocal the viewer in the parent's frame (the orbiters face it)
	 * @param {THREE.Matrix4 | null} [eyeFrame] the frame the eyes sit in when it is not the head's (a photo card)
	 */
	pose(head, dims, eyes, viewerLocal, eyeFrame = null) {
		if (!this.mesh.visible) return;
		const w = this.weight;
		const grow = w * w * (3 - 2 * w); // smoothstep: the stars pop in, not snap
		head.decompose(_p, _q, _s);
		const spin = this.t * 2.4;
		for (let i = 0; i < DIZZY_STARS; i++) {
			const a = spin + (i * Math.PI * 2) / DIZZY_STARS;
			// a ring above the head, gently tilted so the orbit reads as an orbit from the side too
			_w.set(Math.cos(a) * dims.ring, dims.lift + Math.sin(a * 2 + i) * 0.03, Math.sin(a) * dims.ring * 0.85);
			_w.applyQuaternion(_q).add(_p);
			if (viewerLocal) {
				_look.lookAt(viewerLocal, _w, _up);
				_pq.setFromRotationMatrix(_look);
			} else _pq.copy(_q);
			_qz.setFromAxisAngle(_z, spin * 1.7 + i);
			_pq.multiply(_qz);
			const size = dims.size * grow * (0.85 + 0.15 * Math.sin(this.t * 6 + i * 1.3));
			_m.compose(_w, _pq, _s.set(size, size, size));
			this.mesh.setMatrixAt(i, _m);
		}
		for (let e = 0; e < DIZZY_EYES; e++) {
			const idx = DIZZY_STARS + e;
			if (!eyes) {
				_m.makeScale(0, 0, 0);
				this.mesh.setMatrixAt(idx, _m);
				continue;
			}
			const frame = eyeFrame ?? head;
			frame.decompose(_p, _pq, _s);
			_w.copy(eyes[e]).applyQuaternion(_pq).add(_p);
			// star eyes turn the opposite ways, like a cartoon's
			_qz.setFromAxisAngle(_z, (e ? -1 : 1) * this.t * 3.2);
			_pq.multiply(_qz);
			const size = dims.size * 0.9 * grow;
			_m.compose(_w, _pq, _s.set(size, size, size));
			this.mesh.setMatrixAt(idx, _m);
		}
		this.mesh.instanceMatrix.needsUpdate = true;
	}

	dispose() {
		this.mesh.removeFromParent();
		this.mesh.dispose(); // the instance buffers; the star geometry + material are shared
	}
}
