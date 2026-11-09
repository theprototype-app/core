import { get } from 'svelte/store';
import { graphOf, graphExists, SCENE_GRAPH, findNodeAnyGraph } from '../../stores/flowStore';
import { objectsGroup, lockedObjects } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import {
	createFlowNode,
	createFlowEdge,
	deleteFlowNodes,
	serializeNode,
	serializeEdge,
	setNodeData
} from '$lib/nodesHandler';
import { createObjectGraph, recordFlowNodesEntry } from '$lib/flowGraphs';
import { nodeCatalog, findNodeSpec } from '$lib/nodeCatalog';
import {
	setPhysicsFor,
	jointBodyProblem,
	unbuiltJointIds,
	toggleSimulation,
	stopSimulation,
	pauseSimulation,
	resetSimulation,
	simulating,
	remoteSimulating,
	simulationGaps
} from '$lib/physics';
import { createJoint } from '$lib/joints';
import { scriptNodeWarnings } from './scriptNotes.js';
import { isGroupId, normalizeCollidesWith } from '$lib/collisionGroups'; // 36 X5
import { parseGraphText } from '$lib/graphText';
import { scriptInputs, scriptOutputs } from '$lib/scriptIO';
import { edgeHandleProblems, knownInputs, knownMapOutputs } from './edgeHandles.js';
import { lockSkip } from './lockNote.js';
import { activeAiConfig } from './providers.js';
import { matchNodeType } from './nodeTypeMatch.js';
import { describeNodeTypes, paramsOf } from './nodeTypesCore.js';
import { nodeDoc } from '$lib/nodeDocs';
import { inputType, outputType, outputHandleType } from '$lib/flowSockets';

// AI flow + physics executors (assistant v3). The behavior counterpart to
// tools.js: create/update flow nodes (the @xyflow editor graphs driving
// per-frame animation) and — gated per provider — physics params, joints and
// simulation control. Same conventions as tools.js: apply locally + broadcast
// + record undo history exactly like a human edit; executors never throw
// (errors come back as {error} so the model can self-correct).

/** Physics is hard for small local models — a per-provider opt-in checkbox
 * (Settings → AI) gates these tools. @returns {boolean} */
export function physicsToolsEnabled() {
	return physicsForced || !!activeAiConfig()?.physicsTools;
}

/** 55 A6: an AGENT page always offers the physics tools — the checkbox exists for small LOCAL models,
 * and an external agent is not one (test flight T9). Set by tpAgent only. */
let physicsForced = false;
/** @param {boolean} on */
export function forcePhysicsTools(on) {
	physicsForced = !!on;
}

/** Node types only usable when physics tools are on — the sim-driving set
 * (mirrors physics.js PHYSICS_TYPES incl. the CL-C collider override) plus the
 * physics-DEPENDENT trigger/readout nodes (inert without a running sim, so
 * offering them while the sim tools are gated off would only mislead). */
export const PHYSICS_NODE_TYPES = [
	'mass',
	'bounciness',
	'friction',
	'angularvelocity',
	'motor',
	'collider',
	'onimpact',
	'onenter',
	'onexit',
	'velocity'
];

// Editor-only node types the AI must not create: Object Flow composition needs
// declared sockets picked in the editor, sound needs an Explorer asset hash.
const EXCLUDED_NODE_TYPES = ['objectflow', 'flowinput', 'flowoutput', 'sound', 'customnode'];

const ALL_CATALOG_TYPES = nodeCatalog.flatMap((group) => group.items.map((item) => item.type));

