// VR controls — 74 VH1: EDIT GAME LOGIC IN THE HEADSET. The node editor's graph as a panel pinned in the
// world (Tools ▸ Logic, or Selected ▸ Edit logic for the selected object's own flow), with a WRIST PAD on
// the off hand for the values of the node you picked.
//
//   · a trigger-DRAG on a card moves it (one undo step, peers watch it move — `nodemove` while it travels,
//     the same message the desktop sends);
//   · a trigger-drag from a SOCKET draws a wire with the laser; letting go on a matching socket connects
//     them (green while it fits, red when the types refuse — isValidFlowConnection is the one judge), and
//     a wire into an occupied value input replaces the old one, exactly as on the desktop. A drag that
//     starts on an input already holding a wire PICKS THAT WIRE UP: drop it elsewhere to move it, in the
//     empty graph to delete it;
//   · a trigger CLICK on a card selects it: the wrist pad shows its values (− / + for numbers, the value
//     box opens the VR keyboard; ‹ › for choices and colours; toggles), plus Rename / Unwire / Delete;
//   · a trigger-drag on the empty graph pans it, the stick (laser on the panel) zooms at the laser, Fit
//     frames everything; + Node opens the palette (the desktop's groups and node types) and drops the
//     new card in the middle of the view;
//   · a grip on the panel carries it; let go and it stays there.
//
// EVERY WRITE IS THE DESKTOP'S OWN PATH: nodesHandler's appliers + the same broadcast + one
// `recordFlowNodesEntry` per gesture (edges get the desktop's handle-qualified id, or peer dedupe
// diverges), so a peer on the desktop sees each move, wire and value land live, and Ctrl+Z / the panel's
// ↶ takes it back. A viewer (cloud roles) gets the panel read-only and says so.
//
// The panel is ONE canvas on ONE plane and the pad another (logicPanelDraw.js); the layout, the hit test
// and the pad's fields are the pure half (logicGraphCore.js). LOCAL: which graph is open, the view, the
// selection on the panel, where it is pinned — facts about this headset, never replicated.
//
// Data modules are PRIMED dynamic imports (the aiPanel / assetBrowser rule): flowGraphs, history and the
// catalog reach the history family, and a static edge from vr/ closes a loop a green build can TDZ-crash.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, globalRenderer, isVRMode, vrMenuOpen, selectedObjects, objectsGroup } from '../../stores/sceneStore';
import { flowGraphs, graphOf, SCENE_GRAPH } from '../../stores/flowStore';
import { peers } from '../../stores/appStore';
import { safeStorage } from '../safeStorage';
import { openVRKeyboard, vrKeyboardTarget } from '../vrKeyboard';
import { registerVRMenuEntry, unregisterVRMenuEntry } from '../vrRadialMenu';
import { registerVRFrameHook, registerVRTriggerHooks, registerGripHooks, registerStickOwner } from './hooks.js';
import { registerOverlayPanel } from './pointer.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { pointerHand, oneHandedHand } from './bindings.js';
import { hapticPulse } from './haptics.js';
import { vrAssetBrowserOpen, closeVRAssetBrowser } from './assetBrowser.js';
import {
	nodeSockets,
	cardLayout,
	fitView,
	toCanvas,
	toGraph,
	zoomAt,
	hitGraph,
	connectionOf,
	edgeIdOf,
	edgesIntoSocket,
	padFields,
	stepNumber,
	parseNumber,
	cycleOption,
	cycleSwatch,
	fieldText,
	dropPoint
} from './logicGraphCore.js';
import { drawLogicPanel, drawLogicPad, hitAt, PANEL_PX, PAD_PX, GRAPH_AREA, PAD_ROWS, PAL_GROUPS, PAL_PAGE } from './logicPanelDraw.js';

/** the radial entries: Tools ▸ Logic, Selected ▸ Edit logic */
export const RADIAL_TOOLS = { id: 'logic', group: 'tools', order: 6.2 };
export const RADIAL_OBJECT = { id: 'obj:logic', group: 'object', order: 4.8 };
/** the panel and the pad in metres */
export const PANEL_M = { w: 0.96, h: (0.96 * PANEL_PX.h) / PANEL_PX.w };
export const PAD_M = { w: 0.2, h: (0.2 * PAD_PX.h) / PAD_PX.w };
/** the pad rides the off hand's grip space like the Asset Browser: above the back of the hand */
const WRIST_OFFSET = new THREE.Vector3(0, 0.085, 0.05);
const TOUCH_RANGE = 0.15;
/** canvas px a trigger may travel before a press on a card becomes a drag */
const DRAG_SLOP = 10;
const STICK_FLICK = 0.6;
const STICK_REARM = 0.3;
/** a node travelling under the laser tells peers at most this often */
const MOVE_SEND_MS = 100;
/** while a drag repaints every frame, the canvas re-uploads at most this often */
const DRAG_PAINT_MS = 33;

/** the panel is up */
export const vrLogicOpen = writable(false);

/** @type {any} */ let handlersRef = null;
/** @type {any} */ let flowGraphsRef = null;
/** @type {any} */ let historyRef = null;
/** @type {any} */ let catalogRef = null;
/** @type {any} */ let socketsRef = null;
/** @type {any} */ let groupsRef = null;
/** @type {any} */ let permsRef = null;
/** @type {any} */ let scriptRef = null;
/** @type {any} */ let variadicRef = null;
/** @type {any} */ let typePrefsRef = null;
/** @type {any} */ let moduleSdkRef = null;
const primed = Promise.all([
	import('../nodesHandler').then((m) => (handlersRef = m)),
	import('../flowGraphs').then((m) => (flowGraphsRef = m)),
	import('../history').then((m) => (historyRef = m)),
	import('../nodeCatalog').then((m) => (catalogRef = m)),
	import('../flowSockets').then((m) => (socketsRef = m)),
	import('../nodeGroups').then((m) => (groupsRef = m)),
	import('../objectPermissions').then((m) => (permsRef = m)),
	import('../scriptIO').then((m) => (scriptRef = m)),
	import('../variadicNodes.js').then((m) => (variadicRef = m)),
	import('../nodeTypePrefs').then((m) => (typePrefsRef = m)),
	import('../moduleSDK').then((m) => (moduleSdkRef = m))
]).catch(() => {});
const ready = () => !!(handlersRef && flowGraphsRef && historyRef && catalogRef && socketsRef && groupsRef);

// ---- state ------------------------------------------------------------------------------------------
/** the graph on the panel: 'scene' or an object uuid */
let graphId = SCENE_GRAPH;
/** the object the second tab offers (the selection when the panel opened, following it while open) */
let objectTab = /** @type {string | null} */ (null);
/** per graph: the view transform (kept while you switch tabs) @type {Map<string, {s: number, ox: number, oy: number}>} */
const views = new Map();
/** the card the pad edits @type {string | null} */
let selected = null;
let padPage = 0;
/** the add-a-node palette, or null @type {{group: number, gpage: number, page: number} | null} */
let palette = null;
/** nodes added since the panel opened (staggers the drop point) */
let added = 0;
/** @type {'pinned' | 'held'} */
let mode = 'pinned';
const pinned = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
/** @type {any} */ let held = null;
let status = { text: '', tone: /** @type {'info' | 'warn' | 'bad'} */ ('info'), until: 0 };
/**
 * The trigger gesture in progress (one at a time): a press on a card (`node`, a drag once it travels), on a
 * socket (`wire`), on the empty graph (`pan`).
 * @type {null | {slot: number, kind: 'node' | 'wire' | 'pan', start: {x: number, y: number}, moved: boolean,
 *   node?: string, from?: {x: number, y: number}, grab?: {x: number, y: number}, lastSend?: number,
 *   socket?: {node: string, dir: 'in' | 'out', id: string | null}, detach?: any, end?: {x: number, y: number},
 *   target?: any, ok?: boolean | null, view?: {s: number, ox: number, oy: number}}}
 */
