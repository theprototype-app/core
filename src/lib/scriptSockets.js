// 34 D3 — editing a Script node's DECLARED sockets (the write half of scriptIO).
//
// A socket list is node DATA, so it replicates through the ordinary `nodedata` message.
// What that message cannot do is drop the WIRES a rename or removal strands: an edge into a
// handle that no longer exists draws to nowhere on every peer (xyflow logs it, the runtime
// ignores it) and would quietly re-attach if the name ever came back. So the editor that
// makes the change prunes those edges itself and broadcasts the delete — the same
// apply-locally-then-send path every editor edge removal takes (Nodes.svelte).

import { get } from 'svelte/store';
import { graphOf, activeGraphId } from '../stores/flowStore';
import { peers } from '../stores/appStore.js';
import { setNodeData, deleteFlowEdges } from './nodesHandler';
import { scriptInputs, scriptOutputs, SCRIPT_V2_TEMPLATE } from './scriptIO';

/** the v1 template's first line — a node still holding it gets the v2 template on upgrade */
const V1_TEMPLATE_HEAD = '// runs every frame on every peer (keep it deterministic)';

/**
 * Replace a Script node's declared sockets (either list may be omitted to keep it). Passing
 * `null` for BOTH returns the node to v1. Edges into/out of handles that no longer exist are
 * removed and the removal is broadcast. Returns the ids of the edges it dropped.
 * @param {string} nodeId
 * @param {{ inputs?: any[] | null, outputs?: any[] | null }} next
 * @param {string} [graphId]
 * @returns {string[]}
 */
export function setScriptSockets(nodeId, next, graphId) {
	const gid = graphId ?? get(activeGraphId);
	const graph = graphOf(gid);
	const node = graph?.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	if (!node || node.type !== 'script') return [];
	/** @type {any} */
	const patch = {};
	if ('inputs' in next) patch.inputs = next.inputs === null ? undefined : scriptInputs({ inputs: next.inputs });
	if ('outputs' in next) patch.outputs = next.outputs === null ? undefined : scriptOutputs({ outputs: next.outputs });
	const after = { ...node.data, ...patch };
	setNodeData(nodeId, patch, gid);

	// which handles survive: a v1 node has a/b/c in and the unnamed out
	const ins = scriptInputs(after);
	const inNames = new Set(ins ? ins.map((s) => s.name) : ['a', 'b', 'c']);
	const outs = scriptOutputs(after);
	const outNames = new Set(outs.map((s) => s.name));
	const stale = graph.edges
		.filter(
			(/** @type {any} */ e) =>
				(e.target === nodeId && e.targetHandle && !inNames.has(e.targetHandle)) ||
				(e.source === nodeId &&
					(outs.length ? !e.sourceHandle || !outNames.has(e.sourceHandle) : !!e.sourceHandle))
		)
		.map((/** @type {any} */ e) => e.id);
	if (stale.length) {
		deleteFlowEdges(stale, gid);
		/** @type {any} */
		const peer = get(peers);
		peer?.send({ type: 'edgedelete', ids: stale, graphId: gid });
	}
	return stale;
}

/**
 * Opt a v1 Script node into v2: one number input `a`, one number output `out`, and the v2
 * template when the code is still the untouched v1 one (a user's own code is never replaced).
 * @param {string} nodeId @param {string} [graphId]
 */
export function upgradeScriptToV2(nodeId, graphId) {
	const gid = graphId ?? get(activeGraphId);
	const node = graphOf(gid)?.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	if (!node || node.type !== 'script') return;
	const code = String(node.data?.code ?? '');
	if (!code.trim() || code.startsWith(V1_TEMPLATE_HEAD)) setNodeData(nodeId, { code: SCRIPT_V2_TEMPLATE }, gid);
	setScriptSockets(nodeId, { inputs: [{ name: 'a', type: 'number' }], outputs: [{ name: 'out', type: 'number' }] }, gid);
}