/** Small local models invent near-miss node names — map them home. */
const NODE_TYPE_ALIASES = /** @type {Record<string, string>} */ ({
	rotate: 'spin',
	rotation: 'spin',
	rotator: 'spin',
	patrol: 'pathpatrol',
	path: 'pathpatrol',
	waypoints: 'pathpatrol',
	walk: 'pathpatrol',
	move: 'pathpatrol',
	color: 'setcolor',
	colorchange: 'setcolor',
	jump: 'bounce',
	hop: 'bounce',
	flash: 'blink',
	wobble: 'shake',
	click: 'onclick',
	key: 'keypress',
	keyboard: 'keypress',
	particles: 'particle',
	emitter: 'particle',
	weight: 'mass',
	restitution: 'bounciness',
	torque: 'angularvelocity',
	// 17-E A5: the authored-clip trigger, which a model reaches for by verb
	playanimation: 'playanim',
	play_animation: 'playanim',
	startanimation: 'playanim',
	start_animation: 'playanim',
	stopanimation: 'playanim',
	animate: 'playanim',
	// 85 N2: a door on a plain box has no clip to play — Rotate To swings it (pivot left)
	opendoor: 'rotateto',
	door: 'rotateto',
	// 85 N1/N2/N4: the swing, the tweens and the light nodes by the words people use
	swing: 'oscillate',
	sway: 'oscillate',
	pendulum: 'oscillate',
	oscillator: 'oscillate',
	tween: 'moveto',
	turnto: 'rotateto',
	grow: 'scaleto',
	lighttoggle: 'lightswitch',
	lightonoff: 'lightswitch',
	lamp: 'lightswitch',
	dim: 'lightintensity',
	dimmer: 'lightintensity',
	lightfade: 'lightintensity',
	colorcycle: 'lightcycle',
	colourcycle: 'lightcycle',
	disco: 'lightcycle',
	// 85 N5
	wind: 'windsway',
	flag: 'windsway',
	water: 'waterflow',
	river: 'waterflow',
	flowingwater: 'waterflow',
	// 85 N3
	animal: 'ambientanimal',
	ambient: 'ambientanimal',
	critter: 'ambientanimal',
	pet: 'ambientanimal',
	graze: 'ambientanimal',
	// 85 I1
	grab: 'grabbable',
	pickup: 'grabbable',
	carry: 'grabbable',
	holdable: 'grabbable',
	// 21-E4: the logic nodes. The four TYPES need no listing here - aiNodeTypes is
	// derived from nodeCatalog, so adding them to the catalog put them in the enum -
	// but a small model reaches for these four by FUNCTION rather than by name more
	// than for anything else in the palette ("wait 3 seconds", "remember that it was
	// collected"), so the near-misses are worth mapping home.
	//
	// Note the KEY SHAPE: after the exact and case-only catalog matches, normalizeNodeType
	// flattens whitespace/underscores/hyphens out of the model's word before the alias
	// lookup, so only FLATTENED keys can ever match (the `play_animation` style entries
	// above are dead weight, kept as-is).
	// And nothing here may shadow a real catalog type, which wins on the line before:
	// `toggle` (the Input node), `timer` (the delay LINE) and `switcher` are
	// deliberately absent for that reason - a model saying "toggle" means the input.
	flipflop: 'latch',
	hold: 'latch',
	flag: 'latch',
	memory: 'latch',
	remember: 'latch',
	sticky: 'latch',
	togglestate: 'latch',
	wait: 'delay',
	sleep: 'delay',
	timeout: 'delay',
	cooldown: 'delay',
	after: 'delay',
	defer: 'delay',
	steps: 'sequence',
	chain: 'sequence',
	stagger: 'sequence',
	sequencer: 'sequence',
	cascade: 'sequence',
	oneshot: 'once',
	firstonly: 'once',
	onlyonce: 'once',
	triggeronce: 'once',
	firsttime: 'once',
	single: 'once'
});

/**
 * The curated node vocabulary offered to the model (catalog minus editor-only;
 * physics node types only when the provider checkbox is on).
 * @param {boolean} physics
 * @returns {string[]}
 */
export function aiNodeTypes(physics) {
	return ALL_CATALOG_TYPES.filter(
		(type) =>
			!EXCLUDED_NODE_TYPES.includes(type) && (physics || !PHYSICS_NODE_TYPES.includes(type))
	);
}

/**
 * 34 D5: the same vocabulary GROUPED the way the palette groups it — the assistant's node
 * reference. It replaces the 100-name enum the create_flow_nodes schema used to carry: the
 * names are said ONCE, in the system prompt, where the group is context a model can use
 * ("Triggers" are sources, "Logic" holds state), and the executor still validates every
 * type (normalizeNodeType + the allowed list), so dropping the enum loses no safety.
 * @param {boolean} physics @returns {{group: string, types: string[]}[]}
 */
export function aiNodeVocabulary(physics) {
	const allowed = new Set(aiNodeTypes(physics));
	return nodeCatalog
		.map((g) => ({ group: g.group, types: g.items.map((i) => i.type).filter((t) => allowed.has(t)) }))
		.filter((g) => g.types.length);
}

/** @param {any} raw @returns {string|null} a real catalog type or null (exact first — kit-* types keep their case and hyphens) */
function normalizeNodeType(raw) {
	return matchNodeType(raw, ALL_CATALOG_TYPES, NODE_TYPE_ALIASES);
}

/** A fresh uuid (crypto — same helper shape as tools.js). @returns {string} */
function genUuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {string} uuid */
function lockedByPeer(uuid) {
	return get(lockedObjects).some((/** @type {any} */ l) => l[1] === uuid);
}

/**
 * Resolve the `graph` argument: 'scene' (or the literal SCENE_GRAPH id) → the
 * scene graph; an existing object uuid → that object's graph. Null = invalid.
 * @param {any} raw @returns {string|null}
 */
function resolveGraph(raw) {
	const id = String(raw ?? '').trim();
	if (!id || id === 'scene' || id === SCENE_GRAPH) return SCENE_GRAPH;
	return objectOf(id) ? id : null;
}

