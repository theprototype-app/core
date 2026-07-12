import { get } from 'svelte/store';
import { flowNodes, flowEdges, flowCursors } from '../stores/flowStore';
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
		...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
		// visual pass (69): edge shape + arrow replicate so graphs match
		...(edge.type ? { type: edge.type } : {}),
		...(edge.markerEnd ? { markerEnd: edge.markerEnd } : {})
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

/** Apply a peer's flow-editor cursor position (or remove it on leave) @param {any} data */
export function applyFlowCursor(data) {
	flowCursors.update((map) => {
		const next = { ...map };
		if (data.leave) delete next[data.id];
		else next[data.id] = { x: data.x, y: data.y, name: data.name, ts: Date.now() };
		return next;
	});
}

// Merge a full snapshot received from a peer. Nodes we already have are
// updated in place (position + data) so drift heals when a resync arrives.
/** @param {any[]} nodes @param {any[]} edges */
export function applyNodesSnapshot(nodes, edges) {
	if (Array.isArray(nodes)) {
		flowNodes.update((current) => {
			const incoming = new Map(nodes.map((n) => [n.id, n]));
			const merged = current.map((n) => {
				const update = incoming.get(n.id);
				if (!update) return n;
				incoming.delete(n.id);
				return { ...n, position: update.position, data: { ...n.data, ...update.data } };
			});
			return [...merged, ...incoming.values()];
		});
	}
	if (Array.isArray(edges)) edges.forEach(createFlowEdge);
}

// --- Drift detection: peers periodically exchange a graph hash and pull a
// fresh snapshot when theirs differs (heals missed nodedata/move messages) ---

/** djb2 over the serialized graph, order-independent via sort */
export function graphHash() {
	const nodes = get(flowNodes).map(serializeNode).sort((a, b) => a.id.localeCompare(b.id));
	// hash edges by STRUCTURE only — cosmetic type/marker are LOCAL editor prefs
	// (166), so different per-peer edge styles must not trigger a resync
	const edges = get(flowEdges)
		.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle ?? null,
			targetHandle: e.targetHandle ?? null
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	const text = JSON.stringify([nodes, edges]);
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
	const myCount = get(flowNodes).length + get(flowEdges).length;
	if (data.count < myCount) return; // they pull from us instead
	if (data.count === myCount && data.peerId <= peer.peer.id) return;
	const now = Date.now();
	if (now - lastResyncRequest < 30000) return; // resyncs are cheap but not free
	const conn = peer.connections[data.peerId];
	if (!conn?.open) return;
	lastResyncRequest = now;
	console.log('Node graph differs from ' + data.peerId + ' — requesting a snapshot');
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
		const count = get(flowNodes).length + get(flowEdges).length;
		if (count === 0) return;
		peer.send({ type: 'nodesync', peerId: peer.peer.id, hash: graphHash(), count: count });
	}, 10000);
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
