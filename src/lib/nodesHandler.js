import { get } from 'svelte/store';
import {
	flowNodes,
	flowEdges,
	flowGraphs,
	flowCursors,
	SCENE_GRAPH,
	updateGraph,
	graphTotals,
	activeGraphId
} from '../stores/flowStore';
import { peers } from '../stores/appStore';

// Strip runtime-only fields (computed, selected, dragging, __graph) so the node
// is serializable for peerjs
/** @param {any} node */
export function serializeNode(node) {
	return {
		id: node.id,
		type: node.type,
		position: { x: node.position.x, y: node.position.y },
		data: { ...node.data },
		...(node.class ? { class: node.class } : {})
	};
}

/** @param {any} edge */
export function serializeEdge(edge) {
	return {
		id: edge.id,
		source: edge.source,
		target: edge.target,
		...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
		...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
		// visual pass (69): edge shape + arrow replicate so graphs match
		...(edge.type ? { type: edge.type } : {}),
		...(edge.markerEnd ? { markerEnd: edge.markerEnd } : {})
	};
}

// --- Remote appliers (no re-broadcast). H1: every applier takes the graph the
// message targets (absent on old-format messages = the scene graph) and routes
// through updateGraph, which mirrors into the editor view when active. ---

/** @param {any} node @param {string} [graphId] */
export function createFlowNode(node, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes.some((n) => n.id === node.id) ? g.nodes : [...g.nodes, node],
		edges: g.edges
	}));
}

/** @param {string} id @param {{x: number, y: number}} position @param {string} [graphId] */
export function moveFlowNode(id, position, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
		edges: g.edges
	}));
}

/** @param {string} id @param {any} data @param {string} [graphId] */
export function updateFlowNodeData(id, data, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)),
		edges: g.edges
	}));
}

/** @param {string[]} ids @param {string} [graphId] */
export function deleteFlowNodes(ids, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes.filter((n) => !ids.includes(n.id)),
		edges: g.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target))
	}));
}

/** @param {any} edge @param {string} [graphId] */
export function createFlowEdge(edge, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes,
		edges: g.edges.some((e) => e.id === edge.id) ? g.edges : [...g.edges, edge]
	}));
}

/** @param {string[]} ids @param {string} [graphId] */
export function deleteFlowEdges(ids, graphId = SCENE_GRAPH) {
	updateGraph(graphId, (g) => ({
		nodes: g.nodes,
		edges: g.edges.filter((e) => !ids.includes(e.id))
	}));
}

/** Apply a peer's flow-editor cursor position (or remove it on leave) @param {any} data */
export function applyFlowCursor(data) {
	flowCursors.update((map) => {
		const next = { ...map };
		if (data.leave) delete next[data.id];
		else
			next[data.id] = {
				x: data.x,
				y: data.y,
				name: data.name,
				ts: Date.now(),
				graphId: data.graphId ?? SCENE_GRAPH
			};
		return next;
	});
}