/** Editor-like grid auto-layout, offset by how many nodes the graph already has.
 * @param {number} index @returns {{x: number, y: number}} */
function gridPosition(index) {
	return { x: 60 + (index % 4) * 190, y: 60 + Math.floor(index / 4) * 130 };
}

/** ≥2 triples of finite numbers, else null. @param {any} raw @returns {number[][]|null} */
function validatePoints(raw) {
	if (!Array.isArray(raw) || raw.length < 2) return null;
	const points = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length !== 3 || entry.some((n) => !Number.isFinite(n)))
			return null;
		points.push([entry[0], entry[1], entry[2]]);
	}
	return points;
}

/** 85b R10: flowRuntime's DIRECT_TARGET_TYPES (kept here too: flowRuntime is history-family) */
const DIRECT_TARGET_TOOL_TYPES = new Set(['setcolor', 'visibility', 'spin', 'oscillate', 'moveto', 'rotateto', 'scaleto', 'lightswitch', 'lightintensity', 'lightcycle', 'windsway', 'waterflow', 'ambientanimal', 'grabbable']); // 85 N1-N5, I1 join
/** a direct target: '' (none) or the uuid of an object in the scene, else null @param {any} v @returns {string | null} */
function directTarget(v) {
	if (v === '' || v === null) return '';
	if (typeof v !== 'string' || v.length > 64) return null;
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', v) ? v : null;
}

/** describe_node_types: the R10 `target` param on the three types that take one @param {string} t @param {any} spec */
function withDirectTarget(t, spec) {
	if (!spec || !DIRECT_TARGET_TOOL_TYPES.has(t)) return spec;
	return {
		...spec,
		params: [...(Array.isArray(spec.params) ? spec.params : []), { key: 'target', kind: 'text', label: 'target object uuid' }],
		note: [spec.note, 'target (an object uuid) drives that object with no Object Selector: a button drives a door. Empty = the usual rules (a selector it feeds, or the graph\'s own object).'].filter(Boolean).join(' ')
	};
}

/**
 * Node data exactly like the editor builds it (Nodes.svelte addNode): label +
 * type + spec defaults, overlaid with the model's data for KNOWN keys only
 * (plus validated pathpatrol.points and script.code).
 * @param {string} type @param {any} spec @param {any} raw @param {string[]} errors
 */
function buildNodeData(type, spec, raw, errors) {
	/** @type {any} */
	const data = { label: spec?.label ?? type, type, ...(spec?.defaults ?? {}) };
	if (!raw || typeof raw !== 'object') return data;
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'type') continue;
		if (key === 'label') {
			if (typeof value === 'string' && value) data.label = value;
			continue;
		}
		if (key === 'points' && type === 'pathpatrol') {
			const points = validatePoints(value);
			if (points) data.points = points;
			else errors.push('pathpatrol points must be >=2 [x,y,z] triples — kept the default');
			continue;
		}
		if (key === 'code' && type === 'script') {
			if (typeof value === 'string' && value) data.code = value;
			continue;
		}
		// 34 D3: a script's declared sockets (normalized: bad names/types dropped)
		if (key === 'inputs' && type === 'script') {
			const inputs = scriptInputs({ inputs: value });
			if (inputs) data.inputs = inputs;
			continue;
		}
		if (key === 'outputs' && type === 'script') {
			data.outputs = scriptOutputs({ outputs: value });
			continue;
		}
		// 85b R10: Set Color / Visibility / Spin may name the object they drive (no selector chain)
		if (key === 'target' && DIRECT_TARGET_TOOL_TYPES.has(type)) {
			const t = directTarget(value);
			if (t === null) errors.push(type + ' target: an object uuid from list_scene (or "" for the usual rules) — left unset');
			else data.target = t;
			continue;
		}
		if (key in (spec?.defaults ?? {})) data[key] = value;
		// unknown keys are dropped silently — defaults render fine without them
	}
	// mcp-fix: an assistant that asks for world space means world axes (a person's own nodes default to "with the object")
	if (type === 'particle' && raw.space === 'world' && raw.aim === undefined) data.aim = 'world';
	return data;
}

/**
 * 86 T1 (= 85 R9): `describe_node_types` — the sockets, params and one-line doc of the node types this
 * assistant may place, from the same tables the editor and D24's edge check read (nodeTypesCore.js).
 * @param {any} args @param {{physics?: boolean}} [opts] `physics` forces the physics family in (86-fix B1)
 */
