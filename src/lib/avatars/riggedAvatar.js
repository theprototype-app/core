// 36-avatars (plan 76.1-76.3): one peer's rigged body, driven every frame from what the wire already
// carries — the head pose (`camera`, which moveCamera writes onto the peer's root group) and the
// hands (`vrhands`, the peerHands store). Nothing here sends anything.
//
// The body is a SIBLING of the root group, not its child: the root takes the camera's full rotation
// (pitch and roll included), and a body must stand upright and turn only about Y. Both share one
// parent (Player's per-peer group inside the shared content frame), so a position read off the root
// is directly a position for the body.
//
// Per frame: velocity from the root (the locomotion leaf) -> body yaw (the 3-point estimate) -> clip
// weights -> mixer -> neck -> arm IK toward the hands (confidence-faded; floating hands take over when
// it drops) -> the stylised head follows the head bone.

import * as THREE from 'three';
import { CLIP_NAMES, feetBelowHead, AVATAR_SCALE, HEAD_CENTER_ABOVE_BONE, resolveCharacter, hatLiftFor } from './catalog.js';
import { loadCharacter, loadClips, instantiate, setOutfit, buildHeadGeometry, boneName } from './assets.js';
import { yawPitchOf, forwardOfQuat, handsYaw, nextBodyYaw, neckAngles, armConfidence, wrapAngle } from './bodyEstimate.js';
import { newTracker, trackPose, bodyFrameVelocity, locomotionWeights, approachWeights, SLOTS, TELEPORT_M } from './locomotion.js';
import { measureArm, solveArm, orientWrist } from './armIK.js';

