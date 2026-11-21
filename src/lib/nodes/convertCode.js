// 2.0-n3c (roadmap 2.0 N3c) — CONVERT TO CODE, as a PLAN. A pure node of a convertible type becomes
// a Script VALUE node with the same id, the same socket names and every wire kept; its code is the
// type's reference JS (reference.js) behind `const params = {…}` (the node's settings, inlined), and
// `data.convertedFrom` remembers what it was. "Convert back" restores the built-in while the code
// and the sockets are still exactly what Convert wrote.
//
// HUD Text is an EFFECT (it writes a HUD element), so it cannot become a value node: Convert puts a
// Script node in FRONT of it that computes the words (its formatting, as code) and wires that into
// the HUD Text's `format` input, which shows wired text as it is. Its value / format wires move to
// the script. Convert back undoes exactly that.
//
// A LEAF that imports only leaves: the plan is data (`remove` then `add`, nodes + edges, serialized
// shapes), so the applier (convertToCode.js) sends it on the ordinary nodedelete / edgedelete /
// nodecreate / edgecreate messages as ONE undo step, and an older peer applies it unchanged. Script
// value nodes already exist, so no new message and no new sync class.

import { REFERENCE_JS, REFERENCE_TYPES, referenceShape } from './reference.js';
import { printLiteral } from './flowCode.js';

/** the node types Convert to code accepts */
export const CONVERTIBLE = new Set(REFERENCE_TYPES);

/** the name a converted node shows on its card @type {Record<string, string>} */
const TITLES = {
	math: 'Math',
	compare: 'Compare',
	gate: 'Gate',
	select: 'Select',
	maprange: 'Map Range',
	random: 'Random',
	hudtext: 'HUD Text format'
};

/**
 * @typedef {{ id: string, type: string, position: {x: number, y: number}, data: any, class?: string }} PlanNode
 * @typedef {{ id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string, type?: string, markerEnd?: any }} PlanEdge
 * @typedef {{ nodes: PlanNode[], edges: PlanEdge[] }} PlanPart
 * @typedef {{ ok: true, remove: PlanPart, add: PlanPart, focus: string, label: string } | { ok: false, error: string }} Plan
 */

/** the canonical edge id (nodeGroups.edgeId; peer dedupe relies on it) */
function edgeId(/** @type {string} */ s, /** @type {any} */ sh, /** @type {string} */ t, /** @type {any} */ th) {
	return 'e-' + s + (sh ? '.' + sh : '') + '-' + t + (th ? '.' + th : '');
}

/** a serialized edge with new ends; the id follows the ends @param {any} e @param {any} over */
function moved(e, over) {
	const next = { ...e, ...over };
	if (!next.sourceHandle) delete next.sourceHandle;
	if (!next.targetHandle) delete next.targetHandle;
	next.id = edgeId(next.source, next.sourceHandle, next.target, next.targetHandle);
	return next;
}

/** @param {any} n */
function plainNode(n) {
	return {
		id: n.id,
		type: n.type,
		position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
		data: structuredClone(n.data ?? {}),
		...(n.class ? { class: n.class } : {})
	};
}

/** @param {any} e */
function plainEdge(e) {
	const out = /** @type {any} */ ({ id: e.id, source: e.source, target: e.target });
	if (e.sourceHandle) out.sourceHandle = e.sourceHandle;
	if (e.targetHandle) out.targetHandle = e.targetHandle;
	if (e.type) out.type = e.type;
	if (e.markerEnd) out.markerEnd = e.markerEnd;
	return out;
}

/**
 * The code a node of `type` converts to: the reference with the node's params inlined.
 * @param {string} type @param {Record<string, any>} params
 */
export function convertedCode(type, params) {
	return (
		`// convertedFrom: ${type} (${TITLES[type] ?? type}): the built-in's own reference, with this node's settings in \`params\`.\n` +
		`// Edit it freely. "Convert back" (node menu) returns the built-in node while this code is unchanged.\n` +
		`const params = ${printLiteral(params)};\n` +
		REFERENCE_JS[type]
	);
}

