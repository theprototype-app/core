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
import { DizzyFx } from './dizzy.js';

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
const _sole = new THREE.Vector3();
const _toObject = new THREE.Matrix4();

/** 37 R23: the SOLE vertices of each character (indices into its shared geometry), picked once */
/** @type {Map<string, number[]>} */
const SOLES = new Map();
/** 37 R22: where a character's own face is, in its head-CENTRE frame (model units), picked once */
/** @type {Map<string, {eyes: THREE.Vector3[], ring: number, lift: number}>} */
const FACES = new Map();
/** a stylised head's eyes + crown, in the head-centre frame (the geometry's 0.72 scale folded in) */
const STYLISED_FACE = /** @type {Record<string, {eyes: number[][], ring: number, lift: number}>} */ ({
	sphere: { eyes: [[-0.14, 0.05, 0.4], [0.14, 0.05, 0.4]], ring: 0.48, lift: 0.52 },
	box: { eyes: [[-0.14, 0.05, 0.38], [0.14, 0.05, 0.38]], ring: 0.5, lift: 0.5 },
	capsule: { eyes: [[-0.12, 0.08, 0.34], [0.12, 0.08, 0.34]], ring: 0.42, lift: 0.66 },
	cone: { eyes: [[-0.08, -0.08, 0.22], [0.08, -0.08, 0.22]], ring: 0.42, lift: 0.56 }
});
const STYLISED_EYES = Object.fromEntries(Object.entries(STYLISED_FACE).map(([k, f]) => [k, f.eyes.map((e) => new THREE.Vector3(e[0], e[1], e[2]))]));
/** a photo card's eyes, in the CARD's frame (it is 0.8 m square and faces the viewer) */
const PHOTO_EYES = [new THREE.Vector3(-0.13, 0.08, 0.02), new THREE.Vector3(0.13, 0.08, 0.02)];

/**
 * The character's own face: the head-bone vertices in the bind pose, in the head-CENTRE frame. The
 * eyes sit at the centre's height, a third of the way out to each side, on the FRONT of the face at
 * that height (a visor or a hood brim sticks out further — measured there, not at the extreme).
 * @param {THREE.SkinnedMesh} mesh @param {string} id
 */
export function faceOf(mesh, id) {
	const cached = FACES.get(id);
	if (cached) return cached;
	const hi = mesh.skeleton.bones.findIndex((b) => b.name === boneName('head'));
	const inv = mesh.skeleton.boneInverses[hi];
	const pos = mesh.geometry.attributes.position;
	const si = mesh.geometry.attributes.skinIndex;
	const sw = mesh.geometry.attributes.skinWeight;
	const v = new THREE.Vector3();
	let halfW = 0.3;
	let top = 0.5;
	/** @type {(number[] | null)[]} each vertex in the head-centre frame (null = not the head's) */
	const local = new Array(pos.count).fill(null);
	if (hi >= 0 && inv) {
		halfW = 0;
		top = 0;
		for (let k = 0; k < pos.count; k++) {
			let best = 0;
			let bi = -1;
			for (let j = 0; j < 4; j++) {
				const w = sw.getComponent(k, j);
				if (w > best) {
					best = w;
					bi = si.getComponent(k, j);
				}
			}
			if (bi !== hi) continue;
			v.fromBufferAttribute(pos, k).applyMatrix4(mesh.bindMatrix).applyMatrix4(inv);
			v.y -= HEAD_CENTER_ABOVE_BONE;
			halfW = Math.max(halfW, Math.abs(v.x));
			top = Math.max(top, v.y);
			local[k] = [v.x, v.y, v.z];
		}
	}
	const eyeX = Math.min(halfW, 0.6) * 0.33;
	// the depth of the face AT each eye: a ray straight through the eye point, the front-most HEAD
	// triangle it crosses. Not the nose tip and not a nearby helmet rim (the knight's face sits
	// recessed inside its helmet) — a star in front of the face slides off the eye seen from the side
	const index = mesh.geometry.index;
	const tris = index ? index.count / 3 : pos.count / 3;
	const vid = (/** @type {number} */ t, /** @type {number} */ c) => (index ? index.getX(t * 3 + c) : t * 3 + c);
	const depthAt = (/** @type {number} */ x, /** @type {number} */ y) => {
		let z = -Infinity;
		for (let t = 0; t < tris; t++) {
			const a = local[vid(t, 0)];
			const b = local[vid(t, 1)];
			const c = local[vid(t, 2)];
			if (!a || !b || !c) continue;
			const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
			if (Math.abs(d) < 1e-9) continue;
			const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
			const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
			const l3 = 1 - l1 - l2;
			if (l1 < 0 || l2 < 0 || l3 < 0) continue;
			z = Math.max(z, l1 * a[2] + l2 * b[2] + l3 * c[2]);
		}
		return Number.isFinite(z) && z > 0 ? z : 0.45;
	};
	const face = {
		eyes: [new THREE.Vector3(-eyeX, 0, depthAt(-eyeX, 0) + 0.015), new THREE.Vector3(eyeX, 0, depthAt(eyeX, 0) + 0.015)],
		ring: Math.min(halfW, 0.62) + 0.06,
		lift: Math.min(top, 0.62) + 0.12
	};
	FACES.set(id, face);
	return face;
}