export function describeNodeTypesTool(args, opts) {
	return describeNodeTypes(args, {
		vocabulary: aiNodeVocabulary(!!opts?.physics || physicsToolsEnabled()),
		spec: (t) => withDirectTarget(t, findNodeSpec(t)),
		doc: (t) => nodeDoc(t),
		// D24's own lists (edgeHandles.js), so what this tool says is exactly what an edge is checked against;
		// params are listed separately (a wire into a param key drives it)
		inputs: (t) => {
			const spec = /** @type {any} */ (findNodeSpec(t));
			const params = new Set(paramsOf(spec).map((p) => p.key));
			const names = (knownInputs({ type: t, data: { ...(spec?.defaults ?? {}) } }) ?? []).filter((n) => !params.has(n));
			return names.map((name) => ({ name, type: inputType(t, name) }));
		},
		output: (t) => outputType(t),
		namedOutputs: (t) => {
			const spec = /** @type {any} */ (findNodeSpec(t));
			return (knownMapOutputs({ type: t, data: { ...(spec?.defaults ?? {}) } }) ?? []).map((name) => ({ name, type: outputHandleType(t, name) }));
		},
		match: (raw) => normalizeNodeType(raw)
	});
}

/**
 * create_flow_nodes: add behavior nodes (and optional edges) to ONE graph.
 * Local `ref` keys let edges point at freshly created nodes. Records ONE
 * 'flownodes' history entry for the whole call.
 * @param {any} args {graph, nodes: [{ref?, type, data?}], edges?: [{from, to, fromHandle?, toHandle?}]}
 * @param {{physics?: boolean, allow?: string[]}} [opts] `physics` allows the physics node family whatever the checkbox (86-fix B1); `allow` adds node types a tool built the inputs for (85-world: `sound`, after its Explorer asset)
 * @returns {any}
 */