let drag = null;
/** the trailing 'select' of a press the panel took (consumed once) */
let swallowNext = false;
let swallowSetAt = 0;

/** @type {any} */ let panelMesh = null;
/** @type {any} */ let padMesh = null;
/** @type {HTMLCanvasElement | null} */ let panelCanvas = null;
/** @type {HTMLCanvasElement | null} */ let padCanvas = null;
/** @type {any} */ let panelTex = null;
/** @type {any} */ let padTex = null;
/** @type {import('./logicPanelDraw.js').PanelHit[]} */ let panelHits = [];
/** @type {import('./logicPanelDraw.js').PanelHit[]} */ let padHits = [];
/** per slot: what its laser is on — {on: 'panel'|'pad'|null, px, py, button, graph} */
const lasers = [/** @type {any} */ ({ on: null }), /** @type {any} */ ({ on: null })];
const stickArmed = [true, true];
let graphRev = 0;
let panelSig = '';
let padSig = '';
let lastPanelPaint = 0;
let mounted = false;
/** the suites' view */
const debug = { panelDraws: 0, padDraws: 0, presses: /** @type {string[]} */ ([]), writes: /** @type {string[]} */ ([]), refused: 0 };
const perf = { frames: 0, frameMs: 0, paintMs: 0 };

/** @param {string} text @param {'info' | 'warn' | 'bad'} [tone] @param {number} [ms] */
function say(text, tone = 'info', ms = 4000) {
	status = { text, tone, until: Date.now() + ms };
}

// ---- the graph as the panel sees it -----------------------------------------------------------------
/** @param {string} id */
function objectOf(id) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', id) ?? null;
}
/** the object's display name for the tab @param {string | null} id */
function objectName(id) {
	if (!id) return '';
	const o = objectOf(id);
	return o?.name || 'Object';
}
function readOnly() {
	return !!permsRef?.isViewer?.();
}

/** short socket label: a catalog inputLabel up to its explanation @param {string} s */
const shortLabel = (s) => String(s).split(' — ')[0];

/**
 * What the socket tables declare for a node (logicGraphCore.nodeSockets adds every wired handle after).
 * @param {any} node @returns {{inputs: string[], outputs: string[], unnamedIn: boolean, unnamedOut: boolean, labels: Record<string, string>}}
 */
function socketInfo(node) {
	const t = node.type;
	const data = node.data ?? {};
	const spec = catalogRef?.findNodeSpec?.(t) ?? null;
	/** @type {string[]} */ const inputs = [];
	/** @type {string[]} */ const outputs = [];
	/** @type {Record<string, string>} */ const labels = {};
	if (t === 'note' || t === 'group') return { inputs, outputs, unnamedIn: false, unnamedOut: false, labels };
	if (variadicRef?.isVariadic?.(t)) inputs.push(...variadicRef.variadicInputs(data));
	else if (t === 'switcher') {
		inputs.push('index');
		(variadicRef?.switcherItems?.(data) ?? []).forEach((/** @type {any} */ _, /** @type {number} */ i) => inputs.push(variadicRef.switcherHandle(i)));
		outputs.push('value');
	} else if (t === 'script') {
		const decl = scriptRef?.scriptInputs?.(data);
		inputs.push(...(decl ? decl.map((/** @type {any} */ d) => d.name) : ['a', 'b', 'c']));
		outputs.push(...(scriptRef?.scriptOutputs?.(data) ?? []).map((/** @type {any} */ d) => d.name));
	} else if (t === 'behaviour') {
		const s = socketsRef?.behaviourSockets?.(node);
		inputs.push(...(s?.inputs ?? []).map((/** @type {any} */ d) => d.name));
		outputs.push(...(s?.outputs ?? []).map((/** @type {any} */ d) => d.name));
	} else if (t === 'objectflow') {
		for (const n of graphOf(data.flowUuid ?? '')?.nodes ?? []) {
			if (n.type === 'flowinput') inputs.push(n.data?.name ?? 'value');
			if (n.type === 'flowoutput') outputs.push(n.data?.name ?? 'out');
		}
	} else if (t === 'flowoutput') inputs.push('value');
	else {
		for (const k of spec?.inputs ?? []) inputs.push(k);
		for (const p of spec?.params ?? []) if (p.kind === 'range' || p.socket) inputs.push(p.key);
		for (const k of socketsRef?.inputHandles?.(t) ?? []) inputs.push(k);
	}
	if (t === 'sequence') outputs.push('step1', 'step2', 'step3', 'step4');
	outputs.push(...(socketsRef?.outputHandleNames?.(t) ?? []));
	for (const [k, v] of Object.entries(spec?.inputLabels ?? {})) labels[k] = shortLabel(/** @type {string} */ (v));
	for (const p of spec?.params ?? []) if (p.label && !labels[p.key]) labels[p.key] = p.label;
	const named = ['behaviour', 'objectflow', 'sequence', 'flowoutput'];
	return { inputs, outputs, unnamedIn: t === 'objectselector', unnamedOut: !named.includes(t), labels };
}

/** the socket's type for the glyph @param {any} node @param {string | null} id @param {'in' | 'out'} dir */
function socketType(node, id, dir) {
	try {
		return socketsRef?.groupSocketType?.(node, id, dir) ?? 'any';
	} catch {
		return 'any';
	}
}

/** @type {{rev: number, graphId: string, cards: any[], wires: any[], nodes: any[], edges: any[]} | null} */
let laid = null;
/** The panel's layout of the open graph, rebuilt only when the graph (or the module registry) changes. */
function layout() {
	if (laid && laid.rev === graphRev && laid.graphId === graphId) return laid;
	const graph = graphOf(graphId) ?? { nodes: [], edges: [] };
	const nodes = graph.nodes ?? [];
	const edges = graph.edges ?? [];
	let visible = new Set(nodes.map((/** @type {any} */ n) => n.id));
	/** @type {any[]} */ let proxies = [];
	/** @type {Set<string> | null} */ let direct = null;
	if (groupsRef && nodes.some((/** @type {any} */ n) => n.type === 'group')) {
		const view = groupsRef.graphView(nodes, edges, null);
		visible = view.visible;
		proxies = view.proxies;
		direct = view.direct;
	}
	const shown = nodes.filter((/** @type {any} */ n) => visible.has(n.id));
	const drawnEdges = [...edges.filter((/** @type {any} */ e) => (direct ? direct.has(e.id) : visible.has(e.source) && visible.has(e.target))), ...proxies];
	// notes first: a backdrop under the cards (the desktop's order)
	const ordered = [...shown.filter((/** @type {any} */ n) => n.type === 'note'), ...shown.filter((/** @type {any} */ n) => n.type !== 'note')];
	const byId = new Map();
	const cards = ordered.map((/** @type {any} */ n) => {
		const sockets = nodeSockets(n, socketInfo(n), drawnEdges);
		const c = /** @type {any} */ (cardLayout(n, sockets));
		c.node = n;
		c.label = n.type === 'note' ? n.data?.title || 'Note' : n.data?.label || catalogRef?.findNodeSpec?.(n.type)?.label || n.type;
		c.group = catalogRef?.groupOf?.(n.type) ?? null;
		for (const s of c.inputs) s.type = socketType(n, s.id, 'in');
		for (const s of c.outputs) s.type = socketType(n, s.id, 'out');
		if (n.type !== 'note' && !c.inputs.some((/** @type {any} */ s) => s.id) && !c.outputs.some((/** @type {any} */ s) => s.id)) {
			const f = padFields(n, catalogRef?.findNodeSpec?.(n.type), edges)[0];
			if (f) c.sub = `${f.label} ${fieldText(f)}`;
		}
		byId.set(n.id, c);
		return c;
	});
	const wires = drawnEdges
		.map((/** @type {any} */ e) => {
			const s = byId.get(e.source);
			const t = byId.get(e.target);
			const a = s?.outputs.find((/** @type {any} */ x) => x.id === (e.sourceHandle ?? null));
			const b = t?.inputs.find((/** @type {any} */ x) => x.id === (e.targetHandle ?? null));
			if (!a || !b) return null;
			return { id: e.id, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, type: a.type, proxy: !!e.data?.proxy, edge: e };
		})
		.filter(Boolean);
	laid = { rev: graphRev, graphId, cards, wires, nodes, edges };
	return laid;
}

