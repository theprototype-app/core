import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { flowNodes, flowEdges } from '../stores/flowStore';
import { objectsGroup, lockedObjects, selectedObject } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordTransformSet } from './history';
import { notifyExternalMove } from './flowRuntime';
import { nameOf } from './lockControl';

// Physics preview: the INITIATOR runs rapier locally and broadcasts plain
// `move` messages (~10/s per awake body) — peers just watch standard moves.
// Objects wired to a Mass node are dynamic; everything else is static
// scenery. Stopping leaves one transformSet undo entry = "restore layout".

export const simulating = writable(false);
/** @type {import('svelte/store').Writable<string | null>} peer currently simulating */
export const remoteSimulating = writable(null);

/** @type {any} */ let RAPIER = null;
/** @type {any} */ let world = null;
/** @type {{object: any, body: any, offset: THREE.Vector3, initialQuat: THREE.Quaternion}[]} */
let bodies = [];
/** @type {{uuid: string, before: any}[]} */ let beforeStates = [];
let raf = 0;
let lastStep = 0;
let lastBroadcast = 0;

const PHYSICS_TYPES = ['mass', 'bounciness', 'friction'];

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

/** Per-object physics params from the flow graph (read once at sim start) */
function collectParams() {
	const nodes = get(flowNodes);
	const edges = get(flowEdges);
	/** @type {Record<string, any>} */
	const map = {};
	edges.forEach((edge) => {
		const source = nodes.find((n) => n.id === edge.source);
		if (!source || !PHYSICS_TYPES.includes(source.type)) return;
		const target = nodes.find((n) => n.id === edge.target);
		if (target?.type !== 'objectselector') return;
		const uuid = target.data?.selected;
		if (!uuid || uuid === '-None-') return;
		map[uuid] ??= {};
		if (source.type === 'mass') map[uuid].mass = source.data?.kg ?? 1;
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

async function startSimulation() {
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	if (!group) return;
	await warmup();

	const params = collectParams();
	const locked = get(lockedObjects).map((l) => l[1]);
	let dynamicUuids = Object.keys(params).filter((u) => params[u].mass != null && !locked.includes(u));
	if (dynamicUuids.length === 0) {
		const selected = get(selectedObject);
		if (selected && group.getObjectByProperty('uuid', selected.uuid) && !locked.includes(selected.uuid)) {
			params[selected.uuid] = { ...(params[selected.uuid] ?? {}), mass: 1 };
			dynamicUuids = [selected.uuid];
			showToast('No Mass nodes wired — simulating the selected object with mass 1');
		} else {
			showToast('Wire a Mass node to an Object Selector (or select an object) to make something fall');
			return;
		}
	}

	world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.1, 500).setTranslation(0, -0.1, 0));
	bodies = [];
	beforeStates = [];
	const box = new THREE.Box3();
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();

	group.children.forEach((object) => {
		box.setFromObject(object);
		if (!isFinite(box.min.x)) return; // lights/empties
		box.getSize(size).multiplyScalar(0.5);
		size.set(Math.max(size.x, 0.02), Math.max(size.y, 0.02), Math.max(size.z, 0.02));
		box.getCenter(center);
		const p = params[object.uuid];
		const dynamic = !!p && p.mass != null && dynamicUuids.includes(object.uuid);
		const bodyDesc = (dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
			.setTranslation(center.x, center.y, center.z);
		const body = world.createRigidBody(bodyDesc);
		const colliderDesc = RAPIER.ColliderDesc.cuboid(size.x, size.y, size.z);
		if (p?.restitution != null) colliderDesc.setRestitution(p.restitution);
		if (p?.friction != null) colliderDesc.setFriction(p.friction);
		if (dynamic) colliderDesc.setMass(p.mass);
		world.createCollider(colliderDesc, body);
		if (dynamic) {
			beforeStates.push({ uuid: object.uuid, before: transformOf(object) });
			bodies.push({
				object,
				body,
				offset: object.position.clone().sub(center),
				initialQuat: object.quaternion.clone()
			});
		}
	});

	simulating.set(true);
	if (peer) peer.send({ type: 'simulate', running: true, peerId: peer.peer.id });
	lastStep = performance.now();
	raf = requestAnimationFrame(step);
}

const bodyQuat = new THREE.Quaternion();
const rotatedOffset = new THREE.Vector3();

/** @param {number} now */
function step(now) {
	if (!world) return;
	world.timestep = Math.min((now - lastStep) / 1000, 1 / 30) || 1 / 60;
	lastStep = now;
	world.step();

	/** @type {any} */
	const peer = get(peers);
	const broadcast = now - lastBroadcast > 100;
	if (broadcast) lastBroadcast = now;

	bodies.forEach(({ object, body, offset, initialQuat }) => {
		const t = body.translation();
		const r = body.rotation();
		bodyQuat.set(r.x, r.y, r.z, r.w);
		rotatedOffset.copy(offset).applyQuaternion(bodyQuat);
		object.position.set(t.x + rotatedOffset.x, t.y + rotatedOffset.y, t.z + rotatedOffset.z);
		object.quaternion.copy(bodyQuat).multiply(initialQuat);
		if (broadcast && peer && !body.isSleeping()) {
			peer.send({
				type: 'move',
				uuid: object.uuid,
				pos: object.position.toArray(),
				rot: [object.rotation.x, object.rotation.y, object.rotation.z],
				scale: object.scale.toArray()
			});
		}
	});
	objectsGroup.update((value) => value);
	raf = requestAnimationFrame(step);
}

export function stopSimulation() {
	if (!get(simulating)) return;
	cancelAnimationFrame(raf);
	/** @type {any} */
	const peer = get(peers);
	const group = get(objectsGroup);

	// final authoritative transform per dynamic body + one-step undo entry
	const items = [];
	beforeStates.forEach(({ uuid, before }) => {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return;
		const after = transformOf(object);
		if (JSON.stringify(before) !== JSON.stringify(after)) items.push({ uuid, before, after });
		notifyExternalMove(uuid);
		if (peer)
			peer.send({ type: 'move', uuid: uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	});
	if (items.length > 0) recordTransformSet(items);

	world?.free?.();
	world = null;
	bodies = [];
	beforeStates = [];
	simulating.set(false);
	if (peer) peer.send({ type: 'simulate', running: false, peerId: peer.peer.id });
	if (items.length > 0) showToast('Simulation stopped — Ctrl+Z restores the initial layout');
}

/** @param {any} data */
export function applySimulate(data) {
	remoteSimulating.set(data.running ? data.peerId : null);
	if (data.running) showToast('▶ ' + nameOf(data.peerId) + ' is simulating physics');
}

/** @param {string} peerId */
export function physicsPeerDisconnected(peerId) {
	if (get(remoteSimulating) === peerId) remoteSimulating.set(null);
}
