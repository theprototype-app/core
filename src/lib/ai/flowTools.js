import { get } from 'svelte/store';
import { graphOf, graphExists, SCENE_GRAPH } from '../../stores/flowStore';
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
	toggleSimulation,
	stopSimulation,
	pauseSimulation,
	resetSimulation,
	simulating,
	remoteSimulating
} from '$lib/physics';
import { createJoint } from '$lib/joints';
import { activeAiConfig } from './providers.js';

// AI flow + physics executors (assistant v3). The behavior counterpart to
// tools.js: create/update flow nodes (the @xyflow editor graphs driving
// per-frame animation) and — gated per provider — physics params, joints and
// simulation control. Same conventions as tools.js: apply locally + broadcast
// + record undo history exactly like a human edit; executors never throw
// (errors come back as {error} so the model can self-correct).

/** Physics is hard for small local models — a per-provider opt-in checkbox
 * (Settings → AI) gates these tools. @returns {boolean} */
export function physicsToolsEnabled() {
	return !!activeAiConfig()?.physicsTools;
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
	opendoor: 'playanim',
	door: 'playanim'
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

/** @param {any} raw @returns {string|null} a real catalog type or null */
function normalizeNodeType(raw) {
	const flat = String(raw ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, '');
	if (ALL_CATALOG_TYPES.includes(flat)) return flat;
	return NODE_TYPE_ALIASES[flat] ?? null;
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
		if (key in (spec?.defaults ?? {})) data[key] = value;
		// unknown keys are dropped silently — defaults render fine without them
	}
	return data;
}

/**
 * create_flow_nodes: add behavior nodes (and optional edges) to ONE graph.
 * Local `ref` keys let edges point at freshly created nodes. Records ONE
 * 'flownodes' history entry for the whole call.
 * @param {any} args {graph, nodes: [{ref?, type, data?}], edges?: [{from, to, fromHandle?, toHandle?}]}
 * @returns {any}
 */
export function createFlowNodesTool(args) {
	const graphId = resolveGraph(args?.graph);
	if (graphId === null)
		return { error: 'unknown graph "' + args?.graph + '" — pass "scene" or an existing object uuid' };
	const specs = Array.isArray(args?.nodes) ? args.nodes : [];
	if (!specs.length)
		return { error: 'no nodes provided — pass nodes: [{ type, data? }] (one graph per call)' };

	const physics = physicsToolsEnabled();
	const allowed = aiNodeTypes(physics);
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
					? 'node "' + type + '" needs Physics tools enabled (Settings -> AI)'
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
	const edgeSpecs = Array.isArray(args?.edges) ? args.edges : [];
	if (edgeSpecs.length) {
		const inGraph = new Set((graphOf(graphId)?.nodes ?? []).map((/** @type {any} */ n) => n.id));
		for (const e of edgeSpecs) {
			const source = refIds[e?.from] ?? (inGraph.has(e?.from) ? e.from : null);
			const target = refIds[e?.to] ?? (inGraph.has(e?.to) ? e.to : null);
			if (!source || !target) {
				errors.push('edge "' + e?.from + '" -> "' + e?.to + '": unknown node ref/id');
				continue;
			}
			const sourceHandle = typeof e?.fromHandle === 'string' && e.fromHandle ? e.fromHandle : undefined;
			const targetHandle = typeof e?.toHandle === 'string' && e.toHandle ? e.toHandle : undefined;
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
	return {
		graph: graphId,
		created,
		edges: createdEdges.length,
		...(errors.length ? { errors } : {})
	};
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
		...(errors.length ? { errors } : {})
	};
}

const PHYSICS_MODES = ['auto', 'static', 'dynamic'];
const COLLIDER_KINDS = ['box', 'sphere', 'capsule', 'cylinder', 'hull'];

/**
 * set_physics: merge body params onto objects' userData.physics via the shared
 * setPhysicsFor path (replicated + 'props' undo entries). Skips peer-locked.
 * @param {any} args {updates: [{uuid, mode?, mass?, restitution?, friction?, collider?}]}
 * @returns {any}
 */
export function setPhysicsTool(args) {
	const updates = Array.isArray(args?.updates) ? args.updates : [];
	if (!updates.length)
		return { error: 'no updates provided — pass updates: [{ uuid, mode?, mass?, ... }]' };
	const results = updates.map((/** @type {any} */ u) => {
		const uuid = u?.uuid;
		if (!uuid || !objectOf(uuid)) return { uuid, error: 'no object with that uuid' };
		if (lockedByPeer(uuid)) return { uuid, skipped: 'locked by another peer' };
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
		if (!Object.keys(patch).length)
			return { uuid, error: 'no physics keys — pass mode/mass/restitution/friction/collider' };
		setPhysicsFor(uuid, patch);
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
		if (lockedByPeer(a) || lockedByPeer(b)) return { skipped: 'locked by another peer', a, b };
		const axis = ['x', 'y', 'z'].includes(j?.axis) ? j.axis : undefined;
		const motor =
			kind === 'revolute' && j?.motor && Number.isFinite(j.motor.vel)
				? { vel: j.motor.vel, maxForce: Number.isFinite(j.motor.maxForce) ? j.motor.maxForce : 100 }
				: undefined;
		const def = createJoint(/** @type {'fixed'|'revolute'} */ (kind), a, b, axis, motor);
		if (!def) return { error: 'joint creation failed', a, b };
		return { id: def.id, kind, a, b };
	});
	if (results.every((/** @type {any} */ r) => r.error))
		return { error: 'nothing was attached: ' + results[0].error, joints: results };
	return { joints: results };
}

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
		return on
			? { simulating: true }
			: { error: 'simulation did not start — no object has physics yet (use set_physics or a mass node first)' };
	}
	if (action === 'stop') {
		stopSimulation();
		return { simulating: get(simulating) };
	}
	if (action === 'pause') {
		pauseSimulation(true);
		return { simulating: get(simulating), paused: true };
	}
	if (action === 'resume') {
		pauseSimulation(false);
		return { simulating: get(simulating), paused: false };
	}
	if (action === 'reset') {
		resetSimulation();
		return { simulating: get(simulating) };
	}
	return { error: 'unknown action "' + args?.action + '" — start | stop | pause | resume | reset' };
}
