// 102 M7 — CONSTRAINTS AT RUN TIME: evaluate every object's `userData.constraints` once a frame,
// after animation (mixers, clips, the sequencer) and before physics reads the poses, on EVERY
// peer from the replicated records and targets. Nothing here sends: no pose, no bone, no message.
//
// THE BASE RULE (golden rule 10, the propPlayback shape): a constrained node's pose is LOCAL
// derived state laid over its authored pose, so the authored pose (the "base") is remembered:
//   - at the start of a frame, a node still showing exactly what we wrote last frame is put back
//     on its base (nobody else touched it), and the constraints run again from there;
//   - a node showing anything else was moved by someone (an animation, a remote move, an undo,
//     the gizmo): that pose IS the new base;
//   - every serializer parks the base through parkHooks, so saves, the peer sync and exports
//     never carry a constrained pose as authored (the GLB export's "bake constraints" opts in);
//   - a gizmo drag HOLDS the object (Scene.svelte, beside suspendAnimation): it sits on its base
//     so the gizmo edits the base, and the drag's move message carries the base.
// A dynamic physics body is left to physics while a simulation runs (physics owns that pose).
//
// Flow nodes override a weight or a target LOCALLY (every peer runs the same replicated graph,
// so every peer sets the same override); an override not refreshed for 250 ms lapses.

import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup } from '../../stores/sceneStore';
import { registerParkHook } from '../parkHooks';
import {
	normalizeConstraints,
	dependenciesOf,
	evaluationOrder,
	applyConstraint,
	nodesWritten,
	poseOf
} from './constraintCore.js';

/** @typedef {import('./constraintCore.js').Constraint} Constraint */
/** @typedef {{p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3}} Pose */

const RESCAN_MS = 1000;
const OVERRIDE_TTL_MS = 250;
const EPS = 1e-7;

/** owner uuid -> {object, list (normalized), raw (the userData array it came from)} */
/** @type {Map<string, {object: THREE.Object3D, list: Constraint[], raw: any}>} */
let owners = new Map();
/** @type {string[]} */
let order = [];
let dirty = true;
let lastScan = -Infinity;
/** node -> {base, written} */
/** @type {Map<THREE.Object3D, {base: Pose, written: Pose | null, owner: string}>} */
const bases = new Map();
/** owners a gizmo drag holds */
const held = new Set();
/** "uuid|id" -> {weight?, target?, at} */
/** @type {Map<string, {weight?: number, target?: any, at: number}>} */
const overrides = new Map();
/** the last frame's results, for the Inspector's status line: "uuid|id" -> {ok, miss, reason} */
/** @type {Map<string, {ok: boolean, miss?: number, reason?: string}>} */
export const lastResults = new Map();

/** Something about constraints changed (a write, an apply, a load): rescan next frame. */
export function markConstraintsDirty() {
	dirty = true;
}

/** @param {THREE.Object3D} n @param {Pose} p */
function put(n, p) {
	n.position.copy(p.p);
	n.quaternion.copy(p.q);
	n.scale.copy(p.s);
}

/**
 * The start of a frame for a node we posed: PER CHANNEL, a channel still showing what we wrote
 * goes back to its base, a channel someone changed (a typed X in the Inspector, a remote move,
 * an undo) becomes the base. Per channel, because a one-field edit must not bake the rest of the
 * constrained pose into the authored one. Rotation is one channel (a quaternion moves together).
 * @param {THREE.Object3D} n @param {{base: Pose, written: Pose | null}} e
 */
function rebase(n, e) {
	const w = e.written;
	if (!w) return;
	for (const k of /** @type {const} */ (['x', 'y', 'z'])) {
		if (Math.abs(n.position[k] - w.p[k]) < EPS) n.position[k] = e.base.p[k];
		else e.base.p[k] = n.position[k];
		if (Math.abs(n.scale[k] - w.s[k]) < EPS) n.scale[k] = e.base.s[k];
		else e.base.s[k] = n.scale[k];
	}
	const q = n.quaternion;
	if (Math.abs(q.x - w.q.x) < EPS && Math.abs(q.y - w.q.y) < EPS && Math.abs(q.z - w.q.z) < EPS && Math.abs(q.w - w.q.w) < EPS) q.copy(e.base.q);
	else e.base.q.copy(q);
}

/** Put a node back on its base when nobody moved it since our last write; forget it. @param {THREE.Object3D} n */
function letGo(n) {
	const e = bases.get(n);
	if (!e) return;
	rebase(n, e);
	bases.delete(n);
}