/** at most this many sole vertices per foot are re-skinned each frame */
const SOLE_CAP = 40;

/**
 * The vertices a foot stands on: those skinned mostly to a foot/toes bone, within 2% of the
 * body's height of that foot's lowest one in the bind pose (the flat-footed rest pose). The
 * clips roll the foot over its heel and toes, so the lowest point of the body during a stride
 * is always one of these.
 * @param {THREE.SkinnedMesh} mesh @param {string} id @returns {number[]}
 */
export function soleVertices(mesh, id) {
	const cached = SOLES.get(id);
	if (cached) return cached;
	const bones = mesh.skeleton.bones;
	/** @type {Map<number, string>} bone index -> side */
	const footSide = new Map();
	bones.forEach((b, i) => {
		const m = /^(?:foot|toes)([lr])$/.exec(b.name);
		if (m) footSide.set(i, m[1]);
	});
	const pos = mesh.geometry.attributes.position;
	const si = mesh.geometry.attributes.skinIndex;
	const sw = mesh.geometry.attributes.skinWeight;
	/** @type {Record<string, {k: number, y: number}[]>} */
	const sides = { l: [], r: [] };
	let lo = Infinity;
	let hi = -Infinity;
	for (let k = 0; k < pos.count; k++) {
		const y = _sole.fromBufferAttribute(pos, k).applyMatrix4(mesh.bindMatrix).y;
		lo = Math.min(lo, y);
		hi = Math.max(hi, y);
		let best = 0;
		let bi = -1;
		for (let j = 0; j < 4; j++) {
			const w = sw.getComponent(k, j);
			if (w > best) {
				best = w;
				bi = si.getComponent(k, j);
			}
		}
		const side = footSide.get(bi);
		if (side) sides[side].push({ k, y });
	}
	const eps = (hi - lo) * 0.02;
	/** @type {number[]} */
	const out = [];
	for (const list of Object.values(sides)) {
		if (!list.length) continue;
		const min = Math.min(...list.map((v) => v.y));
		const sole = list.filter((v) => v.y <= min + eps).map((v) => v.k);
		const stride = Math.max(1, Math.ceil(sole.length / SOLE_CAP));
		for (let i = 0; i < sole.length; i += stride) out.push(sole[i]);
	}
	SOLES.set(id, out);
	return out;
}

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
		/** 37 R23: the bones this class poses AFTER the mixer, and their clip pose of the last frame */
		/** @type {THREE.Object3D[]} */
		this.posed = [];
		/** @type {Float32Array | null} */
		this.clipPose = null;
		/** @type {number[]} */
		this.soles = [];
		/** how far the sole clamp lifted the body this frame (m), and where the lowest sole ended */
		this.lift = 0;
		this.soleY = 0;
		/** where the feet were anchored from: the sender's walker ('wire') or the head ('head') */
		this.anchor = 'head';
		/** 37 R22: the knocked-off idle (stars, sway, star eyes) — one instanced draw while it shows */
		this.dizzy = new DizzyFx();
		this.object.add(this.dizzy.mesh);
		/** @type {{eyes: THREE.Vector3[], ring: number, lift: number} | null} */
		this.face = null;
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
		// the bones posed on top of the clips (neck, arm IK). A clip whose value did not change
		// since the last frame is NOT re-applied by three's PropertyMixer, so anything multiplied
		// onto such a bone kept accumulating — the idle head spun (37 R22). Each frame restores
		// their clip pose before the mixer runs.
		this.posed = [this.bones.chest, this.bones.head];
		for (const side of /** @type {const} */ (['left', 'right'])) {
			const a = this.bones[side];
			this.posed.push(a.upper, a.lower, a.wrist);
		}
		this.posed = this.posed.filter(Boolean);
		this.clipPose = null;
		this.soles = soleVertices(inst.mesh, id);
		this.face = faceOf(inst.mesh, id);
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

		// body: feet under the head, eased so a 20 Hz stream does not step. 37 R23: a walking
		// sender says where its feet are (its walker's floor — slopes and steps included), which
		// beats a head-height guess: eye heights differ (a 1.7 m walker, a seated VR player).
		const tx = p.x;
		const wireFeet = root.userData?.feet;
		const fromWire = Number.isFinite(wireFeet) && p.y - wireFeet > 0.3 && p.y - wireFeet < 3.5;
		this.anchor = fromWire ? 'wire' : 'head';
		const ty = fromWire ? wireFeet : p.y - feetBelowHead();
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
		this.restoreClipPose();
		this.mixer.update(dt);
		this.saveClipPose();
		this.planFeet();

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
		// 37 R22: knocked off — the head travels a vertical figure-8 in its own XY plane and tilts with
		// it (both on top of the clip pose, which restoreClipPose puts back next frame)
		if (this.dizzy.step(!!root.userData?.knocked, dt) > 0 && this.bones.head) {
			const sw = this.dizzy.sway();
			const hb = this.bones.head;
			hb.position.add(_v.set(sw.x, sw.y, 0).applyQuaternion(hb.quaternion));
			hb.quaternion.multiply(_q.setFromAxisAngle(_w.set(0, 0, 1), sw.roll));
			if (this.bones.chest) this.bones.chest.quaternion.multiply(_q.setFromAxisAngle(_w.set(0, 0, 1), sw.roll * 0.25));
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
		this.poseDizzy(viewer);
	}

	/**
	 * 37 R22: pose the stars and the star eyes for this frame (only while knocked off).
	 * @param {THREE.Vector3 | null} viewer world
	 */
	poseDizzy(viewer) {
		const hb = this.bones?.head;
		if (!this.dizzy.mesh.visible || !hb?.parent) return;
		_m.compose(hb.position, hb.quaternion, _one).premultiply(hb.parent.matrixWorld);
		_m.multiply(_m2.makeTranslation(0, HEAD_CENTER_ABOVE_BONE, 0));
		_toObject.copy(this.object.matrixWorld).invert();
		_m.premultiply(_toObject);
		const viewerLocal = viewer ? this.object.worldToLocal(_target.copy(viewer)) : null;
		const head = this.look.head;
		/** @type {THREE.Vector3[] | null} */
		let eyes = null;
		/** @type {THREE.Matrix4 | null} */
		let eyeFrame = null;
		let dims = { ring: 0.5, lift: 0.55, size: 0.07 };
		if (head === 'photo' && this.photoCard) {
			eyes = PHOTO_EYES;
			eyeFrame = _m2.compose(this.photoCard.position, this.photoCard.quaternion, _one);
			dims = { ring: 0.5, lift: 0.55, size: 0.08 };
		} else if (head && head !== 'character' && STYLISED_FACE[head]) {
			const f = STYLISED_FACE[head];
			eyes = STYLISED_EYES[head];
			dims = { ring: f.ring, lift: f.lift, size: 0.07 };
		} else if (this.face) {
			eyes = this.face.eyes;
			dims = { ring: this.face.ring, lift: this.face.lift, size: 0.07 };
		}
		this.dizzy.pose(_m, dims, eyes, viewerLocal, eyeFrame);
	}

	/** put the post-posed bones back on last frame's clip pose (see `posed`) */
	restoreClipPose() {
		const c = this.clipPose;
		if (!c) return;
		let i = 0;
		for (const b of this.posed) {
			b.quaternion.fromArray(c, i);
			b.position.fromArray(c, i + 4);
			i += 7;
		}
	}

	saveClipPose() {
		if (!this.clipPose) this.clipPose = new Float32Array(this.posed.length * 7);
		let i = 0;
		for (const b of this.posed) {
			b.quaternion.toArray(this.clipPose, i);
			b.position.toArray(this.clipPose, i + 4);
			i += 7;
		}
	}

	/**
	 * 37 R23: the sole clamp. The clips roll each foot over its heel and toes, which takes a sole
	 * up to 8 cm through the floor at heel strike. Lift the body by however far the lowest sole
	 * went below the feet origin (never lower it: a run's flight phase leaves both feet up), so
	 * the planted foot stands ON the floor. Skipped in the airborne pose. Cost: <= 80 re-skinned
	 * vertices per body.
	 */
	planFeet() {
		const inst = this.inst;
		if (!inst || !this.soles.length) return;
		inst.root.position.y = 0;
		this.object.updateMatrixWorld(true);
		_toObject.copy(this.object.matrixWorld).invert().multiply(inst.mesh.matrixWorld);
		let min = Infinity;
		for (const k of this.soles) {
			inst.mesh.getVertexPosition(k, _sole).applyMatrix4(_toObject);
			if (_sole.y < min) min = _sole.y;
		}
		if (!Number.isFinite(min)) return;
		const air = this.weights.air ?? 0;
		this.lift = Math.max(0, -min) * (1 - air);
		this.soleY = min + this.lift;
		inst.root.position.y = this.lift;
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
			feet: this.object.position.toArray(),
			anchor: this.anchor,
			dizzy: this.dizzy.weight,
			lift: this.lift,
			soleY: this.soleY,
			headBone: this.bones?.head ? this.bones.head.quaternion.toArray() : null
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
		this.dizzy.dispose();
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