/** does a group's boundary name this node's output (its socket id would change)? @param {any[]} nodes @param {string} id */
function feedsGroupSocket(nodes, id) {
	return nodes.some(
		(n) =>
			n.type === 'group' &&
			(n.data?.outputs ?? []).some((/** @type {any} */ o) => Array.isArray(o.from) && o.from[0] === id)
	);
}
/** @param {any[]} nodes @param {string} id */
function takesGroupSocket(nodes, id) {
	return nodes.some(
		(n) => n.type === 'group' && (n.data?.inputs ?? []).some((/** @type {any} */ i) => Array.isArray(i.to) && i.to[0] === id)
	);
}

/**
 * Is `node` a converted Script node whose code and sockets are still what Convert wrote?
 * @param {any} node
 */
export function isUnchangedConversion(node) {
	const from = node?.data?.convertedFrom;
	if (node?.type !== 'script' || !from || typeof from !== 'object') return false;
	if (typeof from.code !== 'string' || node.data.code !== from.code) return false;
	const shape = referenceShape(from.type, from.data, new Set(from.wired ?? []));
	if (!shape) return false;
	return (
		JSON.stringify(node.data.inputs ?? null) === JSON.stringify(shape.inputs) &&
		JSON.stringify(node.data.outputs ?? null) === JSON.stringify(shape.outputs)
	);
}

/** What the node menu offers for `node`: 'convert', 'back', 'changed' (converted, edited) or null.
 * A HUD Text answers 'back' when a format script made from it still stands in front of it.
 * @param {any} node @param {{nodes: any[]}} [graph] */
export function conversionState(node, graph) {
	if (!node) return null;
	if (node.type === 'hudtext') {
		const script = graph?.nodes?.find((n) => n.type === 'script' && n.data?.convertedFrom?.target === node.id);
		if (script) return isUnchangedConversion(script) ? 'back' : 'changed';
		return 'convert';
	}
	if (CONVERTIBLE.has(node.type)) return 'convert';
	if (node.type === 'script' && node.data?.convertedFrom) return isUnchangedConversion(node) ? 'back' : 'changed';
	return null;
}

/**
 * Plan "Convert to code" for node `id` in `graph`.
 * @param {{nodes: any[], edges: any[]}} graph @param {string} id
 * @param {{ newId?: () => string, v?: (type: string) => number }} [opts] newId mints the HUD Text's script id;
 *   v = the definition version the node was made with (absent = 1)
 * @returns {Plan}
 */
export function planConvert(graph, id, opts = {}) {
	const node = graph.nodes.find((n) => n.id === id);
	if (!node) return { ok: false, error: 'No node ' + id + ' in this graph' };
	if (!CONVERTIBLE.has(node.type))
		return { ok: false, error: `${node.type} has no code form yet (Convert to code takes: ${REFERENCE_TYPES.join(', ')})` };
	const v = opts.v?.(node.type) ?? 1;
	const into = graph.edges.filter((e) => e.target === id);
	const out = graph.edges.filter((e) => e.source === id);
	const wired = new Set(into.map((e) => e.targetHandle).filter(Boolean));
	const shape = /** @type {import('./reference.js').RefShape} */ (referenceShape(node.type, node.data, wired));
	const code = convertedCode(node.type, shape.params);
	const convertedFrom = { type: node.type, v, data: structuredClone(node.data ?? {}), code, ...(wired.size ? { wired: [...wired].sort() } : {}) };
	const keep = /** @type {Record<string, any>} */ ({});
	for (const k of ['label', 'muted', 'collapsed']) if (node.data?.[k] !== undefined) keep[k] = node.data[k];

	if (node.type === 'hudtext') {
		if (conversionState(node, graph) !== 'convert') return { ok: false, error: 'This HUD Text already has a format script in front of it' };
		if (takesGroupSocket(graph.nodes, id)) return { ok: false, error: 'A group socket feeds this node: ungroup it first' };
		const sid = opts.newId?.() ?? id + '-code';
		if (graph.nodes.some((n) => n.id === sid)) return { ok: false, error: 'Id ' + sid + ' is taken' };
		const script = {
			id: sid,
			type: 'script',
			position: { x: (node.position?.x ?? 0) - 260, y: node.position?.y ?? 0 },
			data: { type: 'script', name: TITLES.hudtext, code, inputs: shape.inputs, outputs: shape.outputs, convertedFrom: { ...convertedFrom, target: id } }
		};
		const movedIn = into.filter((e) => e.targetHandle === 'value' || e.targetHandle === 'format');
		return {
			ok: true,
			label: 'Convert HUD Text formatting to code',
			focus: sid,
			remove: { nodes: [], edges: movedIn.map(plainEdge) },
			add: {
				nodes: [script],
				edges: [...movedIn.map((e) => moved(plainEdge(e), { target: sid })), moved({}, { source: sid, sourceHandle: 'text', target: id, targetHandle: 'format' })]
			}
		};
	}

	if (feedsGroupSocket(graph.nodes, id)) return { ok: false, error: "This node feeds a group's socket: ungroup it first" };
	const script = {
		id,
		type: 'script',
		position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
		data: { ...keep, type: 'script', name: TITLES[node.type] + ' (code)', code, inputs: shape.inputs, outputs: shape.outputs, convertedFrom },
		...(node.class ? { class: node.class } : {})
	};
	const handle = shape.outputs[0].name;
	return {
		ok: true,
		label: `Convert ${TITLES[node.type]} to code`,
		focus: id,
		remove: { nodes: [plainNode(node)], edges: [...into, ...out].map(plainEdge) },
		add: {
			nodes: [script],
			edges: [...into.map(plainEdge), ...out.map((e) => (e.sourceHandle ? plainEdge(e) : moved(plainEdge(e), { sourceHandle: handle })))]
		}
	};
}