/** A named node inside an object (a bone, or a child part); '' = the object. @param {THREE.Object3D} object @param {string} name */
export function nodeIn(object, name) {
	if (!name) return object;
	/** @type {THREE.Object3D | null} */
	let found = null;
	object.traverse((n) => {
		if (found || n === object) return;
		if (n.name === name && (/** @type {any} */ (n).isBone || !found)) found = n;
	});
	return found;
}

/** @param {any} group @param {number} now */
function rescan(group, now) {
	const next = new Map();
	group?.traverse?.((/** @type {THREE.Object3D} */ o) => {
		const raw = o.userData?.constraints;
		if (!Array.isArray(raw) || !raw.length) return;
		const prev = owners.get(o.uuid);
		next.set(o.uuid, { object: o, raw, list: prev && prev.raw === raw ? prev.list : normalizeConstraints(raw) });
	});
	// nodes no longer constrained (an entry deleted, an object removed) go back on their base
	const live = new Set();
	for (const { object, list } of next.values())
		for (const c of list) {
			const owner = nodeIn(object, c.bone);
			if (owner) for (const n of nodesWritten(owner, c, group)) live.add(n);
		}
	for (const n of [...bases.keys()]) if (!live.has(n)) letGo(n);
	owners = next;
	// the order: targets and poles first, then each owner's nearest constrained ancestor
	const depthOf = (/** @type {THREE.Object3D} */ o) => {
		let d = 0;
		for (let p = o.parent; p && p !== group; p = p.parent) d++;
		return d;
	};
	const entries = [...owners.entries()].map(([uuid, { object, list }]) => {
		const deps = dependenciesOf(list);
		for (let p = object.parent; p && p !== group; p = p.parent)
			if (owners.has(p.uuid)) {
				deps.push(p.uuid);
				break;
			}
		// a target that is a node INSIDE another constrained object depends on that object
		return { uuid, depth: depthOf(object), deps: deps.map((d) => ownerOf(d, group) ?? d) };
	});
	order = evaluationOrder(entries);
	dirty = false;
	lastScan = now;
}

/** The constrained object a uuid belongs to (itself, or the nearest owner above it). @param {string} uuid @param {any} group */
function ownerOf(uuid, group) {
	if (owners.has(uuid)) return uuid;
	const o = group?.getObjectByProperty?.('uuid', uuid);
	for (let p = o?.parent; p && p !== group; p = p.parent) if (owners.has(p.uuid)) return p.uuid;
	return null;
}

/** @param {any} group @param {{uuid: string, bone?: string}} ref */
function resolveIn(group, ref) {
	const o = group?.getObjectByProperty?.('uuid', ref.uuid) ?? null;
	if (!o) return null;
	return ref.bone ? nodeIn(o, ref.bone) : o;
}

/**
 * The frame's pass. `physicsRunning` = a simulation steps the world (dynamic bodies are its).
 * @param {{now?: number, physicsRunning?: boolean}} [opts]
 * @returns {number} how many constraints ran
 */
export function tickConstraints(opts = {}) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return 0;
	const now = opts.now ?? performance.now();
	if (dirty || now - lastScan > RESCAN_MS) rescan(group, now);
	if (!owners.size) return 0;
	let ran = 0;
	const resolve = (/** @type {any} */ ref) => resolveIn(group, ref);
	for (const uuid of order) {
		const entry = owners.get(uuid);
		if (!entry) continue;
		const { object } = entry;
		if (!object.parent) continue; // removed since the scan
		// a REPLACED list (a keyed weight, an edit) is read at once; a removed one waits for the rescan
		const raw = object.userData?.constraints;
		if (raw !== entry.raw) {
			if (!Array.isArray(raw) || !raw.length) {
				dirty = true;
				continue;
			}
			entry.raw = raw;
			entry.list = normalizeConstraints(raw);
		}
		const list = entry.list;
		if (held.has(uuid) || (opts.physicsRunning && object.userData?.physics?.mode === 'dynamic')) {
			for (const c of list) {
				const owner = nodeIn(object, c.bone);
				if (owner) for (const n of nodesWritten(owner, c, group)) letGo(n);
			}
			continue;
		}
		// 1. every node this object's constraints write: back on its base (or adopt a new base)
		/** @type {THREE.Object3D[]} */
		const touched = [];
		for (const c of list) {
			const owner = nodeIn(object, c.bone);
			if (!owner) continue;
			for (const n of nodesWritten(owner, c, group)) {
				if (touched.includes(n)) continue;
				touched.push(n);
				const e = bases.get(n);
				if (e && e.written) rebase(n, e);
				else bases.set(n, { base: poseOf(n), written: null, owner: uuid });
			}
		}
		// 2. fresh world matrices from the root down, then the stack in list order
		object.updateWorldMatrix(true, true);
		for (const c of list) {
			const key = uuid + '|' + c.id;
			const owner = nodeIn(object, c.bone);
			if (!owner) {
				lastResults.set(key, { ok: false, reason: 'no such bone' });
				continue;
			}
			const ov = overrides.get(key);
			const live = ov && now - ov.at <= OVERRIDE_TTL_MS ? ov : null;
			const eff = live?.target ? { ...c, target: live.target } : c;
			const res = applyConstraint(owner, eff, resolve, { weight: live && Number.isFinite(live.weight) ? live.weight : c.weight, stop: group });
			lastResults.set(key, res);
			if (res.ok) ran++;
		}
		// 3. remember what we wrote, so next frame can tell our pose from someone else's
		for (const n of touched) {
			const e = bases.get(n);
			if (e) e.written = poseOf(n);
		}
	}
	return ran;
}