/** the view for the open graph (fitted the first time) */
function viewNow() {
	let v = views.get(graphId);
	if (!v) {
		v = fitView(layout().cards, GRAPH_AREA);
		views.set(graphId, v);
	}
	return v;
}
function refit() {
	views.set(graphId, fitView(layout().cards, GRAPH_AREA));
}

// ---- writes (the desktop's paths) -----------------------------------------------------------------------
/** may we write? (a viewer's edits would reach nobody) — says why when not */
function canWrite() {
	if (!ready()) return false;
	if (readOnly()) {
		debug.refused++;
		say('View only: ask the host for edit access to change the logic', 'warn');
		hapticPulse(0.1, 40);
		return false;
	}
	return true;
}
function peer() {
	return /** @type {any} */ (get(peers));
}
function edgeStyle() {
	return safeStorage.getItem('flowEdgeStyle') ?? 'bezier';
}
/** ONE undo step for everything inside `fn` @param {string} label @param {() => void} fn */
function inBatch(label, fn) {
	historyRef.beginHistoryBatch();
	try {
		fn();
	} finally {
		historyRef.endHistoryBatch(label);
	}
}
/** the object graph exists before a write into it (replicated + undoable, the desktop's implicit create) */
function ensureGraph() {
	if (graphId !== SCENE_GRAPH && !graphOf(graphId)) flowGraphsRef.createObjectGraph(graphId);
}

/** a card moved under the laser: record the whole travel as one step @param {string} id @param {{x: number, y: number}} before @param {{x: number, y: number}} after */
function commitMove(id, before, after) {
	if (before.x === after.x && before.y === after.y) return;
	peer()?.send({ type: 'nodemove', id, position: after, graphId });
	flowGraphsRef.recordFlowNodesEntry({ op: 'move', graphId, items: [{ id, before: { ...before }, after: { ...after } }] });
	debug.writes.push('move');
}

/** remove wires (one undo step unless inside a batch) @param {any[]} edges */
function removeEdges(edges) {
	if (!edges.length) return;
	const ids = edges.map((e) => e.id);
	handlersRef.deleteFlowEdges(ids, graphId);
	peer()?.send({ type: 'edgedelete', ids, graphId });
	flowGraphsRef.recordFlowNodesEntry({ op: 'delete', graphId, nodes: [], edges: edges.map(handlersRef.serializeEdge) });
}

/**
 * Connect two sockets: the desktop's rules (a value input holds one wire — the new one replaces it; effect
 * and event inputs fan in), its edge id and shape, one undo step with any wire it replaces or moves.
 * @param {{source: string, sourceHandle: string | null, target: string, targetHandle: string | null}} c
 * @param {any} [moving] the wire picked up from an input (removed in the same step)
 * @returns {boolean}
 */
function connect(c, moving = null) {
	const { nodes, edges } = graphOf(graphId) ?? { nodes: [], edges: [] };
	const real = { source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined };
	if (!socketsRef.isValidFlowConnection(real, nodes)) return false;
	const id = edgeIdOf(c);
	if (edges.some((/** @type {any} */ e) => e.id === id) && (!moving || moving.id === id)) return true; // already wired: nothing to do
	const staleIds = new Set(socketsRef.replaceableInputEdges(real, nodes, edges));
	if (moving) staleIds.add(moving.id);
	const stale = edges.filter((/** @type {any} */ e) => staleIds.has(e.id) && e.id !== id);
	const edge = {
		id,
		source: c.source,
		target: c.target,
		...(c.sourceHandle ? { sourceHandle: c.sourceHandle } : {}),
		...(c.targetHandle ? { targetHandle: c.targetHandle } : {}),
		type: edgeStyle(),
		markerEnd: { type: 'arrowclosed', width: 16, height: 16 }
	};
	inBatch('Connect', () => {
		removeEdges(stale);
		handlersRef.createFlowEdge(edge, graphId);
		const serialized = handlersRef.serializeEdge(edge);
		peer()?.send({ type: 'edgecreate', edge: serialized, graphId });
		flowGraphsRef.recordFlowNodesEntry({ op: 'create', graphId, nodes: [], edges: [serialized] });
	});
	debug.writes.push('connect');
	return true;
}

/** set node values (one undo step) @param {string} id @param {Record<string, any>} patch */
function setValues(id, patch) {
	if (!canWrite()) return;
	const node = graphOf(graphId)?.nodes.find((/** @type {any} */ n) => n.id === id);
	if (!node) return;
	/** @type {Record<string, any>} */ const before = {};
	for (const k of Object.keys(patch)) before[k] = node.data?.[k];
	handlersRef.setNodeData(id, patch, graphId);
	flowGraphsRef.recordFlowNodesEntry({ op: 'data', graphId, items: [{ id, before, after: patch }] });
	debug.writes.push('data');
}

/** add a node of `type` in the middle of the view, selected (one undo step, with the graph it may create) @param {string} type */
function addNode(type) {
	if (!canWrite()) return;
	const spec = catalogRef.findNodeSpec(type);
	const node = {
		id: crypto.randomUUID(),
		type,
		position: dropPoint(viewNow(), GRAPH_AREA, added++),
		data: { label: spec?.label ?? `${type} node`, type, ...(spec?.defaults ?? {}) },
		class: 'w-[150px]'
	};
	inBatch('Add nodes', () => {
		ensureGraph();
		handlersRef.createFlowNode(node, graphId);
		const serialized = handlersRef.serializeNode(node);
		peer()?.send({ type: 'nodecreate', node: serialized, graphId });
		flowGraphsRef.recordFlowNodesEntry({ op: 'create', graphId, nodes: [serialized], edges: [] });
	});
	selected = node.id;
	padPage = 0;
	palette = null;
	debug.writes.push('add:' + type);
	say(`${node.data.label} added — trigger-drag it where you want it`);
}

/** delete the selected node and its wires (one undo step) */
function deleteSelected() {
	if (!selected || !canWrite()) return;
	const { nodes, edges } = graphOf(graphId) ?? { nodes: [], edges: [] };
	const node = nodes.find((/** @type {any} */ n) => n.id === selected);
	if (!node) return;
	if (node.type === 'group') {
		say('Delete a group on the desktop (it takes its contents with it)', 'warn');
		return;
	}
	const gone = edges.filter((/** @type {any} */ e) => e.source === node.id || e.target === node.id);
	handlersRef.deleteFlowNodes([node.id], graphId);
	peer()?.send({ type: 'nodedelete', ids: [node.id], graphId });
	flowGraphsRef.recordFlowNodesEntry({ op: 'delete', graphId, nodes: [handlersRef.serializeNode(node)], edges: gone.map(handlersRef.serializeEdge) });
	debug.writes.push('delete');
	say(`${node.data?.label ?? node.type} deleted — ↶ brings it back`);
	selected = null;
}

