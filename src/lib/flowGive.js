// 102b-flows row 2 — GIVE THIS FLOW TO THE SELECTION: paste one object's flow onto every other
// selected object as PLAIN copies (each its own document, fresh node ids), and later "Update all
// copies from this one" to push an edited flow to the whole family again. A lazy chunk: the object
// menu imports it on the press.
//
// - Inside the copy, a reference to the SOURCE object (an Object Selector naming it, a node's direct
//   `target`) is re-pointed at the object receiving the copy: Star 1's "hide Star 1" becomes Star 2's
//   "hide Star 2". Everything else (other objects, the scene, embeds) keeps pointing where it did.
// - A target that already has a flow has it REPLACED in place (after one confirm), so an Object Flow
//   node embedding it in the Scene graph survives.
// - The family: each receiver gets `userData.flowFrom` = the family's root (the object the flow was
//   first given from), saved and replicated like any object field (additive; old builds keep it and
//   ignore it). Any member can then update all the others.
// - ONE undo step for the whole give, replayed through the `flowreplace` kind below. No new wire
//   type: graphcreate / edgedelete / nodedelete / a whole-document `nodes`, and objectParameters.

import { get } from 'svelte/store';
import { objectsGroup, lockedObjects, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { graphOf, graphExists, updateGraph, SCENE_GRAPH } from '../stores/flowStore';
import { deleteObjectGraph } from './flowGraphs';
import { serializeNode, serializeEdge } from './nodesHandler';
import { registerHistoryKind, recordEntry, beginHistoryBatch, endHistoryBatch } from './history';
import { withWireBatch } from './wireBatch';
import { showConfirm } from './confirmDialog.js';

/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null;
/** @param {any} doc */
const isEmpty = (doc) => !doc || (!(doc.nodes ?? []).length && !(doc.edges ?? []).length);
/** @param {any} doc */
const clone = (doc) => (doc ? { nodes: (doc.nodes ?? []).map((/** @type {any} */ n) => ({ ...n, data: { ...n.data } })), edges: (doc.edges ?? []).map((/** @type {any} */ e) => ({ ...e })) } : null);

/** the root of the family `uuid` belongs to (itself when it never received a copy) @param {string} uuid */
export function flowRootOf(uuid) {
	const from = objectOf(uuid)?.userData?.flowFrom;
	return typeof from === 'string' && from && objectOf(from) ? from : uuid;
}

/** every object sharing `uuid`'s flow family (root + receivers), scene order @param {string} uuid @returns {string[]} */
export function flowFamilyOf(uuid) {
	const root = flowRootOf(uuid);
	/** @type {string[]} */
	const out = [];
	const group = /** @type {any} */ (get(objectsGroup));
	group?.traverse?.((/** @type {any} */ o) => {
		if (o === group) return;
		if (o.uuid === root || o.userData?.flowFrom === root) out.push(o.uuid);
	});
	return out;
}

/**
 * The copy one receiver gets: fresh node ids, canonical edge ids, and references to the source
 * re-pointed at the receiver. Pure (exported for the unit test).
 * @param {any} doc @param {string} fromUuid @param {string} toUuid @param {() => string} [newId]
 */
export function flowCopyFor(doc, fromUuid, toUuid, newId = () => crypto.randomUUID()) {
	/** @type {Record<string, string>} */
	const ids = {};
	const nodes = (doc?.nodes ?? []).map((/** @type {any} */ node) => {
		const id = newId();
		ids[node.id] = id;
		const data = { ...node.data };
		if (data.selected === fromUuid) data.selected = toUuid;
		if (data.target === fromUuid) data.target = toUuid;
		const out = { ...node, id, data };
		delete out.__graph; // the store stamps the graph it lands in
		return out;
	});
	const edges = (doc?.edges ?? [])
		.map((/** @type {any} */ edge) => {
			const source = ids[edge.source];
			const target = ids[edge.target];
			if (!source || !target) return null;
			const id = 'e-' + source + (edge.sourceHandle ? '.' + edge.sourceHandle : '') + '-' + target + (edge.targetHandle ? '.' + edge.targetHandle : '');
			return { ...edge, id, source, target };
		})
		.filter(Boolean);
	return { nodes, edges };
}

/** replace `uuid`'s flow document with `doc` (null = none), replicated, no history @param {string} uuid @param {any} doc */
function writeGraph(uuid, doc) {
	if (!uuid || uuid === SCENE_GRAPH) return;
	if (!doc) {
		if (graphExists(uuid)) deleteObjectGraph(uuid, { record: false });
		return;
	}
	const existed = graphExists(uuid);
	const old = existed ? graphOf(uuid) : null;
	const next = /** @type {any} */ (clone(doc));
	updateGraph(uuid, () => next);
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (!existed) peer.send({ type: 'graphcreate', uuid });
	else if (old) {
		// a received `nodes` MERGES, so what the new document does not have is deleted by name first
		const keepNodes = new Set(next.nodes.map((/** @type {any} */ n) => n.id));
		const keepEdges = new Set(next.edges.map((/** @type {any} */ e) => e.id));
		const edgeIds = (old.edges ?? []).map((/** @type {any} */ e) => e.id).filter((/** @type {string} */ id) => !keepEdges.has(id));
		const nodeIds = (old.nodes ?? []).map((/** @type {any} */ n) => n.id).filter((/** @type {string} */ id) => !keepNodes.has(id));
		if (edgeIds.length) peer.send({ type: 'edgedelete', ids: edgeIds, graphId: uuid });
		if (nodeIds.length) peer.send({ type: 'nodedelete', ids: nodeIds, graphId: uuid });
	}
	// `nodes`/`edges` are the scene graph's slot in this message (the validator wants both arrays); empty = untouched
	peer.send({ type: 'nodes', nodes: [], edges: [], graphs: { [uuid]: { nodes: next.nodes.map(serializeNode), edges: next.edges.map(serializeEdge) } } });
}

/** set / clear the family link on one object, replicated @param {string} uuid @param {string | null} root */
function writeFlowFrom(uuid, root) {
	const object = objectOf(uuid);
	if (!object) return;
	if (root) object.userData.flowFrom = root;
	else delete object.userData.flowFrom;
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'flowFrom', uuid, flowFrom: root ?? null });
	pokeScene();
}

