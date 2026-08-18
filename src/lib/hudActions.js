// 21-D7 — ACTIONS: binding a HUD element to behaviour, from the HUD editor.
//
// THE PROBLEM THIS SOLVES. 21-A made a button emit an event, but wiring it meant leaving the
// HUD editor, adding a `hudbutton` node by hand, and TYPING the element id into it. Nothing
// told you whether an element was wired, or to what. The loop existed and was undiscoverable.
//
// THE MODEL (the user's fork): actions ARE flow nodes — there is no second behaviour system,
// no second replication story and no second undo. What is new is that the HUD editor can
// CREATE AND WIRE them for you and LIST what is already bound. So this module is a VIEW on
// the flow graph plus a writer into it; the HUD document stays presentation-only.
//
// BOTH DIRECTIONS, because "all kinds should be possible to assign actions" means different
// things for different kinds:
//
//   * an INTERACTIVE element (a button) has an OUTGOING binding — "on press, do X".
//   * a DISPLAY element (text, bar, timer, list) has an INCOMING one — "driven by X". For a
//     score readout that IS the assignment, and it is the half a press-only model would
//     have left with no answer.
//
// The writer follows `ai/flowTools.js:createFlowNodesTool` exactly, including its edge-id
// format, which peer dedupe depends on, and its ONE `recordFlowNodesEntry` for the whole
// call — so an "Add action" is a single undo step and a single replicated batch.

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { SCENE_GRAPH, flowGraphs, allNodes, allEdges } from '../stores/flowStore';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import { findNodeSpec } from './nodeCatalog';
import { isInteractiveKind } from './hudKinds';

/** The HUD node types that READ an element (a display binding), by element kind. */
const DISPLAY_NODE = { text: 'hudtext', bar: 'hudbar', timer: 'hudtimer', list: 'hudlist' };

/** The HUD node type that a press comes FROM. */
const PRESS_NODE = 'hudbutton';

/** Every HUD node type that names an element, so a scan knows what to look at. */
export const HUD_BOUND_TYPES = [PRESS_NODE, 'hudtext', 'hudbar', 'hudtimer', 'hudlist', 'hudscreen'];

/**
 * @typedef {{
 *   key: string, label: string, group: string, hint?: string,
 *   role: 'press' | 'drives',
 *   node: string, data?: Record<string, any>,
 *   handle?: string,
 *   via?: { node: string, data?: Record<string, any>, handle: string }
 * }} HudActionDef
 */

/**
 * THE ACTION CATALOG. Curated on purpose: the whole point is a short list of things that make
 * sense on a HUD, with the full node palette one click away for anything else.
 *
 * `role: 'press'` — the element's press drives `node`. `role: 'drives'` — `node` writes INTO
 * the element, optionally fed by `via` (a value source wired to `via.handle`).
 * @type {HudActionDef[]}
 */
