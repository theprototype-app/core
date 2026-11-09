// 78 F7 — LIVE STATE ON NODE CARDS: one short line under a card that says what the node is doing
// right now ("count 3", "on", "fired 1.2 s ago", "to point 3", "resting until Play"), so a graph
// can be read while it runs instead of only in the Debugger panel.
//
// A REGISTRY: `registerLiveState(type, reader)` — a reader turns (node, api) into a string or null.
// The built-ins below cover the logic and trigger nodes that exist today; a lane that adds a node
// with a state worth showing (78-nodes' Hover / Toggle Animation "open / closed", 78-path's Path
// object "waiting at 3") registers one line. A reader must be cheap and must not throw: it runs
// ~4 times a second for the cards of the ONE graph the node editor shows, and only while it shows one.
//
// A LEAF (svelte/store + editorMotion): flowRuntime calls `publishLiveStates` from its tick with
// closures over its own evaluator, so nothing here reaches the runtime.

import { writable } from 'svelte/store';
import { EDITOR_MOTION_TYPES } from './editorMotion';

/**
 * @typedef {{
 *   value: () => any,
 *   pulseAge: () => number | null,
 *   motionTime: number,
 *   motionRests: boolean,
 *   capturing: string | null
 * }} LiveStateApi
 *   `value` = the node's output this tick (evaluated on demand); `pulseAge` = seconds since its last
 *   trigger stamp (null = never); `motionTime` = the clock motion nodes evaluate on; `motionRests` =
 *   "Animate in editor" is off and this is the editor; `capturing` = the Path patrol node placing points
 * @typedef {(node: any, api: LiveStateApi) => string | null | undefined} LiveStateReader
 */

/** @type {Map<string, LiveStateReader>} */
const readers = new Map();

/** Register the live-state line for a node type (a later registration replaces it). @param {string} type @param {LiveStateReader} reader @returns {() => void} unregister */
export function registerLiveState(type, reader) {
	readers.set(type, reader);
	return () => {
		if (readers.get(type) === reader) readers.delete(type);
	};
}

/** @param {string} type */
export function hasLiveState(type) {
	return readers.has(type) || EDITOR_MOTION_TYPES.has(type);
}

/** which graph's cards want live states (the node editor sets it while it is mounted) @type {import('svelte/store').Writable<string | null>} */
export const liveStateGraph = writable(null);
let wantedGraph = /** @type {string | null} */ (null);
liveStateGraph.subscribe((id) => (wantedGraph = id));

/** is any card waiting for live lines? (the runtime's one cheap test per tick) */
export function liveStatesWanted() {
	return wantedGraph !== null;
}

/** node id -> its live line, for the wanted graph @type {import('svelte/store').Writable<Record<string, string>>} */
export const nodeLiveStates = writable({});

/** "fired 1.2 s ago" for a pulse inside the last 10 s @param {number | null} age */
export function firedText(age) {
	if (age === null || !Number.isFinite(age) || age < 0 || age > 10) return null;
	return age < 1 ? 'fired just now' : `fired ${age.toFixed(age < 10 ? 1 : 0)} s ago`;
}

/** On / off for a boolean-ish value @param {any} v */
const onOff = (v) => (v === true || (typeof v === 'number' && v > 0.5) ? 'on' : 'off');

/**
 * Which patrol point a Path patrol node is heading to at `time` — the same walk flowRuntime's
 * applyPathPatrol takes (loop / ping-pong), as a 1-based point number. Pure.
 * @param {any} data @param {number} time @returns {number | null}
 */
