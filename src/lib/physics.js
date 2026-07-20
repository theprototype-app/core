import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { flowNodes, flowEdges } from '../stores/flowStore';
import { objectsGroup, lockedObjects, selectedObject } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordTransformSet } from './history';
import {
	notifyExternalMove,
	setPostTick,
	isAnimatedTarget,
	suspendAnimation,
	resumeAnimation
} from './flowRuntime';
import { nameOf } from './lockControl';
import { sceneJoints } from './joints';

// Physics preview (P-A rework): the INITIATOR runs rapier and broadcasts plain
// `move` messages (~10/s per awake body) — peers just watch standard moves.
// The step is a flowRuntime POST-TICK hook (not its own rAF), so the per-frame
// order is deterministic: flow poses objects -> physics feeds kinematic targets
// -> world.step() -> dynamic results write back. Three body classes:
//   dynamic   — mass param (flow node, or userData.physics mode 'dynamic')
//   kinematic — flow-ANIMATED objects: the flow pose drives the body each step
//               (setNextKinematicTranslation/Rotation), so rapier derives the
//               platform velocity and a spinning slab flings resting boxes.
//               ZERO extra peer traffic: peers run flowRuntime deterministically,
//               so the kinematic object's pose already matches frame-for-frame.
//   fixed     — everything else (scenery).
// Objects BOTH dynamic and animated: dynamic wins — the effect is suspended for
// the run (the established "someone else owns the transform" contract) and the
// settled pose becomes the new animation base at stop.
// Drag-during-sim: a held dynamic body flips kinematic and follows the gizmo;
// release restores dynamic with a velocity estimate = throw. A PEER's drag needs
// no new message: incoming `move`s on a dynamic body become a kinematic hold
// (physicsExternalMove), released after 250ms of silence.
// Stopping leaves one transformSet undo entry = "restore layout".

export const simulating = writable(false);
export const simPaused = writable(false);
/** @type {import('svelte/store').Writable<string | null>} peer currently simulating */
export const remoteSimulating = writable(null);

/** @type {any} */ let RAPIER = null;
/** @type {any} */ let world = null;
/** @typedef {{object: any, body: any, offset: THREE.Vector3, initialQuat: THREE.Quaternion,
 *   mode: 'dynamic'|'kinematic', hull: boolean, hold: 'user'|'external'|null, holdUntil: number,
 *   samples: {t: number, pos: THREE.Vector3, rot: THREE.Euler}[],
 *   lastWritten: {pos: THREE.Vector3, quat: THREE.Quaternion},
 *   lastSent?: {pos: THREE.Vector3, quat: THREE.Quaternion}}} BodyEntry */
/** @type {BodyEntry[]} */
let bodies = [];
/** @type {{uuid: string, before: any}[]} */ let beforeStates = [];
/** @type {Map<string, any>} joint def id -> live rapier impulse joint (P-B) */
let liveJoints = new Map();
/** @type {Map<string, any>} uuid -> FIXED body (scenery a joint may pin to) */
let fixedBodies = new Map();
/** @type {string[]} dynamic+animated uuids whose effects we suspended for the run */
let suspendedForRun = [];
let lastStep = 0;
let lastBroadcast = 0;
let accumulator = 0; // fixed-timestep leftover (see step)

const PHYSICS_TYPES = ['mass', 'bounciness', 'friction'];
const HULL_MAX_VERTS = 5000;
const MAX_LINVEL = 20; // m/s clamp on release-velocity estimates
const MAX_ANGVEL = 20; // rad/s
const EXTERNAL_HOLD_MS = 250; // peer-move silence before a held body drops

/** Pre-load the wasm module (also lets tests warm the vite dep cache) */
export async function warmup() {
	if (RAPIER) return;
	const module = await import('@dimforge/rapier3d-compat');
	await module.init();
	RAPIER = module;
}

/** @param {any} object */
function transformOf(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
}

/**
 * Per-object physics params. Source of truth = object.userData.physics
 * {mode:'auto'|'static'|'dynamic', mass, restitution, friction, collider}
 * (replicates free via object sync / GLTF extras / sessions), seeded first;
 * flow nodes (mass/bounciness/friction -> objectselector) OVERRIDE it, so
 * existing graphs behave byte-identically. @param {any} group
 */
