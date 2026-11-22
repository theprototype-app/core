// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObject, selectedObjects, TControls } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { findNodeAnyGraph } from '../../stores/flowStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { setNodeData } from '../nodesHandler';
import { spawnAtPoint } from '../addObjects';
import { deleteObjectsByUuid } from '../objectActions';
import { cloneSpline, normalizeSpline } from '../splineTube';
import { commitSplineEdit, splineObjectOf } from '../splineTool';
import {
	isPathObject,
	newPathRecord,
	normalizePathBlock,
	normalizePathPointExtras,
	recordFromPatrol,
	reversePath,
	splitPath,
	joinPaths,
	PATH_LINE_RADIUS
} from './pathCore.js';

// 78 F4 — THE PATH OBJECT'S WRITE SIDE (history family: the Inspector, the node card, the AI
// tools and the debug hook call it; the runtime never does). Every change is a SPLINE edit —
// `commitSplineEdit` (apply + `splineedit` + ONE `spline` undo entry) — because a Path IS a
// spline record; creation is the replicated `/create Path`, deletion the ordinary delete. A
// command that makes several changes (Convert, Split, Join, an agent's create) is ONE undo step.

/** run `fn` inside one history batch unless the caller already opened one @template T @param {string} label @param {() => T} fn @returns {T} */
function batch(label, fn) {
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		return fn();
	} finally {
		if (own) endHistoryBatch(label);
	}
}

/** the Path object for a uuid, or null @param {string} uuid */
export function pathObjectOf(uuid) {
	const o = splineObjectOf(uuid);
	return isPathObject(o) ? o : null;
}

/**
 * A record of WORLD points made into a new Path object: the object sits at the points' centroid
 * (objectsGroup frame, identity rotation and scale) and the record is relative to it.
 * @param {any} worldRecord a record whose points are WORLD positions @param {string} [name]
 * @returns {any | null} the object
 */
function placeWorldRecord(worldRecord, name = 'Path') {
	const group = get(objectsGroup);
	if (!group) return null;
	group.updateMatrixWorld(true);
	const local = worldRecord.points.map((/** @type {any} */ p) => group.worldToLocal(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2])));
	const center = local.reduce((/** @type {any} */ s, /** @type {any} */ v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, local.length));
	// spawnAtPoint takes an objectsGroup-local point (it sets `position`)
	const object = spawnAtPoint('/create Path', [center.x, center.y, center.z]);
	if (!object?.uuid || !isPathObject(object)) return null;
	const record = {
		...worldRecord,
		points: worldRecord.points.map((/** @type {any} */ p, /** @type {number} */ i) => ({ ...p, pos: local[i].clone().sub(center).toArray(), radius: PATH_LINE_RADIUS }))
	};
	commitSplineEdit(object.uuid, object.userData.spline, record);
	if (name && name !== object.name) renameObject(object, name);
	return object;
}

/** @param {any} object @param {string} name */
function renameObject(object, name) {
	object.name = name;
	import('../../stores/appStore').then((m) => {
		/** @type {any} */
		const peer = get(m.peers);
		peer?.send({ type: 'name', uuid: object.uuid, name });
	});
}

/** a Path's record with its points in WORLD space @param {any} object */
function worldRecordOf(object) {
	object.updateWorldMatrix(true, false);
	const rec = cloneSpline(object.userData.spline);
	rec.points = rec.points.map((/** @type {any} */ p) => ({ ...p, pos: new THREE.Vector3(...p.pos).applyMatrix4(object.matrixWorld).toArray() }));
	return rec;
}

/**
 * Add a Path object. With no points: the default three-point path at `at` (or in front of the
 * camera). With WORLD points: exactly those (2..200), plus any path settings and point fields.
 * One undo step.
 * @param {{points?: any[], at?: number[] | null, closed?: boolean, mode?: string, speed?: number, smooth?: boolean, showInPlay?: boolean, seed?: number, name?: string}} [opts]
 * @returns {{object: any} | {error: string}}
 */
export function createPath(opts = {}) {
	const pts = Array.isArray(opts.points) ? opts.points : null;
	if (pts && pts.length < 2) return { error: 'A path needs at least two points.' };
	if (pts && pts.length > 200) return { error: 'A path holds at most 200 points.' };
	return batch('Add path', () => {
		if (!pts) {
			const object = spawnAtPoint('/create Path', opts.at ?? null);
			if (!object?.uuid) return { error: 'Could not create the path.' };
			const patch = { mode: opts.mode, speed: opts.speed, smooth: opts.smooth, showInPlay: opts.showInPlay, seed: opts.seed };
			if (Object.values(patch).some((v) => v !== undefined)) setPathSettings(object.uuid, patch);
			if (typeof opts.closed === 'boolean') setPathClosed(object.uuid, opts.closed);
			if (opts.name) renameObject(object, opts.name);
			return { object };
		}
		const world = newPathRecord({ points: pts, closed: !!opts.closed, mode: opts.mode, speed: opts.speed, smooth: opts.smooth, showInPlay: opts.showInPlay, seed: opts.seed });
		const object = placeWorldRecord(world, opts.name || 'Path');
		return object ? { object } : { error: 'Could not create the path.' };
	});
}

/** edit a Path's record through the spline write path @param {string} uuid @param {(rec: any) => any} mutate */
function editPath(uuid, mutate) {
	const object = pathObjectOf(uuid);
	if (!object) return false;
	const before = cloneSpline(object.userData.spline);
	const after = mutate(cloneSpline(before));
	if (!after) return false;
	return commitSplineEdit(uuid, before, after);
}

