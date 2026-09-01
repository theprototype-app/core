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
// 21-E8: a chain action can end in an Object Selector, and the object it should name is
// the one the user has in front of them. The SET is authoritative (never the sticky
// `selectedObject`), and sceneStore is store-only, so this closes no cycle.
import { selectedObjects } from '../stores/sceneStore';
import { SCENE_GRAPH, flowGraphs, allNodes, allEdges } from '../stores/flowStore';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import { findNodeSpec } from './nodeCatalog';
import { isInteractiveKind, isValuedKind } from './hudKinds';
// R3a: module-contributed catalog entries live in the moduleHudKinds LEAF (this module
// reaches nodesHandler/flowGraphs — the history family — so moduleSDK cannot import it;
// the leaf is where both sides can meet, the moduleToolboxes rule)
import { moduleHudActionList } from './moduleHudKinds';

/** The HUD node types that READ an element (a display binding), by element kind. */
// 21-E7.6: the PACK kinds map onto the SAME four display nodes rather than earning nodes
// of their own — an icon row, a radial and a hotbar are all 'a number between min and max'
// (a HUD Bar node), and rich text, a key hint and a scroll panel are all 'a string' (a HUD
// Text node). Without these entries the Actions section offered a pack element NOTHING,
// which is the same 'the loop exists and is undiscoverable' problem 21-D7 was built to fix.
const DISPLAY_NODE = {
	text: 'hudtext',
	bar: 'hudbar',
	timer: 'hudtimer',
	list: 'hudlist',
	iconrow: 'hudbar',
	progressradial: 'hudbar',
	hotbar: 'hudbar',
	richtext: 'hudtext',
	keyhint: 'hudtext',
	scrollpanel: 'hudtext',
	// a custom or module element reads its whole runtime, and `text` is the channel every
	// value source already reaches, so HUD Text is the honest default there too
	custom: 'hudtext'
};

/** The HUD node type that a press comes FROM. */
const PRESS_NODE = 'hudbutton';

/** 21-D4: the kinds that actually FIRE a press. Not the same as `interactive`, which now
 * also covers the inputs - a slider is interactive and emits no press, so offering it
 * 'Start the game' would build a binding that can never fire. A TOGGLE does pulse (it
 * writes its value AND fires), which is exactly what a 'Sound: on/off' control wants. */
const PRESSABLE = ['button', 'toggle'];

/** The node that READS a valued element (21-D4). */
const VALUE_NODE = 'hudinput';

/** Every HUD node type that names an element, so a scan knows what to look at. */
// 21-E7.1: `hudrows` names an element too, so the artboard's wired badge must see it — a
// list filled by a HUD Rows node would otherwise read as dead at a glance.
// 21-G4: `leaderboard` names one too — and it is the only WRITER a list may have that is
// not edge-driven, so a board with no HUD List node beside it must still read as wired.
export const HUD_BOUND_TYPES = [PRESS_NODE, VALUE_NODE, 'hudset', 'hudtext', 'hudbar', 'hudtimer', 'hudlist', 'hudrows', 'hudscreen', 'leaderboard'];

/** 21-G4: the kinds a `role: 'writes'` action is offered for. A LIST is the only element
 * whose content is rows, and a scoreboard is rows. */
const ROWED = ['list'];

