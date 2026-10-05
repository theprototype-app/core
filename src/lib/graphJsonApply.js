// 36-code B6 — APPLY AN EDITED GRAPH JSON: one graph document replaced, ONE undo step, and
// peers told in the messages they already understand.
//
// Why not the `nodes` snapshot FlowCode sends: a snapshot MERGES (mergeGraphSnapshot spreads
// the incoming data over the old and only appends unknown edges), so a deleted data key, a
// changed type or a re-pointed edge never reaches a peer — the graphs drift until nodesync's
// periodic hash compare pulls a resync. So the applier DIFFS the two documents and sends:
//   removed nodes / edges          nodedelete / edgedelete
//   new nodes / edges              nodecreate / edgecreate
//   a node whose TYPE changed or that LOST a data key   nodedelete + nodecreate (+ its edges)
//   an edge whose ends changed     edgedelete + edgecreate
//   otherwise                      nodedata (the whole data — merge is exact) / nodemove
// The `'graphjson'` history kind holds both documents (serialized) and replays the same diff
// the other way. This module's BODY registers that kind, so nothing in history's import
// subtree may reach it (codeWorkspace imports it dynamically).

import { get } from 'svelte/store';
import { flowGraphs, updateGraph } from '../stores/flowStore';
import { peers } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { serializeNode, serializeEdge } from './nodesHandler';

/** @typedef {{nodes: any[], edges: any[]}} Doc */

/** @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @param {string} graphId @returns {Doc} */
function serializedDoc(graphId) {
	const g = get(flowGraphs)[graphId] ?? { nodes: [], edges: [] };
	return { nodes: g.nodes.map(serializeNode), edges: g.edges.map(serializeEdge) };
}

/**
 * Turn `from` into `to` locally and tell the peers.
 * @param {string} graphId @param {Doc} from @param {Doc} to
 */
function replaceDocument(graphId, from, to) {
	updateGraph(graphId, () => ({
		nodes: to.nodes.map((n) => ({ ...n, position: { ...n.position }, data: { ...n.data } })),
		edges: to.edges.map((e) => ({ ...e }))
	}));
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const send = (/** @type {any} */ msg) => peer.send({ ...msg, graphId });

	const oldNodes = new Map(from.nodes.map((n) => [n.id, n]));
	const newNodes = new Map(to.nodes.map((n) => [n.id, n]));
	const oldEdges = new Map(from.edges.map((e) => [e.id, e]));

	/** nodes that must be rebuilt on the peer: type changed, or a data key is gone */
	const rebuild = new Set(
		to.nodes
			.filter((n) => {
				const o = oldNodes.get(n.id);
				if (!o) return false;
				if (o.type !== n.type || (o.class ?? '') !== (n.class ?? '')) return true;
				return Object.keys(o.data ?? {}).some((k) => !(k in (n.data ?? {})));
			})
			.map((n) => n.id)
	);
	const removedNodes = from.nodes.map((n) => n.id).filter((id) => !newNodes.has(id) || rebuild.has(id));
	// a peer drops a deleted node's edges itself; send the edge deletes it would NOT infer
	const removedEdges = from.edges
		.filter((e) => {
			const n = to.edges.find((x) => x.id === e.id);
			return !n || !same(n, e);
		})
		.filter((e) => !removedNodes.includes(e.source) && !removedNodes.includes(e.target))
		.map((e) => e.id);
	if (removedEdges.length) send({ type: 'edgedelete', ids: removedEdges });
	if (removedNodes.length) send({ type: 'nodedelete', ids: removedNodes });

	for (const n of to.nodes) {
		const o = oldNodes.get(n.id);
		if (!o || rebuild.has(n.id)) {
			send({ type: 'nodecreate', node: n });
			continue;
		}
		if (!same(o.data, n.data)) send({ type: 'nodedata', id: n.id, data: n.data });
		if (!same(o.position, n.position)) send({ type: 'nodemove', id: n.id, position: n.position });
	}
	for (const e of to.edges) {
		const o = oldEdges.get(e.id);
		const endpointRebuilt = rebuild.has(e.source) || rebuild.has(e.target) || !oldNodes.has(e.source) || !oldNodes.has(e.target);
		if (!o || !same(o, e) || endpointRebuilt) send({ type: 'edgecreate', edge: e });
	}
}

/**
 * Apply a validated result of `codeTabs.parseGraphJson` to a graph, as ONE undo step.
 * @param {string} graphId @param {{nodes: any[], edges: any[]}} result
 */
export function applyGraphJson(graphId, result) {
	const before = serializedDoc(graphId);
	const after = { nodes: result.nodes.map(serializeNode), edges: result.edges.map(serializeEdge) };
	if (same(before, after)) return false;
	replaceDocument(graphId, before, after);
	recordEntry({ kind: 'graphjson', graphId, before, after });
	// the same invariants every snapshot apply keeps (customNodes/objectFlow sockets)
	import('./customNodes').then((m) => m.pruneAllCustomNodeEdges()).catch(() => {});
	import('./objectFlow').then((m) => m.pruneObjectFlowEdges()).catch(() => {});
	return true;
}

registerHistoryKind('graphjson', (entry, state) => {
	const undoing = state === entry.before;
	const current = serializedDoc(entry.graphId);
	replaceDocument(entry.graphId, current, undoing ? entry.before : entry.after);
	return true;
});
