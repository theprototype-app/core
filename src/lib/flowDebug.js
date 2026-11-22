// 48 D1 — THE NODE GRAPH DEBUGGER: what the panel and the node editor read and write.
//
// LOCAL by design (the decision: "LOCAL to the person debugging"). Breakpoints and watches are
// this device's, never node data: node data replicates and is part of the graph hash, so a
// breakpoint written there would pause nobody but cost every peer a nodesync. They are kept by
// node id in safeStorage; an id that is not in the scene is simply never hit.
//
// A LEAF (svelte/store, sceneStore, safeStorage and the pure core): flowRuntime imports it, and
// anything flowRuntime imports must not reach history (the documented SSR prerender cycle).
// The runtime half — the paused view, the queue, Step — lives in flowRuntime beside the tick it
// pauses; this file only carries REQUESTS to it (`dbg.request`) and the status it publishes back.
//
// ZERO COST WHEN IDLE: flowRuntime's tick and applyNodeTrigger test ONE property, `dbg.armed`,
// which is true only in Play, outside a headset, with a breakpoint set, a pause held or the panel
// open. Nothing else here runs per frame.

import { writable, get } from 'svelte/store';
import { isLocked, isVRMode } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { normalizeBreakpoints, normalizeWatches, watchKey } from './flowDebugCore.js';

const STORE_KEY = 'tp.flowDebug';

/** @typedef {{kind: 'var'|'player'|'node', key: string, handle?: string}} Watch */

function readSaved() {
	try {
		const raw = JSON.parse(safeStorage.getItem(STORE_KEY) || '{}');
		return {
			breakpoints: normalizeBreakpoints(raw?.breakpoints),
			watches: normalizeWatches(raw?.watches)
		};
	} catch {
		return { breakpoints: [], watches: [] };
	}
}

const saved = readSaved();

/** node ids with a breakpoint (LOCAL) @type {import('svelte/store').Writable<string[]>} */
export const debugBreakpoints = writable(saved.breakpoints);
/** the watch list (LOCAL) @type {import('svelte/store').Writable<Watch[]>} */
export const debugWatches = writable(saved.watches);
/** the Debugger panel is open */
export const debugOpen = writable(false);
/** the node whose wires the panel shows (null = the paused node, else the first breakpoint) @type {import('svelte/store').Writable<string|null>} */
export const debugFocus = writable(/** @type {string|null} */ (null));

/**
 * What the runtime says about itself (published on change, never per frame).
 * @typedef {{mode: 'off'|'running'|'paused', playing: boolean, xr: boolean,
 *   at: null | {nodeId: string|null, label: string, why: 'breakpoint'|'step'|'moment'|'pause', bp: string|null},
 *   queued: number, dropped: number, next: string, waiting: boolean, sandboxed: boolean, steps: number}} DebugStatus
 */
/** @type {import('svelte/store').Writable<DebugStatus>} */
export const debugStatus = writable({
	mode: 'off',
	playing: false,
	xr: false,
	at: null,
	queued: 0,
	dropped: 0,
	next: '',
	waiting: false,
	sandboxed: false,
	steps: 0
});

/**
 * The values the panel shows, published by the runtime (≤ ~6/s running, after every step paused).
 * @typedef {{edgeId: string, nodeId: string, label: string, handle: string, kind: 'event'|'value', text: string, high: boolean}} WireRow
 * @typedef {{key: string, label: string, text: string, missing: boolean}} WatchRow
 * @type {import('svelte/store').Writable<{focus: null | {id: string, label: string, type: string, eventless: boolean, why?: {last: string, standing: string | null} | null}, inputs: WireRow[], outputs: WireRow[], watches: WatchRow[]}>}
 */
export const debugValues = writable({ focus: null, inputs: [], outputs: [], watches: [] });

/**
 * THE RUNTIME'S VIEW, a plain object so the per-frame test is a property read, not a store get.
 * `request` is the one-slot mailbox the panel writes and the next tick consumes.
 */
export const dbg = {
	armed: false,
	playing: false,
	xr: false,
	open: false,
	paused: false,
	/** @type {Set<string>} */
	breakpoints: new Set(saved.breakpoints),
	/** bumped whenever the breakpoint set changes (the runtime caches its reach map on it) */
	version: 0,
	/** @type {null | 'step' | 'resume' | 'pause'} */
	request: /** @type {null | 'step' | 'resume' | 'pause'} */ (null),
	/** @type {Watch[]} */
	watches: saved.watches,
	/** @type {string|null} */
	focus: /** @type {string|null} */ (null)
};

function rearm() {
	dbg.armed = dbg.playing && !dbg.xr && (dbg.breakpoints.size > 0 || dbg.paused || dbg.open);
}

function persist() {
	safeStorage.setItem(
		STORE_KEY,
		JSON.stringify({ breakpoints: [...dbg.breakpoints], watches: dbg.watches })
	);
}

/** the runtime flips this as it enters / leaves a pause @param {boolean} on */
export function setDebugPaused(on) {
	dbg.paused = on;
	rearm();
}

/** @param {string} id */
export function hasBreakpoint(id) {
	return dbg.breakpoints.has(id);
}

/** Toggle a breakpoint (or force it with `on`). Returns whether it is set now.
 * @param {string} id @param {boolean} [on] */
export function toggleBreakpoint(id, on) {
	if (typeof id !== 'string' || !id) return false;
	const want = on ?? !dbg.breakpoints.has(id);
	debugBreakpoints.update((list) => {
		const next = list.filter((x) => x !== id);
		if (want) next.push(id);
		return normalizeBreakpoints(next);
	});
	return want;
}

export function clearBreakpoints() {
	debugBreakpoints.set([]);
}

/** @param {Watch} watch */
export function addWatch(watch) {
	debugWatches.update((list) => normalizeWatches([...list, watch]));
}

/** @param {string} key a watchKey */
export function removeWatch(key) {
	debugWatches.update((list) => list.filter((w) => watchKey(w) !== key));
}

/** @param {'step'|'resume'|'pause'} what */
export function requestDebug(what) {
	dbg.request = what;
	// a Pause / Step pressed with no pause held must reach a tick even with no breakpoint set
	if (what === 'pause' && dbg.playing && !dbg.xr) dbg.armed = true;
}

/** @param {boolean} open */
export function setDebugOpen(open) {
	debugOpen.set(!!open);
}

let installed = false;
/** Wire the stores to the runtime view. Called once from startFlowRuntime (never at module eval:
 * a module-level subscribe runs its callback synchronously, the documented TDZ trap). */
export function installFlowDebug() {
	if (installed) return;
	installed = true;
	debugBreakpoints.subscribe((list) => {
		dbg.breakpoints = new Set(list);
		dbg.version++;
		rearm();
		persist();
	});
	debugWatches.subscribe((list) => {
		dbg.watches = list;
		persist();
	});
	debugOpen.subscribe((v) => {
		dbg.open = v;
		rearm();
	});
	debugFocus.subscribe((v) => (dbg.focus = v));
	isLocked.subscribe((v) => {
		dbg.playing = v === true;
		rearm();
	});
	isVRMode.subscribe((v) => {
		dbg.xr = !!v;
		rearm();
	});
}

/** test/debug view */
export function flowDebugState() {
	return {
		armed: dbg.armed,
		playing: dbg.playing,
		paused: dbg.paused,
		open: dbg.open,
		breakpoints: [...dbg.breakpoints],
		watches: dbg.watches.map((w) => ({ ...w })),
		status: get(debugStatus),
		values: get(debugValues)
	};
}