/** A gizmo drag starts on an object: put it on its base and leave it there. @param {string} uuid */
export function holdConstraints(uuid) {
	if (!owners.has(uuid)) return;
	held.add(uuid);
	const group = get(objectsGroup);
	const entry = owners.get(uuid);
	if (!entry) return;
	for (const c of entry.list) {
		const owner = nodeIn(entry.object, c.bone);
		if (owner) for (const n of nodesWritten(owner, c, /** @type {any} */ (group))) letGo(n);
	}
}

/** The drag ended: the pose it left is the new base. @param {string} uuid */
export function releaseConstraints(uuid) {
	held.delete(uuid);
}

/**
 * A flow node's LOCAL override of one constraint (weight 0-1, or another target).
 * @param {string} uuid @param {string} id @param {{weight?: number, target?: {uuid: string, bone?: string} | null}} patch
 */
export function setConstraintOverride(uuid, id, patch) {
	const key = uuid + '|' + id;
	const prev = overrides.get(key) ?? { at: 0 };
	/** @type {any} */
	const next = { ...prev, at: performance.now() };
	if ('weight' in patch && Number.isFinite(Number(patch.weight))) next.weight = Math.min(1, Math.max(0, Number(patch.weight)));
	if ('target' in patch) next.target = patch.target && typeof patch.target.uuid === 'string' ? { uuid: patch.target.uuid, ...(patch.target.bone ? { bone: String(patch.target.bone) } : {}) } : undefined;
	overrides.set(key, next);
}

export function clearConstraintOverrides() {
	overrides.clear();
}

/** Park every constrained node on its base (serializers); returns the re-apply. */
function park() {
	/** @type {[THREE.Object3D, Pose, {written: Pose | null}][]} */
	const lifted = [];
	for (const [n, e] of bases) {
		if (!e.written) continue;
		const now = poseOf(n);
		rebase(n, e); // also adopts any channel changed since our write
		lifted.push([n, now, e]);
		n.updateMatrix();
	}
	if (!lifted.length) return null;
	const group = /** @type {any} */ (get(objectsGroup));
	group?.updateMatrixWorld?.(true);
	return () => {
		for (const [n, p, e] of lifted) {
			put(n, p);
			e.written = poseOf(n); // the posed pose is ours again: the next frame rebases from it
		}
		group?.updateMatrixWorld?.(true);
	};
}

/** Is any constraint in the scene? (the export dialog shows "Bake constraints" only then) */
export function hasConstraints() {
	if (dirty) {
		const group = /** @type {any} */ (get(objectsGroup));
		if (group) rescan(group, performance.now());
	}
	return owners.size > 0;
}

let unregister = registerParkHook(park);

/** Test seam: forget everything (between unit runs). */
export function resetConstraintRuntimeForTest() {
	for (const n of [...bases.keys()]) letGo(n);
	owners = new Map();
	order = [];
	dirty = true;
	held.clear();
	overrides.clear();
	lastResults.clear();
	unregister();
	unregister = registerParkHook(park);
}

/** Debug: what the runtime holds. */
export function constraintRuntimeState() {
	return { owners: [...owners.keys()], order: [...order], bases: bases.size, held: [...held], overrides: overrides.size };
}