export function createFlowNodesTool(args, opts) {
	const graphId = resolveGraph(args?.graph);
	if (graphId === null)
		return { error: 'unknown graph "' + args?.graph + '" — pass "scene" or an existing object uuid' };
	// 34 D5: `text` is the compact graph text (the scene summary's own format) — node lines
	// describe NEW nodes, their ids are local refs; edge lines may also name existing ids
	const fromText = textToSpecs(args?.text);
	if ('error' in fromText) return { error: fromText.error };
	const specs = [...(Array.isArray(args?.nodes) ? args.nodes : []), ...fromText.nodes];
	const textEdges = fromText.edges;
	if (!specs.length && !textEdges.length)
		return { error: 'no nodes provided — pass text: \'id = type {params}\' lines, or nodes: [{ type, data? }] (one graph per call)' };

	const physics = !!opts?.physics || physicsToolsEnabled();
	// 85-world W6: a tool that made the Explorer asset first may create a node the assistant may not (`sound`)
	const allowed = [...aiNodeTypes(physics), ...(Array.isArray(opts?.allow) ? opts.allow : [])];
	/** @type {any} */
	const peer = get(peers);

	// missing object graph → create it first (records 'flowgraph' + graphcreate)
	if (graphId !== SCENE_GRAPH && !graphExists(graphId)) createObjectGraph(graphId);

	const existing = graphOf(graphId)?.nodes.length ?? 0;
	/** @type {any[]} */ const created = [];
	/** @type {any[]} */ const createdNodes = [];
	/** @type {string[]} */ const errors = [];
	/** @type {Record<string, string>} */ const refIds = {};

	for (const rawSpec of specs) {
		const type = normalizeNodeType(rawSpec?.type);
		if (!type || !ALL_CATALOG_TYPES.includes(type)) {
			errors.push('unknown node type "' + rawSpec?.type + '"');
			continue;
		}
		if (!allowed.includes(type)) {
			errors.push(
				PHYSICS_NODE_TYPES.includes(type)
					? 'node "' + type + '" needs Physics tools enabled (Settings ▸ Tools & connections ▸ the chat provider)'
					: 'node type "' + type + '" cannot be created by the assistant'
			);
			continue;
		}
		const spec = findNodeSpec(type);
		const node = {
			id: genUuid(),
			type,
			position: gridPosition(existing + createdNodes.length),
			data: buildNodeData(type, spec, rawSpec?.data, errors),
			class: 'w-[150px]'
		};
		createFlowNode(node, graphId);
		const serialized = serializeNode(node);
		if (peer) peer.send({ type: 'nodecreate', node: serialized, graphId });
		createdNodes.push(serialized);
		const ref = typeof rawSpec?.ref === 'string' && rawSpec.ref ? rawSpec.ref : null;
		if (ref) refIds[ref] = node.id;
		created.push({ ...(ref ? { ref } : {}), id: node.id, type });
	}

	/** @type {any[]} */ const createdEdges = [];
	const edgeSpecs = [...(Array.isArray(args?.edges) ? args.edges : []), ...textEdges];
	if (edgeSpecs.length) {
		const graphNodes = graphOf(graphId)?.nodes ?? [];
		const inGraph = new Set(graphNodes.map((/** @type {any} */ n) => n.id));
		for (const e of edgeSpecs) {
			const source = refIds[e?.from] ?? (inGraph.has(e?.from) ? e.from : null);
			const target = refIds[e?.to] ?? (inGraph.has(e?.to) ? e.to : null);
			if (!source || !target) {
				// 55 (41's research): an id that lives in ANOTHER graph is not unknown — say what to do instead
				const elsewhere = [e?.from, e?.to].some((id) => typeof id === 'string' && !refIds[id] && !inGraph.has(id) && !!findNodeAnyGraph((/** @type {any} */ n) => n.id === id));
				errors.push(
					'edge "' + e?.from + '" -> "' + e?.to + '": ' +
						(elsewhere ? 'edges must stay in one graph; put the source in scene with an Object Selector' : 'unknown node ref/id')
				);
				continue;
			}
			const sourceHandle = typeof e?.fromHandle === 'string' && e.fromHandle ? e.fromHandle : undefined;
			const targetHandle = typeof e?.toHandle === 'string' && e.toHandle ? e.toHandle : undefined;
			// 55 (41's voice-Claude finding): a handle the node does not have made a wire that did nothing
			const bad = edgeHandleProblems(
				graphNodes.find((/** @type {any} */ n) => n.id === source),
				graphNodes.find((/** @type {any} */ n) => n.id === target),
				sourceHandle,
				targetHandle
			);
			if (bad.length) {
				errors.push('edge "' + e?.from + '" -> "' + e?.to + '": ' + bad.join('; '));
				continue;
			}
			// id format MUST match the editor's (peer dedupe diverges otherwise)
			const edge = {
				id:
					'e-' + source + (sourceHandle ? '.' + sourceHandle : '') +
					'-' + target + (targetHandle ? '.' + targetHandle : ''),
				source,
				target,
				...(sourceHandle ? { sourceHandle } : {}),
				...(targetHandle ? { targetHandle } : {})
			};
			createFlowEdge(edge, graphId);
			const serialized = serializeEdge(edge);
			if (peer) peer.send({ type: 'edgecreate', edge: serialized, graphId });
			createdEdges.push(serialized);
		}
	}

	if (createdNodes.length || createdEdges.length)
		recordFlowNodesEntry({ op: 'create', graphId, nodes: createdNodes, edges: createdEdges });
	if (!createdNodes.length && !createdEdges.length)
		return { error: 'nothing was created: ' + (errors[0] ?? 'no valid nodes'), errors };
	// 55 owner finding 3: a half-done call says so at the top level — `partial` + a one-line
	// `warning` — not only deep in errors[] (a top-level `error` would read as "nothing happened"
	// and invite a retry that duplicates what WAS created)
	const failedNodes = specs.length - createdNodes.length;
	const failedEdges = edgeSpecs.length - createdEdges.length;
	// mcp-fix: a script that cannot do what it says must not look like it worked
	const scriptNotes = createdNodes
		.filter((/** @type {any} */ n) => n.type === 'script')
		.flatMap((/** @type {any} */ n) =>
			scriptNodeWarnings(n.data, { unwired: graphId === SCENE_GRAPH && !graphOf(graphId)?.edges.some((/** @type {any} */ e) => e.source === n.id) })
		);
	return {
		graph: graphId,
		created,
		edges: createdEdges.length,
		...(scriptNotes.length && !errors.length ? { warning: scriptNotes.join(' ') } : {}),
		...(errors.length
			? {
					partial: true,
					warning:
						'only part of this call was applied: ' +
						[failedNodes ? failedNodes + ' of ' + specs.length + ' nodes' : '', failedEdges ? failedEdges + ' of ' + edgeSpecs.length + ' edges' : '']
							.filter(Boolean)
							.join(' and ') +
						(failedNodes || failedEdges ? ' were not created' : 'some node data was not applied') +
						' — fix what errors[] names and send only those again' +
						(scriptNotes.length ? '. ' + scriptNotes.join(' ') : ''),
					errors
				}
			: {})
	};
}

/**
 * 34 D5: compact graph text -> create_flow_nodes specs. A node line's id becomes its `ref`,
 * its label + params its data (buildNodeData then lays the catalog defaults under them, so a
 * line need only say what differs); an edge line becomes {from, to, fromHandle, toHandle}.
 * Positions and classes in the text are ignored — the tool lays new nodes out itself.
 * @param {any} text
 * @returns {{nodes: any[], edges: any[]} | {error: string}}
 */