/**
 * @typedef {{
 *   key: string, label: string, group: string, hint?: string,
 *   role: 'press' | 'drives' | 'value' | 'writes',
 *   node: string, data?: Record<string, any>,
 *   handle?: string,
 *   via?: { node: string, data?: Record<string, any>, handle: string },
 *   chain?: { node: string, data?: Record<string, any>, handle?: string }[]
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
	// 21-F3: the FULL reset. Not a duplicate of "Back to the menu": it also zeroes the
	// round clock, and it goes through the very `resetGame()` the Users popover's admin
	// entry calls, so the two ways a game is reset are one function.
	{ key: 'resetgame', label: 'Reset the game', group: 'Game', role: 'press', node: 'setgamestate', data: { state: 'menu', reset: true }, handle: 'trigger', hint: 'Back to the menu AND the round clock to zero — collectibles read un-collected again.' },
	{ key: 'setvar', label: 'Set a variable', group: 'Game', role: 'press', node: 'setvariable', data: { name: 'score', op: 'add', value: 1 }, handle: 'trigger', hint: 'Add to, subtract from or set a shared number.' },
	// 21-F4: LEVEL COMPLETE — travel to a level. The destination is the AUTHOR'S PICK
	// on the Travel card, deliberately not a "next by folder order": the Explorer
	// library is LOCAL, so two peers can hold different orders and a computed "next"
	// would send them to different levels. A hash in the replicated graph is the only
	// shared truth about where "next" is.
	{ key: 'travel', label: 'Level complete — travel to a level', group: 'Game', role: 'press', node: 'travel', handle: 'trigger', hint: 'Everyone travels together, the game state carries — pick the destination on the Travel card.' },
	{ key: 'camera', label: 'Look through a camera', group: 'Camera', role: 'press', node: 'setcamera', handle: 'trigger', hint: 'Moves each peer`s own view — nothing is sent, the press already was.' },
	{ key: 'showscreen', label: 'Show a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'show' }, handle: 'trigger' },
	{ key: 'hidescreen', label: 'Hide a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'hide' }, handle: 'trigger' },
	{ key: 'togglescreen', label: 'Toggle a HUD screen', group: 'HUD', role: 'press', node: 'hudscreen', data: { action: 'toggle' }, handle: 'trigger' },
	{ key: 'count', label: 'Count the presses', group: 'Scene', role: 'press', node: 'counter', data: { step: 1, op: 'up' }, handle: 'pulse', hint: 'A Counter you can then show in a HUD Text.' },
	// 21-E8: the actions a GAME wants, now that the nodes behind them exist. Each one is
	// still just a node and an edge - the catalog stays a curated shortlist over the same
	// palette - but these are the verbs a menu or a HUD button reaches for first, and every
	// one of them was two trips through the node editor before.
	{ key: 'playanim', label: 'Play an animation', group: 'Scene', role: 'press', node: 'playanim', data: { action: 'toggle', speed: 1 }, handle: 'trigger', hint: 'Toggle plays the clip and plays it BACKWARDS to close - wire an Object Selector or put it in the object\u2019s own graph.' },
	// E4 gave Sound a `trigger` input, which is the whole reason play-a-sound-on-press was
	// not authorable by ANY means before: the node had `playing`, a continuous state, and
	// nothing to pulse.
	{ key: 'sound', label: 'Play a sound', group: 'Scene', role: 'press', node: 'sound', data: {}, handle: 'trigger', hint: 'One shot per press (E4 gave sound a trigger input).' },
	// `mode: 'burst'` is NOT decoration: particleRuntime fires a trigger only for an
	// emitter that is not continuous (`cfg.mode !== 'continuous' && cfg.trigger`), and the
	// `sparkles` preset this node is seeded from IS continuous - so the catalog default
	// would have built a 'Fire particles' binding that can never fire, which is exactly the
	// failure PRESSABLE exists to prevent one domain over.
	{ key: 'particles', label: 'Fire particles', group: 'Scene', role: 'press', node: 'particle', data: { mode: 'burst' }, handle: 'trigger' },
	{ key: 'impulse', label: 'Apply an impulse', group: 'Scene', role: 'press', node: 'impulse', data: { mode: 'impulse', space: 'world' }, handle: 'trigger', hint: 'Needs a running physics sim and a wired target object.' },
	{ key: 'resetcounter', label: 'Reset a counter', group: 'Game', role: 'press', node: 'counter', data: { op: 'up', step: 1 }, handle: 'reset', hint: 'Zeroes the counter this press reaches - round 2 starts clean.' },
	// the one CHAIN action in the catalog, and the reason chains exist at all: 'hide it, and
	// show it again next press' is not ONE node. Every trigger in this app is a ~0.3s pulse,
	// so a Latch is what makes the state PERSIST after that pulse has expired - which is
	// exactly what E4 added it for.
	{
		key: 'togglevis',
		label: "Toggle an object's visibility",
		group: 'Scene',
		role: 'press',
		node: '',
		chain: [
			// `initial: true` = VISIBLE before the first press, which is two things at once:
			// it makes the hint literally true (press to hide, press to show) and it stops
			// ASSIGNING the action from hiding the object on the spot, which is what the
			// node's own default would have done the moment the chain existed.
			{ node: 'latch', handle: 'toggle', data: { initial: true } },
			{ node: 'visibility', handle: 'on' },
			// no handle: an Object Selector takes the UNNAMED target handle (its `_default`
			// socket), which is what every effect node in the app already wires into
			{ node: 'objectselector' }
		],
		hint: 'Uses a Latch, so the state persists - press to hide, press to show.'
	},

	// --- what DRIVES a display element -------------------------------------------
	{ key: 'showvar', label: 'Show a variable', group: 'Data', role: 'drives', node: '', via: { node: 'getvariable', data: { name: 'score' }, handle: 'value' }, hint: 'A shared number — a score, lives, a level.' },
	{ key: 'showtime', label: 'Show the round time', group: 'Data', role: 'drives', node: '', via: { node: 'gametime', data: { read: 'remaining', length: 60 }, handle: 'value' }, hint: 'Derived from the shared start stamp, so every peer agrees.' },
	{ key: 'showcount', label: 'Show a counter', group: 'Data', role: 'drives', node: '', via: { node: 'counter', data: { step: 1, op: 'up' }, handle: 'value' }, hint: 'Wire anything that pulses into the Counter to make it a score.' },
	// 21-F3's "Show collectibles left" MOVED to the collectible module (R3a): its via-node
	// was `collectcount`, which moved with the chain shape. A module contributes catalog
	// entries through `api.hud.registerAction` (merged in `actionsForKind` below).
	{ key: 'showplain', label: 'Just show text', group: 'Data', role: 'drives', node: '', hint: 'A HUD Text node with no source, so a graph can drive it later.' },
	// 21-G4: THE LEADERBOARD, and it needed a fourth role. Every 'drives' action wires a
	// value source into a display node's `value` handle, and a list has no such handle —
	// a list is WRITTEN INTO by id (the socket system has no arrays). So `writes` creates
	// ONE node that names the element and fills it, which is what `hudrows` already does
	// on an edge and what a scoreboard does continuously.
	{ key: 'leaderboard', label: 'Show a leaderboard', group: 'Data', role: 'writes', node: 'leaderboard', data: { variable: 'laps', order: 'desc' }, hint: 'One row per player, from their own per-player variable — derived on every peer, so nothing is sent.' },

	// --- 21-D4: what an INPUT's value can do -------------------------------------
	// These create the SOURCE node and stop there, deliberately. A slider's value is
	// wanted in a hundred places (a Map Range into a volume, a Compare, a Set
	// Variable's value) and no short list would cover them, so the honest thing is to
	// put the reader in the graph, name it in this pane, and let the graph do graph
	// work. The pane still answers 'is this control wired to anything'.
	{ key: 'readvalue', label: 'Read its value', group: 'Data', role: 'value', node: '', data: { read: 'value' }, hint: 'A HUD Input node you can wire into anything - a Map Range, a Compare, a variable.' },
	{ key: 'readindex', label: 'Read which option', group: 'Data', role: 'value', node: '', data: { read: 'index' }, hint: 'The position in the option list - what a Switcher wants.' },
	{ key: 'readtext', label: 'Read its text', group: 'Data', role: 'value', node: '', data: { read: 'text' }, hint: 'The typed text, for a name or a room code.' }
];

/** The catalog plus whatever modules registered (R3a — `api.hud.registerAction`, held
 * in the moduleHudKinds leaf because this module reaches the history family).
 * @returns {HudActionDef[]} */