function collectParams(group) {
	/** @type {Record<string, any>} */
	const map = {};
	group?.children.forEach((/** @type {any} */ object) => {
		const p = object.userData?.physics;
		if (!p) return;
		map[object.uuid] = {};
		if (p.mode === 'dynamic') map[object.uuid].mass = p.mass ?? 1;
		if (p.mode === 'static') map[object.uuid].forceStatic = true;
		if (p.restitution != null) map[object.uuid].restitution = p.restitution;
		if (p.friction != null) map[object.uuid].friction = p.friction;
		if (p.collider) map[object.uuid].collider = p.collider;
	});
	const nodes = get(flowNodes);
	const edges = get(flowEdges);
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source || !PHYSICS_TYPES.includes(source.type)) return;
		const target = nodes.find((n) => n.id === edge.target);
		if (target?.type !== 'objectselector') return;
		const uuid = target.data?.selected;
		if (!uuid || uuid === '-None-') return;
		map[uuid] ??= {};
		// flow wiring wins over userData (incl. re-dynamicizing a 'static' object)
		if (source.type === 'mass') {
			map[uuid].mass = source.data?.kg ?? 1;
			delete map[uuid].forceStatic;
		}
		if (source.type === 'bounciness') map[uuid].restitution = source.data?.value ?? 0.3;
		if (source.type === 'friction') map[uuid].friction = source.data?.value ?? 0.5;
	});
	return map;
}

export async function toggleSimulation() {
	if (get(simulating)) {
		stopSimulation();
		return;
	}
	const busy = get(remoteSimulating);
	if (busy) {
		showToast(nameOf(busy) + ' is already simulating — one run at a time');
		return;
	}
	await startSimulation();
}

/** Convex-hull collider desc for a single-Mesh object (scale BAKED into the
 * vertices — rapier colliders don't scale). Returns null when ineligible
 * (Groups, huge meshes) so the caller falls back to the box. @param {any} object */
function hullDesc(object) {
	if (!object.isMesh || !object.geometry?.attributes?.position) return null;
	const position = object.geometry.attributes.position;
	if (position.count > HULL_MAX_VERTS) return null;
	const scaled = new Float32Array(position.count * 3);
	const s = object.scale;
	for (let i = 0; i < position.count; i++) {
		scaled[i * 3] = position.getX(i) * s.x;
		scaled[i * 3 + 1] = position.getY(i) * s.y;
		scaled[i * 3 + 2] = position.getZ(i) * s.z;
	}
	return RAPIER.ColliderDesc.convexHull(scaled);
}

