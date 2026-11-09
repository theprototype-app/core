// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { buildSchedule, scheduleAt, scheduleEvents } from '../motion/motionCore.js';
import { normalizeSpline, isSplineObject } from '../splineTube.js';
import { isPathObject } from './pathCore.js';
import { editingPathUuid } from './pathState.js';
import { get } from 'svelte/store';

// 78 F4 + F9 — THE PATH OBJECT AT RUN TIME, the THREE half (a LEAF: three, the pure cores and one
// store leaf; never the history family — flowRuntime imports it statically).
//
//   - `pathOf(root, uuid)` is THE READ API (F9): everything a walker needs from a Path object —
//     its world points, its settings, its schedule, `poseAt(t)` and `eventsBetween(a, b)`.
//     61-nav's Patrol (61 G1) and any later reader (65 motion along a path, 68's dolly) call this
//     and nothing else: no fourth list of points.
//   - `applyPatrolOnPath` is the Path patrol node walking a Path object (flowRuntime's branch).
//
// A schedule is cached per Path uuid by a SIGNATURE of the record and the object's world matrix,
// so moving the Path object (or a peer's edit) rebuilds it, and nothing else does.

const vA = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** @type {Map<string, {sig: string, view: PathView}>} */
const cache = new Map();

/**
 * @typedef {{
 *   uuid: string, name: string, isPath: boolean,
 *   points: {pos: number[], wait?: number, speed?: number, ease?: string, gap?: boolean, event?: string, facing?: number}[],
 *   closed: boolean, smooth: boolean, mode: string, speed: number, seed: number, showInPlay: boolean, preview: boolean,
 *   schedule: import('../motion/motionCore.js').Schedule | null,
 *   period: number, length: number,
 *   poseAt: (t: number, o?: {start?: number, offset?: number}) => ReturnType<typeof scheduleAt> | null,
 *   eventsBetween: (a: number, b: number, o?: {start?: number, offset?: number}) => {at: number, point: number, event: string}[]
 * }} PathView
 */

/**
 * F9 — THE ONE READ API for a Path object (or any spline, read with Path defaults and the
 * caller's `fallback` settings). Null when the uuid is not a spline.
 * @param {any} root objectsGroup (or any ancestor) @param {string} uuid
 * @param {{mode?: string, speed?: number}} [fallback] settings for a PLAIN spline (no path block)
 * @returns {PathView | null}
 */
export function pathOf(root, uuid, fallback = {}) {
	if (!root || typeof uuid !== 'string' || !uuid) return null;
	const object = root.getObjectByProperty?.('uuid', uuid);
	return pathOfObject(object, fallback);
}

/**
 * The same, from the object itself.
 * @param {any} object @param {{mode?: string, speed?: number}} [fallback] @returns {PathView | null}
 */
export function pathOfObject(object, fallback = {}) {
	if (!object || !isSplineObject(object)) return null;
	object.updateWorldMatrix(true, false);
	const rec = normalizeSpline(object.userData.spline);
	const block = rec.path;
	const mode = block?.mode ?? (['loop', 'pingpong', 'once', 'random'].includes(/** @type {string} */ (fallback.mode)) ? /** @type {string} */ (fallback.mode) : 'loop');
	const speed = block?.speed ?? (Number.isFinite(fallback.speed) ? /** @type {number} */ (fallback.speed) : 1.5);
	const sig = JSON.stringify(rec) + '|' + mode + '|' + speed + '|' + object.matrixWorld.elements.map((/** @type {number} */ v) => v.toFixed(5)).join(',');
	const key = object.uuid + '|' + (block ? 'p' : 's');
	const hit = cache.get(key);
	if (hit && hit.sig === sig) return hit.view;
	const points = rec.points.map((p) => {
		const { radius: _r, pos, ...extras } = p;
		return { ...extras, pos: vA.fromArray(pos).applyMatrix4(object.matrixWorld).toArray() };
	});
	const smooth = block ? block.smooth : true;
	const schedule = buildSchedule(points, { closed: rec.closed, smooth, mode, speed, seed: block?.seed ?? 0 });
	const length = schedule ? schedule.spans.reduce((s, sp) => s + sp.total, 0) : 0;
	/** @type {PathView} */
	const view = {
		uuid: object.uuid,
		name: object.name || 'Path',
		isPath: !!block,
		points,
		closed: rec.closed,
		smooth,
		mode,
		speed,
		seed: block?.seed ?? 0,
		showInPlay: !!block?.showInPlay,
		preview: block ? block.preview : true,
		schedule,
		period: schedule?.period ?? 0,
		length,
		poseAt: (t, o) => (schedule ? scheduleAt(schedule, t, o) : null),
		eventsBetween: (a, b, o) => (schedule ? scheduleEvents(schedule, a, b, o) : [])
	};
	cache.set(key, { sig, view });
	if (cache.size > 256) cache.delete(/** @type {string} */ (cache.keys().next().value));
	return view;
}

