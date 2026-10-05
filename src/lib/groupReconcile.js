// 36 (U10, 36-games-graphs) — group sockets for graphs nobody has opened in the editor.
//
// A group's IO list (N1) is DERIVED from the wires that cross its boundary; the node editor
// rewrites it whenever the graph it shows changes (Nodes.svelte reconcileGroups). A graph AUTHORED
// in code — a game template's Main graph — never passed through that, so the template author
// asks here, with the same derivation and the same socket typing (`groupSocketType`), and the
// editor finds nothing to rewrite when the user opens the game.

import { get } from 'svelte/store';
import { flowGraphs } from '../stores/flowStore';
import { isGroup, parentMap, computeGroupIO, sameIO } from './nodeGroups.js';
import { groupSocketType } from './flowSockets';
import { setNodeData } from './nodesHandler';

/**
 * Bring every group in every graph (or one graph) up to date. Returns how many groups changed.
 * @param {string} [graphId]
 */
export function reconcileGroupSockets(graphId) {
	/** @type {Record<string, any>} */
	const graphs = get(flowGraphs) ?? {};
	let changed = 0;
	for (const [id, doc] of Object.entries(graphs)) {
		if (graphId && id !== graphId) continue;
		const nodes = doc?.nodes ?? [];
		if (!nodes.some(isGroup)) continue;
		const edges = doc?.edges ?? [];
		const parents = parentMap(nodes);
		const ids = new Set(nodes.map((/** @type {any} */ n) => n.id));
		for (const g of nodes.filter(isGroup)) {
			const io = computeGroupIO(nodes, edges, g, { parents, typeOf: groupSocketType });
			const children = (g.data?.children ?? []).filter((/** @type {string} */ c) => ids.has(c));
			/** @type {Record<string, any>} */
			const patch = {};
			if (!sameIO(io.inputs, g.data?.inputs ?? [])) patch.inputs = io.inputs;
			if (!sameIO(io.outputs, g.data?.outputs ?? [])) patch.outputs = io.outputs;
			if (children.length !== (g.data?.children ?? []).length) patch.children = children;
			if (Object.keys(patch).length) {
				setNodeData(g.id, patch, id);
				changed++;
			}
		}
	}
	return changed;
}
