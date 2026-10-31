// 55 (41's voice-Claude finding): CHECK AN AI EDGE'S HANDLES against the node's sockets. create_flow_nodes
// used to copy fromHandle/toHandle verbatim, so a wrong name was accepted ("edges": N) and the logic did
// nothing — the runtime reads an input by its handle name, and a handle-map output (a Sequence's steps,
// Move Input's x/y, a Script's outputs…) by the edge's sourceHandle. Now a bad edge is an error that names
// the valid handles (the partial-nodes rule: what was applied stays, the call says what was not).
//
// Only what is KNOWN is judged. A node's inputs come from the tables the VR logic panel draws from (the
// catalog spec, flowSockets' input table, a Script's / Switcher's / variadic node's data, an embed's flow, a
// behaviour's code once the behaviours have loaded) plus every data key (a wired value lands on
// data[handle]); a node with no named inputs at all (an Object Selector, a module node) is not judged. An OUTPUT handle is judged only on a node whose output IS a handle map: a
// plain output ignores sourceHandle at run time (`a.out -> b.in` in graph text is the usual spelling), so
// refusing one there would turn a working wire into an error.

import { graphOf } from '../../stores/flowStore';
import { findNodeSpec } from '$lib/nodeCatalog';
import { inputHandles, outputHandleNames, behaviourSockets } from '$lib/flowSockets';
import { scriptInputs, scriptOutputs } from '$lib/scriptIO';
import { isVariadic, variadicInputs, switcherItems, switcherHandle } from '$lib/variadicNodes.js';

/** the Sequence node's four outputs (flowRuntime SEQUENCE_STEPS) */
const SEQUENCE_STEPS = ['step1', 'step2', 'step3', 'step4'];
/** node types whose value is a handle map with these fixed names (flowRuntime: the `__handles` producers) */
const MAP_OUTPUTS = /** @type {Record<string, string[]>} */ ({
	sequence: SEQUENCE_STEPS,
	switcher: ['value', 'index'],
	moveinput: ['x', 'y'],
	onhit: ['speed', 'byMe']
});

/**
 * The input handles a node declares, or null when this cannot be known here.
 * @param {any} node @returns {string[] | null}
 */
export function knownInputs(node) {
	const t = node?.type;
	const data = node?.data ?? {};
	if (!t) return null;
	if (isVariadic(t)) return variadicInputs(data);
	if (t === 'switcher') return ['index', ...switcherItems(data).map((/** @type {any} */ _, /** @type {number} */ i) => switcherHandle(i))];
	if (t === 'script') return (scriptInputs(data) ?? [{ name: 'a' }, { name: 'b' }, { name: 'c' }]).map((d) => d.name);
	if (t === 'behaviour') return behaviourSockets(node)?.inputs.map((d) => d.name) ?? null;
	if (t === 'objectflow') return (graphOf(data.flowUuid ?? '')?.nodes ?? []).filter((/** @type {any} */ n) => n.type === 'flowinput').map((/** @type {any} */ n) => n.data?.name ?? 'value');
	// an Object Selector collects every effect wired into it, and a Flow Output harvests its wire, whatever
	// handle they name
	if (t === 'objectselector' || t === 'flowoutput') return null;
	const spec = /** @type {any} */ (findNodeSpec(t));
	const table = inputHandles(t);
	if (!spec && !table.length) return null; // a module node: its sockets are its own business
	// a wired value lands on data[handle] (flowRuntime's input injection), so every data key is an input too
	const out = [...(spec?.inputs ?? []), ...(spec?.params ?? []).map((/** @type {any} */ p) => p.key), ...Object.keys(spec?.defaults ?? {}), ...table];
	// a node with no named inputs (an On Click, a module node) is not judged
	return out.length ? [...new Set(out.map(String))] : null;
}

/**
 * The named outputs of a node whose output is a handle map, or null (a plain output, or not knowable).
 * @param {any} node @returns {string[] | null}
 */
export function knownMapOutputs(node) {
	const t = node?.type;
	const data = node?.data ?? {};
	if (MAP_OUTPUTS[t]) return MAP_OUTPUTS[t];
	if (t === 'script') return scriptOutputs(data).map((d) => d.name);
	if (t === 'behaviour') return behaviourSockets(node)?.outputs.map((d) => d.name) ?? null;
	if (t === 'objectflow') return (graphOf(data.flowUuid ?? '')?.nodes ?? []).filter((/** @type {any} */ n) => n.type === 'flowoutput').map((/** @type {any} */ n) => n.data?.name ?? 'out');
	const named = outputHandleNames(t);
	return named.length ? named : null;
}

/**
 * What is wrong with one end of an edge, or null. Pure over the two lists (exported for the unit test).
 * @param {string} type the node's type @param {string | undefined} handle the edge's handle (absent = the plain one)
 * @param {'input' | 'output'} dir @param {string[] | null} known the node's handles (null = not judged)
 * @returns {string | null}
 */
export function handleProblem(type, handle, dir, known) {
	if (!handle || !known) return null;
	if (known.includes(handle)) return null;
	const side = dir === 'input' ? 'toHandle' : 'fromHandle';
	return (
		side + ' "' + handle + '": a "' + type + '" node has no ' + dir + ' "' + handle + '" — ' +
		(known.length ? 'its ' + dir + 's: ' + known.join(', ') : 'it has no named ' + dir + 's (omit ' + side + ')')
	);
}

/**
 * Both ends of an edge, checked: the problems (empty = fine).
 * @param {any} source the source node @param {any} target the target node
 * @param {string | undefined} sourceHandle @param {string | undefined} targetHandle
 * @returns {string[]}
 */
export function edgeHandleProblems(source, target, sourceHandle, targetHandle) {
	/** @type {string[]} */
	const out = [];
	const from = handleProblem(source?.type, sourceHandle, 'output', sourceHandle ? knownMapOutputs(source) : null);
	if (from) out.push(from);
	const to = handleProblem(target?.type, targetHandle, 'input', targetHandle ? knownInputs(target) : null);
	if (to) out.push(to);
	return out;
}
