import { get } from 'svelte/store';
import {
	flowGraphs,
	graphOf,
	updateGraph,
	SCENE_GRAPH,
	graphExists
} from '../stores/flowStore';
import { peers } from '../stores/appStore';

// H5 (flow v2): object flows embedded in the SCENE graph as `objectflow` nodes.
// The embedded node's sockets are DECLARED by Flow Input / Flow Output interface
// nodes inside the object flow; this module derives that interface, keeps scene
// edges pruned when the interface changes (deterministic applier-side invariant,
// the customNodes precedent), and removes embeds when their flow dies.

/**
 * The declared public interface of an object flow.
 * @param {string} graphId
 * @returns {{inputs: {name: string, vtype: string}[], outputs: {name: string}[]}}
 */
export function interfaceOf(graphId) {
	const graph = graphOf(graphId);
	/** @type {{name: string, vtype: string}[]} */
	const inputs = [];
	/** @type {{name: string}[]} */
	const outputs = [];
	if (graph) {
		const seenIn = new Set();
		const seenOut = new Set();
		for (const node of graph.nodes) {
			if (node.type === 'flowinput') {
				const name = node.data?.name ?? 'value';
				if (!seenIn.has(name)) {
					seenIn.add(name);
					inputs.push({ name, vtype: node.data?.vtype ?? 'number' });
				}
			} else if (node.type === 'flowoutput') {
				const name = node.data?.name ?? 'out';
				if (!seenOut.has(name)) {
					seenOut.add(name);
					outputs.push({ name });
				}
			}
		}
	}
	return { inputs, outputs };
}

/** Objects that HAVE a flow document (for the embed node's picker). */
export function graphsAvailableToEmbed() {
	return Object.keys(get(flowGraphs)).filter((id) => id !== SCENE_GRAPH);
}

/**
 * Prune edges wired to embed sockets that the target flow no longer declares
 * (renamed/retyped/deleted interface nodes). Pure function of graph state —
 * idempotent and applied identically on every peer, never broadcast.
 */
export function pruneObjectFlowEdges() {
	const all = get(flowGraphs);
	for (const [graphId, graph] of Object.entries(all)) {
		/** @type {Set<string>} */
		const bad = new Set();
		for (const node of graph.nodes) {
			if (node.type !== 'objectflow') continue;
			const iface = interfaceOf(node.data?.flowUuid ?? '');
			const inNames = new Set(iface.inputs.map((i) => i.name));
			const outNames = new Set(iface.outputs.map((o) => o.name));
			for (const edge of graph.edges) {
				if (edge.target === node.id && edge.targetHandle && !inNames.has(edge.targetHandle))
					bad.add(edge.id);
				if (edge.source === node.id && edge.sourceHandle && !outNames.has(edge.sourceHandle))
					bad.add(edge.id);
			}
		}
		if (bad.size)
			updateGraph(graphId, (g) => ({
				nodes: g.nodes,
				edges: g.edges.filter((e) => !bad.has(e.id))
			}));
	}
}

/**
 * Remove every embedded node referencing a flow (called when the flow is
 * deleted, on BOTH the local and applier paths — deterministic cleanup).
 * @param {string} flowUuid
 */
export function removeEmbedsOf(flowUuid) {
	const all = get(flowGraphs);
	for (const [graphId, graph] of Object.entries(all)) {
		const ids = graph.nodes
			.filter((n) => n.type === 'objectflow' && n.data?.flowUuid === flowUuid)
			.map((n) => n.id);
		if (!ids.length) continue;
		updateGraph(graphId, (g) => ({
			nodes: g.nodes.filter((n) => !ids.includes(n.id)),
			edges: g.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target))
		}));
	}
}

/**
 * Context-menu entry point: drop an object's flow into the SCENE graph as an
 * embedded node (replicated like any editor-created node).
 * @param {string} flowUuid @param {string} [label] object name for the card
 */
export function addObjectFlowToScene(flowUuid, label) {
	if (!graphExists(flowUuid)) return false;
	const scene = graphOf(SCENE_GRAPH);
	// embed once per graph (v1) — jump duplicates instead of stacking them
	if (scene?.nodes.some((n) => n.type === 'objectflow' && n.data?.flowUuid === flowUuid))
		return false;
	const node = {
		id: crypto.randomUUID(),
		type: 'objectflow',
		position: { x: 80 + Math.floor(Math.random() * 40), y: 80 + Math.floor(Math.random() * 40) },
		data: { type: 'objectflow', label: label || 'Object Flow', flowUuid },
		class: 'w-[170px]'
	};
	updateGraph(SCENE_GRAPH, (g) => ({ nodes: [...g.nodes, node], edges: g.edges }));
	/** @type {any} */
	const peer = get(peers);
	if (peer) {
		peer.send({
			type: 'nodecreate',
			node: {
				id: node.id,
				type: node.type,
				position: node.position,
				data: { ...node.data },
				class: node.class
			},
			graphId: SCENE_GRAPH
		});
	}
	return true;
}

// --- interface-change watcher --------------------------------------------------

let watcherStarted = false;
let lastSignature = '';

/** Signature of every graph's declared interface (names + types). */
function interfaceSignature() {
	const all = get(flowGraphs);
	/** @type {any[]} */
	const parts = [];
	for (const graphId of Object.keys(all).sort()) {
		if (graphId === SCENE_GRAPH) continue;
		const iface = interfaceOf(graphId);
		if (iface.inputs.length || iface.outputs.length) parts.push([graphId, iface]);
	}
	return JSON.stringify(parts);
}

/** Re-prune embed edges whenever any flow's declared interface changes. */
export function startObjectFlowWatcher() {
	if (watcherStarted || typeof window === 'undefined') return;
	watcherStarted = true;
	lastSignature = interfaceSignature();
	flowGraphs.subscribe(() => {
		const signature = interfaceSignature();
		if (signature === lastSignature) return;
		lastSignature = signature;
		pruneObjectFlowEdges();
	});
}
