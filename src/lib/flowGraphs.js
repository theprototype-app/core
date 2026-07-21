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

