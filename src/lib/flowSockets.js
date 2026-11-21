// Phase 165: socket types for the flow graph. Each node's output + named input
// handles carry a type; a connection is allowed only between compatible types
// (same type, or a sane coercion). Value nodes feed typed consumer inputs; the
// effect/anim/action nodes carry the special 'effect' type into an Object
// Selector. Existing saved edges are NOT re-validated — only new drags.

import { graphOf } from '../stores/flowStore';
import { moduleValueTypes, moduleNodeInputs } from './moduleNodeIO';
import { scriptSocketType } from './scriptIO'; // 34 D3: a Script node's DECLARED sockets
import { dataSocketType } from './variadicNodes.js'; // 37 (R6): the Switcher's data-typed sockets
import { coreSocketTables } from './nodes/index.js'; // 2.0 N1: the node definitions

/**
 * 36 (U10): a BEHAVIOUR node's sockets are declared in its CODE (`inputs`, `outputs`), which only
 * the analyzer can read — and the analyzer (acorn) loads with the behaviours. behaviours/app.js
 * registers the reader here, so this leaf stays light; before it does, a behaviour has no typed
 * sockets (nothing can be wired to one before the behaviours start anyway).
 * @type {null | ((node: any) => {inputs: {name: string, type: string}[], outputs: {name: string, type: string}[]} | null)}
 */
let behaviourSocketsOf = null;
/** @param {(node: any) => {inputs: {name: string, type: string}[], outputs: {name: string, type: string}[]} | null} fn */
export function registerBehaviourSockets(fn) {
	behaviourSocketsOf = fn;
}
/** a behaviour node's declared socket type, or null @param {any} node @param {string|null|undefined} handle @param {'input'|'output'} dir */
export function behaviourSocketType(node, handle, dir) {
	if (node?.type !== 'behaviour' || !handle || !behaviourSocketsOf) return null;
	const sockets = behaviourSocketsOf(node);
	const list = dir === 'input' ? sockets?.inputs : sockets?.outputs;
	return list?.find((s) => s.name === handle)?.type ?? null;
}

// 2.0 N1: the three socket tables are GENERATED from the node definitions (src/lib/nodes) — a
// type's sockets live beside its palette entry, card and value now, with the per-type notes that
// used to sit here. Lookups below are unchanged.
const { OUTPUT, INPUT, OUTPUT_HANDLES } = coreSocketTables();

/** 74 VH1: the NAMED source handles a node type declares beyond its plain output — the VR logic panel draws
 * sockets from these tables (a headset has no DOM for xyflow to measure handles from) @param {string} nodeType */
export function outputHandleNames(nodeType) {
	return Object.keys(OUTPUT_HANDLES[nodeType] ?? {});
}

/** 74 VH1: a behaviour node's declared sockets, or null before the behaviours load @param {any} node */
export function behaviourSockets(node) {
	return node?.type === 'behaviour' && behaviourSocketsOf ? behaviourSocketsOf(node) : null;
}

/** the type a source HANDLE carries @param {string} nodeType @param {string|null|undefined} handleId */
export function outputHandleType(nodeType, handleId) {
	return (handleId && OUTPUT_HANDLES[nodeType]?.[handleId]) || outputType(nodeType);
}

// what an OUTPUT type may feed into a differently-typed INPUT
/** @type {Record<string, string[]>} */
const COERCE = {
	number: ['boolean', 'vector3'],
	boolean: ['number'],
	event: ['number', 'boolean'],
	vector3: ['object'],
	object: ['vector3']
};

/** @param {string} nodeType */
export function outputType(nodeType) {
	// A1: a module VALUE node declares its own output type. Without this read the
	// fallback below answered 'effect' for every module type, and an effect output
	// may only reach an effect input — so a module value could not be wired to
	// ANYTHING. That refusal is why module state could not reach a HUD.
	if (moduleValueTypes[nodeType]) return moduleValueTypes[nodeType];
	// anim / effect / action / script / sound / module nodes drive an Object
	// Selector, so their output is the special 'effect' channel
	return OUTPUT[nodeType] ?? 'effect';
}

