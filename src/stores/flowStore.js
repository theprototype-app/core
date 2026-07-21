import { writable, get } from 'svelte/store';

// Shared node graph state, replicated between peers.
//
// H1 (flow v2): graphs are PER-OBJECT documents. `flowGraphs` is the source of
// truth -- a map keyed 'scene' | objectUuid, each entry {nodes, edges}. The
// legacy `flowNodes`/`flowEdges` stores remain as the ACTIVE graph's live VIEW
// (what the xyflow editor binds to); the mirror below keeps the two in sync.
// Code that needs the whole world (runtime, physics, serializers) reads
// flowGraphs; editor-scoped code keeps reading flowNodes/flowEdges.

export const SCENE_GRAPH = 'scene';

/** @type {import('svelte/store').Writable<Record<string, {nodes: any[], edges: any[]}>>} */
export const flowGraphs = writable({ [SCENE_GRAPH]: { nodes: [], edges: [] } });

/** The graph the editor is currently showing ('scene' or an object uuid -- the
 * uuid may have NO graph yet: the editor then shows the create-flow empty state). */
/** @type {import('svelte/store').Writable<string>} */
export const activeGraphId = writable(SCENE_GRAPH);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowNodes = writable([]);

/** @type {import('svelte/store').Writable<any[]>} */
export const flowEdges = writable([]);

// --- the view <-> store mirror (lives HERE, in the leaf store module, so the
// runtime/physics can consume flowGraphs without importing a module that pulls
// in history/peers -- history.js statically imports flowRuntime, and a
// flowRuntime -> flowGraphs -> history edge would close a TDZ cycle) ----------

let mirroring = false;
let mirrorStarted = false;

/** Read one graph document. @param {string} graphId */
export function graphOf(graphId) {
	const all = get(flowGraphs);
	return all?.[graphId] ?? null;
}

/** True when this graph document exists. @param {string} id */
export function graphExists(id) {
	return !!graphOf(id);
}

/** @param {string} graphId */
function pushViewFromGraph(graphId) {
	const graph = graphOf(graphId) ?? { nodes: [], edges: [] };
	mirroring = true;
	flowNodes.set(graph.nodes);
	flowEdges.set(graph.edges);
	mirroring = false;
}

/** Start the editor-view mirror (idempotent; wired from startFlowRuntime). */
export function startGraphMirror() {
	if (mirrorStarted || typeof window === 'undefined') return;
	mirrorStarted = true;
	// view -> store: editor edits (xyflow bind mutations, FlowCode applies, legacy
	// direct-view writers) land in the ACTIVE graph. An object view with no graph
	// document stays view-only (the empty state) -- documents are only born
	// through createObjectGraph (flowGraphs.js).
	flowNodes.subscribe((nodes) => {
		if (mirroring) return;
		const id = get(activeGraphId);
		flowGraphs.update((all) => {
			if (id !== SCENE_GRAPH && !all[id]) return all;
			return { ...all, [id]: { nodes, edges: all[id]?.edges ?? [] } };
		});
	});
	flowEdges.subscribe((edges) => {
		if (mirroring) return;
		const id = get(activeGraphId);
		flowGraphs.update((all) => {
			if (id !== SCENE_GRAPH && !all[id]) return all;
			return { ...all, [id]: { nodes: all[id]?.nodes ?? [], edges } };
		});
	});
	pushViewFromGraph(SCENE_GRAPH);
}

/**
 * Switch the editor to a graph. `id` may be an object uuid WITHOUT a graph --
 * the editor then shows the create-flow empty state over an empty view.
 * @param {string} id
 */
export function setActiveGraph(id) {
	const current = get(activeGraphId);
	if (current === id) return;
	activeGraphId.set(id);
	pushViewFromGraph(id);
}

/** Re-push the active graph into the view (after out-of-band store writes). */
export function refreshActiveView() {
	pushViewFromGraph(get(activeGraphId));
}

/**
 * Mutate one graph document (remote appliers use this so edits to NON-active
 * graphs apply without disturbing the editor). Mirrors into the view when the
 * mutated graph is the active one. Creates the document if missing.
 * @param {string} graphId
 * @param {(graph: {nodes: any[], edges: any[]}) => {nodes: any[], edges: any[]}} fn
 */
export function updateGraph(graphId, fn) {
	flowGraphs.update((all) => {
		const graph = all[graphId] ?? { nodes: [], edges: [] };
		return { ...all, [graphId]: fn(graph) };
	});
	if (get(activeGraphId) === graphId) pushViewFromGraph(graphId);
}