function fullCatalog() {
	const moduleActions = /** @type {HudActionDef[]} */ (moduleHudActionList());
	return moduleActions.length ? [...HUD_ACTIONS, ...moduleActions] : HUD_ACTIONS;
}

/** @param {string} kind @returns {HudActionDef[]} */
export function actionsForKind(kind) {
	const wantsPress = PRESSABLE.includes(kind) && isInteractiveKind(kind);
	const displayNode = /** @type {any} */ (DISPLAY_NODE)[kind];
	const valued = isValuedKind(kind);
	return fullCatalog().filter((a) =>
		a.role === 'press'
			? wantsPress
			: a.role === 'value'
				? valued
				: a.role === 'writes'
					? ROWED.includes(kind)
					: !!displayNode
	);
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
 * rather than like a node type.
 *
 * 21-E8: `handle` is the TARGET handle the edge landed on, and it exists for ONE reason -
 * a Counter reached through `reset` does the OPPOSITE of a Counter reached through
 * `pulse`, and the row called both of them "Count it". Everything else here reads the
 * same whichever socket fed it, so nothing else consults it; absent = the old wording.
 * @param {any} node @param {string|null} [handle] */
export function describeNode(node, handle = null) {
	const d = node?.data ?? {};
	switch (node?.type) {
		case 'hudrows':
			// 21-E7.1
			return (d.op === 'clear' ? 'Clear the rows of ' : d.op === 'set' ? 'Set the rows of ' : 'Add a row to ') + (d.element || 'an element');
		case 'setgamestate':
			// 21-F3: a full reset does something a state change does not, so it must not
			// read as "Set game state -> menu" (the Counter reset/pulse lesson, verbatim)
			if (d.reset) return 'Reset the game';
			return 'Set game state → ' + (d.state ?? 'playing') + (d.outcome ? ' (' + d.outcome + ')' : '');
		case 'setcamera':
			return 'Look through a camera' + (d.camera ? '' : ' (none picked)');
		case 'setvariable':
			// 21-G4: WHOSE number it writes is the difference between a score and a
			// scoreboard row, so the row has to say it (the Counter reset/pulse lesson)
			return (
				(d.op === 'add' ? 'Add to' : d.op === 'subtract' ? 'Subtract from' : 'Set') +
				' “' +
				(d.name ?? '') +
				'”' +
				(d.scope === 'player' ? ' (this player’s own)' : '')
			);
		case 'peervariable':
			return (
				'Player variable “' +
				(d.name ?? '') +
				'” (' +
				(d.read === 'sum' ? 'everyone’s total' : d.read === 'max' ? 'the highest' : d.read === 'peer' ? 'one peer' : 'mine') +
				')'
			);
		case 'leaderboard':
			return 'Leaderboard of “' + (d.variable ?? '') + '”';
		case 'hudscreen':
			// 21-E8: `hide` names no screen (it drops this peer’s override, whatever it is), so
			// the row said 'hide screen “”' - empty quotes reading as an unfinished field.
			return (d.action ?? 'show') === 'hide' && !d.screen
				? 'Hide the current screen'
				: (d.action ?? 'show') + ' screen “' + (d.screen ?? '') + '”';
		case 'counter':
			return handle === 'reset' ? 'Reset counter' : 'Count it';
		// 21-E8: the game verbs. Each says what HAPPENS, not which node does it - a row
		// reading 'Play Animation' would just be the palette label with extra steps.
		case 'playanim':
			return 'Play animation (' + (d.action ?? 'toggle') + ')';
		case 'sound':
			return 'Play a sound';
		case 'particle':
			return 'Fire particles';
		case 'impulse':
			return 'Apply an impulse';
		case 'latch':
			return 'Latch (persistent on/off)';
		case 'visibility':
			return 'Show/hide an object';
		case 'delay':
			return 'After ' + (d.seconds ?? 1) + 's';
		case 'sequence':
			return 'Step sequence';
		case 'once':
			return 'Only once';
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
		case 'hudinput':
			return 'Reads its ' + (d.read ?? 'value');
		case 'hudset':
			return 'Sets it to ' + (d.value ?? 0);
		default:
			// R3a: a MODULE node has no case here and no core spec — its own label (the
			// palette card's) is the honest description
			return findNodeSpec(node?.type)?.label ?? d.label ?? String(node?.type ?? 'node');
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
		if (node.type === PRESS_NODE || node.type === VALUE_NODE) {
			// both READ OUT of the element: a press pulses, a value flows, so both are
			// described by what they REACH - and an unwired one is worth saying out loud,
			// since a dead control is exactly what this pane exists to make visible
			// outgoing: one row per action the press reaches
			const targets = edges.filter((e) => e.source === node.id);
			const role = node.type === VALUE_NODE ? 'value' : 'press';
			if (!targets.length)
				out.push({
					role,
					hudNodeId: node.id,
					actionNodeId: null,
					label: role === 'value' ? 'Read, not wired yet' : 'Nothing yet',
					source: ''
				});
			for (const edge of targets) {
				const target = nodes.find((n) => n.id === edge.target);
				out.push({
					role,
					hudNodeId: node.id,
					actionNodeId: target?.id ?? null,
					// the HANDLE, not just the node: a Counter on `reset` is not a Counter on `pulse`
					label: target ? describeNode(target, edge.targetHandle ?? null) : 'a deleted node',
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
	const action = fullCatalog().find((a) => a.key === actionKey);
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

	if (action.role === 'value') {
		// ONE reader per (element, read) - a second identical HUD Input would be two nodes
		// computing the same number, and the pane would list the control twice
		const want = String(action.data?.read ?? 'value');
		const existing = nodes.find(
			(n) =>
				n.type === VALUE_NODE &&
				String(n.data?.element ?? '') === String(elementId) &&
				String(n.data?.read ?? 'value') === want
		);
		if (existing) return { ok: false, reason: 'that value is already read', nodes: [] };
		created.push(makeNode(VALUE_NODE, baseX, baseY, { element: elementId, ...action.data }));
	} else if (action.role === 'writes') {
		// ONE writer per (element, node type) — a second Leaderboard on the same list would
		// be two derivations racing to own the same rows every tick
		const existing = nodes.find(
			(n) => n.type === action.node && String(n.data?.element ?? '') === String(elementId)
		);
		if (existing) return { ok: false, reason: 'that element already has one', nodes: [] };
		created.push(makeNode(action.node, baseX, baseY, { element: elementId, ...action.data }));
	} else if (action.role === 'press') {
		// reuse the element's EXISTING press node when it has one — a second `hudbutton` on
		// the same element would fire the action twice
		let press = nodes.find((n) => n.type === PRESS_NODE && String(n.data?.element ?? '') === String(elementId));
		if (!press) {
			press = makeNode(PRESS_NODE, baseX, baseY, { element: elementId });
			created.push(press);
		}
		if (action.chain?.length) {
			// 21-E8: a CHAIN action. Some verbs are genuinely more than one node (hide-and-show
			// needs a Latch to hold the state and an Object Selector to say WHOSE), and building
			// them by hand is precisely the trip through the node editor this pane exists to
			// remove. It rides the SAME path as a single-node action from here on - one
			// recordFlowNodesEntry, one broadcast batch, one undo step - so a chain is a longer
			// binding and not a new concept. A single-node action never enters this branch, so
			// every existing key is byte-identical.
			let prev = press;
			let col = 1;
			for (const step of action.chain) {
				/** @type {Record<string, any>} */
				const data = { ...(step.data ?? {}) };
				// an Object Selector the def did not pin takes the CURRENT selection: the action
				// means "this object", the HUD editor has no scene-object picker of its own, and
				// the selection is what the user has in front of them. With nothing selected it
				// keeps the spec default ('-None-'), so the chain is built and inert rather than
				// refused - the node card is then the one obvious place to name a target.
				if (step.node === 'objectselector' && !data.selected) {
					const picked = get(selectedObjects)[0];
					if (picked) data.selected = picked;
				}
				const node = makeNode(step.node, baseX + col * 220, baseY, data);
				created.push(node);
				createdEdges.push(makeEdge(prev, node, step.handle));
				prev = node;
				col++;
			}
		} else {
			const actionNode = makeNode(action.node, baseX + 220, baseY, action.data);
			created.push(actionNode);
			createdEdges.push(makeEdge(press, actionNode, action.handle));
		}
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
