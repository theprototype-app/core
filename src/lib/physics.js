import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { flowGraphs, allNodes, allEdges, SCENE_GRAPH } from '../stores/flowStore';
import { objectsGroup, lockedObjects, selectedObject, selectedObjects } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordTransformSet, recordEntry } from './history';
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
/** @type {(() => void)[]} C2: live node-param subscriptions active during a sim */
let liveUnsubs = [];
let liveSnapshot = '';

const PHYSICS_TYPES = ['mass', 'bounciness', 'friction', 'angularvelocity', 'motor'];
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
	// H1: physics nodes live in ANY graph (scene or per-object documents)
	const nodes = allNodes();
	const edges = allEdges();
	/** apply one physics node's params onto an object's entry @param {any} source @param {string} uuid */
	const applyPhysicsNode = (source, uuid) => {
		map[uuid] ??= {};
		map[uuid].flow = true; // provenance for the Inspector physics list (C1)
		// flow wiring wins over userData (incl. re-dynamicizing a 'static' object)
		if (source.type === 'mass') {
			map[uuid].mass = source.data?.kg ?? 1;
			delete map[uuid].forceStatic;
		}
		if (source.type === 'bounciness') map[uuid].restitution = source.data?.value ?? 0.3;
		if (source.type === 'friction') map[uuid].friction = source.data?.value ?? 0.5;
		// C2: constant spin — implies dynamic (mass 1) so wiring it ALONE works;
		// an explicit Mass node still wins (processed independently, ??=)
		if (source.type === 'angularvelocity') {
			map[uuid].angvel = { axis: source.data?.axis ?? 'y', speed: source.data?.speed ?? 2 };
			if (!map[uuid].forceStatic) map[uuid].mass ??= 1;
		}
		// C2: drives every revolute joint touching the selected object (the car
		// recipe: select the body -> all wheel motors). Joints stay def-owned.
		if (source.type === 'motor')
			map[uuid].motor = { vel: source.data?.vel ?? 3, maxForce: source.data?.maxForce ?? 100 };
	};
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source || !PHYSICS_TYPES.includes(source.type)) return;
		const target = nodes.find((n) => n.id === edge.target);
		if (target?.type !== 'objectselector') return;
		const uuid = target.data?.selected;
		if (!uuid || uuid === '-None-') return;
		applyPhysicsNode(source, uuid);
	});
	// H1: a physics node inside an OBJECT graph with no explicit selector wiring
	// applies to the graph's owner object (matches the runtime's implicit rule)
	nodes.forEach((source) => {
		if (!PHYSICS_TYPES.includes(source.type)) return;
		const graph = source.__graph;
		if (!graph || graph === SCENE_GRAPH) return;
		const wired = edges.some(
			(e) => e.source === source.id && nodes.find((n) => n.id === e.target)?.type === 'objectselector'
		);
		if (!wired) applyPhysicsNode(source, graph);
	});
	return map;
}

/** LOCAL axis letter -> WORLD angvel vector for setAngvel (bodies report/step in
 * world space; box bodies start with identity rotation, so the object's world
 * quaternion is the right frame either way). @param {any} object @param {{axis: string, speed: number}} angvel */
function angvelWorld(object, angvel) {
	const v = new THREE.Vector3(
		angvel.axis === 'x' ? 1 : 0,
		angvel.axis === 'y' ? 1 : 0,
		angvel.axis === 'z' ? 1 : 0
	);
	v.applyQuaternion(object.quaternion).multiplyScalar(angvel.speed ?? 0);
	return { x: v.x, y: v.y, z: v.z };
}

/** Apply a motor param to every live revolute joint touching the object (C2).
 * @param {string} uuid @param {{vel: number, maxForce: number}} motor */
function applyMotorParam(uuid, motor) {
	get(sceneJoints).forEach((def) => {
		if (def.kind !== 'revolute' || (def.a !== uuid && def.b !== uuid)) return;
		const joint = liveJoints.get(def.id);
		joint?.configureMotorVelocity?.(motor.vel ?? 0, motor.maxForce ?? 100);
	});
}