/**
 * The named input handles a node type DECLARES — module inputs first, then the static
 * table, with the `_default` catch-all excluded because it names no socket. Added for
 * the palette-group check (`moduleInputHandles` is the same one line, one module over):
 * the Triggers group means "arriving from OUTSIDE the graph", and the machine-checkable
 * half of that is "it is a SOURCE" — nothing wired into it. A Counter has pulse/reset,
 * which is exactly why it belongs with the stateful Logic nodes instead.
 * @param {string} nodeType @returns {string[]}
 */
export function inputHandles(nodeType) {
	const declared = { ...(moduleNodeInputs[nodeType] ?? {}), ...(INPUT[nodeType] ?? {}) };
	return Object.keys(declared).filter((handle) => handle !== '_default');
}

/** @param {string} nodeType @param {string|null|undefined} handleId */
export function inputType(nodeType, handleId) {
	// A1: a module may declare its node's typed inputs. Checked FIRST, because the
	// static table has no entry for a module type and the fallback is 'number' —
	// which refuses an Object Selector (object -> number is not a coercion).
	const modIn = moduleNodeInputs[nodeType];
	if (modIn) {
		if (handleId && modIn[handleId]) return modIn[handleId];
		if (modIn._default) return modIn._default;
	}
	const map = INPUT[nodeType];
	if (!map) return 'number'; // e.g. anim range params (spin.speed) are numeric
	return (handleId && map[handleId]) || map._default || 'number';
}

/** May an output of `from` connect to an input of `to`? @param {string} from @param {string} to */
export function canConnect(from, to) {
	if (from === to) return true;
	// 4.6 audit fix: EVENT sources (On Click) must reach the Object Selector's
	// effect input — that's the only way fireObjectClick can act on the scene.
	// The blanket effect-only rule rejected it, so the trigger was un-authorable.
	if (from === 'event' && to === 'effect') return true;
	if (from === 'effect' || to === 'effect') return false; // effect only to effect
	return (COERCE[from] || []).includes(to);
}

/** the socket types that have a hue and a shape of their own (the rest draw as `any`) */
export const SOCKET_TYPES = ['number', 'vector3', 'boolean', 'color', 'object', 'event', 'effect'];

/** UI tint per socket type (165). 53 A2: a theme TOKEN (theme.css --socket-tint-<type> — not --socket-<type>: Socket.svelte sets a
 * local --socket-color, and `--socket-color: var(--socket-color)` would be a cycle), so light and
 * High contrast state their own hues — a CSS value, painted through `style`.
 * @param {string} type */
export function typeColor(type) {
	return `var(--socket-tint-${SOCKET_TYPES.includes(type) ? type : 'any'})`;
}

/** 53 A2: the type's SHAPE (theme.css --socket-shape-<type>), so a socket never says its type by
 * colour alone: number disc, vector3 diamond, boolean square, color hexagon, object pentagon,
 * event arrow, effect star, anything else a capsule. A `clip-path` value.
 * @param {string} type */
export function socketShape(type) {
	return `var(--socket-shape-${SOCKET_TYPES.includes(type) ? type : 'any'})`;
}

/**
 * The type one source handle of a placed node carries (data-declared types first). 2.0-n3b: shared by the
 * editor's drag check and the agent tools' edge check, so the two read one rule.
 * @param {any} source @param {string|null|undefined} sourceHandle @returns {string}
 */
export function sourceSocketType(source, sourceHandle) {
	return source.type === 'flowinput'
		? source.data?.vtype ?? 'number'
		: // 34 D3: a script output's type is DATA (its declaration), like flowinput's vtype
			scriptSocketType(source.type, source.data, sourceHandle, 'output') ??
				// 37 (R6): the Switcher's `value` output carries its vtype
				dataSocketType(source, sourceHandle, 'output') ??
				// 36 (U10): a behaviour's outputs are declared in its code
				behaviourSocketType(source, sourceHandle, 'output') ??
				outputHandleType(source.type, sourceHandle);
}