async function startSimulation() {
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	if (!group) return;
	await warmup();

	const params = collectParams(group);
	const locked = get(lockedObjects).map((l) => l[1]);
	let dynamicUuids = Object.keys(params).filter(
		(u) => params[u].mass != null && !params[u].forceStatic && !locked.includes(u)
	);
	if (dynamicUuids.length === 0) {
		const selected = get(selectedObject);
		if (selected && group.getObjectByProperty('uuid', selected.uuid) && !locked.includes(selected.uuid)) {
			params[selected.uuid] = { ...(params[selected.uuid] ?? {}), mass: 1 };
			delete params[selected.uuid].forceStatic;
			dynamicUuids = [selected.uuid];
			showToast('No Mass nodes wired — simulating the selected object with mass 1');
		} else {
			showToast('Wire a Mass node to an Object Selector (or select an object) to make something fall');
			return;
		}
	}

	world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.1, 500).setTranslation(0, -0.1, 0));
	// NOTE for later phases: static scenery would benefit from
	// ColliderDesc.trimesh (fixed bodies only) and terrain from a heightfield —
	// both deferred; every collider today is a cuboid AABB or an opt-in hull.
	bodies = [];
	beforeStates = [];
	suspendedForRun = [];
	fixedBodies = new Map();
	const box = new THREE.Box3();
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();

	group.children.forEach((/** @type {any} */ object) => {
		box.setFromObject(object);
		if (!isFinite(box.min.x)) return; // lights/empties
		box.getSize(size).multiplyScalar(0.5);
		size.set(Math.max(size.x, 0.02), Math.max(size.y, 0.02), Math.max(size.z, 0.02));
		box.getCenter(center);
		const p = params[object.uuid];
		const dynamic = !!p && p.mass != null && dynamicUuids.includes(object.uuid);
		// flow-animated objects (not dynamic) become KINEMATIC platforms: the
		// flow pose feeds the body each step so rapier derives their velocity
		const kinematic = !dynamic && isAnimatedTarget(object.uuid);
		// sleep OFF for dynamics: a kinematic platform moving UNDER a sleeping
		// body never wakes it (existing contact, unchanged normal) — the resting
		// box would ignore the spinning slab; broadcasts gate on movement instead
		const bodyDesc = (dynamic
			? RAPIER.RigidBodyDesc.dynamic().setCanSleep(false)
			: kinematic
				? RAPIER.RigidBodyDesc.kinematicPositionBased()
				: RAPIER.RigidBodyDesc.fixed()
		).setTranslation(center.x, center.y, center.z);
		const body = world.createRigidBody(bodyDesc);
		let colliderDesc = p?.collider === 'hull' ? hullDesc(object) : null;
		if (p?.collider === 'hull' && !colliderDesc)
			showToast('Convex hull unavailable for "' + (object.name || object.type) + '" — using a box');
		let usedHull = !!colliderDesc;
		colliderDesc ??= RAPIER.ColliderDesc.cuboid(size.x, size.y, size.z);
		if (p?.restitution != null) colliderDesc.setRestitution(p.restitution);
		if (p?.friction != null) colliderDesc.setFriction(p.friction);
		if (dynamic) colliderDesc.setMass(p.mass);
		world.createCollider(colliderDesc, body);
		// hull vertices are in the object's LOCAL frame -> the body carries the
		// object's own transform (offset zero); the AABB box path keeps the
		// classic center-offset bookkeeping
		const entry = {
			object,
			body,
			offset: usedHull ? new THREE.Vector3() : object.position.clone().sub(center),
			initialQuat: usedHull ? new THREE.Quaternion() : object.quaternion.clone(),
			mode: /** @type {'dynamic'|'kinematic'} */ (dynamic ? 'dynamic' : 'kinematic'),
			hull: usedHull,
			hold: /** @type {'user'|'external'|null} */ (null),
			holdUntil: 0,
			samples: /** @type {any[]} */ ([]),
			// the pose WE last wrote — a deviation means someone else (a peer's
			// move applier, undo, an AI edit) wrote the object mid-sim
			lastWritten: { pos: object.position.clone(), quat: object.quaternion.clone() }
		};
		if (usedHull) {
			body.setTranslation({ x: object.position.x, y: object.position.y, z: object.position.z }, true);
			body.setRotation(
				{ x: object.quaternion.x, y: object.quaternion.y, z: object.quaternion.z, w: object.quaternion.w },
				true
			);
		}
		if (dynamic) {
			beforeStates.push({ uuid: object.uuid, before: transformOf(object) });
			// dynamic wins over an animation: suspend the effect for the run
			if (isAnimatedTarget(object.uuid)) {
				suspendAnimation(object.uuid);
				suspendedForRun.push(object.uuid);
			}
			bodies.push(entry);
		} else if (kinematic) {
			bodies.push(entry);
		} else {
			fixedBodies.set(object.uuid, body); // a joint may pin something to it (P-B)
		}
	});

	// P-B: build rapier impulse joints from the replicated defs. Anchors are
	// OBJECT-local at attach time -> world -> BODY-local. Box bodies start with
	// IDENTITY rotation (initialQuat compensates), so body-local = world - center
	// and a world axis is valid in both bodies' frames; hull bodies carry the
	// object rotation, so their body frame IS the object frame (scale baked).
	liveJoints = new Map();
	const anchorWorld = new THREE.Vector3();
	const axisWorld = new THREE.Vector3();
	get(sceneJoints).forEach((def) => {
		const entryA = bodies.find((e) => e.object.uuid === def.a);
		const entryB = bodies.find((e) => e.object.uuid === def.b);
		// jointed scenery is possible: fall back to any body we created — bodies[]
		// only holds dynamic+kinematic, so look the object up for a fixed body too
		const bodyA = entryA?.body ?? fixedBodies.get(def.a);
		const bodyB = entryB?.body ?? fixedBodies.get(def.b);
		if (!bodyA || !bodyB) return;
		const objA = get(objectsGroup)?.getObjectByProperty('uuid', def.a);
		const objB = get(objectsGroup)?.getObjectByProperty('uuid', def.b);
		if (!objA || !objB) return;
		/** body-local point for one side @param {any} obj @param {any} entry @param {number[]} anchorLocal @param {any} body */
		const bodyLocal = (obj, entry, anchorLocal, body) => {
			obj.updateWorldMatrix(true, false);
			obj.localToWorld(anchorWorld.fromArray(anchorLocal));
			if (entry?.hull) {
				// hull body frame = object frame: rotate the world offset back
				const t = body.translation();
				return anchorWorld
					.sub(new THREE.Vector3(t.x, t.y, t.z))
					.applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()).invert())
					.toArray();
			}
			const t = body.translation();
			return [anchorWorld.x - t.x, anchorWorld.y - t.y, anchorWorld.z - t.z];
		};
		const a1 = bodyLocal(objA, entryA, def.anchorA, bodyA);
		const a2 = bodyLocal(objB, entryB, def.anchorB, bodyB);
		let data;
		if (def.kind === 'revolute') {
			axisWorld.fromArray(def.axisA ?? [0, 1, 0]).applyQuaternion(objA.quaternion).normalize();
			data = RAPIER.JointData.revolute(
				{ x: a1[0], y: a1[1], z: a1[2] },
				{ x: a2[0], y: a2[1], z: a2[2] },
				{ x: axisWorld.x, y: axisWorld.y, z: axisWorld.z }
			);
		} else {
			data = RAPIER.JointData.fixed(
				{ x: a1[0], y: a1[1], z: a1[2] },
				{ w: 1, x: 0, y: 0, z: 0 },
				{ x: a2[0], y: a2[1], z: a2[2] },
				{ w: 1, x: 0, y: 0, z: 0 }
			);
		}
		const joint = world.createImpulseJoint(data, bodyA, bodyB, true);
		if (def.kind === 'revolute' && def.motor)
			joint.configureMotorVelocity(def.motor.vel ?? 0, def.motor.maxForce ?? 100);
		liveJoints.set(def.id, joint);
	});

	simulating.set(true);
	simPaused.set(false);
	if (peer) peer.send({ type: 'simulate', running: true, peerId: peer.peer.id });
	lastStep = performance.now();
	accumulator = 0;
	setPostTick(step); // steps at the end of every flowRuntime tick
}

