// 37 (R6): the WRITE half of the variadic nodes. Adding or removing a socket is ONE undoable,
// replicated step. A removal touches wires, the node and every group whose IO list names one of
// its sockets, and every part goes out on the ordinary messages (edgedelete / edgecreate /
// nodedata), so the wire is unchanged and an older peer applies it. The plan itself is pure and
// lives in variadicNodes.js. This module only applies it.
//
// Not a leaf: it reaches history (one batch), nodesHandler (the senders) and flowGraphs (the
// `flownodes` kind). Only UI imports it; the runtime never does.

import { get } from 'svelte/store';
import { graphOf, activeGraphId } from '../stores/flowStore';
import { peers } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch } from './history';
import { recordFlowNodesEntry } from './flowGraphs';
import { serializeEdge, deleteFlowEdges, createFlowEdge, setNodeData } from './nodesHandler';
import { edgeId } from './nodeGroups.js';
import { isValidFlowConnection } from './flowSockets';
import {
	isVariadic,
	socketCount,
	MAX_SOCKETS,
	switcherItems,
	switcherVType,
	switcherIndexOf,
	SWITCHER_TYPES,
	MAX_SWITCHER_ITEMS,
	socketRemovalPlan
} from './variadicNodes.js';

/** @param {string|undefined} graphId */
function graphFor(graphId) {
	const id = graphId ?? get(activeGraphId);
	return { id, graph: graphOf(id) ?? { nodes: [], edges: [] } };
}

/** One recorded + replicated node-data write. @param {string} graphId @param {any} node @param {Record<string, any>} patch */
function writeData(graphId, node, patch) {
	/** @type {Record<string, any>} */
	const before = {};
	for (const key of Object.keys(patch)) before[key] = structuredClone(node.data?.[key]);
	setNodeData(node.id, patch, graphId);
	recordFlowNodesEntry({ op: 'data', graphId, items: [{ id: node.id, before, after: patch }] });
}

/**
 * Add an input socket to a math/gate node (up to 8). @param {string} nodeId @param {string} [graphId]
 * @returns {boolean} whether one was added
 */
export function addVariadicSocket(nodeId, graphId) {
	const { id, graph } = graphFor(graphId);
	const node = graph.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	if (!node || !isVariadic(node.type)) return false;
	const count = socketCount(node.data);
	if (count >= MAX_SOCKETS) return false;
	writeData(id, node, { sockets: count + 1 });
	return true;
}

/**
 * Add an item (and its input socket) to a Switcher. @param {string} nodeId @param {string} [name]
 * @param {string} [graphId] @returns {boolean}
 */
export function addSwitcherItem(nodeId, name, graphId) {
	const { id, graph } = graphFor(graphId);
	const node = graph.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	if (!node || node.type !== 'switcher') return false;
	const items = switcherItems(node.data);
	if (items.length >= MAX_SWITCHER_ITEMS) return false;
	writeData(id, node, { items: [...items, name ?? 'item ' + (items.length + 1)] });
	return true;
}

/**
 * Remove ONE input socket: a math/gate letter (`index` = its position) or a Switcher item (`index`
 * = the item). Every wire into a later socket moves down with it, and every group IO entry follows.
 * One undo step. @param {string} nodeId @param {number} index @param {string} [graphId]
 * @returns {boolean} whether anything was removed
 */
export function removeVariadicSocket(nodeId, index, graphId) {
	const { id, graph } = graphFor(graphId);
	const node = graph.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	const plan = socketRemovalPlan(node, graph.nodes, graph.edges, index, edgeId);
	if (!plan) return false;
	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	try {
		if (plan.deleteEdges.length) {
			const ids = plan.deleteEdges.map((e) => e.id);
			deleteFlowEdges(ids, id);
			peer?.send({ type: 'edgedelete', ids, graphId: id });
			recordFlowNodesEntry({ op: 'delete', graphId: id, nodes: [], edges: plan.deleteEdges.map(serializeEdge) });
		}
		if (plan.createEdges.length) {
			for (const e of plan.createEdges) {
				const edge = serializeEdge(e);
				createFlowEdge(edge, id);
				peer?.send({ type: 'edgecreate', edge, graphId: id });
			}
			recordFlowNodesEntry({ op: 'create', graphId: id, nodes: [], edges: plan.createEdges.map(serializeEdge) });
		}
		writeData(id, node, plan.data);
		for (const g of plan.groups) {
			setNodeData(g.id, g.after, id);
			recordFlowNodesEntry({ op: 'data', graphId: id, items: [{ id: g.id, before: g.before, after: g.after }] });
		}
	} finally {
		endHistoryBatch(node.type === 'switcher' ? 'Remove switcher item' : 'Remove input');
	}
	return true;
}

/**
 * Change what a Switcher's item sockets carry. A wire that the new type refuses (a vector3 into a
 * boolean multiplexer) is removed in the same undo step, because a saved edge is never re-validated
 * and a refused value would otherwise travel on silently. @param {string} nodeId @param {string} vtype
 * @param {string} [graphId] @returns {number} how many wires were removed (-1 = nothing changed)
 */
export function setSwitcherType(nodeId, vtype, graphId) {
	const { id, graph } = graphFor(graphId);
	const node = graph.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	if (!node || node.type !== 'switcher' || !SWITCHER_TYPES.includes(vtype) || switcherVType(node.data) === vtype) return -1;
	const next = { ...node, data: { ...node.data, vtype } };
	const nodes = graph.nodes.map((/** @type {any} */ n) => (n.id === nodeId ? next : n));
	const stale = graph.edges.filter(
		(/** @type {any} */ e) =>
			((e.target === nodeId && switcherIndexOf(e.targetHandle) >= 0) || (e.source === nodeId && e.sourceHandle === 'value')) &&
			!isValidFlowConnection(e, nodes)
	);
	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	try {
		if (stale.length) {
			const ids = stale.map((/** @type {any} */ e) => e.id);
			deleteFlowEdges(ids, id);
			peer?.send({ type: 'edgedelete', ids, graphId: id });
			recordFlowNodesEntry({ op: 'delete', graphId: id, nodes: [], edges: stale.map(serializeEdge) });
		}
		writeData(id, node, { vtype });
	} finally {
		endHistoryBatch('Switcher type');
	}
	return stale.length;
}