/** KayKit characters face +Z (glTF's front); three's yaw 0 faces -Z */
const MODEL_YAW = Math.PI;
/** controller frame (-Z points, +Y up) -> KayKit wrist (+Y runs out of the hand) */
const WRIST_OFFSET = {
	left: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2, 'XYZ')),
	right: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2, 'XYZ'))
};
const SLOT_CLIP = {
	idle: CLIP_NAMES.idle,
	walk: CLIP_NAMES.walk,
	back: CLIP_NAMES.back,
	run: CLIP_NAMES.run,
	strafeLeft: CLIP_NAMES.strafeLeft,
	strafeRight: CLIP_NAMES.strafeRight,
	air: CLIP_NAMES.air
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _pole = new THREE.Vector3();
const _target = new THREE.Vector3();
const _hq = new THREE.Quaternion();

/**
 * @typedef {{character: string, head: string, hat: string, body: string, outfit: string, photo?: string}} AvatarLook
 * @typedef {{pos: number[], rot: number[], joints?: number[] | null} | null | undefined} HandPose
 */

export class RiggedAvatar {
	/**
	 * @param {string} peerId @param {AvatarLook} look
	 * @param {{onReady?: () => void, onIk?: (sides: {left: boolean, right: boolean}) => void}} [hooks]
	 */
	constructor(peerId, look, hooks = {}) {
		this.peerId = peerId;
		this.hooks = hooks;
		/** the group added to the scene: body + head, yaw-only, feet at its origin */
		this.object = new THREE.Group();
		this.object.name = peerId + '-avatar';
		this.object.visible = false;
		this.tracker = newTracker();
		this.bodyYaw = 0;
		/** @type {Record<string, number>} */
		this.weights = { idle: 1 };
		this.disposed = false;
		this.ready = false;
		this.placed = false;
		this.ik = { left: 0, right: 0 };
		this.ikShown = { left: false, right: false };
		/** @type {any} */
		this.inst = null;
		/** @type {THREE.AnimationMixer | null} */
		this.mixer = null;
		/** @type {Record<string, THREE.AnimationAction>} */
		this.actions = {};
		/** @type {THREE.Mesh | null} */
		this.headMesh = null;
		/** @type {THREE.Mesh | null} */
		this.photoCard = null;
		/** @type {any} */
		this.bones = null;
		/** @type {Record<string, any>} */
		this.arms = {};
		this.look = { ...look };
		this.characterId = '';
		this.build(look);
	}

	/** (Re)build when the character changes; restyle in place otherwise. @param {AvatarLook} look */
	setLook(look) {
		const prev = this.look;
		this.look = { ...look };
		if (look.character !== this.characterId) return this.build(look);
		if (prev.head !== look.head || prev.hat !== look.hat || prev.body !== look.body || prev.photo !== look.photo) this.buildHead();
		if (this.inst) setOutfit(this.inst.material, this.characterId, look.outfit);
	}

	/** @param {AvatarLook} look */
	async build(look) {
		const id = look.character;
		this.characterId = id;
		let gltf, clips;
		try {
			[gltf, clips] = await Promise.all([loadCharacter(id), loadClips()]);
		} catch (err) {
			console.warn('[avatar] could not load', id, err);
			return;
		}
		// superseded by a newer pick, or unmounted, while loading
		if (this.disposed || this.characterId !== id) return;
		this.teardownInstance();
		const inst = instantiate(gltf, { outfit: look.outfit });
		setOutfit(inst.material, id, this.look.outfit);
		inst.root.scale.setScalar(AVATAR_SCALE);
		inst.root.rotation.y = MODEL_YAW;
		this.object.add(inst.root);
		this.inst = inst;
		const b = (/** @type {string} */ n) => inst.bones.get(boneName(n)) ?? null;
		this.bones = {
			head: b('head'),
			chest: b('chest'),
			spine: b('spine'),
			left: { upper: b('upperarm.l'), lower: b('lowerarm.l'), wrist: b('wrist.l') },
			right: { upper: b('upperarm.r'), lower: b('lowerarm.r'), wrist: b('wrist.r') }
		};
		inst.root.updateMatrixWorld(true);
		/** @type {Record<string, any>} */
		this.arms = {};
		for (const side of /** @type {const} */ (['left', 'right'])) {
			const a = this.bones[side];
			if (a.upper && a.lower && a.wrist) this.arms[side] = { ...a, rest: measureArm(a.upper, a.lower, a.wrist) };
		}
		this.mixer = new THREE.AnimationMixer(inst.root);
		this.actions = {};
		for (const [slot, name] of Object.entries(SLOT_CLIP)) {
			const clip = clips[name];
			if (!clip) continue;
			const action = this.mixer.clipAction(clip);
			action.enabled = true;
			action.setEffectiveWeight(slot === 'idle' ? 1 : 0);
			action.play();
			this.actions[slot] = action;
		}
		this.buildHead();
		this.ready = true;
		this.hooks.onReady?.();
	}

	buildHead() {
		if (this.headMesh) {
			this.object.remove(this.headMesh);
			this.headMesh.geometry.dispose();
			/** @type {any} */ (this.headMesh.material).dispose();
			this.headMesh = null;
		}
		if (this.photoCard) {
			this.object.remove(this.photoCard);
			this.photoCard.geometry.dispose();
			const pm = /** @type {any} */ (this.photoCard.material);
			pm.map?.dispose();
			pm.dispose();
			this.photoCard = null;
		}
		const { head, hat, body, photo } = this.look;
		const stylised = head && head !== 'character';
		if (head === 'photo' && photo) this.buildPhotoCard(photo);
		// the character's own head is collapsed when a stylised one replaces it
		if (this.bones?.head) this.bones.head.scale.setScalar(stylised ? 1e-4 : 1);
		const geo = buildHeadGeometry({
			head: stylised && head !== 'photo' ? head : '',
			hat,
			color: body || '#4f83cc',
			scale: 0.72,
			hatLift: hatLiftFor(this.characterId)
		});
		if (!geo) return;
		const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
		mesh.name = this.peerId + '-avatar-head';
		mesh.matrixAutoUpdate = false;
		mesh.castShadow = true;
		this.object.add(mesh);
		this.headMesh = mesh;
	}

	/** a camera-facing square card carrying the user's photo, in place of the head (the 129 card)
	 * @param {string} url */
	buildPhotoCard(url) {
		const mat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
		const card = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), mat);
		card.name = this.peerId + '-face-card';
		this.object.add(card);
		this.photoCard = card;
		new THREE.TextureLoader().load(url, (tex) => {
			if (this.photoCard !== card) return tex.dispose();
			tex.colorSpace = THREE.SRGBColorSpace;
			mat.map = tex;
			mat.needsUpdate = true;
		});
	}

	/** where the head's centre is, in the avatar group's frame (the label and the photo card hang off it) */
	headCenterLocal(out = new THREE.Vector3()) {
		return out.set(0, feetBelowHead(), 0);
	}

	/**
	 * One frame. `root` is the peer's head group (written by moveCamera); `hands` the peerHands row.
	 * @param {number} dt seconds @param {number} now seconds @param {THREE.Object3D} root
	 * @param {{left?: HandPose, right?: HandPose, active?: boolean, ts?: number} | null | undefined} hands
	 * @param {THREE.Vector3 | null} [viewer] the local camera's world position (the photo card faces it)
	 */
	update(dt, now, root, hands, viewer = null) {
		if (this.disposed) return;
		const p = root.position;
		// the root parks at y=1000 until the first camera sample: no body until we know where it is
		if (p.y > 900) {
			this.object.visible = false;
			return;
		}
		trackPose(this.tracker, [p.x, p.y, p.z], now);
		const fwd = forwardOfQuat([root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w]);
		const { yaw: headYaw, pitch: headPitch } = yawPitchOf(fwd);
		const active = !!hands?.active;
		const L = active ? hands?.left : null;
		const R = active ? hands?.right : null;
		const speed = Math.hypot(this.tracker.vel[0], this.tracker.vel[2]);
		const hy = handsYaw([p.x, p.y, p.z], L?.pos, R?.pos);
		this.bodyYaw = this.placed ? nextBodyYaw({ bodyYaw: this.bodyYaw, headYaw, handsYaw: hy, speed, dt }) : headYaw;

		// body: feet under the head, eased so a 20 Hz stream does not step
		const tx = p.x;
		const ty = p.y - feetBelowHead();
		const tz = p.z;
		const o = this.object.position;
		const jump = Math.hypot(tx - o.x, ty - o.y, tz - o.z);
		if (!this.placed || jump > TELEPORT_M) o.set(tx, ty, tz);
		else {
			const k = 1 - Math.exp(-dt * 14);
			o.x += (tx - o.x) * k;
			o.y += (ty - o.y) * k;
			o.z += (tz - o.z) * k;
		}
		this.object.rotation.set(0, this.bodyYaw, 0);
		this.placed = true;
		this.object.visible = this.ready;
		if (!this.ready || !this.mixer || !this.inst) return;

		// locomotion
		const v = bodyFrameVelocity(this.tracker.vel, this.bodyYaw);
		const { weights, rates } = locomotionWeights(v);
		approachWeights(this.weights, weights, dt);
		for (const s of SLOTS) {
			const a = this.actions[s];
			if (!a) continue;
			a.setEffectiveWeight(this.weights[s] ?? 0);
			a.setEffectiveTimeScale(rates[s] ?? 1);
		}
		this.mixer.update(dt);

		// neck: the head's turn relative to the body, 30% in the chest and 70% in the head
		const neck = neckAngles(headYaw, headPitch, this.bodyYaw);
		if (this.bones.chest) {
			_q.setFromEuler(_e.set(-neck.pitch * 0.3, neck.yaw * 0.3, 0, 'YXZ'));
			this.bones.chest.quaternion.multiply(_q);
		}
		if (this.bones.head) {
			_q.setFromEuler(_e.set(-neck.pitch * 0.7, neck.yaw * 0.7, 0, 'YXZ'));
			this.bones.head.quaternion.multiply(_q);
		}
		this.object.updateMatrixWorld(true);

		// arms (VR peers): two-bone IK toward the controllers, faded by confidence
		const parent = this.object.parent;
		for (const side of /** @type {const} */ (['left', 'right'])) {
			const arm = this.arms[side];
			if (!arm) continue;
			const pose = side === 'left' ? L : R;
			let want = 0;
			if (pose?.pos && parent) {
				_target.fromArray(pose.pos);
				parent.localToWorld(_target);
				arm.upper.getWorldPosition(_v);
				const reach = (arm.rest.lowerPos.length() + arm.rest.wristPos.length()) * AVATAR_SCALE * 1.45;
				const ageMs = hands?.ts ? Date.now() - hands.ts : 0;
				want = armConfidence({ ageMs, distance: _v.distanceTo(_target), reach });
			}
			// fade, never snap
			const k = 1 - Math.exp(-dt * 8);
			this.ik[side] += (want - this.ik[side]) * k;
			const w = this.ik[side] < 0.02 ? 0 : this.ik[side];
			if (w > 0 && pose) {
				// the elbow hangs down, out to its side and a little back
				const sideSign = side === 'left' ? 1 : -1;
				arm.upper.getWorldPosition(_pole);
				_w.set(sideSign * 0.35, -0.7, -0.25).applyAxisAngle(_v.set(0, 1, 0), this.bodyYaw + MODEL_YAW);
				_pole.add(_w);
				solveArm(arm, _target, _pole, w);
				if (pose.rot && parent) {
					_hq.setFromEuler(_e.set(pose.rot[0], pose.rot[1], pose.rot[2], 'XYZ'));
					parent.getWorldQuaternion(_q2);
					_hq.premultiply(_q2);
					orientWrist(arm.wrist, _hq, WRIST_OFFSET[side], w);
				}
			} else solveArm(arm, _target, _pole, 0);
			const shown = this.ik[side] > 0.5;
			if (shown !== this.ikShown[side]) {
				this.ikShown[side] = shown;
				this.hooks.onIk?.({ ...this.ikShown });
			}
		}

		// the stylised head / hat rides the head bone (scale ignored: a collapsed bone has none to give)
		if (this.headMesh && this.bones.head && this.bones.head.parent) {
			const hb = this.bones.head;
			_m.compose(hb.position, hb.quaternion, _one);
			_m.premultiply(hb.parent.matrixWorld);
			// lift to the head's centre in the bone's own frame
			_m2.makeTranslation(0, HEAD_CENTER_ABOVE_BONE, 0);
			_m.multiply(_m2);
			_m2.copy(this.object.matrixWorld).invert();
			this.headMesh.matrix.multiplyMatrices(_m2, _m);
			this.headMesh.matrixWorldNeedsUpdate = true;
		}
		// the photo card: at the head's centre, square to the viewer
		if (this.photoCard && this.bones.head && this.bones.head.parent) {
			const hb = this.bones.head;
			_m.compose(hb.position, hb.quaternion, _one).premultiply(hb.parent.matrixWorld);
			_v.set(0, HEAD_CENTER_ABOVE_BONE, 0).applyMatrix4(_m);
			this.object.worldToLocal(_v);
			this.photoCard.position.copy(_v);
			if (viewer) {
				this.photoCard.getWorldPosition(_w);
				_q.setFromRotationMatrix(_m.lookAt(viewer, _w, this.object.up));
				this.object.getWorldQuaternion(_q2);
				this.photoCard.quaternion.copy(_q2.invert().multiply(_q));
			}
		}
	}

	/** debug/e2e: what the body is doing */
	state() {
		const w = this.weights;
		const top = SLOTS.reduce((a, b) => ((w[b] ?? 0) > (w[a] ?? 0) ? b : a), 'idle');
		const wristL = this.arms?.left?.wrist?.getWorldPosition(new THREE.Vector3()).toArray();
		const wristR = this.arms?.right?.wrist?.getWorldPosition(new THREE.Vector3()).toArray();
		return {
			ready: this.ready,
			character: this.characterId,
			head: this.look.head,
			visible: this.object.visible,
			bodyYaw: wrapAngle(this.bodyYaw),
			speed: Math.hypot(...this.tracker.vel),
			top,
			weights: { ...w },
			ik: { ...this.ik },
			wrist: { left: wristL, right: wristR },
			feet: this.object.position.toArray()
		};
	}

	teardownInstance() {
		if (!this.inst) return;
		this.mixer?.stopAllAction();
		if (this.inst.root) this.mixer?.uncacheRoot(this.inst.root);
		this.object.remove(this.inst.root);
		this.inst.material.dispose();
		this.inst = null;
		this.mixer = null;
		this.actions = {};
		this.ready = false;
	}

	dispose() {
		this.disposed = true;
		this.teardownInstance();
		if (this.headMesh) {
			this.headMesh.geometry.dispose();
			/** @type {any} */ (this.headMesh.material).dispose();
			this.headMesh = null;
		}
		this.object.removeFromParent();
	}
}

/**
 * The look a config asks for (null = the classic floating head).
 * @param {any} config resolved avatar config @param {string} peerId @param {string} [photoUrl] the peer's profile photo
 * @returns {AvatarLook | null}
 */
export function lookOf(config, peerId, photoUrl = '') {
	const c = resolveCharacter(config.character, peerId);
	if (!c) return null;
	const photo = config.face === 'image' && photoUrl ? photoUrl : '';
	return {
		character: c.id,
		photo,
		head: photo ? 'photo' : config.head || 'character',
		hat: config.hat || 'none',
		body: config.body,
		outfit: config.outfit || ''
	};
}
