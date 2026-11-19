// 2.0 N2 — ONE way to ask for a graph's code: the Nodes editor's Code tab, the phone/VR sheet and the
// agent's `code` field all call this, so they print the same text for the same graph (the late-joiner
// e2e compares two peers' copies). It hands flowCode.js the catalog lookups the AI view already uses.
import { get } from 'svelte/store';
import { graphToCode } from './flowCode.js';
import { findNodeSpec } from '../nodeCatalog.js';
import { flowGraphs, SCENE_GRAPH } from '../../stores/flowStore';
import { objectsGroup } from '../../stores/sceneStore';

/** the catalog lookups (graphText's AI-view options): defaults and default labels are left out of the code */
export const codeOptions = {
	defaults: (/** @type {string} */ type) => findNodeSpec(type)?.defaults,
	defaultLabel: (/** @type {string} */ type) => findNodeSpec(type)?.label ?? ''
};

/** @param {string} graphId */
export function codeTitle(graphId) {
	if (graphId === SCENE_GRAPH) return 'Scene flow';
	const name = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', graphId)?.name;
	return (name ? quoteless(name) : 'Object') + ' flow';
}
/** a name on one comment line @param {string} s */
const quoteless = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 60);

/**
 * The code for a graph document. @param {{ nodes: any[], edges: any[] }} graph @param {string} [graphId]
 * @returns {import('./flowCode.js').FlowCode}
 */
export function codeForGraph(graph, graphId = SCENE_GRAPH) {
	return graphToCode(graph ?? { nodes: [], edges: [] }, { ...codeOptions, title: codeTitle(graphId) });
}

/** the code for a graph by id (null when there is no such graph) @param {string} graphId */
export function codeForGraphId(graphId) {
	const g = /** @type {Record<string, any>} */ (get(flowGraphs))[graphId];
	return g ? codeForGraph(g, graphId).code : null;
}