const bodyQuat = new THREE.Quaternion();
const rotatedOffset = new THREE.Vector3();
const targetQuat = new THREE.Quaternion();
const invInitial = new THREE.Quaternion();
const targetPos = new THREE.Vector3();

/** The body pose that matches the object's CURRENT transform (inverse of the
 * dynamic write-back math). @param {any} entry */
function kinematicTargetOf(entry) {
	const { object, offset, initialQuat } = entry;
	invInitial.copy(initialQuat).invert();
	targetQuat.copy(object.quaternion).multiply(invInitial);
	rotatedOffset.copy(offset).applyQuaternion(targetQuat);
	targetPos.copy(object.position).sub(rotatedOffset);
	return { pos: targetPos.clone(), quat: targetQuat.clone() };
}

/** Ring buffer of recent held poses -> a release-velocity estimate. @param {any} entry @param {number} now */
function recordHoldSample(entry, now) {
	entry.samples.push({
		t: now,
		pos: entry.object.position.clone(),
		rot: entry.object.rotation.clone()
	});
	if (entry.samples.length > 4) entry.samples.shift();
}

/** Flip a held body back to dynamic, imparting the estimated velocity (throw).
 * @param {any} entry */
function releaseHold(entry) {
	entry.hold = null;
	entry.holdUntil = 0;
	entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
	const s = entry.samples;
	if (s.length >= 2) {
		const a = s[0];
		const b = s[s.length - 1];
		const dt = Math.max((b.t - a.t) / 1000, 1e-3);
		const clamp = (/** @type {number} */ v, /** @type {number} */ m) => Math.max(-m, Math.min(m, v));
		entry.body.setLinvel(
			{
				x: clamp((b.pos.x - a.pos.x) / dt, MAX_LINVEL),
				y: clamp((b.pos.y - a.pos.y) / dt, MAX_LINVEL),
				z: clamp((b.pos.z - a.pos.z) / dt, MAX_LINVEL)
			},
			true
		);
		entry.body.setAngvel(
			{
				x: clamp((b.rot.x - a.rot.x) / dt, MAX_ANGVEL),
				y: clamp((b.rot.y - a.rot.y) / dt, MAX_ANGVEL),
				z: clamp((b.rot.z - a.rot.z) / dt, MAX_ANGVEL)
			},
			true
		);
	}
	entry.samples = [];
}