/** Remove a graph document (lifecycle wrappers in flowGraphs.js replicate/record).
 * @param {string} graphId */
export function removeGraphDocument(graphId) {
	if (graphId === SCENE_GRAPH) return;
	flowGraphs.update((all) => {
		if (!all[graphId]) return all;
		const next = { ...all };
		delete next[graphId];
		return next;
	});
	if (get(activeGraphId) === graphId) pushViewFromGraph(graphId);
}

/**
 * All nodes across every graph, each tagged with a runtime-only `__graph`
 * field (never serialized -- serializeNode copies explicit fields only). The
 * runtime uses the tag for implicit-owner targeting in object graphs.
 */
export function allNodes() {
	const all = get(flowGraphs);
	const out = [];
	for (const [graphId, graph] of Object.entries(all ?? {})) {
		for (const node of graph.nodes) {
			if (node.__graph !== graphId) node.__graph = graphId;
			out.push(node);
		}
	}
	return out;
}

/** Find a node in ANY graph. @param {(n: any) => boolean} pred
 * @returns {{node: any, graphId: string} | null} */
export function findNodeAnyGraph(pred) {
	const all = get(flowGraphs);
	for (const [graphId, graph] of Object.entries(all ?? {})) {
		const node = graph.nodes.find(pred);
		if (node) return { node, graphId };
	}
	return null;
}

/** All edges across every graph. */
export function allEdges() {
	const all = get(flowGraphs);
	const out = [];
	for (const graph of Object.values(all ?? {})) out.push(...graph.edges);
	return out;
}

/** nodes+edges count across every graph (nodesync drift heal). */
export function graphTotals() {
	const all = get(flowGraphs);
	let count = 0;
	for (const graph of Object.values(all ?? {})) count += graph.nodes.length + graph.edges.length;
	return count;
}

/**
 * Replace all graph documents (session/autosave restore). Resets the editor to
 * the scene graph.
 * @param {Record<string, {nodes: any[], edges: any[]}>} graphs
 */
export function restoreGraphs(graphs) {
	/** @type {Record<string, {nodes: any[], edges: any[]}>} */
	const next = { [SCENE_GRAPH]: { nodes: [], edges: [] } };
	for (const [graphId, graph] of Object.entries(graphs ?? {})) {
		next[graphId] = { nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
	}
	flowGraphs.set(next);
	activeGraphId.set(SCENE_GRAPH);
	pushViewFromGraph(SCENE_GRAPH);
}

/** Empty every graph (clear scene). */
export function clearGraphs() {
	flowGraphs.set({ [SCENE_GRAPH]: { nodes: [], edges: [] } });
	activeGraphId.set(SCENE_GRAPH);
	pushViewFromGraph(SCENE_GRAPH);
}

// scene object uuids whose flow effects (animations/colors) are muted locally
/** @type {import('svelte/store').Writable<string[]>} */
export const mutedFlowObjects = writable([]);

// live output value of each value/logic node (133), for the on-card readouts --
// the runtime writes it ~6/s; nodeId -> number | boolean | [x,y,z] | string
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const flowValues = writable({});

// event-node state (134): OnClick/Counter ride replicated trigger messages, not
// streamed state. nodeId -> { count, lastT } (lastT = shared synced time of the
// last pulse). A trigger log, deterministic because the timestamp is shared.
/** @type {import('svelte/store').Writable<Record<string, {count: number, lastT: number}>>} */
export const flowTriggers = writable({});

// live peer cursors in the flow editor: peerId -> { x, y, name, ts, graphId }
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const flowCursors = writable({});

// animations use wall-clock time so phases match across peers (NTP keeps
// machines within tens of ms); off = local page time like before
export const syncedAnimations = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('syncedAnimations') !== 'false'
);

// user-designed node definitions ({id, name, params, code}), replicated
/** @type {import('svelte/store').Writable<any[]>} */
export const customNodeDefs = writable([]);

// script side panel: node id being edited (null = closed)
/** @type {import('svelte/store').Writable<string | null>} */
export const scriptEditorOpen = writable(null);

// node designer modal: def being edited (null = closed, 'new' = create)
/** @type {import('svelte/store').Writable<any>} */
export const nodeDesignerOpen = writable(null);

// nodeId -> last script error message (shown as a badge on the node)
/** @type {import('svelte/store').Writable<Record<string, string>>} */
export const scriptErrors = writable({});
