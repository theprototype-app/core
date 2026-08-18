import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { flowGraphs, allNodes, allEdges, SCENE_GRAPH } from '../stores/flowStore';
import { objectsGroup, lockedObjects, selectedObject, selectedObjects } from '../stores/sceneStore';
import { peers, showToast, openSceneSection } from '../stores/appStore';
import { recordTransformSet, recordEntry } from './history';
import {
	notifyExternalMove,
	setPostTick,
	isAnimatedTarget,
	suspendAnimation,
	resumeAnimation,
	fireObjectImpact,
	fireObjectEnter,
	fireObjectExit,
	fireObjectRest,
	noteObjectPose
} from './flowRuntime';
import { colliderSpecOf } from './colliderSpec';
import {
	sceneGravity,
	scenePhysicsGround,
	scenePhysicsBounds,
	scenePhysicsDefaults
} from './scenePhysics';
import { velocityFromSamples, clampThrow, MAX_LINVEL, MAX_ANGVEL } from './throwVelocity';
import { burstObjectParticles } from './particleActions';
import { hasImpactEmitter } from './particleRuntime';
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
 *   holdPeer?: string | null,
 *   samples: {t: number, pos: THREE.Vector3, quat: THREE.Quaternion}[],
 *   lastWritten: {pos: THREE.Vector3, quat: THREE.Quaternion},
 *   lastSent?: {pos: THREE.Vector3, quat: THREE.Quaternion},
 *   colliders: any[], shapeKey: string,
 *   oob?: boolean, restSince?: number | null,
 *   preVy?: number}} BodyEntry */
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
// PFX-C: collision events. Rapier only reports contacts when an EventQueue is
// passed to world.step AND a collider in the pair carries ActiveEvents flags —
// neither existed before this phase. Impacts are INITIATOR-detected (only the
// stepping peer has a world) and replicate through the existing shared-stamp
// paths: applyNodeTrigger for On Impact nodes, particleburst for emitters.
/** @type {any} */ let eventQueue = null;
/** @type {Map<number, {uuid: string, entry: BodyEntry | null, sensor: boolean}>} collider handle -> owner */
let colliderOwner = new Map();
let groundHandle = -1;
/** B4: the live ground collider, so a config change can swap it mid-sim */
/** @type {any} */ let groundCollider = null;
/** B4: a store subscription fires on subscribe; the world was just built with
 * that same value, so the first emission is skipped rather than re-applied */
let groundSubPrimed = false;
let defaultsSubPrimed = false;
/** B4: out-of-bounds bodies handled this run, coalesced into ONE toast */
let oobCount = 0;
/** @type {any} */ let oobTimer = null;
/** @type {string} */ let oobAction = 'respawn';
/** @type {Map<string, number>} uuid -> last impact stamp (step-now ms) */
let lastImpactAt = new Map();
/** @type {{uuid: string, strength: number}[]} contacts collected inside the substep loop */
let pendingImpacts = [];
/** CL-A: colliders attached to FIXED scenery bodies (rebuild bookkeeping —
 * BodyEntry only exists for dynamic/kinematic). @type {Map<string, any[]>} */
let fixedColliders = new Map();
/** @type {Map<string, string>} uuid -> shapeKey for fixed bodies (live rebuild) */
let fixedShapeKeys = new Map();
/** CL-A A3: sensor enter/exit edges collected inside the substep loop
 * @type {{uuid: string, otherUuid: string, entered: boolean}[]} */
let pendingEnterExit = [];
/** per-frame dedupe of repeated sensor events @type {Set<string>} */
let sensorEventSeen = new Set();
/** @type {(() => void)[]} C2: live node-param subscriptions active during a sim */
let liveUnsubs = [];
let liveSnapshot = '';

const PHYSICS_TYPES = ['mass', 'bounciness', 'friction', 'angularvelocity', 'motor', 'collider'];

// CL-A A4: physics material presets — picking one in the Inspector writes BOTH
// friction and restitution via setPhysics (sliders stay editable; the select
// shows Custom when the values match no preset).
export const PHYSICS_MATERIALS = {
	ice: { friction: 0.02, restitution: 0.05 },
	rubber: { friction: 0.9, restitution: 0.85 },
	wood: { friction: 0.55, restitution: 0.25 },
	metal: { friction: 0.3, restitution: 0.1 }
};
// B2: MAX_LINVEL / MAX_ANGVEL and the estimator itself live in throwVelocity.js
// now — the same numbers have to bound a peer's throw on the receive side, and
// two copies of a clamp is how they drift apart
const EXTERNAL_HOLD_MS = 250; // peer-move silence before a held body drops
const IMPACT_COOLDOWN_MS = 300; // per-body: a roll/settle can't machine-gun impacts
const IMPACT_MIN_DOWN_VY = 1.2; // m/s downward (pre-step) for a contact to count

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
		if (p.sensor) map[object.uuid].sensor = true; // CL-A A3: trigger volume
		if (p.freeze) map[object.uuid].freeze = p.freeze; // CL-A A5: axis locks
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
			map[uuid].motor = {
				vel: source.data?.vel ?? 3,
				maxForce: source.data?.maxForce ?? 100,
				side: source.data?.side ?? 'all' // B6
			};
		// CL-C C1: collider node — shape/sensor/scale WIN over the Inspector
		// pick (flow-overrides-Inspector, the mass precedent); shape 'object'
		// hulls the object wired into the node's `source` handle
		if (source.type === 'collider') {
			map[uuid].collider = source.data?.shape ?? 'box';
			if (source.data?.scale != null) map[uuid].colliderScale = source.data.scale;
			if (source.data?.sensor) map[uuid].sensor = true;
			const sourceEdge = edges.find((e) => e.target === source.id && e.targetHandle === 'source');
			const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : null;
			const sourceUuid = sourceNode?.type === 'objectselector' ? sourceNode.data?.selected : null;
			if (sourceUuid && sourceUuid !== '-None-') map[uuid].colliderSource = sourceUuid;
		}
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