export const HUD_ACTIONS = [
	// --- what a button DOES -------------------------------------------------------
	{ key: 'start', label: 'Start the game', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'playing' }, handle: 'trigger', hint: 'Every peer enters play; a Game Start node decides which camera.' },
	{ key: 'pause', label: 'Pause', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'paused' }, handle: 'trigger' },
	{ key: 'resume', label: 'Resume', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'playing' }, handle: 'trigger' },
	{ key: 'gameover', label: 'End the game', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'over' }, handle: 'trigger' },
	{ key: 'menu', label: 'Back to the menu', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'menu' }, handle: 'trigger' },
	{ key: 'setvar', label: 'Set a variable', group: 'Game', role: 'press', node: 'setvariable', data: { name: 'score', op: 'add', value: 1 }, handle: 'trigger', hint: 'Add to, subtract from or set a shared number.' },
	{ key: 'camera', label: 'Look through a camera', group: 'Camera', role: 'press', node: 'setcamera', handle: 'trigger', hint: 'Moves each peer`s own view — nothing is sent, the press already was.' },
	{ key: 'showscreen', label: 'Show a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'show' }, handle: 'trigger' },
	{ key: 'hidescreen', label: 'Hide a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'hide' }, handle: 'trigger' },
	{ key: 'togglescreen', label: 'Toggle a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'toggle' }, handle: 'trigger' },
	{ key: 'count', label: 'Count the presses', group: 'Scene', role: 'press', node: 'counter', data: { step: 1, op: 'up' }, handle: 'pulse', hint: 'A Counter you can then show in a HUD Text.' },

	// --- what DRIVES a display element -------------------------------------------
	{ key: 'showvar', label: 'Show a variable', group: 'Data', role: 'drives', node: '', via: { node: 'getvariable', data: { name: 'score' }, handle: 'value' }, hint: 'A shared number — a score, lives, a level.' },
	{ key: 'showtime', label: 'Show the round time', group: 'Data', role: 'drives', node: '', via: { node: 'gametime', data: { read: 'remaining', length: 60 }, handle: 'value' }, hint: 'Derived from the shared start stamp, so every peer agrees.' },
	{ key: 'showcount', label: 'Show a counter', group: 'Data', role: 'drives', node: '', via: { node: 'counter', data: { step: 1, op: 'up' }, handle: 'value' }, hint: 'Wire anything that pulses into the Counter to make it a score.' },
	{ key: 'showplain', label: 'Just show text', group: 'Data', role: 'drives', node: '', hint: 'A HUD Text node with no source, so a graph can drive it later.' }
];

/** @param {string} kind @returns {HudActionDef[]} */
export function actionsForKind(kind) {
	const wantsPress = isInteractiveKind(kind);
	const displayNode = /** @type {any} */ (DISPLAY_NODE)[kind];
	return HUD_ACTIONS.filter((a) => (a.role === 'press' ? wantsPress : !!displayNode));
}

/** Grouped for the picker menu, in catalog order. @param {string} kind */
export function actionGroupsForKind(kind) {
	/** @type {{group: string, items: HudActionDef[]}[]} */
	const out = [];
	for (const action of actionsForKind(kind)) {
		let entry = out.find((e) => e.group === action.group);
		if (!entry) out.push((entry = { group: action.group, items: [] }));
		entry.items.push(action);
	}
	return out;
}

// ---- reading the graph ----------------------------------------------------------

/** The scene graph's nodes and edges. HUD nodes live in the SCENE graph — an element is a
 * screen-space thing, not an object's. */
function sceneGraph() {
	const doc = get(flowGraphs)[SCENE_GRAPH];
	return { nodes: doc?.nodes ?? [], edges: doc?.edges ?? [] };
}

/** A short human sentence for one action node, so the list reads like the thing it does
 * rather than like a node type. @param {any} node */
export function describeNode(node) {
	const d = node?.data ?? {};
	switch (node?.type) {
		case 'setgamestate':
			return 'Set game state → ' + (d.state ?? 'playing') + (d.outcome ? ' (' + d.outcome + ')' : '');
		case 'setcamera':
			return 'Look through a camera' + (d.camera ? '' : ' (none picked)');
		case 'setvariable':
			return (d.op === 'add' ? 'Add to' : d.op === 'subtract' ? 'Subtract from' : 'Set') + ' “' + (d.name ?? '') + '”';
		case 'hudscreen':
			return (d.action ?? 'show') + ' screen “' + (d.screen ?? '') + '”';
		case 'counter':
			return 'Count it';
		case 'getvariable':
			return 'Variable “' + (d.name ?? '') + '”';
		case 'gametime':
			return 'Round time (' + (d.read ?? 'elapsed') + ')';
		case 'hudtext':
			return 'Text' + (d.format && d.format !== '{v}' ? ' “' + d.format + '”' : '');
		case 'hudbar':
			return 'Bar';
		case 'hudtimer':
			return 'Timer';
		case 'hudlist':
			return 'List';
		default:
			return findNodeSpec(node?.type)?.label ?? String(node?.type ?? 'node');
	}
}

/**
 * WHAT IS BOUND to this element, read straight off the graph — so the list cannot drift from
 * what actually runs, and editing the nodes by hand shows up here.
 * @param {string} elementId
 * @returns {{role: 'press'|'drives', hudNodeId: string, actionNodeId: string|null, label: string, source: string}[]}
 */
export function bindingsFor(elementId) {
	if (!elementId) return [];
	const { nodes, edges } = sceneGraph();
	/** @type {any[]} */
	const out = [];
	for (const node of nodes) {
		if (!HUD_BOUND_TYPES.includes(node.type)) continue;
		if (String(node.data?.element ?? '') !== String(elementId)) continue;
		if (node.type === PRESS_NODE) {
			// outgoing: one row per action the press reaches
			const targets = edges.filter((e) => e.source === node.id);
			if (!targets.length) out.push({ role: 'press', hudNodeId: node.id, actionNodeId: null, label: 'Nothing yet', source: '' });
			for (const edge of targets) {
				const target = nodes.find((n) => n.id === edge.target);
				out.push({
					role: 'press',
					hudNodeId: node.id,
					actionNodeId: target?.id ?? null,
					label: target ? describeNode(target) : 'a deleted node',
					source: ''
				});
			}
		} else {
			// incoming: what feeds this display node's value
			const feed = edges.find((e) => e.target === node.id && e.targetHandle === 'value');
			const src = feed ? nodes.find((n) => n.id === feed.source) : null;
			out.push({
				role: 'drives',
				hudNodeId: node.id,
				actionNodeId: src?.id ?? null,
				label: describeNode(node),
				source: src ? describeNode(src) : ''
			});
		}
	}
	return out;
}

/** Is anything at all bound? The artboard badge reads this. @param {string} elementId */
export function isWired(elementId) {
	return bindingsFor(elementId).length > 0;
}

/** Every element id that has a binding, so the artboard can badge them in one pass.
 * @returns {Set<string>} */
export function wiredElementIds() {
	const { nodes } = sceneGraph();
	const out = new Set();
	for (const node of nodes) {
		if (!HUD_BOUND_TYPES.includes(node.type)) continue;
		const id = String(node.data?.element ?? '');
		if (id) out.add(id);
	}
	return out;
}

// ---- writing the graph ---------------------------------------------------------

let seq = 0;
/** @param {string} type */
function newId(type) {
	seq++;
	return 'hud-' + type + '-' + seq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** node data the editor would build: the spec's defaults, then ours (Nodes.svelte's shape).
 * @param {string} type @param {Record<string, any>} [data] */
function nodeData(type, data) {
	const spec = findNodeSpec(type);
	return { label: spec?.label ?? type, type, ...(spec?.defaults ?? {}), ...(data ?? {}) };
}

/** @param {string} type @param {number} x @param {number} y @param {Record<string, any>} [data] */
function makeNode(type, x, y, data) {
	return { id: newId(type), type, position: { x, y }, data: nodeData(type, data), class: 'w-[150px]' };
}

/** The editor's edge-id format. It MUST match, or peer dedupe diverges (flowTools' note).
 * @param {any} source @param {any} target @param {string} [handle] */
function makeEdge(source, target, handle) {
	return {
		id: 'e-' + source.id + '-' + target.id + (handle ? '.' + handle : ''),
		source: source.id,
		target: target.id,
		...(handle ? { targetHandle: handle } : {})
	};
}

/**
 * Bind an element to an action: create whatever nodes are missing, wire them, broadcast, and
 * record ONE undo entry for the lot.
 *
 * Laid out to the RIGHT of the existing HUD nodes on a coarse grid, so a graph built entirely
 * from this panel is still readable when you open the node editor.
 * @param {string} elementId @param {string} actionKey
 * @returns {{ok: boolean, reason?: string, nodes: any[]}}
 */
export function addBinding(elementId, actionKey) {
	const action = HUD_ACTIONS.find((a) => a.key === actionKey);
	if (!action || !elementId) return { ok: false, reason: 'unknown action', nodes: [] };
	const { nodes } = sceneGraph();
	/** @type {any} */
	const peer = get(peers);
	/** @type {any[]} */
	const created = [];
	/** @type {any[]} */
	const createdEdges = [];

	// where to put them: past whatever is furthest right, in a column per binding
	const baseX = nodes.reduce((max, n) => Math.max(max, Number(n.position?.x) || 0), 0) + 220;
	const baseY = 40 + bindingsFor(elementId).length * 150;

	if (action.role === 'press') {
		// reuse the element's EXISTING press node when it has one — a second `hudbutton` on
		// the same element would fire the action twice
		let press = nodes.find((n) => n.type === PRESS_NODE && String(n.data?.element ?? '') === String(elementId));
		if (!press) {
			press = makeNode(PRESS_NODE, baseX, baseY, { element: elementId });
			created.push(press);
		}
		const actionNode = makeNode(action.node, baseX + 220, baseY, action.data);
		created.push(actionNode);
		createdEdges.push(makeEdge(press, actionNode, action.handle));
	} else {
		const displayType = /** @type {any} */ (DISPLAY_NODE)[String(action.role === 'drives' ? currentKindOf(elementId) : '')] ?? 'hudtext';
		let display = nodes.find((n) => n.type === displayType && String(n.data?.element ?? '') === String(elementId));
		if (!display) {
			display = makeNode(displayType, baseX + 220, baseY, { element: elementId });
			created.push(display);
		}
		if (action.via) {
			const source = makeNode(action.via.node, baseX, baseY, action.via.data);
			created.push(source);
			createdEdges.push(makeEdge(source, display, action.via.handle));
		}
	}

	if (!created.length && !createdEdges.length) return { ok: false, reason: 'already bound', nodes: [] };

	// apply + broadcast in the editor's own order: nodes before edges
	for (const node of created) {
		createFlowNode(node, SCENE_GRAPH);
		if (peer) peer.send({ type: 'nodecreate', node: serializeNode(node), graphId: SCENE_GRAPH });
	}
	for (const edge of createdEdges) {
		createFlowEdge(edge, SCENE_GRAPH);
		if (peer) peer.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId: SCENE_GRAPH });
	}
	// ONE entry for the whole call, with SERIALIZED copies so a replayed re-broadcast hashes
	// identically on every peer (the nodesync drift guard)
	recordFlowNodesEntry({
		op: 'create',
		graphId: SCENE_GRAPH,
		nodes: created.map(serializeNode),
		edges: createdEdges.map(serializeEdge)
	});
	return { ok: true, nodes: created };
}

