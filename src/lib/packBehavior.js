// 33 P2 — ANIMATED, FUNCTIONAL PACK ITEMS: the runtime. A door you click open, a chest
// lid, a lever, a fan. The pure rules (normalize, timing, the doorway maths) live in
// behaviorCore.js; this file feeds them and acts on the answer.
//
// WHAT DRIVES WHAT
//  · The SPEC rides the placed root (`userData.behavior`, registered by animatedImports
//    from the pack row or the GLB's own extras). animatedImports skips these roots in its
//    looping transport; THIS file poses them, every frame, through the same mixer.
//  · The STATE `{on, at, from, n}` is runtime and SHARED: one `behavior` message per
//    trigger, latest-wins on a sessionNow() stamp, every pose a pure function of it — so a
//    door swings in phase on every peer with no stream. A late joiner gets it as an additive
//    `behaviorState` on the objectfile message (animatedImports' behaviorFields). It is
//    never saved and never undone: a scene saved with a door open reopens shut.
//  · THE USER'S RULE: nothing moves in EDIT. A peer in Edit renders the rest pose whatever
//    the shared state says (gameFeelActive is LOCAL), so authoring never sees a door swing,
//    and an ambient loop only runs in Interact/Play. The Animation panel can PREVIEW a clip
//    in Edit — local, never sent, back to rest at the end.
//
// TRIGGERS (Interact/Play only): click — every click path (the desktop Interact click, the
// Play tap, the VR laser/trigger and the hold-and-sweep poke) reaches moduleSDK's ONE
// dispatch, where a core handler is pushed; knock — a VR hand moving into a moving part at
// >= KNOCK_SPEED (a desktop click still knocks); proximity — the local player within 1.5 m
// opens on the rising edge, the falling edge closes, a click still toggles.
//
// COLLIDERS (`collider: 'follow'`): the frame is a CUSTOM compound collider of slab boxes
// with the doorway cut out (behaviorCore.frameSlabs), stamped on `userData.physics` at
// registration on every peer (deterministic from the file, so nothing travels), and each
// moving node gets its own KINEMATIC box in the live rapier world that follows the node
// every frame. physics.js skips colliders it does not own (physicsRuntime's contract), and
// the walker's capsule collides with everything in the world — so an open door lets you
// through and a shut one stops you. Only while a simulation runs, which is the only time
// the walker collides with anything at all (charController's tiers, unchanged).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { sessionNow } from './sessionClock';
import { gameFeelActive } from './gameFeel';
import { behaviorOf, behaviorUuids, behaviorRegistry, animatedRecordOf, setBehaviorHooks } from './animatedImports';
import {
	normalizeState,
	restState,
	stateIsNewer,
	poseAt,
	nextState,
	frameSlabs,
	boxCorners,
	defaultSound,
	PROXIMITY_RADIUS,
	KNOCK_SPEED
} from './behaviorCore';
import { playGameSound } from './gameSfx';
import { moduleClickHandlers } from './moduleSDK';

/** @type {Map<string, import('./behaviorCore').BehaviorState>} */
const states = new Map();
/** @type {Map<string, any>} uuid -> the placed root (re-found when a registration repeats) */
const roots = new Map();
/** @type {Map<string, number>} uuid -> when we last looked and found NO root (a deleted item:
 * the registry keeps it, and a tree search per frame per ghost would be a per-frame cost) */
const missingAt = new Map();
/** @type {Map<string, string>} uuid -> the pose last written ("clip@time"), so an idle door costs nothing */
const lastPose = new Map();
/** @type {Map<string, any>} uuid -> the action last driven (switching clip stops it) */
const lastAction = new Map();
/** @type {Map<string, {clip: string, start: number}>} LOCAL Animation-panel previews */
const previews = new Map();
/** @type {Map<string, boolean>} proximity: was the player inside last frame */
const near = new Map();
/** @type {Map<string, number>} knock cooldown: uuid -> performance.now() it may fire again */
const knockReady = new Map();
/** @type {Map<string, {box: THREE.Box3, at: number}>} world boxes for proximity, refreshed */
const boxCache = new Map();
const stats = { triggers: 0, received: 0, stale: 0, poses: 0, sounds: 0, knocks: 0, colliderBuilds: 0 };

