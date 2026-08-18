import { get } from 'svelte/store';
import {
	flowGraphs,
	SCENE_GRAPH,
	graphExists,
	graphOf,
	updateGraph,
	removeGraphDocument
} from '../stores/flowStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { removeEmbedsOf } from './objectFlow';
import {
	createFlowNode,
	createFlowEdge,
	deleteFlowNodes,
	deleteFlowEdges,
	updateFlowNodeData,
	serializeNode,
	serializeEdge
} from './nodesHandler';

// H1 (flow v2): object-flow lifecycle -- create/delete graph documents,
// replicated (graphcreate/graphdelete) and undoable (the 'flowgraph' history
// kind). The view<->store mirror and the whole-world read helpers live in
// flowStore.js (leaf module) so the runtime can use them without closing an
// import cycle through history.js.

// --- lifecycle ---------------------------------------------------------------

/** @param {string} uuid @param {{replicate?: boolean, record?: boolean}} [opts] */
export function createObjectGraph(uuid, opts = {}) {
	const { replicate = true, record = true } = opts;
	if (!uuid || uuid === SCENE_GRAPH || graphExists(uuid)) return;
	updateGraph(uuid, () => ({ nodes: [], edges: [] }));
	if (record)
		recordEntry({
			kind: 'flowgraph',
			op: 'create',
			uuid,
			graph: { nodes: [], edges: [] },
			before: 'before',
			after: 'after'
		});
	/** @type {any} */
	const peer = get(peers);
	if (replicate && peer) peer.send({ type: 'graphcreate', uuid });
}

/**
 * #20 P1 (duplicate parity): give `to` its OWN copy of `from`'s flow document.
 *
 * Node ids are REGENERATED (a node id is global to the app, not scoped to its
 * graph) and the edges remap onto them, rebuilding each edge id in the editor's
 * handle-qualified format — a divergent id breaks peer dedupe (the AI flow
 * tools carry the same note).
 *
 * An embedded `objectflow` node keeps pointing at the object it referenced.
 * Re-pointing it at the copy is a user decision, and leaving the reference alone
 * is the safe default.
 *
 * Not a history entry of its own, for the reason `copyAnimationsTo` documents:
 * the object's create entry owns the lifecycle, and a deleted object keeps its
 * graph so undo->redo finds it (serializeGraphs prunes at output only).
 *
 * Replication reuses the pair the 'flowgraph' undo path already sends —
 * `graphcreate` then a whole-document `nodes` — so there is no new wire type.
 * @param {string} fromUuid @param {string} toUuid
 * @returns {boolean} true when a graph was copied
 */
export function copyGraphTo(fromUuid, toUuid) {
	if (!fromUuid || !toUuid || fromUuid === toUuid || toUuid === SCENE_GRAPH) return false;
	const graph = graphOf(fromUuid);
	if (!graph || (!graph.nodes.length && !graph.edges.length)) return false;
	if (graphExists(toUuid)) return false; // a fresh clone never has one; never clobber

	/** @type {Record<string, string>} old node id -> new */
	const idMap = {};
	const nodes = graph.nodes.map((/** @type {any} */ node) => {
		const id = crypto.randomUUID();
		idMap[node.id] = id;
		return { ...node, id, position: { ...node.position }, data: { ...node.data } };
	});
	const edges = graph.edges
		.map((/** @type {any} */ edge) => {
			const source = idMap[edge.source];
			const target = idMap[edge.target];
			if (!source || !target) return null; // an edge to a node we did not copy
			return {
				...edge,
				id:
					'e-' + source + (edge.sourceHandle ? '.' + edge.sourceHandle : '') +
					'-' + target + (edge.targetHandle ? '.' + edge.targetHandle : ''),
				source,
				target
			};
		})
		.filter(Boolean);

	updateGraph(toUuid, () => ({ nodes, edges }));
	/** @type {any} */
	const peer = get(peers);
	if (peer) {
		peer.send({ type: 'graphcreate', uuid: toUuid });
		peer.send({
			type: 'nodes',
			graphs: { [toUuid]: { nodes: nodes.map(serializeNode), edges: edges.map(serializeEdge) } }
		});
	}
	return true;
}

/** @param {string} uuid @param {{replicate?: boolean, record?: boolean}} [opts] */
export function deleteObjectGraph(uuid, opts = {}) {
	const { replicate = true, record = true } = opts;
	const graph = graphOf(uuid);
	if (!graph || uuid === SCENE_GRAPH) return;
	if (record)
		recordEntry({
			kind: 'flowgraph',
			op: 'delete',
			uuid,
			graph: {
				nodes: graph.nodes.map((/** @type {any} */ n) => ({ ...n })),
				edges: graph.edges.map((/** @type {any} */ e) => ({ ...e }))
			},
			before: 'before',
			after: 'after'
		});
	removeGraphDocument(uuid);
	removeEmbedsOf(uuid); // H5: embedded Object Flow nodes die with their flow
	/** @type {any} */
	const peer = get(peers);
	if (replicate && peer) peer.send({ type: 'graphdelete', uuid });
}

// remote appliers (no re-broadcast) -- golden rule 1
/** @param {string} uuid */
export function applyGraphCreate(uuid) {
	if (!uuid || uuid === SCENE_GRAPH || graphExists(uuid)) return;
	updateGraph(uuid, (g) => g);
}
/** @param {string} uuid */
export function applyGraphDelete(uuid) {
	removeGraphDocument(uuid);
	removeEmbedsOf(uuid); // deterministic on the applier side too
}