// Drop a peer's flow cursor on disconnect. The TTL sweep in PeerCursors only
// runs while the flow pane is mounted, so a dropped peer's cursor otherwise
// leaks in the store; clear it as part of the disconnect teardown (172).
/** @param {string} peerId */
export function dropPeerCursor(peerId) {
	flowCursors.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** Merge one graph's snapshot: known nodes update in place, unknown append. */
/** @param {string} graphId @param {any[]} nodes @param {any[]} edges */
function mergeGraphSnapshot(graphId, nodes, edges) {
	updateGraph(graphId, (g) => {
		let nextNodes = g.nodes;
		if (Array.isArray(nodes)) {
			const incoming = new Map(nodes.map((n) => [n.id, n]));
			nextNodes = g.nodes.map((n) => {
				const update = incoming.get(n.id);
				if (!update) return n;
				incoming.delete(n.id);
				return { ...n, position: update.position, data: { ...n.data, ...update.data } };
			});
			nextNodes = [...nextNodes, ...incoming.values()];
		}
		let nextEdges = g.edges;
		if (Array.isArray(edges)) {
			const have = new Set(g.edges.map((e) => e.id));
			nextEdges = [...g.edges, ...edges.filter((e) => !have.has(e.id))];
		}
		return { nodes: nextNodes, edges: nextEdges };
	});
}

// Merge a full snapshot received from a peer. Old format = {nodes, edges} for
// the scene graph; H1 format adds {graphs: {graphId: {nodes, edges}}}. Nodes we
// already have are updated in place (position + data) so drift heals when a
// resync arrives.
/** @param {any[]} nodes @param {any[]} edges @param {Record<string, any>} [graphs] */
export function applyNodesSnapshot(nodes, edges, graphs) {
	if (graphs && typeof graphs === 'object') {
		for (const [graphId, graph] of Object.entries(graphs)) {
			mergeGraphSnapshot(graphId, graph?.nodes ?? [], graph?.edges ?? []);
		}
	} else if (Array.isArray(nodes) || Array.isArray(edges)) {
		// legacy format (pre-H1 peer / old session): scene graph only
		mergeGraphSnapshot(SCENE_GRAPH, nodes, edges);
	}
	// B4.5: a stale snapshot must not resurrect edges into removed custom-node
	// params -- prune deterministically after every snapshot apply
	import('./customNodes').then((m) => m.pruneAllCustomNodeEdges());
	// H5: same invariant for embedded Object Flow sockets
	import('./objectFlow').then((m) => m.pruneObjectFlowEdges());
}

// --- Drift detection: peers periodically exchange a graph hash and pull a
// fresh snapshot when theirs differs (heals missed nodedata/move messages) ---

/** djb2 over ALL serialized graphs, order-independent via sort */
export function graphHash() {
	const all = get(flowGraphs);
	/** @type {any[]} */
	const parts = [];
	for (const graphId of Object.keys(all).sort()) {
		const graph = all[graphId];
		const nodes = graph.nodes.map(serializeNode).sort((a, b) => a.id.localeCompare(b.id));
		// hash edges by STRUCTURE only -- cosmetic type/marker are LOCAL editor
		// prefs (166), so different per-peer edge styles must not trigger a resync
		const edges = graph.edges
			.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				sourceHandle: e.sourceHandle ?? null,
				targetHandle: e.targetHandle ?? null
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (nodes.length || edges.length) parts.push([graphId, nodes, edges]);
	}
	const text = JSON.stringify(parts);
	let hash = 5381;
	for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return hash;
}

let lastResyncRequest = 0;

/**
 * Compare a peer's graph hash with ours and pull a snapshot on mismatch.
 * Only one direction may pull or two drifted peers would swap graphs forever:
 * the peer with fewer nodes+edges pulls; equal counts tiebreak on peer id.
 * @param {any} data
 */
export function applyNodeSync(data) {
	if (data.hash === graphHash()) return;
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const myCount = graphTotals();
	if (data.count < myCount) return; // they pull from us instead
	if (data.count === myCount && data.peerId <= peer.peer.id) return;
	const now = Date.now();
	if (now - lastResyncRequest < 30000) return; // resyncs are cheap but not free
	const conn = peer.connections[data.peerId];
	if (!conn?.open) return;
	lastResyncRequest = now;
	console.log('Node graph differs from ' + data.peerId + ' -- requesting a snapshot');
	conn.send({ type: 'getnodes', sender: peer.peer.id });
}

let syncTimer = null;

/** Broadcast our graph hash every 10s so peers can detect drift */
export function startNodeSync() {
	if (syncTimer || typeof window === 'undefined') return;
	syncTimer = setInterval(() => {
		/** @type {any} */
		const peer = get(peers);
		if (!peer) return;
		const count = graphTotals();
		if (count === 0) return;
		peer.send({ type: 'nodesync', peerId: peer.peer.id, hash: graphHash(), count: count });
	}, 10000);
}

// --- Broadcast helpers ---

// Update local node data and replicate it to all peers. `graphId` defaults to
// the ACTIVE graph -- node components call this from the editor.
/** @param {string} id @param {any} data @param {string} [graphId] */
export function setNodeData(id, data, graphId) {
	const target = graphId ?? get(activeGraphId);
	updateFlowNodeData(id, data, target);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'nodedata', id: id, data: data, graphId: target });
}

/**
 * Sends ALL node graphs to the given peer (late-joiner full state / drift heal).
 * Keeps the legacy {nodes, edges} fields carrying the scene graph alongside the
 * H1 {graphs} map. Waits for our outgoing connection to exist and open --
 * messages sent earlier are dropped by peerjs.
 * @param {string} peerId - The ID of the peer to send the nodes to.
 */
export function sendNodes(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const all = get(flowGraphs);
	/** @type {Record<string, {nodes: any[], edges: any[]}>} */
	const graphs = {};
	let total = 0;
	for (const [graphId, graph] of Object.entries(all)) {
		const nodes = graph.nodes.map(serializeNode);
		const edges = graph.edges.map(serializeEdge);
		if (nodes.length === 0 && edges.length === 0) continue;
		graphs[graphId] = { nodes, edges };
		total += nodes.length + edges.length;
	}
	if (total === 0) return;

	// our connection back to this peer may still be getting (re)established -- retry until it is open
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendNodes(peerId, attempt + 1), 500);
		return;
	}
	console.log('Sending ' + total + ' nodes+edges across ' + Object.keys(graphs).length + ' graphs to ' + peerId);
	conn.send({
		type: 'nodes',
		graphs,
		nodes: graphs[SCENE_GRAPH]?.nodes ?? [],
		edges: graphs[SCENE_GRAPH]?.edges ?? []
	});
}