/**
 * The initiator grabbed a dynamic body (gizmo/multi-pivot drag): it follows the
 * pointer as a kinematic until release. @param {string} uuid
 */
export function holdBody(uuid) {
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic');
	if (!entry || !world) return false;
	entry.hold = 'user';
	entry.samples = [];
	entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
	return true;
}

/** Drag ended: back to dynamic + throw velocity. @param {string} uuid */
export function releaseBody(uuid) {
	const entry = bodies.find((e) => e.object.uuid === uuid && e.hold === 'user');
	if (!entry || !world) return false;
	releaseHold(entry);
	return true;
}

/**
 * An incoming peer `move` landed on a body mid-sim (peerHandler calls this after
 * moveGeometry applied the transform). A dynamic body becomes an EXTERNAL
 * kinematic hold that follows the move stream; 250ms of silence releases it
 * with a (coarse, ~10Hz-sampled) velocity estimate. Returns true if consumed.
 * @param {string} uuid
 */
export function physicsExternalMove(uuid) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic');
	if (!entry || entry.hold === 'user') return false;
	if (entry.hold !== 'external') {
		entry.hold = 'external';
		entry.samples = [];
		entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
	}
	entry.holdUntil = performance.now() + EXTERNAL_HOLD_MS;
	return true;
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