// 'flowgraph' history kind: undo of create removes the graph; undo of delete
// restores the captured document (and replicates the restoration).
registerHistoryKind('flowgraph', (entry, state) => {
	const undoing = state === entry.before;
	const shouldExist = entry.op === 'create' ? !undoing : undoing;
	if (shouldExist) {
		updateGraph(entry.uuid, () => ({
			nodes: entry.graph.nodes.map((/** @type {any} */ n) => ({ ...n })),
			edges: entry.graph.edges.map((/** @type {any} */ e) => ({ ...e }))
		}));
		/** @type {any} */
		const peer = get(peers);
		if (peer) {
			peer.send({ type: 'graphcreate', uuid: entry.uuid });
			if (entry.graph.nodes.length || entry.graph.edges.length)
				peer.send({ type: 'nodes', graphs: { [entry.uuid]: entry.graph } });
		}
	} else {
		deleteObjectGraph(entry.uuid, { record: false });
	}
	return true;
});

// 'flownodes' history kind (AI flow tools): node/edge creation, data edits and
// removals INSIDE one graph as a single undoable entry. Entries carry
// SERIALIZED node/edge copies (serializeNode/serializeEdge shapes) so replayed
// re-broadcasts hash identically on every peer (nodesync drift guard).

/**
 * Record an undoable flow-node mutation.
 * op 'create'/'delete' take {nodes, edges} (serialized); op 'data' takes
 * {items: [{id, before, after}]} of node-data patches.
 * @param {{op: 'create'|'delete'|'data', graphId: string, nodes?: any[],
 *   edges?: any[], items?: {id: string, before: any, after: any}[]}} info
 */
export function recordFlowNodesEntry(info) {
	recordEntry({ kind: 'flownodes', ...info, before: 'before', after: 'after' });
}

registerHistoryKind('flownodes', (entry, state) => {
	const undoing = state === entry.before;
	/** @type {any} */
	const peer = get(peers);
	const graphId = entry.graphId;
	if (entry.op === 'data') {
		for (const item of entry.items ?? []) {
			const data = undoing ? item.before : item.after;
			updateFlowNodeData(item.id, data, graphId);
			if (peer) peer.send({ type: 'nodedata', id: item.id, data, graphId });
		}
		return true;
	}
	const removing = entry.op === 'create' ? undoing : !undoing;
	if (removing) {
		const edgeIds = (entry.edges ?? []).map((/** @type {any} */ e) => e.id);
		const nodeIds = (entry.nodes ?? []).map((/** @type {any} */ n) => n.id);
		if (edgeIds.length) deleteFlowEdges(edgeIds, graphId);
		if (nodeIds.length) deleteFlowNodes(nodeIds, graphId);
		if (peer) {
			if (edgeIds.length) peer.send({ type: 'edgedelete', ids: edgeIds, graphId });
			if (nodeIds.length) peer.send({ type: 'nodedelete', ids: nodeIds, graphId });
		}
	} else {
		// resurrect the graph document defensively (redo after its owner graph
		// was deleted, or undo of a delete in a fresh session)
		if (graphId !== SCENE_GRAPH && !graphExists(graphId)) {
			updateGraph(graphId, () => ({ nodes: [], edges: [] }));
			if (peer) peer.send({ type: 'graphcreate', uuid: graphId });
		}
		for (const node of entry.nodes ?? []) {
			createFlowNode({ ...node }, graphId);
			if (peer) peer.send({ type: 'nodecreate', node, graphId });
		}
		for (const edge of entry.edges ?? []) {
			createFlowEdge({ ...edge }, graphId);
			if (peer) peer.send({ type: 'edgecreate', edge, graphId });
		}
	}
	return true;
});

// --- serialization helpers -----------------------------------------------------

/**
 * Serialize every graph via the caller-supplied node/edge serializers
 * (nodesHandler owns those; passed in to keep this module import-light).
 * @param {(n: any) => any} serializeNode @param {(e: any) => any} serializeEdge
 * @param {{pruneMissing?: (uuid: string) => boolean}} [opts] pruneMissing returns
 *   true when the OWNER OBJECT no longer exists -- orphan graphs are dropped
 *   from the OUTPUT only (kept live in the store so undoing an object delete
 *   finds its flow intact).
 */
export function serializeGraphs(serializeNode, serializeEdge, opts = {}) {
	const { pruneMissing } = opts;
	/** @type {Record<string, {nodes: any[], edges: any[]}>} */
	const out = {};
	for (const [graphId, graph] of Object.entries(get(flowGraphs))) {
		if (graphId !== SCENE_GRAPH && pruneMissing && pruneMissing(graphId)) continue;
		out[graphId] = {
			nodes: graph.nodes.map(serializeNode),
			edges: graph.edges.map(serializeEdge)
		};
	}
	return out;
}

/** Guarded delete for the editor UI: confirmation toast, then replicated delete.
 * @param {string} uuid @param {string} label object name for the message */
export function requestDeleteObjectGraph(uuid, label) {
	const graph = graphOf(uuid);
	if (!graph) return;
	const count = graph.nodes.length;
	showToast(
		'Delete the flow of "' + (label || 'object') + '"? ' +
			count + ' node' + (count === 1 ? '' : 's') + ' will be removed for everyone.',
		[
			{ label: 'Delete flow', action: () => deleteObjectGraph(uuid) },
			{ label: 'Cancel', action: () => {} }
		]
	);
}