function textToSpecs(text) {
	if (text === undefined || text === null || text === '') return { nodes: [], edges: [] };
	if (typeof text !== 'string') return { error: 'text must be a string of graph lines' };
	const { graphs, order, errors } = parseGraphText(text);
	if (errors.length)
		return { error: 'could not read the graph text: ' + errors.slice(0, 5).map((e) => e.message).join('; ') };
	const nodes = [];
	const edges = [];
	for (const key of order) {
		for (const n of graphs[key].nodes) {
			if (!n || typeof n !== 'object') continue;
			nodes.push({ ref: n.id, type: n.type, data: n.data });
		}
		for (const e of graphs[key].edges) {
			if (!e || typeof e !== 'object') continue;
			edges.push({
				from: e.source,
				to: e.target,
				...(e.sourceHandle ? { fromHandle: e.sourceHandle } : {}),
				...(e.targetHandle ? { toHandle: e.targetHandle } : {})
			});
		}
	}
	return { nodes, edges };
}

/**
 * update_flow_nodes: tune node data and/or remove nodes in ONE graph.
 * @param {any} args {graph, updates?: [{id, data}], remove?: [ids]}
 * @returns {any}
 */
export function updateFlowNodesTool(args) {
	const graphId = resolveGraph(args?.graph);
	if (graphId === null)
		return { error: 'unknown graph "' + args?.graph + '" — pass "scene" or an existing object uuid' };
	const graph = graphOf(graphId);
	if (!graph || !graph.nodes.length) return { error: 'that graph has no nodes yet' };
	/** @type {any} */
	const peer = get(peers);
	/** @type {string[]} */ const errors = [];
	/** @type {any[]} */ const updated = [];
	/** @type {string[]} */ const scriptNotes = [];
	/** @type {{id: string, before: any, after: any}[]} */ const items = [];

	for (const u of Array.isArray(args?.updates) ? args.updates : []) {
		const node = graph.nodes.find((/** @type {any} */ n) => n.id === u?.id);
		if (!node) {
			errors.push('no node "' + u?.id + '" in that graph');
			continue;
		}
		const spec = findNodeSpec(node.type);
		/** @type {any} */ const patch = {};
		/** @type {any} */ const before = {};
		const raw = u?.data && typeof u.data === 'object' ? u.data : {};
		for (const [key, value] of Object.entries(raw)) {
			if (key === 'type') continue;
			if (key === 'points' && node.type === 'pathpatrol') {
				const points = validatePoints(value);
				if (!points) {
					errors.push('pathpatrol points must be >=2 [x,y,z] triples');
					continue;
				}
				before.points = node.data.points;
				patch.points = points;
				continue;
			}
			// 85b R10: a direct target on Set Color / Visibility / Spin, checked like create's
			if (key === 'target' && DIRECT_TARGET_TOOL_TYPES.has(node.type)) {
				const t = directTarget(value);
				if (t === null) {
					errors.push(node.type + ' target: an object uuid from list_scene (or "" for the usual rules)');
					continue;
				}
				before.target = node.data.target ?? '';
				patch.target = t;
				continue;
			}
			const known = key === 'label' || key in (spec?.defaults ?? {}) || key in node.data;
			if (!known) continue;
			before[key] = node.data[key];
			patch[key] = value;
		}
		if (!Object.keys(patch).length) {
			errors.push('no valid data keys for node "' + u?.id + '"');
			continue;
		}
		// ALWAYS pass the graph — setNodeData defaults to the active editor graph
		setNodeData(node.id, patch, graphId);
		items.push({ id: node.id, before, after: patch });
		updated.push({ id: node.id, keys: Object.keys(patch) });
		if (node.type === 'script' && 'code' in patch)
			scriptNotes.push(...scriptNodeWarnings({ ...node.data, ...patch }, { unwired: graphId === SCENE_GRAPH && !graph.edges.some((/** @type {any} */ e) => e.source === node.id) }));
	}
	if (items.length) recordFlowNodesEntry({ op: 'data', graphId, items });

	const wantRemove = Array.isArray(args?.remove) ? args.remove : [];
	const removeIds = wantRemove.filter((/** @type {any} */ id) =>
		graph.nodes.some((/** @type {any} */ n) => n.id === id)
	);
	wantRemove
		.filter((/** @type {any} */ id) => !removeIds.includes(id))
		.forEach((/** @type {any} */ id) => errors.push('no node "' + id + '" to remove'));
	if (removeIds.length) {
		// capture serialized nodes + touching edges BEFORE deleting (undo restore)
		const nodes = graph.nodes
			.filter((/** @type {any} */ n) => removeIds.includes(n.id))
			.map(serializeNode);
		const edges = graph.edges
			.filter((/** @type {any} */ e) => removeIds.includes(e.source) || removeIds.includes(e.target))
			.map(serializeEdge);
		deleteFlowNodes(removeIds, graphId); // also drops touching edges (applier-identical)
		if (peer) peer.send({ type: 'nodedelete', ids: removeIds, graphId });
		recordFlowNodesEntry({ op: 'delete', graphId, nodes, edges });
	}

	if (!updated.length && !removeIds.length)
		return { error: errors[0] ?? 'nothing to do — pass updates and/or remove', errors };
	return {
		graph: graphId,
		updated,
		removed: removeIds.length,
		...(scriptNotes.length ? { warning: scriptNotes.join(' ') } : {}),
		...(errors.length ? { errors } : {})
	};
}