/** remove every wire on the selected node */
function unwireSelected() {
	if (!selected || !canWrite()) return;
	const gone = (graphOf(graphId)?.edges ?? []).filter((/** @type {any} */ e) => e.source === selected || e.target === selected);
	if (!gone.length) return;
	removeEdges(gone);
	debug.writes.push('unwire');
}

// ---- presses ------------------------------------------------------------------------------------------
/** the palette's groups (the desktop palette's: catalog + modules, minus the types switched off) */
function paletteGroups() {
	const groups = [...(catalogRef?.nodeCatalog ?? []), ...(moduleSdkRef ? get(moduleSdkRef.moduleNodeGroups) : [])];
	const enabled = typePrefsRef ? typePrefsRef.enabledCatalog(groups, get(typePrefsRef.disabledNodeTypes)) : groups;
	// a flow's interface nodes only mean something inside an object flow; the rest need a desktop picker
	const skip = new Set(['customnode', 'objectflow', 'sound', ...(graphId === SCENE_GRAPH ? ['flowinput', 'flowoutput'] : [])]);
	return enabled
		.map((/** @type {any} */ g) => ({ group: g.group, items: g.items.filter((/** @type {any} */ i) => !skip.has(i.type)) }))
		.filter((/** @type {any} */ g) => g.items.length);
}

/**
 * Press a control on the panel or the pad.
 * @param {string} id @param {number} [slot] the controller slot that pressed
 */
export function pressLogicButton(id, slot = -1) {
	debug.presses.push(id);
	void slot;
	if (id === 'close') return closeVRLogic();
	if (id === 'graph:scene') return switchGraph(SCENE_GRAPH);
	if (id === 'graph:object') return objectTab ? switchGraph(objectTab) : undefined;
	if (id === 'fit') return refit();
	if (id.startsWith('zoom:')) {
		const v = viewNow();
		views.set(graphId, zoomAt(v, Number(id.slice(5)) > 0 ? 1.25 : 0.8, GRAPH_AREA.x + GRAPH_AREA.w / 2, GRAPH_AREA.y + GRAPH_AREA.h / 2));
		return;
	}
	if (id === 'undo') return void historyRef?.undo?.();
	if (id === 'redo') return void historyRef?.redo?.();
	if (id === 'add') {
		if (palette) palette = null;
		else if (canWrite()) palette = { group: 0, gpage: 0, page: 0 };
		return;
	}
	if (id.startsWith('pal:')) return pressPalette(id.slice(4));
	// the pad
	if (id === 'page:-1' || id === 'page:1') {
		padPage += Number(id.slice(5));
		return;
	}
	if (id === 'delete') return deleteSelected();
	if (id === 'disconnect') return unwireSelected();
	if (id === 'rename') return renameSelected();
	if (id.startsWith('f:')) return pressField(id);
}

/** @param {string} id */
function pressPalette(id) {
	if (!palette) return;
	const groups = paletteGroups();
	if (id.startsWith('group:')) {
		palette.group = Number(id.slice(6)) || 0;
		palette.page = 0;
	} else if (id.startsWith('gpage:')) {
		palette.gpage = Math.max(0, Math.min(Math.ceil(groups.length / PAL_GROUPS) - 1, palette.gpage + Number(id.slice(6))));
	} else if (id.startsWith('page:')) {
		const items = groups[palette.group]?.items ?? [];
		palette.page = Math.max(0, Math.min(Math.ceil(items.length / PAL_PAGE) - 1, palette.page + Number(id.slice(5))));
	} else if (id.startsWith('item:')) addNode(id.slice(5));
}

/** @param {string} id `f:<key>:<op>` */
function pressField(id) {
	const op = id.slice(id.lastIndexOf(':') + 1);
	const key = id.slice(2, id.lastIndexOf(':'));
	const node = selectedNode();
	if (!node) return;
	const field = padFields(node, catalogRef?.findNodeSpec?.(node.type), graphOf(graphId)?.edges ?? []).find((f) => f.key === key);
	if (!field) return;
	if (op === '-' || op === '+') return setValues(node.id, { [key]: stepNumber(field, op === '+' ? 1 : -1) });
	if (op === 'toggle') return setValues(node.id, { [key]: !field.value });
	if (op === 'prev' || op === 'next') {
		const dir = op === 'next' ? 1 : -1;
		return setValues(node.id, { [key]: field.kind === 'color' ? cycleSwatch(field.value, dir) : cycleOption(field, dir) });
	}
	if (op === 'type') {
		if (readOnly()) return void canWrite();
		openVRKeyboard({
			title: `${node.data?.label ?? node.type}: ${field.label}`,
			initial: field.kind === 'number' ? fieldText(field) : String(field.value ?? ''),
			onCommit: (/** @type {string} */ text) => {
				if (field.kind === 'number') {
					const v = parseNumber(field, text);
					if (v === null) return say(`"${text}" is not a number`, 'warn');
					setValues(node.id, { [key]: v });
				} else setValues(node.id, { [key]: text });
			},
			onCancel: () => {}
		});
	}
}

function renameSelected() {
	const node = selectedNode();
	if (!node || readOnly()) return void canWrite();
	openVRKeyboard({
		title: 'Rename node',
		initial: node.data?.label ?? '',
		onCommit: (/** @type {string} */ text) => {
			const label = text.trim();
			if (label) setValues(node.id, { label });
		},
		onCancel: () => {}
	});
}

function selectedNode() {
	if (!selected) return null;
	return graphOf(graphId)?.nodes.find((/** @type {any} */ n) => n.id === selected) ?? null;
}

/** show another graph on the panel @param {string} id */
function switchGraph(id) {
	if (id === graphId) return;
	graphId = id;
	selected = null;
	palette = null;
	padPage = 0;
	drag = null;
	laid = null;
}

// ---- open / close / pose --------------------------------------------------------------------------------
/** The single selected object's uuid, or null. */
function singleSelection() {
	const sel = get(selectedObjects);
	return sel.length === 1 && typeof sel[0] === 'string' && sel[0] ? sel[0] : null;
}

/**
 * Open the panel on `graph` ('scene' / an object uuid), else on the single selected object's flow (if it has
 * one), else on the scene graph. Pinned in front of you; the pad on the off hand's wrist.
 * @param {{graph?: string}} [opts]
 */
export function openVRLogic(opts = {}) {
	ensureMeshes();
	const sel = singleSelection();
	objectTab = opts.graph && opts.graph !== SCENE_GRAPH ? opts.graph : sel;
	const target = opts.graph ?? (sel && graphOf(sel) ? sel : SCENE_GRAPH);
	switchGraph(target);
	added = 0;
	// one wrist panel at a time: the pad takes the off hand
	if (get(vrAssetBrowserOpen)) closeVRAssetBrowser();
	pinInFront();
	vrLogicOpen.set(true);
	void primed.then(() => {
		laid = null;
		graphRev++;
	});
}
export function closeVRLogic() {
	vrLogicOpen.set(false);
	held = null;
	drag = null;
	palette = null;
}
export function toggleVRLogic() {
	if (get(vrLogicOpen)) closeVRLogic();
	else openVRLogic();
}