/** @param {number} now */
function step(now) {
	if (!world) return;
	if (get(simPaused)) {
		lastStep = now; // don't accumulate a giant timestep across the pause
		accumulator = 0;
		return;
	}
	// fixed-timestep accumulator: sim time tracks REAL time even when rAF is
	// throttled (background/headless tabs) — the old per-frame 1/30 clamp made
	// the sim run in slow motion below 30fps. Backlog is capped (spiral guard).
	accumulator += Math.min((now - lastStep) / 1000, 0.25);
	lastStep = now;
	const substeps = Math.min(Math.floor(accumulator / FIXED_DT), MAX_SUBSTEPS);
	if (substeps === 0) return; // sub-frame remainder — step next frame
	accumulator -= substeps * FIXED_DT;
	if (accumulator > FIXED_DT) accumulator = 0; // drop the capped backlog

	// EXTERNAL-write detection: a dynamic body's object transform is physics-
	// owned between our write-backs — if it deviated, another writer (a peer's
	// move stream, undo, an AI edit) moved it. Engage/refresh a kinematic hold;
	// 250ms without further writes releases it. Detecting by DEVIATION keeps the
	// mechanism self-contained (the dev server can split module instances, so a
	// hook called from peerHandler can land on a different physics instance).
	bodies.forEach((entry) => {
		if (entry.mode !== 'dynamic' || entry.hold === 'user') return;
		const written = entry.lastWritten;
		// component-wise compare — NOT quaternion dot: dot(q,q) = |q|^2, and
		// rapier's f32 components leave the norm ~1e-9 off unit, which reads as
		// a phantom deviation and pins resting bodies in a permanent hold
		const q = entry.object.quaternion;
		const deviated =
			written.pos.distanceToSquared(entry.object.position) > 1e-10 ||
			Math.abs(written.quat.x - q.x) +
				Math.abs(written.quat.y - q.y) +
				Math.abs(written.quat.z - q.z) +
				Math.abs(written.quat.w - q.w) >
				1e-6;
		if (!deviated) return;
		if (entry.hold !== 'external') {
			entry.hold = 'external';
			entry.samples = [];
			entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
		}
		entry.holdUntil = now + EXTERNAL_HOLD_MS;
		written.pos.copy(entry.object.position);
		written.quat.copy(entry.object.quaternion);
	});

	// kinematic targets are INTERPOLATED across the substeps: feeding the final
	// pose only once would give the body its full velocity on substep 1 and ZERO
	// on the rest — friction would alternately drag and brake a resting box and
	// a spinning platform would net no fling. Slerp keeps the velocity continuous.
	/** @type {{entry: BodyEntry, startPos: THREE.Vector3, startQuat: THREE.Quaternion, end: {pos: THREE.Vector3, quat: THREE.Quaternion}}[]} */
	const feeds = [];
	bodies.forEach((entry) => {
		if (entry.mode === 'kinematic' || entry.hold) {
			const t = entry.body.translation();
			const r = entry.body.rotation();
			feeds.push({
				entry,
				startPos: new THREE.Vector3(t.x, t.y, t.z),
				startQuat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
				end: kinematicTargetOf(entry)
			});
			if (entry.hold) {
				recordHoldSample(entry, now);
				if (entry.hold === 'external' && now > entry.holdUntil) releaseHold(entry);
			}
		}
	});

	world.timestep = FIXED_DT;
	const stepPos = new THREE.Vector3();
	const stepQuat = new THREE.Quaternion();
	for (let k = 1; k <= substeps; k++) {
		const f = k / substeps;
		for (const feed of feeds) {
			if (feed.entry.hold === null && feed.entry.mode !== 'kinematic') continue; // released mid-frame
			stepPos.copy(feed.startPos).lerp(feed.end.pos, f);
			stepQuat.copy(feed.startQuat).slerp(feed.end.quat, f);
			feed.entry.body.setNextKinematicTranslation({ x: stepPos.x, y: stepPos.y, z: stepPos.z });
			feed.entry.body.setNextKinematicRotation({ x: stepQuat.x, y: stepQuat.y, z: stepQuat.z, w: stepQuat.w });
		}
		world.step();
	}

	/** @type {any} */
	const peer = get(peers);
	const broadcast = now - lastBroadcast > 100;
	if (broadcast) lastBroadcast = now;

	bodies.forEach((entry) => {
		const { object, body, offset, initialQuat, mode, hold } = entry;
		// kinematic platforms + held bodies: flow/gizmo own the object transform
		if (mode === 'kinematic' || hold) return;
		const t = body.translation();
		const r = body.rotation();
		bodyQuat.set(r.x, r.y, r.z, r.w);
		rotatedOffset.copy(offset).applyQuaternion(bodyQuat);
		object.position.set(t.x + rotatedOffset.x, t.y + rotatedOffset.y, t.z + rotatedOffset.z);
		object.quaternion.copy(bodyQuat).multiply(initialQuat);
		entry.lastWritten.pos.copy(object.position);
		entry.lastWritten.quat.copy(object.quaternion);
		if (broadcast && peer) {
			// sleep is disabled (kinematic-wake), so gate broadcasts on MOVEMENT:
			// settled bodies stop producing traffic
			const moved =
				!entry.lastSent ||
				entry.lastSent.pos.distanceToSquared(object.position) > 1e-8 ||
				Math.abs(entry.lastSent.quat.dot(object.quaternion)) < 1 - 1e-8;
			if (moved) {
				entry.lastSent ??= { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
				entry.lastSent.pos.copy(object.position);
				entry.lastSent.quat.copy(object.quaternion);
				peer.send({
					type: 'move',
					uuid: object.uuid,
					pos: object.position.toArray(),
					rot: [object.rotation.x, object.rotation.y, object.rotation.z],
					scale: object.scale.toArray()
				});
			}
		}
	});
	objectsGroup.update((value) => value);
}

/** Pause/resume the stepping (world + suspensions stay alive). Peers simply see
 * motion stop; the pause flag rides the existing simulate message. @param {boolean=} paused */
export function pauseSimulation(paused) {
	if (!get(simulating)) return;
	const next = paused ?? !get(simPaused);
	simPaused.set(next);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'simulate', running: true, paused: next, peerId: peer.peer.id });
}