/** the leftover after a clip end before a preview hands the pose back */
const PREVIEW_HOLD = 0.4;
const KNOCK_COOLDOWN_MS = 800;
const BOX_REFRESH_MS = 500;

/** @type {((hand: 'left'|'right') => any) | null} */
let hands = null;
/** @type {any} */ let physicsRef = null;
/** @type {any} */ let flowRef = null;
let started = false;

/* ------------------------------------------------------------------ helpers ------ */

/** the placed root for a uuid (cached, re-validated: an undo re-adds a NEW object) @param {string} uuid */
function rootOf(uuid) {
	const cached = roots.get(uuid);
	if (cached && cached.parent) return cached;
	const now = performance.now();
	if (now - (missingAt.get(uuid) ?? -Infinity) < 1000) return null;
	const found = get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
	if (found) {
		roots.set(uuid, found);
		missingAt.delete(uuid);
	} else {
		roots.delete(uuid);
		missingAt.set(uuid, now);
	}
	return found;
}

/** the behavior root a clicked mesh belongs to, or null @param {any} mesh */
export function behaviorRootOf(mesh) {
	for (let node = mesh; node; node = node.parent) if (node.uuid && behaviorOf(node.uuid)) return node;
	return null;
}

/** the nodes a clip animates (the MOVING parts), by the track names @param {any} root @param {any[]} clips */
function movingNodesOf(root, clips) {
	/** @type {Set<any>} */
	const out = new Set();
	for (const clip of clips) {
		for (const track of clip?.tracks ?? []) {
			// a weights-only track (a banner's morph) moves no collider
			if (track.name.endsWith('.morphTargetInfluences')) continue;
			const parsed = THREE.PropertyBinding.parseTrackName(track.name);
			const node = parsed.nodeName ? THREE.PropertyBinding.findNode(root, parsed.nodeName) : null;
			if (node && node !== root) out.add(node);
		}
	}
	return [...out];
}

/** the spec's clips as AnimationClips @param {string} uuid */
function specClips(uuid) {
	const spec = behaviorOf(uuid);
	const record = animatedRecordOf(uuid);
	if (!spec || !record) return [];
	/** @type {string[]} */
	const names = spec.closeClip ? [spec.clip, spec.closeClip] : [spec.clip];
	return names.map((name) => record.actions[name]?.getClip?.()).filter(Boolean);
}

/**
 * Write a pose: `clip` at `time` seconds. The action is played, its time SET, and the
 * mixer updated by 0 — an exact evaluation with no accumulated drift and no loop wrap.
 * @param {string} uuid @param {string} clip @param {number} time
 */
function writePose(uuid, clip, time) {
	const record = animatedRecordOf(uuid);
	const action = record?.actions?.[clip];
	if (!action) return;
	const dur = action.getClip().duration;
	const t = Math.min(dur, Math.max(0, time));
	const key = clip + '@' + t.toFixed(4);
	if (lastPose.get(uuid) === key) return;
	const previous = lastAction.get(uuid);
	if (previous && previous !== action) previous.stop();
	if (!action.isScheduled() || !action.enabled) {
		action.reset();
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		action.play();
	}
	action.paused = false;
	action.time = t;
	record.mixer.update(0);
	lastAction.set(uuid, action);
	lastPose.set(uuid, key);
	stats.poses++;
}

/** play the item's sound at the object @param {string} uuid */
function soundFor(uuid) {
	const spec = behaviorOf(uuid);
	const name = spec?.sound ?? (spec ? defaultSound(spec) : null);
	if (!name) return;
	const root = rootOf(uuid);
	const at = root ? root.getWorldPosition(new THREE.Vector3()).toArray() : null;
	if (playGameSound(name, at)) stats.sounds++;
}

/* ------------------------------------------------------------------ the state ---- */