const PHYSICS_MODES = ['auto', 'static', 'dynamic'];
const COLLIDER_KINDS = ['box', 'sphere', 'capsule', 'cylinder', 'hull', 'trimesh'];

/**
 * set_physics: merge body params onto objects' userData.physics via the shared
 * setPhysicsFor path (replicated + 'props' undo entries). Skips peer-locked.
 * @param {any} args {updates: [{uuid, mode?, mass?, restitution?, friction?, collider?}]}
 * @returns {any}
 */
export function setPhysicsTool(args) {
	const updates = Array.isArray(args?.updates) ? args.updates : [];
	if (!updates.length)
		return {
			error:
				(Array.isArray(args?.objects) ? 'set_physics takes "updates", not "objects"' : 'no updates provided') +
				' — pass updates: [{ uuid, mode?, mass?, ... }]'
		};
	const results = updates.map((/** @type {any} */ u) => {
		const uuid = u?.uuid;
		if (!uuid || !objectOf(uuid)) return { uuid, error: 'no object with that uuid' };
		const lock = lockSkip(uuid, objectOf(uuid));
		if (lock) return { uuid, skipped: lock };
		/** @type {any} */ const patch = {};
		if (typeof u.mode === 'string' && PHYSICS_MODES.includes(u.mode)) patch.mode = u.mode;
		if (Number.isFinite(u.mass)) {
			patch.mass = Math.max(0.01, u.mass);
			if (!patch.mode) patch.mode = 'dynamic'; // mass only means anything on a dynamic body
		}
		const restitution = Number.isFinite(u.restitution) ? u.restitution : u.bounciness;
		if (Number.isFinite(restitution)) patch.restitution = Math.min(Math.max(restitution, 0), 1);
		if (Number.isFinite(u.friction)) patch.friction = Math.min(Math.max(u.friction, 0), 2);
		if (typeof u.collider === 'string' && COLLIDER_KINDS.includes(u.collider))
			patch.collider = u.collider;
		if (typeof u.sensor === 'boolean') patch.sensor = u.sensor; // CL-A A3 trigger volume
		if (isGroupId(u.group)) patch.group = u.group === 'default' ? null : u.group; // 36 X5
		if (Array.isArray(u.collidesWith)) patch.collidesWith = normalizeCollidesWith(u.collidesWith);
		if (!Object.keys(patch).length)
			return { uuid, error: 'no physics keys — pass mode/mass/restitution/friction/collider' };
		setPhysicsFor(uuid, patch);
		// mcp-fix: only a top-level object gets a body, so say it now and not at the start
		const held = objectOf(uuid);
		if (held?.parent && held.parent !== get(objectsGroup)) return { uuid, ok: true, physics: patch, warning: nestedWords([{ name: held.name || held.type, group: held.parent.name || 'a group' }]) };
		// mcp-fix: a body's kind is fixed for a run, so say that instead of seeming to have changed it
		if (patch.mode && get(simulating)) return { uuid, ok: true, physics: patch, note: 'the simulation is running: the new mode applies from the next start (stop, then start)' };
		return { uuid, ok: true, physics: patch };
	});
	if (results.every((/** @type {any} */ r) => r.error))
		return { error: 'nothing was updated: ' + results[0].error, updated: results };
	return { updated: results };
}

/**
 * create_joints: attach object pairs (fixed weld / revolute hinge + optional
 * motor). Pre-validates uuids/locks — createJoint toasts + returns null on bad
 * input, which must come back to the model as {error}, not a silent no-op.
 * @param {any} args {joints: [{kind, a, b, axis?, motor?: {vel, maxForce}}]}
 * @returns {any}
 */
