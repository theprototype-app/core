// 2.0-n3c (roadmap 2.0 N3c) — the WRITE half of Convert to code / Convert back. The plan is pure
// (nodes/convertCode.js); this applies it as ONE undo step and sends every part on the ordinary
// messages (edgedelete / nodedelete, then nodecreate / edgecreate), so a second peer ends up with the
// same node and the same wires, the nodesync hashes agree, and an older peer applies it unchanged.
// The undo entries are the `flownodes` kind's own (a delete, then a create), inside one history batch.
//
// Not a leaf: it reaches history, nodesHandler and flowGraphs (the variadicEdit.js shape). The node
// menu, the phone / VR node sheet and the agent's update_flow_nodes call it; the runtime never does.

import { get } from 'svelte/store';
import { graphOf, activeGraphId } from '../stores/flowStore';
import { peers } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { recordFlowNodesEntry } from './flowGraphs';
import { createFlowNode, createFlowEdge, deleteFlowNodes, deleteFlowEdges } from './nodesHandler';
import { planConvert, planConvertBack, conversionState } from './nodes/convertCode.js';
import { nodeDef } from './nodes/index.js';

/** @typedef {{ ok: true, focus: string, label: string } | { ok: false, error: string }} ConvertResult */

/**
 * Convert node `nodeId` to code (`back: false`) or back to its built-in (`back: true`).
 * @param {string} nodeId @param {{ back?: boolean, graphId?: string, newId?: () => string }} [opts]
 * @returns {ConvertResult}
 */
export function convertNode(nodeId, opts = {}) {
	const graphId = opts.graphId ?? get(activeGraphId);
	const graph = graphOf(graphId);
	if (!graph) return { ok: false, error: 'No graph ' + graphId };
	const plan = opts.back
		? planConvertBack(graph, nodeId)
		: planConvert(graph, nodeId, {
				newId: opts.newId ?? (() => crypto.randomUUID()),
				v: (type) => /** @type {any} */ (nodeDef(type))?.v ?? 1
			});
	if (!plan.ok) return plan;
	/** @type {any} */
	const peer = get(peers);
	// inside somebody else's batch (the agent's tool call), join it; else this is its own step
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		const edgeIds = plan.remove.edges.map((e) => e.id);
		const nodeIds = plan.remove.nodes.map((n) => n.id);
		if (edgeIds.length) {
			deleteFlowEdges(edgeIds, graphId);
			if (peer) peer.send({ type: 'edgedelete', ids: edgeIds, graphId });
		}
		if (nodeIds.length) {
			deleteFlowNodes(nodeIds, graphId);
			if (peer) peer.send({ type: 'nodedelete', ids: nodeIds, graphId });
		}
		if (edgeIds.length || nodeIds.length) recordFlowNodesEntry({ op: 'delete', graphId, nodes: plan.remove.nodes, edges: plan.remove.edges });
		for (const node of plan.add.nodes) {
			createFlowNode({ ...node }, graphId);
			if (peer) peer.send({ type: 'nodecreate', node, graphId });
		}
		for (const edge of plan.add.edges) {
			createFlowEdge({ ...edge }, graphId);
			if (peer) peer.send({ type: 'edgecreate', edge, graphId });
		}
		if (plan.add.nodes.length || plan.add.edges.length) recordFlowNodesEntry({ op: 'create', graphId, nodes: plan.add.nodes, edges: plan.add.edges });
	} finally {
		if (own) endHistoryBatch(plan.label);
	}
	return { ok: true, focus: plan.focus, label: plan.label };
}

/** What the node menu offers for a node: 'convert' | 'back' | 'changed' | null. @param {any} node @param {string} [graphId] */
export function conversionOf(node, graphId) {
	return conversionState(node, graphOf(graphId ?? get(activeGraphId)) ?? undefined);
}