/**
 * Validate a proposed connection against the two nodes' socket types.
 * @param {any} connection xyflow {source, target, sourceHandle, targetHandle}
 * @param {any[]} nodes the current flow nodes
 * @returns {boolean}
 */
export function isValidFlowConnection(connection, nodes) {
	if (!connection || connection.source === connection.target) return false;
	const source = nodes.find((n) => n.id === connection.source);
	const target = nodes.find((n) => n.id === connection.target);
	if (!source || !target) return false;
	// H5: the object-flow interface types come from node DATA / the referenced
	// graph's declarations, not the static type table
	const from = sourceSocketType(source, connection.sourceHandle);
	if (source.type === 'objectflow') {
		// embedded outputs carry whatever the flow's outputs compute — untyped v1,
		// anything except the effect channel may consume them
		return resolvedInputType(target, connection.targetHandle) !== 'effect';
	}
	const to = resolvedInputType(target, connection.targetHandle);
	if (to === 'any') return from !== 'effect'; // flow outputs accept any value
	if (from === 'any') return to !== 'effect'; // 36 (U10): an untyped value (a behaviour's text/list state) feeds any value input
	return canConnect(from, to);
}

/**
 * 36 (U10): the type a GROUP's routed socket carries for an inner endpoint — the one rule the
 * node editor's group reconcile and the template author's both use (a data-declared script or
 * behaviour output, else the static table), so an authored group never needs rewriting on open.
 * @param {any} node @param {string|null} socket @param {'in'|'out'} dir
 */
export function groupSocketType(node, socket, dir) {
	try {
		const t =
			dir === 'in'
				? resolvedInputType(node, socket)
				: scriptSocketType(node?.type, node?.data, socket, 'output') ?? dataSocketType(node, socket, 'output') ?? behaviourSocketType(node, socket, 'output') ?? outputHandleType(node?.type, socket);
		return t || 'any';
	} catch {
		return 'any';
	}
}

/**
 * A target node's ACTUAL input type for a handle — the static table plus the
 * H5 data-declared cases (flowoutput accepts any value; objectflow inputs take
 * the referenced flow's declared vtype).
 * @param {any} targetNode @param {string|null|undefined} handleId
 */
export function resolvedInputType(targetNode, handleId) {
	if (!targetNode) return 'number';
	if (targetNode.type === 'flowoutput') return 'any';
	// 34 D3: a v2 Script node's inputs are declared in its data
	const declared =
		scriptSocketType(targetNode.type, targetNode.data, handleId, 'input') ??
		dataSocketType(targetNode, handleId, 'input') ?? // 37 (R6): a Switcher's typed item sockets
		behaviourSocketType(targetNode, handleId, 'input');
	if (declared) return declared;
	if (targetNode.type === 'objectflow') {
		const graph = graphOf(targetNode.data?.flowUuid ?? '');
		const decl = graph?.nodes.find(
			(/** @type {any} */ n) => n.type === 'flowinput' && (n.data?.name ?? 'value') === handleId
		);
		return decl?.data?.vtype ?? 'number';
	}
	return inputType(targetNode.type, handleId);
}

/**
 * Single-connection inputs (Blender/UE semantics): a NAMED value input holds at
 * most one wire — connecting a new one REPLACES the old (the runtime only reads
 * the first edge anyway). Multi-fan-IN stays for the effect channel (many
 * animations into one Object Selector) and event inputs (many triggers into one
 * Counter); fan-OUT from one output to many inputs is always unlimited.
 * @param {any} connection the NEW connection being made
 * @param {any[]} nodes @param {any[]} edges
 * @returns {string[]} ids of existing edges the new wire replaces
 */
export function replaceableInputEdges(connection, nodes, edges) {
	if (!connection?.targetHandle) return []; // unnamed handles = the effect channel
	const target = nodes.find((n) => n.id === connection.target);
	const type = resolvedInputType(target, connection.targetHandle);
	if (type === 'effect' || type === 'event') return [];
	return edges
		.filter((e) => e.target === connection.target && e.targetHandle === connection.targetHandle)
		.map((e) => e.id);
}