/** @param {{reset?: boolean}=} opts reset restores the initial layout (no undo entry) */
export function stopSimulation(opts = {}) {
	if (!get(simulating)) return;
	setPostTick(null); // clear the hook BEFORE freeing the world
	/** @type {any} */
	const peer = get(peers);
	const group = get(objectsGroup);

	/** @type {{uuid: string, before: any, after: any}[]} */
	const items = [];
	beforeStates.forEach(({ uuid, before }) => {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return;
		if (opts.reset) {
			// reset = put everything back where it started; a net no-op for history
			object.position.fromArray(before.pos);
			object.rotation.set(before.rot[0], before.rot[1], before.rot[2]);
			object.scale.fromArray(before.scale);
		}
		const after = transformOf(object);
		if (!opts.reset && JSON.stringify(before) !== JSON.stringify(after))
			items.push({ uuid, before, after });
		notifyExternalMove(uuid);
		if (peer)
			peer.send({ type: 'move', uuid: uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	});
	if (items.length > 0) recordTransformSet(items);

	// resume the effects we suspended for dynamic+animated objects: the settled
	// (or reset) pose becomes the new animation base
	suspendedForRun.forEach((uuid) => resumeAnimation(uuid));
	suspendedForRun = [];

	world?.free?.();
	world = null;
	bodies = [];
	beforeStates = [];
	liveJoints = new Map();
	fixedBodies = new Map();
	simulating.set(false);
	simPaused.set(false);
	if (peer) peer.send({ type: 'simulate', running: false, peerId: peer.peer.id });
	if (items.length > 0) showToast('Simulation stopped — Ctrl+Z restores the initial layout');
	objectsGroup.update((value) => value);
}

/** Reset: restore the initial layout and stop (no history entry — net no-op). */
export function resetSimulation() {
	stopSimulation({ reset: true });
}

/** Whether THIS peer is the one stepping the world (initiator-authority). */
export function isInitiator() {
	return get(simulating);
}

/** Drive a revolute joint's motor mid-sim (P-B) — initiator-only (only the
 * stepping peer holds live joints; forward inputs to it, pong-paddle pattern).
 * @param {string} jointId @param {number} vel rad/s @param {number=} maxForce */
export function setJointMotor(jointId, vel, maxForce = 100) {
	if (!world || !get(simulating)) return false;
	const joint = liveJoints.get(jointId);
	if (!joint?.configureMotorVelocity) return false;
	joint.configureMotorVelocity(vel, maxForce);
	return true;
}

/** Push a dynamic body (module SDK) — initiator-only, mid-sim.
 * @param {string} uuid @param {number[]} impulse [x,y,z] */
export function applyImpulse(uuid, impulse) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic' && !e.hold);
	if (!entry) return false;
	entry.body.applyImpulse({ x: impulse[0] ?? 0, y: impulse[1] ?? 0, z: impulse[2] ?? 0 }, true);
	return true;
}

/** @param {any} data */
export function applySimulate(data) {
	remoteSimulating.set(data.running ? data.peerId : null);
	if (data.running && !data.paused) showToast('▶ ' + nameOf(data.peerId) + ' is simulating physics');
}

/** @param {string} peerId */
export function physicsPeerDisconnected(peerId) {
	if (get(remoteSimulating) === peerId) remoteSimulating.set(null);
}

/** test/debug view of the live bodies */
export function physicsDebug() {
	return bodies.map((entry) => ({
		uuid: entry.object.uuid,
		mode: entry.mode,
		hull: !!entry.hull,
		hold: entry.hold,
		bodyType: entry.body?.bodyType?.(),
		sleeping: entry.body?.isSleeping?.() ?? null,
		linvel: entry.body?.linvel?.() ?? null,
		angvel: entry.body?.angvel?.() ?? null,
		bodyRot: entry.body?.rotation?.() ?? null
	}));
}