export function patrolTarget(data, time) {
	const points = Array.isArray(data?.points) ? data.points : [];
	if (points.length < 2) return null;
	const speed = Number(data.speed ?? 1) || 0;
	const loop = (data.mode ?? 'loop') === 'loop';
	const count = loop ? points.length : points.length - 1;
	/** @type {number[]} */
	const lengths = [];
	let total = 0;
	for (let i = 0; i < count; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
		lengths.push(l);
		total += l;
	}
	if (total <= 0 || speed <= 0) return null;
	let distance;
	let reverse = false;
	if (loop) distance = (time * speed) % total;
	else {
		const cycle = (time * speed) % (2 * total);
		reverse = cycle > total;
		distance = reverse ? 2 * total - cycle : cycle;
	}
	for (let i = 0; i < lengths.length; i++) {
		if (distance > lengths[i]) {
			distance -= lengths[i];
			continue;
		}
		// segment i runs point i -> i+1; walking back it runs i+1 -> i
		return reverse ? i + 1 : ((i + 1) % points.length) + 1;
	}
	return reverse ? 1 : points.length;
}

// --- the built-ins -----------------------------------------------------------------------
const TRIGGERS = ['onclick', 'ongrab', 'onhit', 'onimpact', 'onrest', 'onenter', 'onexit', 'keypress', 'gamepadbutton', 'hudbutton', 'ongamestate', 'animfinished', 'animmarker', 'onanimstate', 'onclap', 'onseqevent', 'allplayers'];
for (const type of TRIGGERS) registerLiveState(type, (_node, api) => firedText(api.pulseAge()));
registerLiveState('counter', (_node, api) => {
	const v = api.value();
	return typeof v === 'number' && Number.isFinite(v) ? `count ${Math.round(v * 100) / 100}` : null;
});
registerLiveState('latch', (_node, api) => onOff(api.value()));
registerLiveState('once', (_node, api) => (api.pulseAge() === null ? 'armed' : 'fired'));
registerLiveState('compare', (_node, api) => (api.value() ? 'true' : 'false'));
registerLiveState('getvariable', (_node, api) => {
	const v = api.value();
	return v === undefined || v === null ? null : `= ${typeof v === 'number' ? Math.round(v * 100) / 100 : String(v).slice(0, 24)}`;
});
registerLiveState('pathpatrol', (node, api) => {
	if (api.capturing === node.id) return 'placing points';
	if (api.motionRests) return 'resting until Play';
	const to = patrolTarget(node.data, api.motionTime);
	return to === null ? null : `to point ${to}`;
});

let publishedAt = -Infinity;
let lastJson = '';

/**
 * Called by flowRuntime at the end of its tick. Throttled to ~4 Hz, only for the wanted graph's
 * nodes, and the store is written only when a line changed.
 * @param {{ nodes: any[], now: number, motionTime: number, motionRests: boolean, capturing: string | null,
 *   value: (node: any) => any, pulseAt: (id: string) => number | null, time: number }} tick
 */
export function publishLiveStates(tick) {
	if (!wantedGraph) return;
	if (tick.now - publishedAt < 250) return;
	publishedAt = tick.now;
	/** @type {Record<string, string>} */
	const out = {};
	for (const node of tick.nodes) {
		if ((node.__graph ?? 'scene') !== wantedGraph || node.data?.muted) continue;
		const reader = readers.get(node.type);
		/** @type {string | null | undefined} */
		let text = null;
		if (reader) {
			try {
				text = reader(node, {
					value: () => tick.value(node),
					pulseAge: () => {
						const at = tick.pulseAt(node.id);
						return at === null || at === undefined ? null : tick.time - at;
					},
					motionTime: tick.motionTime,
					motionRests: tick.motionRests,
					capturing: tick.capturing
				});
			} catch {
				text = null;
			}
		} else if (tick.motionRests && EDITOR_MOTION_TYPES.has(node.type)) text = 'resting until Play';
		if (text) out[node.id] = String(text).slice(0, 40);
	}
	const json = JSON.stringify(out);
	if (json === lastJson) return;
	lastJson = json;
	nodeLiveStates.set(out);
}

/** forget the published lines (the editor closed) */
export function clearLiveStates() {
	lastJson = '';
	publishedAt = -Infinity;
	nodeLiveStates.set({});
}