/** The element's kind, needed to pick the right display node. Read through allNodes' own
 * store rather than importing hudDocs, to keep this module's imports one-directional.
 * @type {(id: string) => string} */
let kindLookup = () => 'text';
/** The HUD editor supplies this (it already holds the document). @param {(id: string) => string} fn */
export function registerHudKindLookup(fn) {
	kindLookup = fn;
}
/** @param {string} id */
function currentKindOf(id) {
	try {
		return kindLookup(id) || 'text';
	} catch {
		return 'text';
	}
}

/**
 * Unbind: delete the action node and the HUD node that fed it, when that HUD node has nothing
 * else attached. ONE undo entry, replicated.
 * @param {{hudNodeId: string, actionNodeId: string|null, role: string}} binding
 */
export function removeBinding(binding) {
	const { nodes, edges } = sceneGraph();
	/** @type {any} */
	const peer = get(peers);
	/** @type {string[]} */
	const dropNodes = [];
	if (binding.actionNodeId) dropNodes.push(binding.actionNodeId);
	// keep the HUD node when it still serves another binding
	const others = edges.filter(
		(e) =>
			(e.source === binding.hudNodeId || e.target === binding.hudNodeId) &&
			e.source !== binding.actionNodeId &&
			e.target !== binding.actionNodeId
	);
	if (!others.length) dropNodes.push(binding.hudNodeId);

	const dropEdges = edges.filter((e) => dropNodes.includes(e.source) || dropNodes.includes(e.target));
	const keptNodes = nodes.filter((n) => dropNodes.includes(n.id));
	if (!keptNodes.length) return false;

	// edges BEFORE nodes, the 'flownodes' applier's own order
	import('./nodesHandler').then((m) => {
		m.deleteFlowEdges(dropEdges.map((e) => e.id), SCENE_GRAPH);
		m.deleteFlowNodes(dropNodes, SCENE_GRAPH);
	});
	if (peer) {
		peer.send({ type: 'edgedelete', ids: dropEdges.map((e) => e.id), graphId: SCENE_GRAPH });
		peer.send({ type: 'nodedelete', ids: dropNodes, graphId: SCENE_GRAPH });
	}
	recordFlowNodesEntry({
		op: 'delete',
		graphId: SCENE_GRAPH,
		nodes: keptNodes.map(serializeNode),
		edges: dropEdges.map(serializeEdge)
	});
	return true;
}
