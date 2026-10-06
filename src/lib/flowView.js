import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';

// 36 F10 — WHERE THE NODE EDITOR OPENS. A leaf (svelte/store + safeStorage), so flowStore,
// sessions, autosave, Settings and Nodes.svelte can all reach it with no cycle.
//
// The user's report (1.25 feedback): opening the node editor on a template showed some other
// corner of the canvas. The pane fitted ONCE, at mount (xyflow's `fitView` prop) — loading a
// second scene with the editor open kept the first scene's pan and zoom, and nothing anywhere
// remembered where a creator had left a graph. Now:
//
//   · a graph somebody PANNED or ZOOMED by hand has a saved view: its CENTRE in flow
//     coordinates + the zoom (a centre, not xyflow's top-left translate, so the view lands the
//     same on a phone and on a 4K pane). Only a user gesture records one — a programmatic fit
//     (frame all, focus a node) is not "where it was left".
//   · the saved views ride the scene file (`flowViews`, omitted when there are none, so every
//     template the author script writes — no hand ever moved its view — opens FRAMED).
//   · opening the editor, switching graphs or loading a scene shows the graph's saved view,
//     else frames every node (the A command). The setting "Node editor opens" = 'left' (the
//     default: where it was left, framed when nothing was left) or 'framed' (always frame).
//
// Views are a LOCAL editor convenience: never replicated, never in the graph hash.

/** @typedef {{x: number, y: number, zoom: number}} FlowView  x/y = the pane CENTRE in flow coordinates */
/** @typedef {'left' | 'framed'} NodeEditorOpens */

const KEY = 'flow:opens';

/** @param {any} value @returns {NodeEditorOpens} */
export function normalizeOpens(value) {
	return value === 'framed' ? 'framed' : 'left';
}

/** @type {import('svelte/store').Writable<NodeEditorOpens>} */
export const nodeEditorOpens = writable(normalizeOpens(safeStorage.getItem(KEY)));
nodeEditorOpens.subscribe((value) => safeStorage.setItem(KEY, normalizeOpens(value)));

/** the choices, as DATA, so the Settings row and the docs cannot drift */
export const NODE_EDITOR_OPENS = [
	{ value: 'left', name: 'Where it was left (framed when new)' },
	{ value: 'framed', name: 'Framed — every node in view' }
];

/** the zoom range the editor allows (Nodes.svelte minZoom / maxZoom) */
export const VIEW_ZOOM = { min: 0.2, max: 1 };

/** @type {Map<string, FlowView>} graphId -> where it was left */
const views = new Map();

/**
 * Bumped whenever the graph documents are replaced wholesale (a scene load, a restore, a
 * cleared scene). The editor watches it: a new scene is a new "open".
 */
export const flowViewEpoch = writable(0);

/** @param {any} v @returns {FlowView | null} */
export function sanitizeView(v) {
	if (!v || typeof v !== 'object') return null;
	const x = Number(v.x);
	const y = Number(v.y);
	const zoom = Number(v.zoom);
	if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return null;
	const z = Math.min(VIEW_ZOOM.max, Math.max(VIEW_ZOOM.min, zoom));
	// 3 decimals: a saved file stays readable and stable across a save -> load -> save
	const r = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
	return { x: r(x), y: r(y), zoom: r(z) };
}

/** A user gesture left `graphId` at this view. @param {string} graphId @param {any} view */
export function rememberView(graphId, view) {
	const v = sanitizeView(view);
	if (!graphId || !v) return;
	views.set(graphId, v);
}

/** @param {string} graphId @returns {FlowView | null} */
export function savedView(graphId) {
	return views.get(graphId) ?? null;
}

/** Forget one graph's view (it was deleted). @param {string} graphId */
export function forgetView(graphId) {
	views.delete(graphId);
}

/**
 * What the editor shows when `graphId` opens: its saved view, or a frame of every node.
 * @param {string} graphId @param {NodeEditorOpens} opens
 * @returns {{kind: 'saved', view: FlowView} | {kind: 'frame'}}
 */
export function openingView(graphId, opens) {
	const view = normalizeOpens(opens) === 'left' ? savedView(graphId) : null;
	return view ? { kind: 'saved', view } : { kind: 'frame' };
}

/**
 * The scene file's `flowViews` field: null when no graph has a saved view (the caller omits
 * it, so a scene nobody panned saves byte-identical to an older build's).
 * @param {(graphId: string) => boolean} [keep] drop views of graphs that are not saved
 * @returns {Record<string, FlowView> | null}
 */
export function flowViewsSnapshot(keep) {
	/** @type {Record<string, FlowView>} */
	const out = {};
	for (const [id, v] of [...views.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (!keep || keep(id)) out[id] = { ...v };
	}
	return Object.keys(out).length ? out : null;
}

/**
 * A scene arrived: its views REPLACE this session's (absent = none, so the new scene's graphs
 * open framed), and the editor re-opens the active graph.
 * @param {any} raw the file's `flowViews` (anything; junk is dropped)
 */
export function loadFlowViews(raw) {
	views.clear();
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [id, v] of Object.entries(raw)) rememberView(id, v);
	}
	flowViewEpoch.update((n) => n + 1);
}

/**
 * The xyflow viewport (top-left translate) that puts `view`'s centre in the middle of a
 * `w` x `h` pane, and back. Pure, so the round trip is unit-tested.
 * @param {FlowView} view @param {number} w @param {number} h
 */
export function viewportOf(view, w, h) {
	return { x: w / 2 - view.x * view.zoom, y: h / 2 - view.y * view.zoom, zoom: view.zoom };
}
/** @param {{x: number, y: number, zoom: number}} vp @param {number} w @param {number} h @returns {FlowView} */
export function viewOf(vp, w, h) {
	const zoom = vp.zoom || 1;
	return { x: (w / 2 - vp.x) / zoom, y: (h / 2 - vp.y) / zoom, zoom };
}