/** @param {number} w @param {number} h @param {number} pw @param {number} ph @param {string} name */
function makePlane(w, h, pw, ph, name) {
	const canvas = document.createElement('canvas');
	canvas.width = pw;
	canvas.height = ph;
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
	mesh.name = name;
	mesh.visible = false;
	return { canvas, texture, mesh };
}
function ensureMeshes() {
	if (panelMesh || typeof document === 'undefined') return;
	const p = makePlane(PANEL_M.w, PANEL_M.h, PANEL_PX.w, PANEL_PX.h, 'vr-logic-panel');
	panelMesh = p.mesh;
	panelCanvas = p.canvas;
	panelTex = p.texture;
	const q = makePlane(PAD_M.w, PAD_M.h, PAD_PX.w, PAD_PX.h, 'vr-logic-pad');
	padMesh = q.mesh;
	padCanvas = q.canvas;
	padTex = q.texture;
}

/** the off hand (the pad's wrist); null when one-handed @returns {'left' | 'right' | null} */
export function padHand() {
	if (oneHandedHand()) return null;
	return pointerHand() === 'left' ? 'right' : 'left';
}
function renderer() {
	return /** @type {any} */ (get(globalRenderer));
}
function headPosition() {
	const r = renderer();
	if (!r?.xr?.isPresenting) return null;
	const cam = r.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	return cam.getWorldPosition(new THREE.Vector3());
}
/** face `object` toward the head, upright @param {any} object @param {any} head */
function faceHead(object, head) {
	if (!head) return;
	object.lookAt(new THREE.Vector3(head.x, object.position.y + (head.y - object.position.y) * 0.6, head.z));
}
/** pin the panel ~0.85 m in front of the head, a little below the eyes */
function pinInFront() {
	const head = headPosition();
	mode = 'pinned';
	if (!head || !panelMesh) return;
	const cam = renderer().xr.getCamera();
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
	fwd.y = 0;
	if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
	fwd.normalize();
	panelMesh.position.copy(head).addScaledVector(fwd, 0.85);
	panelMesh.position.y -= 0.12;
	faceHead(panelMesh, head);
	pinned.position.copy(panelMesh.position);
	pinned.quaternion.copy(panelMesh.quaternion);
}
/** world pose of controller slot `index` @param {number} index */
function controllerPose(index) {
	const c = renderer()?.xr?.getController(index);
	if (!c) return null;
	c.updateMatrixWorld(true);
	return { position: c.getWorldPosition(new THREE.Vector3()), quaternion: c.getWorldQuaternion(new THREE.Quaternion()) };
}
/** the pad's wrist spot (world), or null when that hand is not tracked */
function wristSpot() {
	const hand = padHand();
	const r = renderer();
	if (!hand || !r?.xr) return null;
	const index = controllerIndexFor(hand);
	if (index < 0) return null;
	const grip = r.xr.getControllerGrip(index);
	if (!grip || grip.visible === false) return null;
	grip.updateMatrixWorld(true);
	return grip.localToWorld(WRIST_OFFSET.clone());
}
function poseMeshes() {
	if (mode === 'held' && held) {
		const p = controllerPose(held.index);
		if (p) {
			panelMesh.position.copy(held.relPos).applyQuaternion(p.quaternion).add(p.position);
			panelMesh.quaternion.copy(p.quaternion).multiply(held.relQuat);
		}
	} else {
		panelMesh.position.copy(pinned.position);
		panelMesh.quaternion.copy(pinned.quaternion);
	}
	panelMesh.updateMatrixWorld(true);
	const spot = wristSpot();
	if (spot) {
		padMesh.position.copy(spot);
		faceHead(padMesh, headPosition());
	} else {
		// one-handed (or the hand is lost): the pad stands beside the panel's right edge
		padMesh.position.copy(panelMesh.localToWorld(new THREE.Vector3(PANEL_M.w / 2 + PAD_M.w / 2 + 0.03, 0, 0)));
		padMesh.quaternion.copy(panelMesh.quaternion);
	}
	padMesh.updateMatrixWorld(true);
}

// ---- the laser ------------------------------------------------------------------------------------------
const _ray = new THREE.Raycaster();
/** controller slot `index`'s ray (world), or null @param {number} index */
function rayOf(index) {
	const c = renderer()?.xr?.getController(index);
	if (!c) return null;
	c.updateMatrixWorld(true);
	const ray = new THREE.Ray();
	ray.origin.setFromMatrixPosition(c.matrixWorld);
	ray.direction.set(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(c.matrixWorld)).normalize();
	return ray;
}
/** where slot `index`'s laser meets `mesh` (canvas px), or null @param {number} index @param {any} mesh @param {{w: number, h: number}} px */
function laserOn(index, mesh, px) {
	if (!mesh?.visible) return null;
	const ray = rayOf(index);
	if (!ray) return null;
	_ray.ray.copy(ray);
	_ray.far = 4;
	const hit = _ray.intersectObject(mesh, false)[0];
	if (!hit?.uv) return null;
	return { x: hit.uv.x * px.w, y: (1 - hit.uv.y) * px.h, distance: hit.distance };
}
/** where slot `index`'s laser meets the PANEL'S PLANE (canvas px, may lie off the panel) — a drag keeps
 * following the laser past the edge @param {number} index */
function laserOnPanelPlane(index) {
	const ray = rayOf(index);
	if (!ray || !panelMesh) return null;
	const n = new THREE.Vector3(0, 0, 1).applyQuaternion(panelMesh.getWorldQuaternion(new THREE.Quaternion()));
	const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, panelMesh.getWorldPosition(new THREE.Vector3()));
	const p = ray.intersectPlane(plane, new THREE.Vector3());
	if (!p) return null;
	const local = panelMesh.worldToLocal(p);
	return { x: (local.x / PANEL_M.w + 0.5) * PANEL_PX.w, y: (0.5 - local.y / PANEL_M.h) * PANEL_PX.h };
}
/** is slot `index` the pad's own hand? (it cannot point at its own wrist) @param {number} index */
function isPadSlot(index) {
	const hand = padHand();
	return !!hand && index === controllerIndexFor(hand) && !!wristSpot();
}
/** inside the graph area? @param {{x: number, y: number}} p */
const inGraph = (p) => p.x >= GRAPH_AREA.x && p.x <= GRAPH_AREA.x + GRAPH_AREA.w && p.y >= GRAPH_AREA.y && p.y <= GRAPH_AREA.y + GRAPH_AREA.h;

/** what slot `index`'s laser is on this frame: {on: 'panel'|'pad'|null, x, y, distance, button, graph}
 * @param {number} index @returns {any} */
function readLaser(index) {
	if (isPadSlot(index)) return { on: null };
	const onPad = laserOn(index, padMesh, PAD_PX);
	const onPanel = laserOn(index, panelMesh, PANEL_PX);
	if (onPad && (!onPanel || onPad.distance < onPanel.distance)) return { on: 'pad', ...onPad, button: hitAt(padHits, onPad.x, onPad.y)?.id ?? null };
	if (!onPanel) return { on: null };
	const button = hitAt(panelHits, onPanel.x, onPanel.y)?.id ?? null;
	const graph = !button && !palette && inGraph(onPanel) ? hitGraph(layout().cards, viewNow(), onPanel.x, onPanel.y) : null;
	return { on: 'panel', ...onPanel, button, graph };
}

// ---- per frame ----------------------------------------------------------------------------------------
function frame() {
	if (!panelMesh) return;
	const t0 = performance.now();
	frameBody();
	if (panelMesh.visible) {
		perf.frames++;
		perf.frameMs += performance.now() - t0;
	}
}