/** The graph's angvel/motor params only, as a change-detection key (C2). */
function liveParamsJson() {
	const group = get(objectsGroup);
	if (!group) return '';
	const params = collectParams(group);
	/** @type {Record<string, any>} */
	const out = {};
	Object.keys(params).forEach((uuid) => {
		if (params[uuid].angvel || params[uuid].motor)
			out[uuid] = { angvel: params[uuid].angvel, motor: params[uuid].motor };
	});
	return JSON.stringify(out);
}

/** Re-apply angvel/motor from the current graph to the live world (C2). */
function applyLiveParams() {
	const group = get(objectsGroup);
	if (!world || !group) return;
	const live = collectParams(group);
	bodies.forEach((entry) => {
		const p = live[entry.object.uuid];
		if (entry.mode === 'dynamic' && !entry.hold && p?.angvel)
			entry.body.setAngvel(angvelWorld(entry.object, p.angvel), true);
	});
	Object.keys(live).forEach((uuid) => {
		if (live[uuid].motor) applyMotorParam(uuid, live[uuid].motor);
	});
}

/**
 * C1 discoverability: every object that would get physics params at sim start,
 * as display rows for the Inspector scene-mode "Physics" section. Pure read —
 * recomputed by the UI from objectsGroup/flowNodes/flowEdges changes.
 * @returns {{uuid: string, name: string, mode: 'dynamic'|'static'|'props', mass: number|null, flow: boolean}[]}
 */
export function listPhysicsObjects() {
	const group = get(objectsGroup);
	if (!group) return [];
	const params = collectParams(group);
	return group.children
		.filter((/** @type {any} */ o) => params[o.uuid])
		.map((/** @type {any} */ o) => {
			const p = params[o.uuid];
			return {
				uuid: o.uuid,
				name: o.name || o.type,
				mode: /** @type {'dynamic'|'static'|'props'} */ (
					p.forceStatic ? 'static' : p.mass != null ? 'dynamic' : 'props'
				),
				mass: p.mass ?? null,
				flow: !!p.flow
			};
		});
}

/**
 * C1 quick action: make the current selection dynamic (userData.physics mode
 * 'dynamic', mass 1 unless already set) — replicates via the existing
 * objectParameters message and records a props undo entry per object.
 * @returns {number} objects updated
 */