/** is `uuid` locked by another person (their object to change)? @param {string} uuid */
function lockedByOther(uuid) {
	const me = /** @type {any} */ (get(peers))?.peer?.id ?? null;
	return (/** @type {any[]} */ (get(lockedObjects) ?? [])).some((lock) => lock?.[1] === uuid && lock?.[0] !== me);
}

/**
 * Give `fromUuid`'s flow to every object in `targets` (itself and missing / locked ones skipped).
 * @param {string} fromUuid @param {string[]} targets
 * @param {{confirm?: boolean, label?: string}} [opts] confirm: false = no "replace their flows?" question
 * @returns {Promise<number>} how many objects got the flow
 */
export async function giveFlow(fromUuid, targets, opts = {}) {
	const source = graphOf(fromUuid);
	if (isEmpty(source)) {
		showToast('This object has no flow to give yet');
		return 0;
	}
	const list = [...new Set(targets)].filter((u) => u && u !== fromUuid && objectOf(u) && !lockedByOther(u));
	if (!list.length) {
		showToast('Nothing else selected to give the flow to');
		return 0;
	}
	const replacing = list.filter((u) => !isEmpty(graphOf(u)));
	if (replacing.length && opts.confirm !== false) {
		const ok = await showConfirm({
			title: 'Replace their flows?',
			message: `${replacing.length} of the ${list.length} objects already have a flow. Giving them this one replaces it (one undo puts them back).`,
			confirmLabel: 'Replace',
			cancelLabel: 'Cancel'
		});
		if (!ok) return 0;
	}
	const root = flowRootOf(fromUuid);
	const label = opts.label ?? 'Give flow';
	beginHistoryBatch();
	try {
		withWireBatch(() => {
			for (const uuid of list) {
				const before = clone(graphExists(uuid) ? graphOf(uuid) : null);
				const beforeFrom = objectOf(uuid)?.userData?.flowFrom ?? null;
				const after = flowCopyFor(source, fromUuid, uuid);
				// the root itself is never linked to itself (an "update all" from a copy reaches the root too)
				const afterFrom = uuid === root ? null : root;
				writeGraph(uuid, after);
				if (beforeFrom !== afterFrom) writeFlowFrom(uuid, afterFrom);
				recordEntry({ kind: 'flowreplace', uuid, before: { graph: before, from: beforeFrom }, after: { graph: clone(after), from: afterFrom } });
			}
		});
	} finally {
		endHistoryBatch(`${label} (${list.length})`);
	}
	showToast(list.length === 1 ? 'Flow given to 1 object' : `Flow given to ${list.length} objects`);
	return list.length;
}

/** "Update all copies from this one": push `uuid`'s flow to every other member of its family @param {string} uuid */
export function updateFlowFamily(uuid) {
	const others = flowFamilyOf(uuid).filter((u) => u !== uuid);
	return giveFlow(uuid, others, { confirm: false, label: 'Update flow copies' });
}

registerHistoryKind('flowreplace', (entry, state) => {
	if (!objectOf(entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	writeGraph(entry.uuid, state?.graph ?? null);
	const from = state?.from ?? null;
	if ((objectOf(entry.uuid)?.userData?.flowFrom ?? null) !== from) writeFlowFrom(entry.uuid, from);
	return true;
});