function frameBody() {
	const r = renderer();
	const live = get(vrLogicOpen) && !!r?.xr?.isPresenting && get(isVRMode);
	if (!live) {
		panelMesh.visible = false;
		padMesh.visible = false;
		held = null;
		if (mode === 'held') mode = 'pinned';
		return;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && panelMesh.parent !== scene) scene.add(panelMesh);
	if (scene && padMesh.parent !== scene) scene.add(padMesh);
	// the selection moves the object tab (the desktop editor follows the selection too)
	const sel = singleSelection();
	if (sel && sel !== objectTab) {
		const wasObject = graphId !== SCENE_GRAPH && graphId === objectTab;
		objectTab = sel;
		if (wasObject && !drag) switchGraph(sel);
	}
	if (graphId !== SCENE_GRAPH && !objectOf(graphId)) switchGraph(SCENE_GRAPH); // its object was deleted
	if (selected && !selectedNode()) selected = null;
	poseMeshes();
	panelMesh.visible = true;
	padMesh.visible = !get(vrMenuOpen) || !padHand();
	for (const i of [0, 1]) {
		lasers[i] = readLaser(i);
		// the stick on the panel zooms at the laser; on the pad it pages
		const on = lasers[i].on;
		const y = on ? (axesForSlot(i)[3] ?? 0) : 0;
		if (stickArmed[i] && Math.abs(y) > STICK_FLICK) {
			stickArmed[i] = false;
			if (on === 'panel') views.set(graphId, zoomAt(viewNow(), y < 0 ? 1.25 : 0.8, lasers[i].x, lasers[i].y));
			else padPage += y > 0 ? 1 : -1;
			hapticPulse(0.1, 12);
		} else if (!stickArmed[i] && Math.abs(y) < STICK_REARM) stickArmed[i] = true;
	}
	if (drag) dragFrame();
	redraw();
}

/** the gesture follows its laser */
function dragFrame() {
	if (!drag) return;
	const p = laserOnPanelPlane(drag.slot);
	if (!p) return;
	if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > DRAG_SLOP) drag.moved = true;
	if (!drag.moved) return;
	const v = viewNow();
	if (drag.kind === 'pan' && drag.view) {
		views.set(graphId, { s: drag.view.s, ox: drag.view.ox + (p.x - drag.start.x), oy: drag.view.oy + (p.y - drag.start.y) });
	} else if (drag.kind === 'node' && drag.node && drag.from && drag.grab) {
		if (readOnly()) return;
		const g = toGraph(v, p.x, p.y);
		const pos = { x: Math.round(drag.from.x + g.x - drag.grab.x), y: Math.round(drag.from.y + g.y - drag.grab.y) };
		handlersRef.moveFlowNode(drag.node, pos, graphId);
		const now = performance.now();
		if (!drag.lastSend || now - drag.lastSend > MOVE_SEND_MS) {
			drag.lastSend = now;
			peer()?.send({ type: 'nodemove', id: drag.node, position: pos, graphId });
		}
	} else if (drag.kind === 'wire' && drag.socket) {
		drag.end = p;
		const over = inGraph(p) ? hitGraph(layout().cards, v, p.x, p.y) : null;
		drag.target = over?.kind === 'socket' ? over : null;
		drag.ok = drag.target ? wireFits(drag.socket, drag.target) : null;
	}
}

/** would this drop connect? @param {any} from @param {any} to */
function wireFits(from, to) {
	const c = connectionOf(from, to);
	if (!c) return false;
	const nodes = graphOf(graphId)?.nodes ?? [];
	return !!socketsRef?.isValidFlowConnection({ source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined }, nodes);
}

/** the hover id of a slot for the painters @param {'panel' | 'pad'} on */
function hoverOf(on) {
	for (const i of [0, 1]) if (lasers[i].on === on && lasers[i].button) return lasers[i].button;
	return null;
}
function graphHover() {
	for (const i of [0, 1]) if (lasers[i].on === 'panel' && lasers[i].graph && lasers[i].graph.kind !== 'empty') return lasers[i].graph;
	return null;
}

/** @returns {import('./logicPanelDraw.js').LogicView} */
function panelView() {
	const L = layout();
	const v = viewNow();
	const hover = graphHover();
	const hotSocket = drag?.kind === 'wire' ? drag.target : hover?.kind === 'socket' ? hover : null;
	const sameSocket = (/** @type {any} */ s, /** @type {string} */ node, /** @type {'in' | 'out'} */ dir) => !!s && s.node === node && s.dir === dir;
	const cards = L.cards.map((/** @type {any} */ c) => ({
		id: c.id,
		x: c.x,
		y: c.y,
		w: c.w,
		h: c.h,
		kind: c.kind,
		label: c.label,
		sub: c.sub,
		group: c.group,
		selected: c.id === selected,
		hover: (hover?.kind === 'node' && hover.node === c.id) || (drag?.kind === 'node' && drag.node === c.id),
		dragging: drag?.kind === 'node' && drag.node === c.id && drag.moved,
		inputs: c.inputs.map((/** @type {any} */ s) => ({ ...s, hot: sameSocket(hotSocket, c.id, 'in') && hotSocket.id === s.id })),
		outputs: c.outputs.map((/** @type {any} */ s) => ({ ...s, hot: sameSocket(hotSocket, c.id, 'out') && hotSocket.id === s.id }))
	}));
	const wires = L.wires.map((/** @type {any} */ w) => ({
		a: w.a,
		b: w.b,
		type: w.type,
		proxy: w.proxy,
		hot: !!selected && (w.edge.source === selected || w.edge.target === selected),
		detached: drag?.kind === 'wire' && drag.detach?.id === w.id
	}));
	let rubber = null;
	if (drag?.kind === 'wire' && drag.socket && drag.end && drag.moved) {
		const fromCard = L.cards.find((/** @type {any} */ c) => c.id === drag?.socket?.node);
		const list = drag.socket.dir === 'out' ? fromCard?.outputs : fromCard?.inputs;
		const s = list?.find((/** @type {any} */ x) => x.id === drag?.socket?.id);
		if (s) {
			const a = toCanvas(v, s.x, s.y);
			rubber = drag.socket.dir === 'out' ? { a, b: drag.end, ok: drag.ok ?? null, type: s.type } : { a: drag.end, b: a, ok: drag.ok ?? null, type: s.type };
		}
	}
	let text = status.text && Date.now() < status.until ? status.text : '';
	let tone = status.tone;
	if (!text) {
		tone = 'info';
		if (readOnly()) {
			text = 'View only — you can look, but not change the logic';
			tone = 'warn';
		} else if (drag?.kind === 'wire' && drag.moved) text = drag.ok === false ? 'Those sockets do not fit together' : drag.ok ? 'Let go to connect' : drag.detach ? 'Let go on a socket to move the wire, anywhere else to remove it' : 'Let go on a socket to connect';
		else if (palette) text = 'Pick a node to add it in the middle of the view';
		else text = 'Trigger-drag: move cards, wire sockets, pan · stick zooms · grip carries the panel';
	}
	/** @type {any} */
	let pal = null;
	if (palette) {
		const groups = paletteGroups();
		palette.group = Math.min(palette.group, Math.max(0, groups.length - 1));
		const items = groups[palette.group]?.items ?? [];
		const pages = Math.max(1, Math.ceil(items.length / PAL_PAGE));
		palette.page = Math.min(palette.page, pages - 1);
		pal = {
			groups: groups.map((/** @type {any} */ g) => g.group),
			group: palette.group,
			gpage: palette.gpage,
			gpages: Math.max(1, Math.ceil(groups.length / PAL_GROUPS)),
			items: items.slice(palette.page * PAL_PAGE, palette.page * PAL_PAGE + PAL_PAGE).map((/** @type {any} */ i) => ({ type: i.type, label: i.label })),
			page: palette.page,
			pages
		};
	}
	const tabs = [{ id: 'graph:scene', label: 'Scene', on: graphId === SCENE_GRAPH }];
	if (objectTab) tabs.push({ id: 'graph:object', label: objectName(objectTab), on: graphId === objectTab });
	return {
		title: 'Logic',
		tabs,
		cards,
		wires,
		view: v,
		rubber,
		status: text,
		statusTone: tone,
		empty: graphId === SCENE_GRAPH ? 'The scene graph is empty — + Node adds one' : `${objectName(graphId)} has no logic yet — + Node starts it`,
		readOnly: readOnly(),
		canUndo: !!historyRef && get(historyRef.canUndo),
		canRedo: !!historyRef && get(historyRef.canRedo),
		palette: pal
	};
}

