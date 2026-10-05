// G1 — the readable-logic contract (roadmap 36, owner 36-dataflow; consumers 36-node-ux,
// 36-code, 36-games-graphs). A LEAF: it imports only builtinCode.js (another leaf), so the
// runtime, the editor, the code workspace and the template builders can all read it without
// closing a cycle.
//
// What it fixes is the user's own sentence: "nodes do not represent game logic, often not
// connected, cannot be edited or double-clicked to see the code, functionality hidden
// elsewhere". Four decisions, each chosen so NOTHING in the wire, the save format or the
// graph hash changes:
//
// 1. THE MAIN GRAPH IS THE SCENE GRAPH. `flowGraphs.scene` is already the one document
//    every scene has, already first in the Flow list, already replicated, saved and hashed.
//    A new "named graph" document kind would need a new key form in serializeGraphs (which
//    prunes every key that is not an object uuid), the nodes message, nodesync and undo.
//    So the convention is a LABEL ("Main") plus a migration that makes the logic hidden
//    elsewhere VISIBLE from it — never a new document.
// 2. EVERYTHING ELSE RIDES NODE DATA. Graph documents stay `{nodes, edges}` exactly.
// 3. CODE IS NODE DATA TOO. A node with code keeps its text in `data.code` (what the
//    runtime runs, what a peer without the asset still runs). `data.src` says where that
//    text came from — an Explorer script asset bound by hash (36-code, plan 75.3), or a
//    module's file (read-only until "Make editable copy" forks it into an asset).
// 4. GROUPS AND NOTES ARE VIEWS. The value graph never sees through a group: a group's
//    children stay ordinary nodes in `nodes[]` and the edges between them stay real. The
//    runtime ignores `group` and `note` nodes entirely (no value, no effect).

import { isBuiltinCodeType } from './builtinCode.js'; // 36-fb-code (F5)

/** The graph document that is "Main". */
export const MAIN_GRAPH = 'scene';
/** What the Flow list and the editor call it. */
export const MAIN_GRAPH_LABEL = 'Main';

/** Node types reserved for 36-node-ux (contract N1) — the KIND is the node's `type` (N1 confirmed
 * 2026-10-05). The runtime never evaluates them, nor a node whose `data.muted === true` (36-node-ux's
 * mute: not evaluated, its wires dropped, no pass-through) — one filter, `flowStore.runtimeGraph`,
 * owned by 36-node-ux, applied where flowRuntime takes its node/edge arrays. */
export const VIEW_NODE_TYPES = Object.freeze(['group', 'note']);

/** Socket types a value wire can carry (flowSockets' set, spelled once for consumers). */
export const SOCKET_TYPES = Object.freeze([
	'number',
	'boolean',
	'vector3',
	'color',
	'object',
	'event',
	'effect',
	'string',
	'any'
]);

/**
 * PROPERTY SCHEMA — what a node type declares so the Flow ⚙ panel can render and edit it.
 * It is the catalog's existing `params` list, grown (every old spec is already valid):
 *   key     the node.data key it edits (written with ONE setNodeData per commit)
 *   kind    'range' | 'number' | 'select' | 'toggle' | 'text' | 'color' | 'vector3' | 'code'
 *   label?  shown instead of the key; `doc?` one line under it
 *   group?  a heading the panel groups rows under (e.g. 'Shot', 'Timing')
 *   min/max/step (range, number) · options (select) · placeholder/maxLength (text)
 *   socket? false = never offer an input socket for it (a range gets one by default when the
 *           spec has `inputs`; any key named in `inputs` is wire-overridable via resolveInputs)
 * Module nodes declare the same list in `api.registerNodeGroup` items (`params`).
 * @typedef {{
 *   key: string,
 *   kind: 'range' | 'number' | 'select' | 'toggle' | 'text' | 'color' | 'vector3' | 'code',
 *   label?: string, doc?: string, group?: string,
 *   min?: number, max?: number, step?: number, options?: string[],
 *   placeholder?: string, maxLength?: number, socket?: boolean
 * }} PropSpec
 */

