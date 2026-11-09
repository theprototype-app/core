// 78 F24 — FLOW LINT: wiring that is legal on paper and dead at run time, found by a PURE
// function of a graph's nodes and edges so the node editor, the agent tools (85 R4/R8) and a
// unit test all ask the same question.
//
// The first rule is the one agents hit (research round 2): an Object Selector wired INTO a
// trigger. Triggers find their object by walking FORWARD from themselves to an Object Selector
// (flowRuntime.reachesObjectSelector: On Click → Object Selector), so the reversed wire
// (Object Selector → On Click) is never walked and the click silently never fires. The editor
// cannot draw it (object → an un-typed input is refused), but saved graphs, pasted graph text
// and agent tool calls can. A selector wired into a trigger's DECLARED object input (On Enter's
// `filter`, On Impact's `filter`) is not this — that is how a filter is meant to be wired.
//
// Pure: nodes + edges in, findings out. No store, no DOM.

/** Triggers that find their object through `reachesObjectSelector` (flowRuntime's fire* paths). */
export const SELECTOR_TRIGGERS = new Set([
	'onclick',
	'ongrab',
	'onhit',
	'onimpact',
	'onrest',
	'onenter',
	'onexit',
	'animfinished',
	'animmarker',
	'onanimstate'
]);

/** The trigger inputs that legitimately take an object (flowSockets' INPUT table). */
const TRIGGER_OBJECT_INPUTS = /** @type {Record<string, string[]>} */ ({
	onimpact: ['filter'],
	onenter: ['filter'],
	onexit: ['filter']
});

/**
 * @typedef {{
 *   code: 'reversed-trigger',
 *   edgeId: string,
 *   source: string,
 *   target: string,
 *   message: string,
 *   fix: { kind: 'reverse', source: string, target: string, sourceHandle: null, targetHandle: null }
 * }} FlowLintFinding
 */

/** a node's display name @param {any} node */
function nameOf(node) {
	const label = String(node?.data?.label ?? '').trim();
	return label || String(node?.type ?? 'node');
}

/**
 * Is this edge an Object Selector wired INTO a trigger's body (the reversed On Click)?
 * @param {any} edge @param {any} source the edge's source node @param {any} target the edge's target node
 */
export function isReversedTriggerEdge(edge, source, target) {
	if (!edge || source?.type !== 'objectselector' || !SELECTOR_TRIGGERS.has(target?.type)) return false;
	const handle = edge.targetHandle ?? null;
	return !(handle && (TRIGGER_OBJECT_INPUTS[target.type] ?? []).includes(handle));
}

/**
 * Every lint finding in one graph. Order follows the edge list, so two peers (and a test)
 * read the same list.
 * @param {any[]} nodes @param {any[]} edges @returns {FlowLintFinding[]}
 */
export function lintFlowGraph(nodes, edges) {
	/** @type {Map<string, any>} */
	const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
	/** @type {FlowLintFinding[]} */
	const out = [];
	for (const edge of edges ?? []) {
		if (edge?.data?.proxy) continue; // a group card's drawn stand-in, not a real wire
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		if (!isReversedTriggerEdge(edge, source, target)) continue;
		const trigger = nameOf(target);
		out.push({
			code: 'reversed-trigger',
			edgeId: String(edge.id),
			source: edge.source,
			target: edge.target,
			message: `Backwards wire: the Object Selector feeds ${trigger}, so ${trigger} never fires. ${trigger} has to feed the Object Selector — Reverse fixes it.`,
			fix: { kind: 'reverse', source: edge.target, target: edge.source, sourceHandle: null, targetHandle: null }
		});
	}
	return out;
}

/**
 * The lint findings of every graph document, keyed by graph id (the agent tools' view).
 * @param {Record<string, {nodes?: any[], edges?: any[]}>} graphs @returns {Record<string, FlowLintFinding[]>}
 */
export function lintFlowGraphs(graphs) {
	/** @type {Record<string, FlowLintFinding[]>} */
	const out = {};
	for (const [graphId, graph] of Object.entries(graphs ?? {})) {
		const found = lintFlowGraph(graph?.nodes ?? [], graph?.edges ?? []);
		if (found.length) out[graphId] = found;
	}
	return out;
}