/** @returns {import('./logicPanelDraw.js').PadView} */
function padView() {
	const node = selectedNode();
	const edges = graphOf(graphId)?.edges ?? [];
	if (!node) return { title: 'Values', sub: graphId === SCENE_GRAPH ? 'Scene graph' : objectName(graphId), rows: [], page: 0, pages: 1, status: '', hasNode: false, readOnly: readOnly(), canDisconnect: false };
	const spec = catalogRef?.findNodeSpec?.(node.type);
	const fields = padFields(node, spec, edges);
	const pages = Math.max(1, Math.ceil(fields.length / PAD_ROWS));
	padPage = Math.max(0, Math.min(pages - 1, padPage));
	const rows = fields.slice(padPage * PAD_ROWS, padPage * PAD_ROWS + PAD_ROWS).map((f) => ({
		key: f.key,
		kind: f.kind,
		label: f.label,
		text: f.kind === 'color' ? String(f.value) : fieldText(f),
		wired: !!f.wired,
		...(f.kind === 'color' ? { swatch: String(f.value) } : {})
	}));
	return {
		title: node.data?.label || spec?.label || node.type,
		sub: `${spec?.label ?? node.type} · ${graphId === SCENE_GRAPH ? 'Scene graph' : objectName(graphId)}`,
		rows,
		page: padPage,
		pages,
		status: '',
		hasNode: true,
		readOnly: readOnly(),
		canDisconnect: edges.some((/** @type {any} */ e) => e.source === node.id || e.target === node.id)
	};
}

/** repaint what changed (a few cheap inputs compared first; a drag repaints at most ~30 Hz) */
function redraw() {
	const now = performance.now();
	const v = viewNow();
	const gh = graphHover();
	const pSig = [
		graphRev,
		graphId,
		objectTab,
		v.s,
		v.ox,
		v.oy,
		hoverOf('panel'),
		gh ? JSON.stringify(gh) : '',
		selected,
		palette ? JSON.stringify(palette) : '',
		drag ? JSON.stringify({ k: drag.kind, m: drag.moved, e: drag.end, t: drag.target, ok: drag.ok, n: drag.node }) : '',
		status.text && Date.now() < status.until ? status.text : '',
		readOnly(),
		historyRef ? get(historyRef.canUndo) + '' + get(historyRef.canRedo) : ''
	].join('\u0001');
	if (pSig !== panelSig && (!drag?.moved || now - lastPanelPaint > DRAG_PAINT_MS)) {
		const g = /** @type {CanvasRenderingContext2D} */ (panelCanvas?.getContext('2d'));
		if (g) {
			panelSig = pSig;
			lastPanelPaint = now;
			const t0 = performance.now();
			panelHits = drawLogicPanel(g, panelView(), { hover: hoverOf('panel') });
			panelTex.needsUpdate = true;
			perf.paintMs += performance.now() - t0;
			debug.panelDraws++;
		}
	}
	const dSig = [graphRev, graphId, selected, padPage, hoverOf('pad'), readOnly()].join('\u0001');
	if (dSig !== padSig) {
		const g = /** @type {CanvasRenderingContext2D} */ (padCanvas?.getContext('2d'));
		if (g) {
			padSig = dSig;
			padHits = drawLogicPad(g, padView(), { hover: hoverOf('pad') });
			padTex.needsUpdate = true;
			debug.padDraws++;
		}
	}
}

// ---- trigger + grip ---------------------------------------------------------------------------------------
/** the keyboard or the radial is up over everything: the panel stands aside */
function panelBusy() {
	return !!get(vrKeyboardTarget) || get(vrMenuOpen);
}

/** @param {number} index */
function onTriggerStart(index) {
	if (!get(vrLogicOpen) || !panelMesh?.visible || panelBusy() || !ready()) return false;
	const at = readLaser(index);
	if (!at.on) return false;
	swallowNext = true;
	swallowSetAt = Date.now();
	hapticPulse(0.2, 20);
	if (at.button) {
		pressLogicButton(at.button, index);
		return true;
	}
	if (at.on !== 'panel' || !at.graph) return true; // the panel's press, on nothing pressable
	const start = { x: at.x, y: at.y };
	const g = at.graph;
	if (g.kind === 'socket') {
		if (readOnly()) {
			canWrite();
			return true;
		}
		const node = layout().nodes.find((/** @type {any} */ n) => n.id === g.node);
		if (node?.type === 'group') {
			say('Wire into a group on the desktop (open the group there)', 'warn');
			return true;
		}
		// an input that holds a wire: pick that wire up by its far end
		if (g.dir === 'in') {
			const into = edgesIntoSocket(layout().edges, g.node, g.id);
			if (into.length) {
				const e = into[into.length - 1];
				drag = { slot: index, kind: 'wire', start, moved: false, socket: { node: e.source, dir: 'out', id: e.sourceHandle ?? null }, detach: e };
				return true;
			}
		}
		drag = { slot: index, kind: 'wire', start, moved: false, socket: { node: g.node, dir: g.dir, id: g.id } };
		return true;
	}
	if (g.kind === 'node') {
		const node = layout().nodes.find((/** @type {any} */ n) => n.id === g.node);
		const grab = toGraph(viewNow(), at.x, at.y);
		drag = { slot: index, kind: 'node', start, moved: false, node: g.node, from: { x: node?.position?.x ?? 0, y: node?.position?.y ?? 0 }, grab };
		return true;
	}
	drag = { slot: index, kind: 'pan', start, moved: false, view: { ...viewNow() } };
	return true;
}

/** @param {number} index */
function onTriggerEnd(index) {
	swallowNext = false;
	if (!drag || drag.slot !== index) return false;
	const d = drag;
	drag = null;
	if (d.kind === 'node' && d.node) {
		if (!d.moved) {
			selected = d.node;
			padPage = 0;
			palette = null;
			return true;
		}
		const node = graphOf(graphId)?.nodes.find((/** @type {any} */ n) => n.id === d.node);
		if (node && d.from && ready()) commitMove(d.node, d.from, { x: node.position.x, y: node.position.y });
		hapticPulse(0.2, 20);
		return true;
	}
	if (d.kind === 'pan') {
		if (!d.moved) {
			selected = null;
			palette = null;
		}
		return true;
	}
	if (d.kind === 'wire' && d.socket) {
		if (!d.moved) return true;
		if (!canWrite()) return true;
		const target = d.target;
		if (target && target.node !== d.socket.node) {
			const c = connectionOf(d.socket, target);
			if (c && connect(c, d.detach)) {
				hapticPulse(0.35, 30);
				say('Connected');
			} else say('Those sockets do not fit together', 'warn');
		} else if (d.detach) {
			removeEdges([d.detach]);
			debug.writes.push('disconnect');
			say('Wire removed — ↶ puts it back');
		}
		return true;
	}
	return true;
}