/**
 * Plan "Convert back" for node `id` (a converted Script node, or a HUD Text with its format script).
 * Refused once the code or the sockets were edited: the built-in could not do what the edit does.
 * @param {{nodes: any[], edges: any[]}} graph @param {string} id
 * @returns {Plan}
 */
export function planConvertBack(graph, id) {
	let node = graph.nodes.find((n) => n.id === id);
	if (!node) return { ok: false, error: 'No node ' + id + ' in this graph' };
	if (node.type === 'hudtext') {
		const script = graph.nodes.find((n) => n.type === 'script' && n.data?.convertedFrom?.target === id);
		if (!script) return { ok: false, error: 'This HUD Text has no format script to convert back' };
		node = script;
	}
	const from = node.data?.convertedFrom;
	if (node.type !== 'script' || !from) return { ok: false, error: 'This node was not converted from a built-in' };
	if (!isUnchangedConversion(node))
		return { ok: false, error: 'The code was edited since Convert to code: the built-in cannot do what it does now. Undo the edits, or keep it as code' };
	const into = graph.edges.filter((e) => e.target === node.id);
	const out = graph.edges.filter((e) => e.source === node.id);

	if (from.type === 'hudtext') {
		const hud = graph.nodes.find((n) => n.id === from.target);
		if (!hud) return { ok: false, error: 'The HUD Text this script formats is gone' };
		return {
			ok: true,
			label: 'Convert HUD Text formatting back',
			focus: hud.id,
			remove: { nodes: [plainNode(node)], edges: [...into, ...out].map(plainEdge) },
			add: { nodes: [], edges: into.map((e) => moved(plainEdge(e), { target: hud.id })) }
		};
	}
	const shape = /** @type {import('./reference.js').RefShape} */ (referenceShape(from.type, from.data, new Set(from.wired ?? [])));
	const handle = shape.outputs[0].name;
	const builtIn = {
		id: node.id,
		type: from.type,
		position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
		data: { ...structuredClone(from.data ?? {}) },
		...(node.class ? { class: node.class } : {})
	};
	for (const k of ['label', 'muted', 'collapsed']) {
		if (node.data?.[k] !== undefined) builtIn.data[k] = node.data[k];
		else delete builtIn.data[k];
	}
	return {
		ok: true,
		label: `Convert ${TITLES[from.type] ?? from.type} back`,
		focus: node.id,
		remove: { nodes: [plainNode(node)], edges: [...into, ...out].map(plainEdge) },
		add: {
			nodes: [builtIn],
			edges: [...into.map(plainEdge), ...out.map((e) => (e.sourceHandle === handle ? moved(plainEdge(e), { sourceHandle: undefined }) : plainEdge(e)))]
		}
	};
}