/** the current shared state (a copy) @param {string} uuid */
export function behaviorState(uuid) {
	const s = states.get(uuid);
	return s ? { ...s } : null;
}

/**
 * TRIGGER: the click, the knock, the proximity edge. Applies locally, sends ONE message,
 * plays the sound here (every receiver plays its own). `want` forces a direction.
 * @param {string} uuid @param {boolean} [want] @returns {boolean} did anything change
 */
export function triggerBehavior(uuid, want) {
	const spec = behaviorOf(uuid);
	const record = animatedRecordOf(uuid);
	if (!spec || !record) return false;
	const next = nextState(spec, states.get(uuid) ?? restState(), record.durations, sessionNow(), want);
	if (!next) return false;
	states.set(uuid, next);
	stats.triggers++;
	soundFor(uuid);
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.({ type: 'behavior', uuid, on: next.on, at: next.at, from: next.from, n: next.n });
	return true;
}

/**
 * Receive side of `behavior` (and of a late joiner's `behaviorState`). Latest wins; a
 * FRESH remote trigger also sounds here (a stale one — a joiner's history — does not).
 * @param {any} data @param {{sound?: boolean}} [opts] @returns {boolean} applied
 */
export function applyBehaviorState(data, opts = {}) {
	const uuid = data?.uuid;
	const state = normalizeState(data);
	if (typeof uuid !== 'string' || !state) return false;
	if (!stateIsNewer(states.get(uuid) ?? null, state)) {
		stats.stale++;
		return false;
	}
	states.set(uuid, state);
	stats.received++;
	if (opts.sound !== false && behaviorOf(uuid) && Math.abs(sessionNow() - state.at) < 1500) soundFor(uuid);
	return true;
}

/** the wire applier (peerHandler) @param {any} data */
export function applyRemoteBehavior(data) {
	return applyBehaviorState(data);
}

/**
 * LOCAL preview from the Animation panel / Inspector play button: plays `clip` once and
 * hands the pose back. Never sent, never saved, works in Edit (that is what it is for).
 * @param {string} uuid @param {string} [clip]
 */
export function previewBehavior(uuid, clip) {
	const spec = behaviorOf(uuid);
	const record = animatedRecordOf(uuid);
	if (!spec || !record) return false;
	const name = clip && record.actions[clip] ? clip : spec.clip;
	previews.set(uuid, { clip: name, start: performance.now() });
	return true;
}

/** stop a preview at once @param {string} uuid */
export function stopBehaviorPreview(uuid) {
	previews.delete(uuid);
}

/* ------------------------------------------------------------------ colliders ---- */

/** local box of `object`'s meshes in the frame of `frame` (scale removed with it) @param {any} object @param {any} frame @param {(m: any) => boolean} [filter] */
function boxInFrame(object, frame, filter) {
	frame.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
	const box = new THREE.Box3();
	const m = new THREE.Matrix4();
	const piece = new THREE.Box3();
	object.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || !node.geometry) return;
		if (filter && !filter(node)) return;
		if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
		piece.copy(node.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, node.matrixWorld));
		box.union(piece);
	});
	return box;
}

/** @param {THREE.Box3} b @returns {number[]} */
const boxArray = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];

/**
 * The frame's collider: static meshes' boxes minus the moving parts' REST boxes, as a
 * custom compound collider on `userData.physics` (local to the root, the customPieces
 * convention: scale is baked by physics). Never overrides a collider the user chose.
 * @param {string} uuid
 */