/**
 * The path settings (mode / speed / smooth / showInPlay / preview / seed). Undefined fields keep.
 * @param {string} uuid @param {Record<string, any>} patch
 */
export function setPathSettings(uuid, patch) {
	return editPath(uuid, (rec) => {
		/** @type {Record<string, any>} */
		const clean = {};
		for (const [k, v] of Object.entries(patch ?? {})) if (v !== undefined) clean[k] = v;
		rec.path = normalizePathBlock({ ...rec.path, ...clean });
		return rec;
	});
}

/** @param {string} uuid @param {boolean} closed */
export function setPathClosed(uuid, closed) {
	return editPath(uuid, (rec) => ({ ...rec, closed: !!closed }));
}

/**
 * Point fields on several points at once (the multi-select). A value of null / '' clears it.
 * @param {string} uuid @param {number[]} indices @param {Record<string, any>} patch
 */
export function setPathPointFields(uuid, indices, patch) {
	return editPath(uuid, (rec) => {
		for (const i of indices) {
			const p = rec.points[i];
			if (!p) continue;
			const merged = { ...p };
			for (const [k, v] of Object.entries(patch ?? {})) {
				if (v === null || v === '' || v === undefined || (k === 'gap' && v === false) || (k === 'ease' && v === 'linear')) delete merged[k];
				else merged[k] = v;
			}
			rec.points[i] = { ...normalizePathPointExtras(merged), pos: p.pos, radius: p.radius };
		}
		return rec;
	});
}

/** walk the other way round @param {string} uuid */
export function reversePathObject(uuid) {
	return editPath(uuid, (rec) => reversePath(rec));
}

/**
 * Split at point `index`: an open path becomes two Path objects, a closed one opens there.
 * One undo step. @param {string} uuid @param {number} index @returns {{ok: true, made?: string} | {ok: false, error: string}}
 */
export function splitPathObject(uuid, index) {
	const object = pathObjectOf(uuid);
	if (!object) return { ok: false, error: 'That is not a Path.' };
	const rec = normalizeSpline(object.userData.spline);
	const pieces = splitPath(rec, index);
	if (!pieces) return { ok: false, error: 'Split at a point in the middle (an end point has nothing to split).' };
	return batch('Split path', () => {
		if (pieces.length === 1) {
			commitSplineEdit(uuid, rec, pieces[0]);
			return { ok: true };
		}
		// the second piece becomes a new object where it already is (world space)
		const world = worldRecordOf(object);
		const second = { ...pieces[1], points: world.points.slice(index) };
		commitSplineEdit(uuid, rec, pieces[0]);
		const made = placeWorldRecord(second, (object.name || 'Path') + ' (2)');
		return made ? { ok: true, made: made.uuid } : { ok: false, error: 'Could not make the second piece.' };
	});
}

/**
 * Join B onto the end of A (B's points re-expressed in A's frame; a shared end point welds),
 * then delete B. One undo step. @param {string} uuidA @param {string} uuidB
 */
export function joinPathObjects(uuidA, uuidB) {
	const a = pathObjectOf(uuidA);
	const b = pathObjectOf(uuidB);
	if (!a || !b || a === b) return { ok: false, error: 'Pick two different Paths to join.' };
	a.updateWorldMatrix(true, false);
	const inv = new THREE.Matrix4().copy(a.matrixWorld).invert();
	const bWorld = worldRecordOf(b);
	const bInA = { ...bWorld, points: bWorld.points.map((/** @type {any} */ p) => ({ ...p, pos: new THREE.Vector3(...p.pos).applyMatrix4(inv).toArray() })) };
	const before = normalizeSpline(a.userData.spline);
	// weld within 2 cm (the line's own thickness)
	const after = joinPaths(before, bInA, 0.02);
	return batch('Join paths', () => {
		commitSplineEdit(uuidA, before, after);
		deleteObjectsByUuid([uuidB]);
		return { ok: true };
	});
}

/**
 * CONVERT a legacy Path patrol node: its clicked waypoints become a Path object (pose for pose
 * the same walk — tests/unit/pathCore.test.js), and the node walks that Path. One undo step.
 * @param {string} nodeId @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function convertPatrolNode(nodeId) {
	const found = findNodeAnyGraph((/** @type {any} */ n) => n.id === nodeId);
	if (!found || found.node.type !== 'pathpatrol') return { ok: false, error: 'That node is not a Path patrol.' };
	const conv = recordFromPatrol(found.node.data);
	if (!conv) return { ok: false, error: 'This patrol has fewer than two waypoints — nothing to convert.' };
	const world = { ...conv.record, points: conv.record.points.map((/** @type {any} */ p) => ({ ...p, pos: p.pos.map((/** @type {number} */ v, /** @type {number} */ i) => v + conv.center[i]) })) };
	return batch('Convert patrol to a Path', () => {
		const object = placeWorldRecord(world, 'Patrol path');
		if (!object) return { ok: false, error: 'Could not create the Path object.' };
		setNodeData(nodeId, { path: object.uuid, points: [] }, found.graphId);
		// creating selected the Path; the patrol's own object (if any) is what the user was on
		return { ok: true, path: object.uuid };
	});
}

/** select a Path and open it in the spline editor (the editor IS the Path editor) @param {string} uuid */
export async function editPathObject(uuid) {
	const object = pathObjectOf(uuid);
	if (!object) return false;
	selectedObject.set(object);
	selectedObjects.set([uuid]);
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach?.();
	const m = await import('../splineEdit');
	return m.enterSplineEdit(uuid);
}

/** say why a Path command was refused @param {{ok: boolean, error?: string}} r */
export function toastRefusal(r) {
	if (!r.ok && r.error) showToast(r.error);
	return r;
}
