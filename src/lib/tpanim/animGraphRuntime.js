// 57 M11: the Animation states graphs, running. Every frame (animatedImports.tickAnimatedMixers
// calls in through setAnimGraphTick) each model with a graph gets its parameters — the graph's
// defaults, the SYNCED ones (Set Animation Parameter, the window, the API) and, for a `motion`
// driver, speed / vy / grounded read from how the object moves — steps its machine (animGraph.js)
// and feeds the result to its pose driver. Every peer does this itself from the same inputs:
// nothing per frame or per state travels. A parameter set outside a graph (the window, the API) is
// ONE `objectParameters 'animParam'` message, latest-wins by its stamp.
//
// Lazy: animatedImports loads it only when a model carries a graph.

import { get, writable } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { setAnimGraphTick, setPoseDriver, clearPoseDriver, clipInfo, hasClipModel } from '../animatedImports';
import { runtimeNow } from '../moduleSDK';
import { normalizeAnimGraph, newRun, stepGraph, motionParams } from './animGraph.js';
import { newTracker, trackPose } from '../avatars/locomotion.js';

/** @type {Map<string, {graph: any, run: any, tracker: any, memo: {groundedFor: number}, last: number, params: Record<string, any>, root: any}>} */
const graphs = new Map();
/** uuid -> name -> {v, at} @type {Map<string, Map<string, {v: any, at: number}>>} */
const synced = new Map();
/** what the window shows: uuid -> {state, params}, refreshed ~6 times a second @type {import('svelte/store').Writable<Record<string, {state: string, params: Record<string, any>}>>} */
export const animStates = writable({});
/** On Animation State: (uuid, stateId, stateName) => void @type {Set<(uuid: string, id: string, name: string) => void>} */
const enterListeners = new Set();
const _pos = new THREE.Vector3();
let lastPublish = 0;

/** be told when a model's machine enters a state @param {(uuid: string, id: string, name: string) => void} fn */
export function onAnimStateEnter(fn) {
	enterListeners.add(fn);
	return () => enterListeners.delete(fn);
}

/** (re)read one model's graph from its userData @param {string} uuid */
export function syncAnimGraph(uuid) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const graph = normalizeAnimGraph(root?.userData?.animGraph);
	const held = graphs.get(uuid);
	if (!graph || !root) {
		if (held) {
			graphs.delete(uuid);
			clearPoseDriver(uuid);
			animStates.update((m) => {
				const next = { ...m };
				delete next[uuid];
				return next;
			});
		}
		return;
	}
	const t = runtimeNow();
	// an edit keeps the run where it is when its state still exists
	const run = held && graph.states.some((/** @type {any} */ s) => s.id === held.run.state) ? held.run : newRun(graph, t);
	graphs.set(uuid, { graph, run, tracker: held?.tracker ?? newTracker(), memo: held?.memo ?? { groundedFor: 1 }, last: held?.last ?? t, params: held?.params ?? {}, root });
	setAnimGraphTick(tick);
}

/** the live reading of a model's machine (state id + parameters), or null @param {string} uuid */
export function animGraphReading(uuid) {
	const e = graphs.get(uuid);
	return e ? { state: e.run.state, params: { ...e.params } } : null;
}

/**
 * Set a parameter. `replicate` false = this peer only (a graph node: every peer runs it from the
 * same trigger); otherwise ONE message. Latest-wins by `at` (a synced stamp).
 * @param {string} uuid @param {string} name @param {number | boolean} value @param {{replicate?: boolean, at?: number}} [opts]
 */
export function setAnimParam(uuid, name, value, opts = {}) {
	const at = Number.isFinite(opts.at) ? /** @type {number} */ (opts.at) : runtimeNow();
	let map = synced.get(uuid);
	if (!map) synced.set(uuid, (map = new Map()));
	const held = map.get(name);
	if (held && held.at > at) return false;
	map.set(name, { v: value, at });
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'objectParameters', parameter: 'animParam', uuid, name, value, at });
	}
	return true;
}

/** fire a trigger parameter (its value IS the stamp) @param {string} uuid @param {string} name @param {{replicate?: boolean, at?: number}} [opts] */
export function fireAnimTrigger(uuid, name, opts = {}) {
	const at = Number.isFinite(opts.at) ? /** @type {number} */ (opts.at) : runtimeNow();
	return setAnimParam(uuid, name, at, { ...opts, at });
}

/** @param {number} time */
function tick(time) {
	if (!graphs.size) return;
	const publish = time - lastPublish > 0.16 || time < lastPublish;
	/** @type {Record<string, {state: string, params: Record<string, any>}>} */
	const reading = {};
	for (const [uuid, e] of graphs) {
		const root = e.root?.parent ? e.root : get(objectsGroup)?.getObjectByProperty('uuid', uuid);
		if (!root || !hasClipModel(uuid)) {
			graphs.delete(uuid);
			continue;
		}
		e.root = root;
		const dt = Math.min(Math.max(time - e.last, 0), 0.1);
		e.last = time;
		/** @type {Record<string, any>} */
		const params = {};
		for (const p of e.graph.params) params[p.name] = p.default ?? (p.type === 'bool' ? false : p.type === 'trigger' ? -Infinity : 0);
		if (e.graph.driver === 'motion') {
			root.getWorldPosition(_pos);
			trackPose(e.tracker, [_pos.x, _pos.y, _pos.z], time);
			Object.assign(params, motionParams(e.tracker.vel, e.memo, dt));
		}
		for (const [name, { v }] of synced.get(uuid) ?? []) params[name] = v;
		const info = clipInfo(uuid);
		/** @type {Record<string, number>} */
		const durations = {};
		for (const c of info) durations[c.name] = c.duration;
		const out = stepGraph(e.graph, e.run, params, time, Object.keys(durations), durations);
		setPoseDriver(uuid, out.weights, out.rates, { times: out.times });
		e.params = params;
		if (out.entered) {
			const st = e.graph.states.find((/** @type {any} */ s) => s.id === out.state);
			for (const fn of enterListeners) {
				try {
					fn(uuid, out.state, st?.name ?? out.state);
				} catch (error) {
					console.log('animation state listener failed', error);
				}
			}
		}
		if (publish) reading[uuid] = { state: out.state, params };
	}
	if (publish) {
		lastPublish = time;
		animStates.set(reading);
	}
	if (!graphs.size) setAnimGraphTick(null);
}

// a scene load that brings graphs: every model already registered gets read once
for (const child of get(objectsGroup)?.children ?? []) if (child?.userData?.animGraph) syncAnimGraph(child.uuid);