function stampFrameCollider(uuid) {
	const spec = behaviorOf(uuid);
	const root = rootOf(uuid);
	if (!spec || spec.collider !== 'follow' || !root) return;
	if (root.userData.physics?.collider && !root.userData.physics.__behaviorFrame) return;
	const moving = movingNodesOf(root, specClips(uuid));
	if (!moving.length) return;
	const movingSet = new Set();
	for (const node of moving) node.traverse((/** @type {any} */ n) => movingSet.add(n));
	/** @type {number[][]} */
	const statics = [];
	root.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || movingSet.has(node)) return;
		const b = boxInFrame(node, root);
		if (!b.isEmpty()) statics.push(boxArray(b));
	});
	const holes = moving.map((node) => boxArray(boxInFrame(node, root))).filter((b) => b[3] > b[0]);
	const slabs = frameSlabs(statics, holes).slice(0, 50); // CUSTOM_MAX_FLOATS / 24
	if (!slabs.length) return;
	/** @type {number[]} */
	const verts = [];
	/** @type {number[][]} */
	const pieces = [];
	for (const s of slabs) {
		pieces.push([verts.length, 24]);
		verts.push(...boxCorners(s).map((v) => Math.round(v * 1e5) / 1e5));
	}
	root.userData.physics = {
		...(root.userData.physics ?? {}),
		collider: 'custom',
		colliderVerts: verts,
		colliderPieces: pieces,
		// marks the collider as OURS, so a re-registration may restamp it and a user's own
		// pick is never overwritten
		__behaviorFrame: true
	};
}

/** @type {{world: any, parts: {uuid: string, node: any, body: any, last?: {pos: THREE.Vector3, quat: THREE.Quaternion}}[]} | null} */
let built = null;

/** the live rapier world, or null @returns {any} */
function runtime() {
	try {
		return physicsRef?.physicsRuntime?.() ?? null;
	} catch {
		return null;
	}
}

/** (re)build a kinematic box per moving node of every follow-item into `rt.world` @param {any} rt */
function buildPartColliders(rt) {
	const { world, RAPIER } = rt;
	built = { world, parts: [] };
	stats.colliderBuilds++;
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scale = new THREE.Vector3();
	for (const uuid of behaviorUuids()) {
		const spec = behaviorOf(uuid);
		const root = rootOf(uuid);
		if (!spec || spec.collider !== 'follow' || !root) continue;
		for (const node of movingNodesOf(root, specClips(uuid))) {
			const local = boxInFrame(node, node);
			if (local.isEmpty()) continue;
			node.updateWorldMatrix(true, false);
			node.matrixWorld.decompose(pos, quat, scale);
			const size = local.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
			const centre = local.getCenter(new THREE.Vector3()).multiply(scale);
			try {
				const body = world.createRigidBody(
					RAPIER.RigidBodyDesc.kinematicPositionBased()
						.setTranslation(pos.x, pos.y, pos.z)
						.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
				);
				world.createCollider(
					RAPIER.ColliderDesc.cuboid(Math.max(0.01, size.x), Math.max(0.01, size.y), Math.max(0.01, size.z)).setTranslation(
						centre.x,
						centre.y,
						centre.z
					),
					body
				);
				built.parts.push({ uuid, node, body });
			} catch (error) {
				console.log('behavior collider failed', error);
			}
		}
	}
}

// per-frame temps (no allocation in the hot path — MODULES.md's performance rule)
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
/** set when a registration (or a removal) changes what must be followed */
let collidersDirty = true;