/**
 * VALUE SOCKETS. Inputs: a spec's `inputs: string[]` (+ optional `inputTypes: {name: type}`);
 * a module's `registerValueNode(type, fn, {inputs: {name: type}})`; a v2 script's
 * `data.inputs: [{name, type, value?}]` (`value` = the property used while unwired).
 * Outputs: one unnamed output (the node's value), or several NAMED outputs carried as a
 * handle map `{__handles: {name: value}, __default?}` and picked per edge by
 * `edge.sourceHandle` (script v2 `data.outputs: [{name, type}]`; core onhit/sequence/…).
 * A spec may list them for the editor as `outputs: [{name, type}]`.
 * @typedef {{ name: string, type: string, value?: any }} SocketSpec
 */

/**
 * WHERE A NODE'S CODE LIVES (`data.src`, optional; `data.code` always holds the text):
 *   {kind: 'inline'}                              the default when absent
 *   {kind: 'asset', hash, name}                   an Explorer script bound by content hash
 *                                                 (36-code updates `code` + `hash` on save)
 *   {kind: 'module', module, file, line?}         a module's source — read-only; "Make
 *                                                 editable copy" turns it into kind 'asset'
 * @typedef {{ kind: 'inline' } | { kind: 'asset', hash: string, name: string } |
 *   { kind: 'module', module: string, file: string, line?: number }} CodeSrc
 */

/**
 * What double-click / "Open code" asks the code workspace for (36-code implements
 * `openCode`; until it is merged the editor's existing Script panel is the fallback).
 * @typedef {{ source: 'script' | 'behaviour' | 'module' | 'customnode', ref: string,
 *   graphId?: string, line?: number, readonly?: boolean }} OpenCodeRequest
 */

/** Node types whose code lives in their own data. */
export const CODE_NODE_TYPES = Object.freeze(['script', 'behaviour']);

/** A kit node's type is `kit-<piece>-<call>`; its code is the piece's file in core. */
const KIT_TYPE = /^kit-([a-z]+)-/;

/** Does this node carry user-visible code (and so answer double-click with "Open code")?
 * `spec` (findNodeSpec(node.type), optional) tells a MODULE's node type by its `moduleId` tag.
 * @param {any} node @param {any} [spec] */
export function nodeHasCode(node, spec) {
	if (!node) return false;
	if (CODE_NODE_TYPES.includes(node.type)) return true;
	if (node.type === 'customnode') return true; // the def's code (NodeDesigner)
	if (node.type === 'coderef') return true; // a Main-graph link to a module's source
	if (KIT_TYPE.test(String(node.type))) return true; // the kit piece's source
	if (spec?.moduleId) return true; // a module's node: the module's source
	if (isBuiltinCodeType(node.type)) return true; // 36-fb-code (F5): a built-in with its own code (the Player)
	return !!node.data?.src;
}

/**
 * The OpenCodeRequest for a node, or null when it has no code.
 * @param {any} node @param {string} [graphId] @param {any} [spec] findNodeSpec(node.type)
 * @returns {OpenCodeRequest | null}
 */
export function openCodeRequestFor(node, graphId, spec) {
	if (!nodeHasCode(node, spec)) return null;
	const src = node.data?.src;
	if (src?.kind === 'module' || node.type === 'coderef')
		return {
			source: 'module',
			ref: (src?.module ?? node.data?.module ?? '') + ((src?.file ?? node.data?.file) ? '/' + (src?.file ?? node.data?.file) : ''),
			graphId,
			line: src?.line ?? node.data?.line,
			readonly: true
		};
	const kit = String(node.type).match(KIT_TYPE);
	if (kit) return { source: 'module', ref: 'kit/' + kit[1] + '.js', graphId, readonly: true };
	if (spec?.moduleId && !CODE_NODE_TYPES.includes(node.type) && node.type !== 'customnode')
		return { source: 'module', ref: String(spec.moduleId), graphId, readonly: true };
	if (node.type === 'customnode') return { source: 'customnode', ref: String(node.data?.defId ?? ''), graphId };
	return {
		source: node.type === 'behaviour' ? 'behaviour' : 'script',
		ref: node.id,
		graphId
	};
}

/** Is this graph id Main? @param {string | null | undefined} id */
export function isMainGraph(id) {
	return (id ?? MAIN_GRAPH) === MAIN_GRAPH;
}