/**
 * Collider shape from the Inspector's collider pick + the object's LOCAL half
 * extents (PFX-C follow-up: sphere/capsule/cylinder join box + hull; 15-A3
 * adds cone). Capsule, cylinder and cone stand along the object's local Y;
 * sphere takes the largest extent so nothing pokes through.
 * @param {string|undefined} kind @param {THREE.Vector3} he half extents
 */
function shapeDesc(kind, he) {
	if (kind === 'sphere') return RAPIER.ColliderDesc.ball(Math.max(he.x, he.y, he.z));
	if (kind === 'capsule') {
		const radius = Math.max(he.x, he.z, 0.02);
		return RAPIER.ColliderDesc.capsule(Math.max(he.y - radius, 0.01), radius);
	}
	if (kind === 'cylinder') return RAPIER.ColliderDesc.cylinder(he.y, Math.max(he.x, he.z, 0.02));
	if (kind === 'cone') return RAPIER.ColliderDesc.cone(he.y, Math.max(he.x, he.z, 0.02));
	return RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z);
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

/**
 * Apply a motor param to the live revolute joints touching the object (C2).
 *
 * B6: `side` narrows it. Until now ONE motor node drove EVERY revolute joint on
 * an object with the same velocity, so differential steering — the thing a
 * driving game is made of — could not be expressed at all. The side is read off
 * the joint's own OBJECT-local anchor, which is how the car module already
 * distinguishes its wheels.
 * @param {string} uuid @param {{vel: number, maxForce: number, side?: string}} motor
 */
function applyMotorParam(uuid, motor) {
	const side = motor.side ?? 'all';
	get(sceneJoints).forEach((def) => {
		if (def.kind !== 'revolute' || (def.a !== uuid && def.b !== uuid)) return;
		if (side !== 'all') {
			// the anchor on the side that is NOT this object is the wheel's offset
			const anchor = def.a === uuid ? def.anchorA : def.anchorB;
			const axis = side[1] === 'x' ? 0 : 2;
			const wanted = side[0] === '-' ? -1 : 1;
			const value = anchor?.[axis] ?? 0;
			if (Math.sign(value) !== wanted || value === 0) return;
		}
		const joint = liveJoints.get(def.id);
		joint?.configureMotorVelocity?.(motor.vel ?? 0, motor.maxForce ?? 100);
	});
}

/** The graph's LIVE-appliable params (angvel/motor + everything that forces a
 * collider rebuild — CL-A A2 widened this beyond angvel/motor). */
function liveParamsJson() {
	const group = get(objectsGroup);
	if (!group) return '';
	const params = collectParams(group);
	/** @type {Record<string, any>} */
	const out = {};
	Object.keys(params).forEach((uuid) => {
		const p = params[uuid];
		if (p.angvel || p.motor || p.collider || p.sensor || p.freeze || p.restitution != null || p.friction != null || p.mass != null)
			out[uuid] = {
				angvel: p.angvel,
				motor: p.motor,
				shape: shapeKeyOf(p, group.getObjectByProperty('uuid', uuid))
			};
	});
	return JSON.stringify(out);
}

/** Re-apply live params to the running world (C2 angvel/motor; CL-A A2:
 * collider/sensor/freeze/material changes REBUILD the affected colliders
 * in place — no sim restart). */
function applyLiveParams() {
	const group = get(objectsGroup);
	if (!world || !group) return;
	const live = collectParams(group);
	bodies.forEach((entry) => {
		const p = live[entry.object.uuid];
		if (entry.mode === 'dynamic' && !entry.hold && p?.angvel)
			entry.body.setAngvel(angvelWorld(entry.object, p.angvel), true);
		// shape/material/sensor/freeze drift vs what the colliders were built
		// with -> rebuild this body's collider set live
		if (entry.shapeKey && entry.shapeKey !== shapeKeyOf(p ?? {}, entry.object))
			rebuildColliders(entry, p ?? {});
	});
	fixedShapeKeys.forEach((key, uuid) => {
		const next = shapeKeyOf(live[uuid] ?? {}, group.getObjectByProperty('uuid', uuid));
		if (key !== next) rebuildFixedColliders(uuid, live[uuid] ?? {});
	});
	Object.keys(live).forEach((uuid) => {
		if (live[uuid].motor) applyMotorParam(uuid, live[uuid].motor);
	});
}

/**
 * CL-A A2: live collider rebuild for a tracked (dynamic/kinematic) body —
 * removes the old collider set and rebuilds from the CURRENT object state,
 * keeping the body pose/velocity (and any joints) untouched.
 * @param {BodyEntry} entry @param {any} p collectParams entry
 */
function rebuildColliders(entry, p) {
	if (!world) return;
	entry.colliders.forEach((c) => {
		colliderOwner.delete(c.handle);
		world.removeCollider(c, true);
	});
	entry.colliders = [];
	createCollidersFor(entry.object, entry.body, p ?? {}, entry.mode === 'dynamic', entry);
	if (entry.mode === 'dynamic') applyFreeze(entry.body, p?.freeze); // set OR clear
	// the write-back bookkeeping changed shape: refresh the deviation baseline
	entry.lastWritten.pos.copy(entry.object.position);
	entry.lastWritten.quat.copy(entry.object.quaternion);
}

/** CL-A A2: live collider rebuild for FIXED scenery (sensor toggles on a
 * static trigger volume are the common case). @param {string} uuid @param {any} p */
function rebuildFixedColliders(uuid, p) {
	if (!world) return;
	const body = fixedBodies.get(uuid);
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!body || !object) return;
	(fixedColliders.get(uuid) ?? []).forEach((c) => {
		colliderOwner.delete(c.handle);
		world.removeCollider(c, true);
	});
	const built = createCollidersFor(object, body, p ?? {}, false, null);
	fixedColliders.set(uuid, built?.colliders ?? []);
	fixedShapeKeys.set(uuid, shapeKeyOf(p, object));
}