export function enablePhysicsOnSelection() {
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	const multi = get(selectedObjects);
	const primary = /** @type {any} */ (get(selectedObject));
	const uuids = multi?.length ? multi : primary?.uuid ? [primary.uuid] : [];
	let count = 0;
	uuids.forEach((/** @type {string} */ uuid) => {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return;
		const before = object.userData.physics ? { ...object.userData.physics } : null;
		const next = { ...(object.userData.physics ?? {}), mode: 'dynamic', mass: object.userData.physics?.mass ?? 1 };
		object.userData.physics = next;
		recordEntry({ kind: 'props', uuid, before: { physics: before }, after: { physics: next } });
		peer?.send({ type: 'objectParameters', parameter: 'physics', uuid, physics: next });
		count++;
	});
	if (count === 0) {
		showToast('Select an object first — then Enable physics makes it fall and collide');
		return 0;
	}
	objectsGroup.update((v) => v);
	selectedObject.update((v) => v);
	showToast(count === 1 ? 'Physics enabled — dynamic, mass 1' : 'Physics enabled on ' + count + ' objects — dynamic, mass 1');
	return count;
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

/** Convex-hull collider desc for a single-Mesh object (scale AND rotation
 * BAKED into the vertices — rapier colliders don't scale, and baking the
 * rotation lets hull bodies start from an IDENTITY rotation like the box
 * bodies do, so one world-space joint axis is valid in every body's local
 * frame. C3 root-cause: hull bodies used to CARRY the object rotation, which
 * gave the car's z-rotated wheel hulls a 90-degree-wrong hinge axis — the
 * solver fought itself and launched the assembly). Returns null when
 * ineligible (Groups, huge meshes) so the caller falls back to the box.
 * @param {any} object */
function hullDesc(object) {
	if (!object.isMesh || !object.geometry?.attributes?.position) return null;
	const position = object.geometry.attributes.position;
	if (position.count > HULL_MAX_VERTS) return null;
	const scaled = new Float32Array(position.count * 3);
	const s = object.scale;
	const v = new THREE.Vector3();
	for (let i = 0; i < position.count; i++) {
		v.set(position.getX(i) * s.x, position.getY(i) * s.y, position.getZ(i) * s.z);
		v.applyQuaternion(object.quaternion);
		scaled[i * 3] = v.x;
		scaled[i * 3 + 1] = v.y;
		scaled[i * 3 + 2] = v.z;
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
			showToast(
				'No objects have physics yet — simulating the selected object with mass 1. Make it permanent in Inspector ▸ Physics.'
			);
		} else {
			showToast(
				'Nothing to simulate — enable physics on an object first (select it → Inspector ▸ Physics, or wire a Mass node)'
			);
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
		// hull vertices are baked in the object's WORLD orientation around its
		// origin -> the body carries only the translation and starts at IDENTITY
		// rotation (like the box path, initialQuat compensates); the AABB box
		// path keeps the classic center-offset bookkeeping
		const entry = {
			object,
			body,
			offset: usedHull ? new THREE.Vector3() : object.position.clone().sub(center),
			initialQuat: object.quaternion.clone(),
			mode: /** @type {'dynamic'|'kinematic'} */ (dynamic ? 'dynamic' : 'kinematic'),
			hull: usedHull,
			hold: /** @type {'user'|'external'|null} */ (null),
			holdUntil: 0,
			samples: /** @type {any[]} */ ([]),
			// the pose WE last wrote — a deviation means someone else (a peer's
			// move applier, undo, an AI edit) wrote the object mid-sim
			lastWritten: { pos: object.position.clone(), quat: object.quaternion.clone() }
		};
		if (usedHull)
			body.setTranslation({ x: object.position.x, y: object.position.y, z: object.position.z }, true);
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
	// OBJECT-local at attach time -> world -> BODY-local. EVERY body (box and
	// hull alike, C3) starts with IDENTITY rotation (initialQuat compensates),
	// so body-local = world - translation and ONE world-space axis is valid in
	// both bodies' local frames — which rapier's revolute() requires.
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
		/** body-local point for one side (all bodies start world-aligned, C3)
		 * @param {any} obj @param {number[]} anchorLocal @param {any} body */
		const bodyLocal = (obj, anchorLocal, body) => {
			obj.updateWorldMatrix(true, false);
			obj.localToWorld(anchorWorld.fromArray(anchorLocal));
			const t = body.translation();
			return [anchorWorld.x - t.x, anchorWorld.y - t.y, anchorWorld.z - t.z];
		};
		const a1 = bodyLocal(objA, def.anchorA, bodyA);
		const a2 = bodyLocal(objB, def.anchorB, bodyB);
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

	// C2: initial angular velocities + graph-driven motors (needs liveJoints).
	// Node params win over a joint def's own motor — applied last.
	applyLiveParams();

	// C2: LIVE re-apply — editing an Angular Velocity / Motor node mid-sim
	// (local slider drag or a peer's replicated nodechange) re-applies on the
	// stepping peer. Change-detected on the physics params only, so node drags
	// (position updates also fire flowNodes) never touch the world.
	liveSnapshot = liveParamsJson();
	const onGraphChange = () => {
		if (!world) return;
		const snap = liveParamsJson();
		if (snap === liveSnapshot) return;
		liveSnapshot = snap;
		applyLiveParams();
	};
	liveUnsubs = [flowGraphs.subscribe(onGraphChange)]; // H1: sees every graph

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
	liveUnsubs.forEach((unsub) => unsub());
	liveUnsubs = [];
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

/** Spin a dynamic body (module SDK, C2) — initiator-only, mid-sim.
 * @param {string} uuid @param {number[]} torque world-space [x,y,z] */
export function applyTorqueImpulse(uuid, torque) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic' && !e.hold);
	if (!entry) return false;
	entry.body.applyTorqueImpulse({ x: torque[0] ?? 0, y: torque[1] ?? 0, z: torque[2] ?? 0 }, true);
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
