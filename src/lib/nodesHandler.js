import { get } from 'svelte/store';
import { flowNodes, flowEdges } from '../stores/flowStore';
import { peers } from '../stores/appStore';

// Strip runtime-only fields (computed, selected, dragging) so the node is serializable for peerjs
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
		...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
	};
}

// --- Remote appliers (no re-broadcast, plain store updates) ---

/** @param {any} node */
export function createFlowNode(node) {
	flowNodes.update((nodes) => (nodes.some((n) => n.id === node.id) ? nodes : [...nodes, node]));
}

/** @param {string} id @param {{x: number, y: number}} position */
export function moveFlowNode(id, position) {
	flowNodes.update((nodes) => nodes.map((n) => (n.id === id ? { ...n, position } : n)));
}

/** @param {string} id @param {any} data */
export function updateFlowNodeData(id, data) {
	flowNodes.update((nodes) =>
		nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n))
	);
}

/** @param {string[]} ids */
export function deleteFlowNodes(ids) {
	flowNodes.update((nodes) => nodes.filter((n) => !ids.includes(n.id)));
	flowEdges.update((edges) =>
		edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target))
	);
}

/** @param {any} edge */
export function createFlowEdge(edge) {
	flowEdges.update((edges) => (edges.some((e) => e.id === edge.id) ? edges : [...edges, edge]));
}

/** @param {string[]} ids */
export function deleteFlowEdges(ids) {
	flowEdges.update((edges) => edges.filter((e) => !ids.includes(e.id)));
}

// Merge a full snapshot received from a peer
/** @param {any[]} nodes @param {any[]} edges */
export function applyNodesSnapshot(nodes, edges) {
	if (Array.isArray(nodes)) nodes.forEach(createFlowNode);
	if (Array.isArray(edges)) edges.forEach(createFlowEdge);
}

// --- Broadcast helpers ---

// Update local node data and replicate it to all peers
/** @param {string} id @param {any} data */
export function setNodeData(id, data) {
	updateFlowNodeData(id, data);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'nodedata', id: id, data: data });
}

/**
 * Sends the whole node graph to the given peer.
 * Waits for our outgoing connection to exist and open — messages sent earlier are dropped by peerjs.
 * @param {string} peerId - The ID of the peer to send the nodes to.
 */
export function sendNodes(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const nodes = get(flowNodes).map(serializeNode);
	const edges = get(flowEdges).map(serializeEdge);
	if (nodes.length === 0 && edges.length === 0) return;

	// our connection back to this peer may still be getting (re)established — retry until it is open
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendNodes(peerId, attempt + 1), 500);
		return;
	}
	console.log('Sending ' + nodes.length + ' nodes and ' + edges.length + ' edges to ' + peerId);
	conn.send({ type: 'nodes', nodes: nodes, edges: edges });
}