/** every Path object under root (the patrol card's picker, the AI tools) @param {any} root @returns {any[]} */
export function pathObjectsIn(root) {
	/** @type {any[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (isPathObject(o)) out.push(o);
	});
	return out;
}

// ---- the Path patrol node on a Path object ---------------------------------------------------

/** per walker (node|object): the last effect time its events were read up to @type {Map<string, number>} */
const eventClock = new Map();
/** per walker: what it is doing (F7's "waiting at 3", the tests) @type {Map<string, {kind: string, point: number, next: number, path: string}>} */
const walkerState = new Map();

/** what the walker `key` is doing (null when it is not on a Path) @param {string} key */
export function patrolStateOf(key) {
	return walkerState.get(key) ?? null;
}

/** forget walkers (a scene load) */
export function resetPathRuntime() {
	eventClock.clear();
	walkerState.clear();
	cache.clear();
}

/** @param {any} object @param {number[]} p */
function setWorldPos(object, p) {
	vA.set(p[0], p[1], p[2]);
	const parent = object.parent;
	if (parent) {
		parent.updateWorldMatrix(true, false);
		parent.worldToLocal(vA);
	}
	object.position.copy(vA);
}

/** upright yaw in WORLD space, written as the local rotation @param {any} object @param {number} yaw */
function setWorldYaw(object, yaw) {
	const world = qA.setFromAxisAngle(UP, yaw);
	const parent = object.parent;
	if (parent) {
		parent.updateWorldMatrix(true, false);
		parent.getWorldQuaternion(qB);
		object.quaternion.copy(qB.invert().multiply(world));
	} else object.quaternion.copy(world);
}

/**
 * Walk a Path object. A pure function of (path, data, shared effect time, start stamp): every
 * peer computes the same pose. Arrival events are reported through `ctx.onEvent` with their
 * exact effect-clock time; the first sight of a walker only seeds its clock (a late joiner or
 * a reload never replays the past).
 * @param {any} object the walker @param {any} data the node's data (`path`, `offset`, `face`, legacy speed/mode)
 * @param {number} time the effect clock
 * @param {{root: any, key: string, nodeId?: string, start: number | null, onEvent?: (pathUuid: string, name: string, at: number, point: number) => void}} ctx
 * @returns {boolean} whether the walker was placed (false: no such path — the caller may fall back)
 */
export function applyPatrolOnPath(object, data, time, ctx) {
	const view = pathOf(ctx.root, data.path, { mode: data.mode, speed: data.speed });
	if (!view?.schedule) {
		walkerState.delete(ctx.key);
		return false;
	}
	const offset = Number.isFinite(+data.offset) ? +data.offset : 0;
	// a once-walk with nothing to start it stands at its first point
	const start = ctx.start ?? (view.mode === 'once' ? time + 1 : 0);
	const pose = view.poseAt(time, { start, offset });
	if (!pose) return false;
	setWorldPos(object, pose.p);
	if (data.face !== false) setWorldYaw(object, pose.yaw);
	const state = { kind: pose.kind, point: pose.point, next: pose.next, path: view.uuid };
	walkerState.set(ctx.key, state);
	// the node's card reads its (first) walker by node id
	if (ctx.nodeId) walkerState.set(ctx.nodeId, state);
	const last = eventClock.get(ctx.key);
	eventClock.set(ctx.key, time);
	// first sight, a scrub back, or a clock jump: seed, fire nothing
	if (last === undefined || time < last || time - last > 5) return true;
	if (ctx.onEvent)
		for (const ev of view.eventsBetween(last, time, { start, offset })) ctx.onEvent(view.uuid, ev.event, ev.at, ev.point);
	return true;
}

/**
 * Should walkers on this path hold still right now? In the EDITOR a path whose Preview is off,
 * or the path being edited, holds its walkers at their base pose ("Preview: off while editing").
 * Play always walks.
 * @param {any} root @param {string} uuid @param {boolean} playing
 */
export function pathPreviewHeld(root, uuid, playing) {
	if (playing || !uuid) return false;
	if (get(editingPathUuid) === uuid) return true;
	const object = root?.getObjectByProperty?.('uuid', uuid);
	const block = object?.userData?.spline?.path;
	return !!block && block.preview === false;
}