/**
 * CL-A A2: an Inspector setPhysics / remote objectParameters 'physics' write
 * changed an object's collider-relevant params — rebuild live if a sim runs.
 * (userData.physics has no flowGraphs subscription, so callers poke this
 * directly; no-op unless simulating with a live body.) @param {string} uuid
 */
export function physicsShapeChanged(uuid) {
	if (!world || !get(simulating)) return false;
	const group = get(objectsGroup);
	if (!group) return false;
	const p = collectParams(group)[uuid] ?? {};
	const entry = bodies.find((e) => e.object.uuid === uuid);
	if (entry) {
		if (entry.shapeKey === shapeKeyOf(p, entry.object)) return false;
		rebuildColliders(entry, p);
		return true;
	}
	if (fixedBodies.has(uuid)) {
		const object = group.getObjectByProperty('uuid', uuid);
		if (fixedShapeKeys.get(uuid) === shapeKeyOf(p, object)) return false;
		rebuildFixedColliders(uuid, p);
		return true;
	}
	return false;
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
 * Set/merge physics body params on ONE object's userData.physics — the shared
 * write path for the Inspector, quick actions and the AI set_physics tool.
 * Rides the existing 'props' history kind (undo/redo replays + re-broadcasts
 * free) and replicates via objectParameters. Returns the new params, or null
 * when the object doesn't exist.
 * @param {string} uuid
 * @param {{mode?: 'auto'|'static'|'dynamic', mass?: number, restitution?: number,
 *   friction?: number, collider?: string}} patch
 * @returns {any|null}
 */
export function setPhysicsFor(uuid, patch) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	const before = object.userData.physics ? { ...object.userData.physics } : null;
	const next = { mode: 'auto', ...(object.userData.physics ?? {}), ...patch };
	object.userData.physics = next;
	recordEntry({ kind: 'props', uuid, before: { physics: before }, after: { physics: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'physics', uuid, physics: next });
	objectsGroup.update((v) => v); // collider viz re-syncs from the poke
	physicsShapeChanged(uuid); // CL-A A2: live mid-sim collider rebuild
	return next;
}

/**
 * C1 quick action: make the current selection dynamic (userData.physics mode
 * 'dynamic', mass 1 unless already set) — replicates via the existing
 * objectParameters message and records a props undo entry per object.
 * @returns {number} objects updated
 */
export function enablePhysicsOnSelection() {
	const group = get(objectsGroup);
	const multi = get(selectedObjects);
	const primary = /** @type {any} */ (get(selectedObject));
	const uuids = multi?.length ? multi : primary?.uuid ? [primary.uuid] : [];
	let count = 0;
	uuids.forEach((/** @type {string} */ uuid) => {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return;
		const next = setPhysicsFor(uuid, {
			mode: 'dynamic',
			mass: object.userData.physics?.mass ?? 1
		});
		if (next) count++;
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

/** CL-A A5: apply (or clear) per-axis locks on a dynamic body.
 * @param {any} body @param {{rx?:boolean,ry?:boolean,rz?:boolean,px?:boolean,py?:boolean,pz?:boolean}|undefined} f */
function applyFreeze(body, f) {
	body.setEnabledRotations(!f?.rx, !f?.ry, !f?.rz, true);
	body.setEnabledTranslations(!f?.px, !f?.py, !f?.pz, true);
}

/** CL-A A2: change-detection key over everything that forces a collider
 * rebuild (shape kind, custom verts, sensor, freeze, materials, mass).
 * @param {any} p collectParams entry @param {any} object */
function shapeKeyOf(p, object) {
	const verts = object?.userData?.physics?.colliderVerts;
	const vertsKey = Array.isArray(verts)
		? verts.length + ':' + verts.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0).toFixed(2)
		: null;
	// B4: the scene default is part of what a collider was BUILT with, so a change
	// to it has to read as drift here or applyLiveParams never rebuilds
	const sceneMaterial = get(scenePhysicsDefaults).material;
	return JSON.stringify({
		c: p?.collider ?? null,
		v: vertsKey,
		sm: [sceneMaterial.friction, sceneMaterial.restitution],
		s: !!p?.sensor,
		f: p?.freeze ?? null,
		r: p?.restitution ?? null,
		fr: p?.friction ?? null,
		m: p?.mass ?? null,
		cs: p?.colliderScale ?? null, // CL-C: node shape scale
		src: p?.colliderSource ?? null // CL-C: 'object' shape source uuid
	});
}

/** CL-C: node params may hull ANOTHER object ('object' source) and scale the
 * shape — resolve those extras into the shared spec. @param {any} object @param {any} p */
function specOf(object, p) {
	const sourceObject = p?.colliderSource
		? get(objectsGroup)?.getObjectByProperty('uuid', p.colliderSource)
		: null;
	return colliderSpecOf(object, p?.collider, { sourceObject, scale: p?.colliderScale });
}

/**
 * CL-A A1/A2: build + attach the collider set for one body from the shared
 * colliderSpec, placed RELATIVE to the body's CURRENT pose — identity at sim
 * start (byte-identical to the old inline construction), and on a live
 * mid-sim rebuild the body pose is untouched so joints and velocities
 * survive. Hull/custom pieces get the object rotation baked into the verts
 * (identity-start convention, C3); primitives carry it on the desc.
 * Updates entry offset/initialQuat bookkeeping + colliderOwner.
 * @param {any} object @param {any} body @param {any} p params entry
 * @param {boolean} dynamic @param {BodyEntry | null} entry
 * @param {any=} knownSpec spec already computed by the caller
 * @returns {{colliders: any[], spec: any} | null}
 */
function createCollidersFor(object, body, p, dynamic, entry, knownSpec) {
	const spec = knownSpec ?? specOf(object, p);
	if (!spec) return null;
	if (spec.fallback)
		showToast(
			(p?.collider === 'custom' ? 'Custom collider' : 'Convex hull') +
				' unavailable for "' +
				(object.name || object.type) +
				'" — using a box'
		);
	const t = body.translation();
	const r = body.rotation();
	const bodyQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
	const invBody = bodyQuat.clone().invert();
	const bodyPos = new THREE.Vector3(t.x, t.y, t.z);
	/** world point -> body-local @param {any} world */
	const localOf = (world) => world.clone().sub(bodyPos).applyQuaternion(invBody);
	const relQuat = invBody.clone().multiply(spec.quat); // object rotation in the body frame
	/** @type {any[]} */
	const descs = [];
	if (spec.pieces) {
		// hull/custom: verts are scale-baked around the OBJECT ORIGIN — bake the
		// relative rotation per-vert, carry the origin offset on the desc
		const origin = localOf(object.position);
		const v = new THREE.Vector3();
		for (const piece of spec.pieces) {
			const baked = new Float32Array(piece.verts.length);
			for (let i = 0; i < piece.verts.length; i += 3) {
				v.set(piece.verts[i], piece.verts[i + 1], piece.verts[i + 2]).applyQuaternion(relQuat);
				baked[i] = v.x;
				baked[i + 1] = v.y;
				baked[i + 2] = v.z;
			}
			const desc = RAPIER.ColliderDesc.convexHull(baked);
			if (desc) descs.push(desc.setTranslation(origin.x, origin.y, origin.z));
		}
	}
	if (!descs.length) {
		const local = localOf(spec.center);
		descs.push(
			shapeDesc(spec.pieces ? 'box' : spec.kind, spec.halfExtents)
				.setTranslation(local.x, local.y, local.z)
				.setRotation({ x: relQuat.x, y: relQuat.y, z: relQuat.z, w: relQuat.w })
		);
	}
	/** @type {any[]} */
	const colliders = [];
	// B4: the SCENE default material fills in wherever the object says nothing —
	// "make this whole scene rubber" as ONE control. The per-object value still
	// wins, so every existing scene is byte-identical (its default is null/null).
	const sceneMaterial = get(scenePhysicsDefaults).material;
	descs.forEach((desc) => {
		const restitution = p?.restitution ?? sceneMaterial.restitution;
		const friction = p?.friction ?? sceneMaterial.friction;
		if (restitution != null) desc.setRestitution(restitution);
		if (friction != null) desc.setFriction(friction);
		if (dynamic) desc.setMass((p.mass ?? 1) / descs.length);
		// PFX-C: dynamics report contact starts; CL-A: sensors need events too
		if (dynamic || p?.sensor) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
		if (p?.sensor) desc.setSensor(true);
		const collider = world.createCollider(desc, body);
		colliders.push(collider);
		colliderOwner.set(collider.handle, { uuid: object.uuid, entry, sensor: !!p?.sensor });
	});
	// write-back bookkeeping, generalized to any body pose: at sim start (body
	// world-aligned) these equal the classic values (objPos-center / objQuat)
	if (entry) {
		// primitives at start: objPos - center; hulls at start: 0 (body sits at
		// the object origin); mid-sim rebuilds: whatever keeps the pose fixed
		entry.offset = localOf(object.position);
		entry.initialQuat = invBody.clone().multiply(object.quaternion);
		entry.colliders = colliders;
		entry.hull = !!spec.pieces;
		entry.shapeKey = shapeKeyOf(p, object);
	}
	return { colliders, spec };
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

	// CL-A A6: scene gravity is a replicated singleton (scenePhysics.js); the
	// live subscription below applies mid-sim changes on the stepping peer
	world = new RAPIER.World({ x: 0, y: get(sceneGravity), z: 0 });
	groundCollider = null;
	groundHandle = -1;
	buildGround(get(scenePhysicsGround));
	eventQueue = new RAPIER.EventQueue(true);
	colliderOwner = new Map();
	lastImpactAt = new Map();
	pendingImpacts = [];
	// NOTE for later phases: static scenery would benefit from
	// ColliderDesc.trimesh (fixed bodies only) and terrain from a heightfield —
	// both deferred; every collider today is a cuboid AABB or an opt-in hull.
	bodies = [];
	beforeStates = [];
	suspendedForRun = [];
	fixedBodies = new Map();
	fixedColliders = new Map();
	fixedShapeKeys = new Map();

	group.children.forEach((/** @type {any} */ object) => {
		// CL-A A1: the shape measurement + hull/custom vert extraction moved to
		// colliderSpec.js (ONE source of truth, shared with the collider viz).
		// Colliders stay ORIENTED: primitives fit the LOCAL AABB (rotation
		// stripped for the measure) and carry the rotation on the desc;
		// hull/custom pieces bake it into the verts — so every body starts
		// WORLD-ALIGNED (identity rotation; joints require it, C3).
		const p = params[object.uuid];
		const spec = specOf(object, p);
		if (!spec) return; // lights/empties
		const dynamic = !!p && p.mass != null && dynamicUuids.includes(object.uuid);
		// flow-animated objects (not dynamic) become KINEMATIC platforms: the
		// flow pose feeds the body each step so rapier derives their velocity
		const kinematic = !dynamic && isAnimatedTarget(object.uuid);
		// hull/custom bodies sit at the OBJECT ORIGIN (verts are origin-
		// relative); primitives at the AABB center (center-offset bookkeeping)
		const at = spec.pieces ? object.position : spec.center;
		// sleep OFF for dynamics: a kinematic platform moving UNDER a sleeping
		// body never wakes it (existing contact, unchanged normal) — the resting
		// box would ignore the spinning slab; broadcasts gate on movement instead
		const bodyDesc = (dynamic
			? RAPIER.RigidBodyDesc.dynamic().setCanSleep(false)
			: kinematic
				? RAPIER.RigidBodyDesc.kinematicPositionBased()
				: RAPIER.RigidBodyDesc.fixed()
		).setTranslation(at.x, at.y, at.z);
		// B4: scene damping defaults — the knob that turns a jittery tower stable
		// and stops crates sliding forever. Dynamics only: a kinematic body's motion
		// is prescribed and a fixed one has none.
		if (dynamic) {
			const defaults = get(scenePhysicsDefaults);
			bodyDesc.setLinearDamping(defaults.damping.linear ?? 0);
			bodyDesc.setAngularDamping(defaults.damping.angular ?? 0);
		}
		const body = world.createRigidBody(bodyDesc);
		// B4: no CCD exists today, and a 20 m/s throw moves 0.33 m per step — thin
		// walls tunnel, which is precisely the new gesture's failure mode
		if (dynamic && get(scenePhysicsDefaults).ccd) body.enableCcd(true);
		/** @type {BodyEntry} */
		const entry = {
			object,
			body,
			offset: new THREE.Vector3(),
			initialQuat: object.quaternion.clone(),
			mode: /** @type {'dynamic'|'kinematic'} */ (dynamic ? 'dynamic' : 'kinematic'),
			hull: false,
			hold: /** @type {'user'|'external'|null} */ (null),
			holdUntil: 0,
			samples: /** @type {any[]} */ ([]),
			colliders: /** @type {any[]} */ ([]),
			shapeKey: '',
			// the pose WE last wrote — a deviation means someone else (a peer's
			// move applier, undo, an AI edit) wrote the object mid-sim
			lastWritten: { pos: object.position.clone(), quat: object.quaternion.clone() }
		};
		const tracked = dynamic || kinematic;
		const built = createCollidersFor(object, body, p ?? {}, dynamic, tracked ? entry : null, spec);
		if (dynamic && p?.freeze) applyFreeze(body, p.freeze); // CL-A A5
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
			fixedColliders.set(object.uuid, built?.colliders ?? []);
			fixedShapeKeys.set(object.uuid, shapeKeyOf(p, object));
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
	groundSubPrimed = false;
	defaultsSubPrimed = false;
	liveSnapshot = liveParamsJson();
	const onGraphChange = () => {
		if (!world) return;
		const snap = liveParamsJson();
		if (snap === liveSnapshot) return;
		liveSnapshot = snap;
		applyLiveParams();
	};
	liveUnsubs = [
		flowGraphs.subscribe(onGraphChange), // H1: sees every graph
		// A6: gravity applies live (world.gravity is a plain setter; dynamics
		// never sleep, so they notice immediately)
		sceneGravity.subscribe((g) => {
			if (world) world.gravity = { x: 0, y: g, z: 0 };
		}),
		// B4: the ground swaps mid-sim (joints, velocities and resting contacts all
		// survive — a resting body can drop up to 0.1 m for one frame, which is the
		// documented cost of not restarting the run)
		scenePhysicsGround.subscribe((cfg) => {
			// a store subscription fires immediately, and world create just built the
			// ground with this very config — skip that one, then track every change
			if (!groundSubPrimed) {
				groundSubPrimed = true;
				return;
			}
			if (world) buildGround(cfg);
		}),
		// B4: damping/CCD/material apply to the live bodies. timeScale needs no
		// hook at all — step() reads it per frame.
		scenePhysicsDefaults.subscribe((defaults) => {
			if (!world) return;
			if (!defaultsSubPrimed) {
				defaultsSubPrimed = true;
				return; // the bodies were just built with these values
			}
			bodies.forEach((entry) => {
				if (entry.mode !== 'dynamic') return;
				entry.body.setLinearDamping(defaults.damping.linear ?? 0);
				entry.body.setAngularDamping(defaults.damping.angular ?? 0);
				entry.body.enableCcd(!!defaults.ccd);
			});
			// a material change is collider state, so it rides the shapeKey drift
			// path that already exists for the per-object values
			applyLiveParams();
		})
	];

	simulating.set(true);
	simPaused.set(false);
	if (peer) peer.send({ type: 'simulate', running: true, peerId: peer.peer.id });
	lastStep = performance.now();
	accumulator = 0;
	setPostTick(step); // steps at the end of every flowRuntime tick
}

/**
 * B4: the scene ground, as an OWNED unit — build, swap and remove all go through
 * here, at world create and from the live subscription.
 *
 * groundHandle is compared BY VALUE in queueContact and rapier reuses small
 * integer handles, so leaving a stale one behind when the ground is disabled can
 * ALIAS a real collider and silently swallow that body's impacts. The disabled
 * path sets it to -1 explicitly, which no live handle can equal.
 *
 * The collider is a 0.2 m thick slab translated so its TOP FACE lands exactly on
 * cfg.height (rapier cuboids measure half-extents from their centre). It stays
 * out of colliderOwner, so both event paths keep skipping it as they always did.
 * @param {any} cfg scenePhysicsGround
 */
function buildGround(cfg) {
	if (!world || !RAPIER) return false;
	if (groundCollider) {
		world.removeCollider(groundCollider, true);
		groundCollider = null;
	}
	groundHandle = -1;
	if (!cfg?.enabled) return false;
	const desc = RAPIER.ColliderDesc.cuboid(500, 0.1, 500).setTranslation(0, (cfg.height ?? 0) - 0.1, 0);
	if (cfg.friction != null) desc.setFriction(cfg.friction);
	if (cfg.restitution != null) desc.setRestitution(cfg.restitution);
	groundCollider = world.createCollider(desc);
	groundHandle = groundCollider.handle;
	return true;
}

/**
 * B4: a body leaves the world. Delete needs it now; B7's spawner gets its
 * inverse for free. Leaves the OBJECT alone — the caller decides whether the
 * scene keeps it. @param {string} uuid
 */
export function physicsRemoveBody(uuid) {
	if (!world) return false;
	const index = bodies.findIndex((e) => e.object.uuid === uuid);
	if (index === -1) return false;
	const entry = bodies[index];
	entry.colliders.forEach((c) => colliderOwner.delete(c.handle));
	world.removeRigidBody(entry.body);
	bodies.splice(index, 1);
	beforeStates = beforeStates.filter((b) => b.uuid !== uuid);
	return true;
}

/**
 * B4: a dynamic body fell past the scene's out-of-bounds limit. ONE toast per
 * burst rather than per body: a collapsing stack drops several in the same
 * frame, and plain-string toasts dedupe but would still emit one per distinct
 * count. @param {BodyEntry} entry @param {string} action
 */
function handleOutOfBounds(entry, action) {
	const uuid = entry.object.uuid;
	entry.oob = true;
	if (action === 'freeze') {
		entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		entry.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
		// a frozen body produces no movement, so the broadcast gate already
		// silences it — no extra bookkeeping needed
	} else if (action === 'delete') {
		physicsRemoveBody(uuid);
		// objectActions imports joints/geometries/flowRuntime/history, so a STATIC
		// edge from here is the cycle shape CLAUDE.md warns about
		import('./objectActions')
			.then((m) => m.deleteObjectsByUuid([uuid]))
			.catch(() => {});
	} else {
		// respawn: beforeStates already holds the sim-start transform per dynamic
		// uuid, which is exactly the right answer for a pad-spawned crate
		const before = beforeStates.find((b) => b.uuid === uuid)?.before;
		if (!before) return;
		entry.object.position.fromArray(before.pos);
		entry.object.rotation.set(before.rot[0], before.rot[1], before.rot[2]);
		const target = kinematicTargetOf(entry);
		entry.body.setTranslation({ x: target.pos.x, y: target.pos.y, z: target.pos.z }, true);
		entry.body.setRotation(
			{ x: target.quat.x, y: target.quat.y, z: target.quat.z, w: target.quat.w },
			true
		);
		entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
		entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
		entry.lastWritten.pos.copy(entry.object.position);
		entry.lastWritten.quat.copy(entry.object.quaternion);
		entry.oob = false; // it is back in play
	}
	oobCount++;
	oobAction = action;
	clearTimeout(oobTimer);
	oobTimer = setTimeout(flushOutOfBoundsToast, 400);
}

function flushOutOfBoundsToast() {
	if (oobCount === 0) return;
	const what = oobCount === 1 ? '1 object fell' : oobCount + ' objects fell';
	const fate =
		oobAction === 'freeze'
			? 'frozen in place'
			: oobAction === 'delete'
				? 'removed'
				: 'returned to spawn';
	oobCount = 0;
	showToast(what + ' out of bounds — ' + fate, [
		{ label: 'Physics settings', action: () => openSceneSection('Physics') }
	]);
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

/** Ring buffer of recent held poses -> a release-velocity estimate. B2 stores
 * the QUATERNION, not the Euler: differencing Euler components is wrong across a
 * wrap and wrong in general (YXZ couples the axes).
 * @param {any} entry @param {number} now */
function recordHoldSample(entry, now) {
	entry.samples.push({
		t: now,
		pos: entry.object.position.clone(),
		quat: entry.object.quaternion.clone()
	});
	if (entry.samples.length > 4) entry.samples.shift();
}

/** Flip a held body back to dynamic, imparting the estimated velocity (throw).
 * `velocity` lets a caller hand over a value it measured itself (play-mode
 * release, B5's `throw` message); both paths end in clampThrow, which is the
 * whole reason the receive side needs no validation of its own.
 * @param {any} entry
 * @param {{linvel: any, angvel: any} | null} [velocity]
 */
function releaseHold(entry, velocity = null) {
	entry.hold = null;
	entry.holdUntil = 0;
	entry.holdPeer = null;
	entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
	// no measurement and fewer than two samples: leave the body's own velocity
	// alone, exactly as before — an instant release is not a throw of zero
	const v = velocity
		? clampThrow(velocity.linvel, velocity.angvel)
		: entry.samples.length >= 2
			? velocityFromSamples(entry.samples)
			: null;
	if (v) {
		entry.body.setLinvel({ x: v.linvel.x, y: v.linvel.y, z: v.linvel.z }, true);
		entry.body.setAngvel({ x: v.angvel.x, y: v.angvel.y, z: v.angvel.z }, true);
		// B4: CCD unconditionally for a FAST release, whatever the scene toggle
		// says — a 20 m/s throw travels 0.33 m per step and would tunnel a wall.
		// B6's rest detector clears it again.
		if (v.linvel.length() > 5) entry.body.enableCcd(true);
	}
	// Whoever held this body moved the OBJECT while the write-back was skipping
	// it, so lastWritten still describes the pose at grab time. Refresh it here or
	// the very next step reads that as a phantom EXTERNAL write, re-engages a
	// kinematic hold, and eats the throw — measured: a released crate came back
	// hold:'external', bodyType kinematic, one frame later. (The same trap B5's
	// applyThrow has to answer for an incoming message.)
	entry.lastWritten.pos.copy(entry.object.position);
	entry.lastWritten.quat.copy(entry.object.quaternion);
	entry.samples = [];
	return v;
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

/** Drag ended: back to dynamic + throw velocity. `velocity` overrides the
 * sample-derived estimate (play-mode measures its own; a cancel passes zeros —
 * a cancel is not a throw). @param {string} uuid
 * @param {{linvel: any, angvel: any} | null} [velocity] */
export function releaseBody(uuid, velocity = null) {
	const entry = bodies.find((e) => e.object.uuid === uuid && e.hold === 'user');
	if (!entry || !world) return false;
	releaseHold(entry, velocity);
	return true;
}

/**
 * An incoming peer `move` landed on a body mid-sim (peerHandler calls this after
 * moveGeometry applied the transform). A dynamic body becomes an EXTERNAL
 * kinematic hold that follows the move stream; 250ms of silence releases it
 * with a (coarse, ~10Hz-sampled) velocity estimate. Returns true if consumed.
 * @param {string} uuid
 */
export function physicsExternalMove(uuid, peerId = null) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic');
	if (!entry || entry.hold === 'user') return false;
	// B5: the minimum arbitration that stops two 20 Hz streams fighting over one
	// crate — FIRST CLAIM holds it until the hold expires. Deliberately not a hard
	// lock: two people wrestling a crate is a feature in a party game, and the
	// claim only keeps it from becoming jitter.
	if (peerId && entry.hold === 'external' && entry.holdPeer && entry.holdPeer !== peerId)
		return false;
	if (entry.hold !== 'external') {
		entry.hold = 'external';
		entry.samples = [];
		entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
	}
	if (peerId) entry.holdPeer = peerId;
	entry.holdUntil = performance.now() + EXTERNAL_HOLD_MS;
	return true;
}

/**
 * B5: a peer released something they were carrying, and told us EXACTLY how.
 *
 * Applied by the INITIATOR only (rule 8: two peers authoring one flight is
 * mixing sync models) and never re-broadcast — the flight replicates through
 * the existing movement-gated move stream, so peers converge with zero new
 * state on the wire. A throw is an EVENT like nodetrigger/ping, so there is no
 * full-state reply to owe either.
 *
 * The incoming vectors go through the SAME clampThrow as the local path, so a
 * hostile linvel is bounded without a line of validation here.
 * @param {any} data {uuid, pos, rot, linvel, angvel}
 */
export function applyThrow(data) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === data?.uuid && e.mode === 'dynamic');
	if (!entry) return false;
	const object = entry.object;
	// pos/rot ride along so the handler is independent of message ORDER: a
	// DataConnection is ordered, so the last carry move precedes this, but the
	// 20 Hz gate may have dropped the final one
	if (Array.isArray(data.pos)) object.position.fromArray(data.pos);
	if (Array.isArray(data.rot)) object.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
	object.updateMatrixWorld();
	const target = kinematicTargetOf(entry);
	entry.body.setTranslation({ x: target.pos.x, y: target.pos.y, z: target.pos.z }, true);
	entry.body.setRotation(
		{ x: target.quat.x, y: target.quat.y, z: target.quat.z, w: target.quat.w },
		true
	);
	entry.hold = null;
	entry.holdUntil = 0;
	entry.holdPeer = null;
	entry.samples = [];
	entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
	const v = clampThrow(data.linvel, data.angvel);
	entry.body.setLinvel({ x: v.linvel.x, y: v.linvel.y, z: v.linvel.z }, true);
	entry.body.setAngvel({ x: v.angvel.x, y: v.angvel.y, z: v.angvel.z }, true);
	if (v.linvel.length() > 5) entry.body.enableCcd(true); // B4
	// writing the object pose from a message is EXACTLY what the deviation
	// detector exists to catch, so without this the very next step re-engages an
	// external kinematic hold and EATS the throw
	entry.lastWritten.pos.copy(object.position);
	entry.lastWritten.quat.copy(object.quaternion);
	objectsGroup.update((value) => value);
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
	// B4: global time scale. Scale the accumulator FEED, never world.timestep —
	// changing the timestep changes solver behaviour, i.e. makes the sim
	// differently wrong rather than slower.
	accumulator += Math.min((now - lastStep) / 1000, 0.25) * (get(scenePhysicsDefaults).timeScale ?? 1);
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
	sensorEventSeen.clear(); // A3: per-frame dedupe window
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
		// PFX-C: impact strength must be sampled BEFORE the step — contact
		// resolution rewrites linvel during it (a bounce reads as upward after)
		bodies.forEach((entry) => {
			if (entry.mode === 'dynamic' && !entry.hold) entry.preVy = entry.body.linvel().y;
		});
		world.step(eventQueue);
		// drain per SUBSTEP or events from early substeps get merged/lost
		eventQueue.drainCollisionEvents((/** @type {number} */ h1, /** @type {number} */ h2, /** @type {boolean} */ started) => {
			if (started) queueContact(h1, h2, now);
			queueSensorEvent(h1, h2, started); // A3: enter/exit edges
		});
	}
	dispatchImpacts();
	dispatchEnterExit();

	/** @type {any} */
	const peer = get(peers);
	const broadcast = now - lastBroadcast > 100;
	if (broadcast) lastBroadcast = now;
	const sceneCcd = !!get(scenePhysicsDefaults).ccd;
	const boundsCfg = get(scenePhysicsBounds);
	const oobLimit = boundsCfg.limit ?? -100;
	const oobActionNow = boundsCfg.action ?? 'respawn';
	/** @type {BodyEntry[]} */
	const pendingOob = [];

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
		// B4: out of bounds. Inside the write-back loop the object pose is already
		// in hand, so this costs one comparison per dynamic body per frame. The
		// ACTION runs after the loop: 'delete' splices the bodies array, and
		// mutating the array a forEach is walking silently skips the next entry.
		if (object.position.y < oobLimit && !entry.oob) pendingOob.push(entry);
		// B6: REST detection. Initiator-detected and replicated as a shared trigger
		// stamp, exactly like impacts — and deliberately NOT rapier's isSleeping(),
		// because sleep is off by design (a kinematic platform moving under a
		// sleeping body never wakes it).
		const linear = body.linvel();
		const spin = body.angvel();
		const still =
			Math.hypot(linear.x, linear.y, linear.z) < 0.05 &&
			Math.hypot(spin.x, spin.y, spin.z) < 0.1;
		if (still) {
			entry.restSince ??= now;
			// B4: a body that was thrown fast carries CCD until it settles
			if (!sceneCcd && body.isCcdEnabled?.()) body.enableCcd(false);
			fireObjectRest(object.uuid, (now - entry.restSince) / 1000);
		} else if (entry.restSince != null) {
			entry.restSince = null;
			fireObjectRest(object.uuid, 0); // re-arm any On Rest node watching it
		}
		// CL-C C3: exact-ish speed feed on the initiator (velocity node)
		noteObjectPose(object.uuid, object.position.x, object.position.y, object.position.z);
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
	pendingOob.forEach((entry) => handleOutOfBounds(entry, oobActionNow));
	objectsGroup.update((value) => value);
}

/**
 * A contact-start seen inside the substep loop. Either side that is a falling
 * DYNAMIC body (pre-step downward velocity above the threshold, not held, off
 * cooldown) registers an impact — dynamic-vs-ground, dynamic-vs-scenery and
 * dynamic-vs-dynamic all count.
 * @param {number} h1 @param {number} h2 @param {number} now step clock (ms)
 */
function queueContact(h1, h2, now) {
	for (const handle of [h1, h2]) {
		if (handle === groundHandle) continue;
		const entry = colliderOwner.get(handle)?.entry;
		if (!entry || entry.mode !== 'dynamic' || entry.hold) continue;
		const down = -(entry.preVy ?? 0);
		if (down < IMPACT_MIN_DOWN_VY) continue;
		const uuid = entry.object.uuid;
		if (now - (lastImpactAt.get(uuid) ?? -Infinity) < IMPACT_COOLDOWN_MS) continue;
		lastImpactAt.set(uuid, now);
		pendingImpacts.push({ uuid, strength: down });
	}
}

/**
 * CL-A A3: a sensor pair crossed (started) or separated (stopped) — collect
 * the edge for BOTH tracked sides. Sensors bypass the downward-velocity
 * impact filter entirely (enter/exit are edges, not impulses); repeated
 * events for the same pair within a frame dedupe.
 * @param {number} h1 @param {number} h2 @param {boolean} entered
 */
function queueSensorEvent(h1, h2, entered) {
	const o1 = colliderOwner.get(h1);
	const o2 = colliderOwner.get(h2);
	if (!o1 || !o2) return; // ground / unknown
	if (!o1.sensor && !o2.sensor) return;
	const key = o1.uuid + '|' + o2.uuid + '|' + entered;
	if (sensorEventSeen.has(key)) return;
	sensorEventSeen.add(key);
	pendingEnterExit.push({ uuid: o1.uuid, otherUuid: o2.uuid, entered });
	pendingEnterExit.push({ uuid: o2.uuid, otherUuid: o1.uuid, entered });
}

/** CL-A A3: fire collected enter/exit edges AFTER the substep loop. The
 * dispatch fns live in flowRuntime (replicated trigger stamps); with no
 * onenter/onexit nodes in any graph they no-op — CL-C adds the nodes. */
function dispatchEnterExit() {
	if (!pendingEnterExit.length) return;
	const events = pendingEnterExit;
	pendingEnterExit = [];
	events.forEach(({ uuid, otherUuid, entered }) => {
		if (entered) fireObjectEnter(uuid, otherUuid);
		else fireObjectExit(uuid, otherUuid);
	});
}

/** Fire the collected impacts AFTER the substep loop (keeps the stepping tight
 * and the peer sends out of the drain callback). Initiator-only by construction. */
function dispatchImpacts() {
	if (!pendingImpacts.length) return;
	const impacts = pendingImpacts;
	pendingImpacts = [];
	const group = get(objectsGroup);
	impacts.forEach(({ uuid, strength }) => {
		// flow path: pulse On Impact nodes targeting this object — the trigger
		// stamp replicates (nodetrigger), so every peer computes the same pulse
		fireObjectImpact(uuid, strength);
		// zero-flow path: an emitter set to "On impact" bursts for everyone
		// (replicated particleburst timestamp) — userData emitters checked on
		// the object, NODE emitters through the runtime
		const object = group?.getObjectByProperty('uuid', uuid);
		if (object?.userData?.particles?.mode === 'impact' || hasImpactEmitter(uuid))
			burstObjectParticles(uuid);
	});
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

	clearTimeout(oobTimer);
	oobTimer = null;
	oobCount = 0;
	groundCollider = null;
	groundHandle = -1;
	world?.free?.();
	world = null;
	eventQueue?.free?.();
	eventQueue = null;
	colliderOwner = new Map();
	pendingImpacts = [];
	pendingEnterExit = [];
	sensorEventSeen = new Set();
	bodies = [];
	beforeStates = [];
	liveJoints = new Map();
	fixedBodies = new Map();
	fixedColliders = new Map();
	fixedShapeKeys = new Map();
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

/**
 * B6: set a dynamic body's velocity outright (the Set Velocity node) —
 * initiator-only, mid-sim, and refused while something holds the body, exactly
 * like applyImpulse. This is a KINEMATIC-ish override rather than a force: it
 * replaces the velocity instead of adding to it.
 * @param {string} uuid @param {number[]|null} linvel @param {number[]|null} angvel
 */
export function setBodyVelocity(uuid, linvel, angvel) {
	if (!world || !get(simulating)) return false;
	const entry = bodies.find((e) => e.object.uuid === uuid && e.mode === 'dynamic' && !e.hold);
	if (!entry) return false;
	if (linvel)
		entry.body.setLinvel({ x: linvel[0] ?? 0, y: linvel[1] ?? 0, z: linvel[2] ?? 0 }, true);
	if (angvel)
		entry.body.setAngvel({ x: angvel[0] ?? 0, y: angvel[1] ?? 0, z: angvel[2] ?? 0 }, true);
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
	// B5: drop that peer's grab claim, or their crate stays theirs forever
	bodies.forEach((entry) => {
		if (entry.holdPeer === peerId) entry.holdPeer = null;
	});
}

/** B4: test/debug view of the world-level state (ground, bounds, timing) */
export function physicsWorldDebug() {
	return {
		running: !!world,
		groundHandle,
		groundEnabled: !!groundCollider,
		groundTop: groundCollider ? (get(scenePhysicsGround).height ?? 0) : null,
		bodies: bodies.length,
		ownerHandles: [...colliderOwner.keys()],
		oobPending: oobCount
	};
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
		oob: !!entry.oob,
		holdPeer: entry.holdPeer ?? null,
		colliders: entry.colliders.map((/** @type {any} */ c) => c.handle),
		ccd: entry.body?.isCcdEnabled?.() ?? null,
		bodyRot: entry.body?.rotation?.() ?? null
	}));
}