export function createJointsTool(args) {
	const specs = Array.isArray(args?.joints) ? args.joints : [];
	if (!specs.length)
		return { error: 'no joints provided — pass joints: [{ kind: "fixed"|"revolute", a, b }]' };
	const results = specs.map((/** @type {any} */ j) => {
		const rawKind = String(j?.kind ?? '').toLowerCase();
		const kind =
			rawKind === 'fixed' || rawKind === 'weld'
				? 'fixed'
				: rawKind === 'revolute' || rawKind === 'hinge'
					? 'revolute'
					: null;
		if (!kind)
			return { error: 'unknown joint kind "' + j?.kind + '" — use fixed (weld) or revolute (hinge)' };
		const a = j?.a;
		const b = j?.b;
		if (!a || !objectOf(a)) return { error: 'joint "a" object not found: ' + a };
		if (!b || !objectOf(b)) return { error: 'joint "b" object not found: ' + b };
		if (a === b) return { error: 'cannot joint an object to itself' };
		const lock = lockSkip(a, objectOf(a)) || lockSkip(b, objectOf(b));
		if (lock) return { skipped: lock, a, b };
		// mcp-fix: a joint with no body on one side would report success and then hold nothing
		for (const [side, uuid] of [['a', a], ['b', b]]) {
			const why = jointBodyProblem(objectOf(uuid));
			if (why) return { error: 'joint "' + side + '" cannot hold: ' + why, a, b };
		}
		const axis = ['x', 'y', 'z'].includes(j?.axis) ? j.axis : undefined;
		const motor =
			kind === 'revolute' && j?.motor && Number.isFinite(j.motor.vel)
				? { vel: j.motor.vel, maxForce: Number.isFinite(j.motor.maxForce) ? j.motor.maxForce : 100 }
				: undefined;
		// 55 owner finding 6: anchor (world point), contacts:false and hinge limits reach the joint
		const anchor =
			Array.isArray(j?.anchor) && j.anchor.length === 3 && j.anchor.every((/** @type {any} */ n) => Number.isFinite(n))
				? j.anchor
				: undefined;
		const def = createJoint(/** @type {'fixed'|'revolute'} */ (kind), a, b, axis, motor, {
			...(anchor ? { anchor } : {}),
			...(j?.contacts === false ? { contacts: false } : {}),
			...(Array.isArray(j?.limits) ? { limits: j.limits } : {})
		});
		if (!def) return { error: 'joint creation failed', a, b };
		return { id: def.id, kind, a, b, ...(def.contacts === false ? { contacts: false } : {}) };
	});
	if (results.every((/** @type {any} */ r) => r.error))
		return { error: 'nothing was attached: ' + results[0].error, joints: results };
	return { joints: results };
}

/** @param {{name: string, group: string}[]} list objects with physics inside a group */
const nestedWords = (list) =>
	list.map((o) => '"' + o.name + '" (in "' + o.group + '")').join(', ') +
	(list.length > 1 ? ' have' : ' has') +
	' physics but will not simulate, because the simulation only runs objects at the top of the scene, not inside a group. Move them out with update_objects parentUuid "root", or set physics on the group itself.';

/**
 * control_simulation: start/stop/pause/resume/reset the physics sim. Start
 * guards the remote-initiator rule; sim start/stop deliberately records NO
 * history entry of its own here (stopSimulation's transformSet matches manual
 * behavior — undoing the AI batch never stops a running sim).
 * @param {any} args {action: 'start'|'stop'|'pause'|'resume'|'reset'}
 * @returns {Promise<any>}
 */
export async function controlSimulationTool(args) {
	const action = String(args?.action ?? '').toLowerCase();
	if (action === 'start') {
		if (get(simulating)) return { simulating: true, note: 'already running' };
		if (get(remoteSimulating))
			return { error: 'another peer is already simulating — one run at a time' };
		await toggleSimulation(); // handles the rapier wasm warmup
		const on = get(simulating);
		const gaps = simulationGaps();
		const inGroups = gaps.nested.length ? nestedWords(gaps.nested) : '';
		if (!on) {
			if (inGroups) return { error: 'simulation did not start: ' + inGroups };
			if (gaps.lockedOut.length) return { error: 'simulation did not start: another person is editing ' + gaps.lockedOut.join(', ') + ', and those are the only objects with dynamic physics.' };
			return { error: 'simulation did not start — no object has physics yet (use set_physics or a mass node first)' };
		}
		// mcp-fix: a joint that was not built holds nothing, so never let that pass as a clean start
		const unbuilt = unbuiltJointIds();
		const warnings = [...(unbuilt.length ? ['these joints are not in the simulation, because a side has no physics body: ' + unbuilt.join(', ')] : []), ...(inGroups ? [inGroups] : [])];
		return { simulating: true, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
	}
	if (action === 'stop') {
		stopSimulation();
		return { simulating: get(simulating) };
	}
	if (action === 'pause' || action === 'resume') {
		// mcp-fix: only a running simulation can pause; pauseSimulation does nothing otherwise
		if (!get(simulating))
			return { error: 'cannot ' + action + ': ' + (get(remoteSimulating) ? 'another peer is running the simulation' : 'the simulation is not running. Use action "start" first') };
		pauseSimulation(action === 'pause');
		return { simulating: true, paused: action === 'pause' };
	}
	if (action === 'reset') {
		resetSimulation();
		return { simulating: get(simulating) };
	}
	return { error: 'unknown action "' + args?.action + '" — start | stop | pause | resume | reset' };
}