/** @param {number} index */
function onGripStart(index) {
	if (!get(vrLogicOpen) || !panelMesh?.visible || held) return false;
	const p = controllerPose(index);
	if (!p) return false;
	// the laser on the panel, or the hand right at its face
	const onPanel = !!laserOn(index, panelMesh, PANEL_PX);
	const local = panelMesh.worldToLocal(p.position.clone());
	const touching = Math.abs(local.z) < TOUCH_RANGE && Math.abs(local.x) < PANEL_M.w / 2 && Math.abs(local.y) < PANEL_M.h / 2;
	if (!onPanel && !touching) return false;
	const inv = p.quaternion.clone().invert();
	held = { index, relPos: panelMesh.position.clone().sub(p.position).applyQuaternion(inv), relQuat: inv.multiply(panelMesh.quaternion.clone()) };
	mode = 'held';
	hapticPulse(0.3, 30);
	return true;
}
/** @param {number} index */
function onGripEnd(index) {
	if (!held || held.index !== index) return false;
	held = null;
	pinned.position.copy(panelMesh.position);
	pinned.quaternion.copy(panelMesh.quaternion);
	mode = 'pinned';
	hapticPulse(0.25, 30);
	return true;
}

/** the hand whose stick the panel owns this frame (its laser is on the panel or the pad) */
function stickHand() {
	if (!get(vrLogicOpen)) return null;
	for (const i of [0, 1]) {
		if (lasers[i].on) {
			const h = renderer()?.xr?.getController(i)?.userData?.handedness;
			return h === 'left' || h === 'right' ? h : pointerHand();
		}
	}
	return null;
}

// ---- mount ------------------------------------------------------------------------------------------------
/** Mount the panel + its hooks + the radial entries; returns the teardown (VRLogicPanel.svelte). */
export function mountVRLogic() {
	if (mounted || typeof document === 'undefined') return () => {};
	mounted = true;
	ensureMeshes();
	const undo = [
		registerOverlayPanel(panelMesh),
		registerOverlayPanel(padMesh),
		registerVRFrameHook(frame),
		registerVRTriggerHooks({
			start: onTriggerStart,
			end: onTriggerEnd,
			swallow: (/** @type {number} */ index) =>
				(swallowNext && Date.now() - swallowSetAt < 5000) || (get(vrLogicOpen) && !panelBusy() && index >= 0 && !!readLaser(index).on)
		}),
		registerGripHooks({ start: onGripStart, end: onGripEnd }),
		registerStickOwner(stickHand),
		// any graph change (a peer's, an undo, ours) re-lays the panel out
		flowGraphs.subscribe(() => {
			graphRev++;
		})
	];
	primed.then(() => {
		if (!mounted || !moduleSdkRef) return;
		undo.push(moduleSdkRef.moduleNodeGroups.subscribe(() => graphRev++));
	});
	registerVRMenuEntry({ ...RADIAL_TOOLS, label: 'Logic', icon: 'spline', closes: true, active: () => get(vrLogicOpen), action: () => toggleVRLogic() });
	registerVRMenuEntry({
		...RADIAL_OBJECT,
		label: 'Edit logic',
		icon: 'spline',
		closes: true,
		visible: () => !!singleSelection(),
		action: () => {
			const sel = singleSelection();
			if (sel) openVRLogic({ graph: sel });
		}
	});
	undo.push(() => unregisterVRMenuEntry(RADIAL_TOOLS.id, RADIAL_TOOLS.group));
	undo.push(() => unregisterVRMenuEntry(RADIAL_OBJECT.id, RADIAL_OBJECT.group));
	return () => {
		mounted = false;
		for (const fn of undo) fn();
		closeVRLogic();
		for (const m of [panelMesh, padMesh]) {
			m?.parent?.remove(m);
			if (m) m.visible = false;
		}
	};
}

// ---- the suites ---------------------------------------------------------------------------------------------
/** the panel / the pad as PNG data URLs (the suites' evidence shots) */
export function logicPanelImage() {
	return panelCanvas ? panelCanvas.toDataURL('image/png') : null;
}
export function logicPadImage() {
	return padCanvas ? padCanvas.toDataURL('image/png') : null;
}
/** world point of a canvas point on the panel or the pad @param {'panel' | 'pad'} which @param {number} x @param {number} y */
function canvasToWorld(which, x, y) {
	const mesh = which === 'pad' ? padMesh : panelMesh;
	const px = which === 'pad' ? PAD_PX : PANEL_PX;
	const m = which === 'pad' ? PAD_M : PANEL_M;
	if (!mesh) return null;
	mesh.updateMatrixWorld(true);
	return mesh.localToWorld(new THREE.Vector3((x / px.w - 0.5) * m.w, (0.5 - y / px.h) * m.h, 0)).toArray();
}
/** world point of a control's centre (panel first, then pad), or null @param {string} id */
export function logicControlPoint(id) {
	const p = panelHits.find((h) => h.id === id);
	if (p) return canvasToWorld('panel', p.x + p.w / 2, p.y + p.h / 2);
	const q = padHits.find((h) => h.id === id);
	return q ? canvasToWorld('pad', q.x + q.w / 2, q.y + q.h / 2) : null;
}
/** world point of a graph-unit point on the panel @param {number} gx @param {number} gy */
export function logicGraphPoint(gx, gy) {
	const c = toCanvas(viewNow(), gx, gy);
	return canvasToWorld('panel', c.x, c.y);
}
/** world point of a socket (dir 'in'/'out', handle null = the plain one), or of a card's body when `dir` is
 * omitted @param {string} node @param {'in' | 'out'} [dir] @param {string | null} [handle] */
export function logicSocketPoint(node, dir, handle = null) {
	const c = layout().cards.find((/** @type {any} */ x) => x.id === node);
	if (!c) return null;
	if (!dir) return logicGraphPoint(c.x + c.w / 2, c.y + c.h - 6);
	const s = (dir === 'out' ? c.outputs : c.inputs).find((/** @type {any} */ x) => x.id === handle);
	return s ? logicGraphPoint(s.x, s.y) : null;
}
export function vrLogicDebug() {
	const L = panelMesh ? layout() : null;
	return {
		open: get(vrLogicOpen),
		visible: !!panelMesh?.visible,
		padVisible: !!padMesh?.visible,
		graphId,
		objectTab,
		selected,
		padPage,
		palette: palette ? { ...palette } : null,
		mode,
		padHand: padHand(),
		view: views.get(graphId) ?? null,
		cards: L ? L.cards.map((/** @type {any} */ c) => ({ id: c.id, type: c.node.type, label: c.label, x: c.x, y: c.y, w: c.w, h: c.h, inputs: c.inputs.map((/** @type {any} */ s) => s.id), outputs: c.outputs.map((/** @type {any} */ s) => s.id) })) : [],
		wires: L ? L.wires.map((/** @type {any} */ w) => w.id) : [],
		buttons: panelHits.map((h) => h.id),
		padButtons: padHits.map((h) => h.id),
		pad: panelMesh ? padView() : null,
		lasers: lasers.map((l) => ({ on: l.on, button: l.button ?? null, graph: l.graph ?? null })),
		drag: drag ? { kind: drag.kind, moved: drag.moved, ok: drag.ok ?? null, target: drag.target ?? null } : null,
		status: status.text && Date.now() < status.until ? status.text : '',
		readOnly: readOnly(),
		panelDraws: debug.panelDraws,
		padDraws: debug.padDraws,
		presses: debug.presses.slice(),
		writes: debug.writes.slice(),
		refused: debug.refused,
		position: panelMesh ? panelMesh.position.toArray() : null,
		perf: { ...perf }
	};
}