/** one frame of the followed colliders */
function tickColliders() {
	const rt = runtime();
	if (!rt) {
		built = null; // the world is gone with its bodies (stopSimulation frees it)
		return;
	}
	let stale = !built || built.world !== rt.world || collidersDirty;
	if (!stale && built) for (const part of built.parts) if (!part.node.parent || !rootOf(part.uuid)) stale = true;
	let moved = false;
	if (stale) {
		collidersDirty = false;
		if (built && built.world === rt.world)
			for (const part of built.parts) {
				try {
					rt.world.removeRigidBody(part.body);
				} catch {}
			}
		buildPartColliders(rt);
	}
	if (!built) return;
	for (const part of built.parts) {
		part.node.updateWorldMatrix(true, false);
		part.node.matrixWorld.decompose(_pos, _quat, _scale);
		// a part that has not moved since the last write costs nothing
		if (part.last && _pos.equals(part.last.pos) && _quat.equals(part.last.quat)) continue;
		part.last ??= { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
		part.last.pos.copy(_pos);
		part.last.quat.copy(_quat);
		try {
			// rapier copies vectors in: THREE's own {x,y,z(,w)} shapes are accepted as-is
			part.body.setNextKinematicTranslation(_pos);
			part.body.setNextKinematicRotation(_quat);
			// the walker queries colliders between steps: teleport too, so a query this frame
			// already sees the leaf where it is drawn
			part.body.setTranslation(_pos, true);
			part.body.setRotation(_quat, true);
			moved = true;
		} catch {}
	}
	if (moved) {
		try {
			rt.world.propagateModifiedBodyPositionsToColliders?.();
		} catch {}
	}
}

/* ------------------------------------------------------------------ triggers ----- */

const _player = new THREE.Vector3();

/** world box of a root, cached briefly (proximity) @param {string} uuid @param {any} root */
function worldBox(uuid, root) {
	const now = performance.now();
	const cached = boxCache.get(uuid);
	if (cached && now - cached.at < BOX_REFRESH_MS) return cached.box;
	const box = new THREE.Box3().setFromObject(root);
	boxCache.set(uuid, { box, at: now });
	return box;
}

/** hand samples, reused every frame: `now` is this frame's, `prev` the one before */
const handSamples = {
	left: { now: { pos: new THREE.Vector3(), t: 0, ok: false }, prev: { pos: new THREE.Vector3(), t: 0, ok: false } },
	right: { now: { pos: new THREE.Vector3(), t: 0, ok: false }, prev: { pos: new THREE.Vector3(), t: 0, ok: false } }
};
const _knockBox = new THREE.Box3();
const HAND_LIST = [handSamples.left, handSamples.right];
const HAND_NAMES = /** @type {const} */ (['left', 'right']);

/** one frame of the proximity and knock triggers @param {string} uuid @param {any} spec @param {any} root */
function tickTriggers(uuid, spec, root) {
	if (spec.trigger === 'proximity') {
		const camera = /** @type {any} */ (get(globalCamera));
		if (!camera) return;
		camera.getWorldPosition(_player);
		const inside = worldBox(uuid, root).distanceToPoint(_player) <= PROXIMITY_RADIUS;
		const was = near.get(uuid) ?? false;
		if (inside !== was) {
			near.set(uuid, inside);
			triggerBehavior(uuid, spec.type === 'oneshot' ? undefined : inside);
		}
		return;
	}
	if (spec.trigger === 'knock' && hands) {
		const now = performance.now();
		if ((knockReady.get(uuid) ?? 0) > now) return;
		_knockBox.copy(worldBox(uuid, root)).expandByScalar(0.05);
		for (const sample of HAND_LIST) {
			const { now: cur, prev } = sample;
			if (!cur.ok || !prev.ok || cur.t <= prev.t) continue;
			const speed = (cur.pos.distanceTo(prev.pos) / (cur.t - prev.t)) * 1000;
			// the ENTRY edge: inside now, outside last frame, moving fast enough
			if (_knockBox.containsPoint(cur.pos) && !_knockBox.containsPoint(prev.pos) && speed >= KNOCK_SPEED) {
				knockReady.set(uuid, now + KNOCK_COOLDOWN_MS);
				stats.knocks++;
				triggerBehavior(uuid);
				return;
			}
		}
	}
}

/** this frame's hand poses (the previous frame's become `prev`) — no allocation */
function sampleHands() {
	if (!hands) return;
	const t = performance.now();
	for (const hand of HAND_NAMES) {
		const sample = handSamples[hand];
		sample.prev.pos.copy(sample.now.pos);
		sample.prev.t = sample.now.t;
		sample.prev.ok = sample.now.ok;
		const snap = hands(hand);
		sample.now.ok = !!snap?.position;
		if (sample.now.ok) {
			sample.now.pos.fromArray(snap.position);
			sample.now.t = t;
		}
	}
}

/* ------------------------------------------------------------------ the frame ---- */

/** Per frame from Scene's loop (beside tickAnimatedMixers). Cheap when nothing moves. */
export function tickPackBehaviors() {
	const registry = behaviorRegistry();
	if (!registry.size) {
		if (built) built = null;
		return;
	}
	const active = gameFeelActive();
	const now = sessionNow();
	if (active && hands) sampleHands();
	for (const [uuid, spec] of registry) {
		const record = animatedRecordOf(uuid);
		const root = rootOf(uuid);
		if (!spec || !record || !root) continue;
		if (active && spec.trigger !== 'click') tickTriggers(uuid, spec, root);
		if (!active) near.delete(uuid);
		const preview = previews.get(uuid);
		if (preview) {
			const dur = record.durations[preview.clip] ?? 1;
			const t = (performance.now() - preview.start) / 1000;
			if (t <= dur + PREVIEW_HOLD) {
				writePose(uuid, preview.clip, t);
				continue;
			}
			previews.delete(uuid);
		}
		const pose = poseAt(spec, states.get(uuid) ?? restState(), record.durations, now, active);
		writePose(uuid, pose.clip, pose.time);
	}
	if (physicsRef) tickColliders();
}

/* ------------------------------------------------------------------ the click ---- */

/**
 * The core click handler in moduleSDK's ONE dispatch (pushed raw, so it hears every mode;
 * it gates itself). Consumes the click it acts on, then pulses the object's On Click so an
 * author can still hang a sound or a counter on the door.
 * @param {any} mesh @returns {boolean}
 */
function onBehaviorClick(mesh) {
	if (!gameFeelActive()) return false;
	const root = behaviorRootOf(mesh);
	if (!root) return false;
	const spec = behaviorOf(root.uuid);
	if (!spec || (spec.type === 'loop' && spec.autoplay)) return false;
	// proximity doors still answer a click (a toggle by hand); knock doors take a desktop
	// click as the knock (a desktop has no hands)
	if (!triggerBehavior(root.uuid)) return false;
	try {
		flowRef?.fireObjectClick?.(root.uuid);
	} catch {}
	return true;
}

/**
 * Start once (Scene.svelte, beside the knock). `hands` is vrControls.handSnapshot, passed
 * in so this file never imports vrControls.
 * @param {{hands?: (hand: 'left'|'right') => any}} [options]
 */
export function startPackBehaviors(options = {}) {
	if (options.hands) hands = options.hands;
	if (started) return;
	started = true;
	setBehaviorHooks({
		state: (uuid) => behaviorState(uuid),
		apply: (uuid, state) => applyBehaviorState({ ...state, uuid }, { sound: false }),
		preview: (uuid, clip) => previewBehavior(uuid, clip),
		registered: (uuid) => {
			roots.delete(uuid);
			missingAt.delete(uuid);
			lastPose.delete(uuid);
			lastAction.delete(uuid);
			const record = animatedRecordOf(uuid);
			const spec = behaviorOf(uuid);
			// the rest pose NOW, so the frame collider is measured with the part shut
			if (record && spec) writePose(uuid, spec.clip, 0);
			stampFrameCollider(uuid);
			collidersDirty = true; // a new part to follow: rebuild against the live world
		}
	});
	// a registration that happened before we started (a restore during boot)
	for (const uuid of behaviorUuids()) stampFrameCollider(uuid);
	moduleClickHandlers.push(onBehaviorClick);
	// primed (physics and flowRuntime sit in history's cycle family)
	import('./physics').then((m) => (physicsRef = m)).catch(() => {});
	import('./flowRuntime').then((m) => (flowRef = m)).catch(() => {});
}

/** the suites' view @returns {any} */
export function packBehaviorDebug() {
	return {
		...stats,
		items: behaviorUuids().map((uuid) => ({
			uuid,
			spec: behaviorOf(uuid),
			state: behaviorState(uuid),
			pose: lastPose.get(uuid) ?? null,
			preview: previews.has(uuid),
			physics: rootOf(uuid)?.userData?.physics ?? null
		})),
		colliders: built ? built.parts.map((p) => ({ uuid: p.uuid, node: p.node.name, handle: p.body.handle })) : []
	};
}
