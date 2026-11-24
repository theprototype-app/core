// 102-boot-diet — BEHAVIOURS LOAD WHEN SOMETHING NEEDS THEM, NOT AT BOOT.
//
// behaviours/app.js reaches the analyzer (acorn, ~34 KB gz), the sandbox guest and the behaviour
// runtime. Until 1.75 peerHandler imported it statically (for `bhv` receive + the handshake push), so
// every page paid for it before the first frame, including a played scene with no code in it.
// This leaf is what peerHandler imports now. app.js loads on the FIRST of:
//   - a `behaviour` node in any graph (flowRuntime's graph watch: a scene load, a joiner's node
//     sync, a node added by hand) -- that is the scene loader's own moment, so the chunk is fetched
//     while the rest of the scene is still arriving;
//   - a `bhv` message (queued here in order and delivered once the module is in);
//   - the AI layer (ai/tools.js, the assistant and the agent tab) -- it offers create_behaviour on an
//     empty scene, which needs the host app.js registers;
//   - the code workspace / behaviour view (they import app.js themselves, as before).
// flowRuntime registers the STARTER (emitter + startBehaviours), so behaviours still start exactly
// where they did, only later on a page that never needs them.
//
// A LEAF: svelte/store (+ joinArrival, two boot stores). Nothing here may import app.js statically.

import { writable } from 'svelte/store';
// app.js's "has the joiner's scene arrived" watch must run from boot (see joinArrival.js)
import './joinArrival.js';

/** @type {any} the loaded behaviours/app.js, or null */
let mod = null;
/** @type {Promise<any> | null} */
let loading = null;
/** @type {null | ((m: any) => void)} */
let starter = null;
/** `bhv` messages that arrived before the module (in order) @type {any[]} */
const queue = [];
const QUEUE_CAP = 512;

/** the loaded app.js module (null before it loads) — for UI that wants to react when it arrives */
export const behavioursModule = writable(/** @type {any} */ (null));

/** analyze.js (the behaviour analyzer: acorn) once loaded, for the editor panels that read a
 * behaviour's structure synchronously @type {import('svelte/store').Writable<null | typeof import('./analyze.js')>} */
export const analyzeLib = writable(null);
/** @type {Promise<any> | null} */
let analyzeLoading = null;
/** load the analyzer alone (an editor panel showing a behaviour) @returns {Promise<typeof import('./analyze.js') | null>} */
export function loadAnalyzer() {
	return (analyzeLoading ??= import('./analyze.js')
		.then((m) => {
			analyzeLib.set(m);
			return m;
		})
		.catch((error) => {
			analyzeLoading = null;
			console.warn('behaviour analyzer failed to load', error);
			return null;
		}));
}

/** has app.js loaded? */
export const behavioursLoaded = () => !!mod;

/** flowRuntime: what to do with the module once it is in (runs at once when it already is) @param {(m: any) => void} fn */
export function onBehavioursLoad(fn) {
	starter = fn;
	if (mod) fn(mod);
}

/** load behaviours/app.js (idempotent); resolves to the module, or null when it failed @returns {Promise<any>} */
export function loadBehaviours() {
	return (loading ??= Promise.all([import('./app.js'), loadAnalyzer()])
		.then(([m]) => {
			mod = m;
			try {
				starter?.(m);
			} catch (error) {
				console.warn('behaviours failed to start', error);
			}
			for (const data of queue.splice(0)) m.receiveBehaviourMessage(data);
			behavioursModule.set(m);
			return m;
		})
		.catch((error) => {
			loading = null;
			console.warn('behaviours failed to load', error);
			return null;
		}));
}

/** does a list of flow nodes hold a behaviour? (flowRuntime's graph watch) @param {Iterable<any>} nodes */
export function hasBehaviourNode(nodes) {
	for (const n of nodes) if (n?.type === 'behaviour') return true;
	return false;
}

/** a `bhv` message (already through wireValidate): delivered now, or queued until app.js is in @param {any} data */
export function receiveBehaviourMessage(data) {
	if (mod) return mod.receiveBehaviourMessage(data);
	if (queue.length >= QUEUE_CAP) queue.shift();
	queue.push(data);
	loadBehaviours();
	return false;
}

/** the handshake push: every behaviour document this peer holds — before app.js is in, the ones
 * still queued (a joiner takes the newer, so a repeat is harmless) @returns {any[]} */
export function behaviourPayloads() {
	return mod ? mod.behaviourPayloads() : queue.slice();
}
