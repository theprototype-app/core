// Module SDK — flow triggers (fireObjectClick / fireNodeTrigger) and api.flow.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { peers } from '../../stores/appStore';
import {
	flowGraphs,
	flowValues,
	flowTriggers,
	allNodes,
	findNodeAnyGraph,
	SCENE_GRAPH
} from '../../stores/flowStore';
import { coalescedSubscribe } from '../coalesce';
import { freeRegion as freeRegionIn } from '../flowLayout';
import {
	createFlowNode,
	createFlowEdge,
	serializeNode,
	serializeEdge,
	setNodeData as sendNodeData
} from '../nodesHandler';
import { get } from 'svelte/store';
import { flowRuntimeRef, flowGraphsRef, nodeCatalogRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkFlowTriggers(ctx) {
	return {
		/**
		 * Fire the replicated flow click trigger on an object (DEVX #4, the
		 * essentials pattern) — user graphs with an On Click node targeting the
		 * object react to your module's events on every peer. @param {string} uuid
		 */
		fireObjectClick(uuid) {
			// dynamic: flowRuntime statically imports moduleSDK (cycle rule)
			import('../flowRuntime').then((m) => m.fireObjectClick(uuid));
		},
		/**
		 * A1 (DEVX #9): pulse your module's own EVENT nodes — a level cleared, a goal
		 * scored, a wave spawned. REPLICATED like a click (the pulse rides the existing
		 * `nodetrigger` message from ONE peer's stamp), so call it on the peer where the
		 * event happened and NOT on all of them, or a Counter counts it once per peer.
		 *
		 * `match(data, id)` picks which instances fire; all of them when it is absent.
		 * Register the node type's output as `{vtype: 'event'}` so it can be wired to a
		 * Counter or an Object Selector.
		 *
		 * R3a: `opts.replicate === false` keeps the pulse in THIS peer's own trigger log —
		 * the per-player mechanism (a per-player collect fires locally; everything
		 * downstream — latch state, hide, counting — is then per-peer for free). Absent,
		 * the node's own `perPlayer` data flag decides, exactly as before.
		 * @param {string} type @param {(data: any, id: string) => boolean=} match
		 * @param {{replicate?: boolean}=} opts
		 */
		fireNodeTrigger(type, match, opts) {
			if (flowRuntimeRef) flowRuntimeRef.fireModuleTrigger(type, match, opts);
			else import('../flowRuntime').then((m) => m.fireModuleTrigger(type, match, opts));
		}
	};
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkFlow(ctx) {
	const { moduleId, owned } = ctx;
	/** A value frozen for the undo stack, so a module mutating its patch object later
	 * cannot rewrite history. @param {any} v */
	const frozen = (v) => {
		try {
			return structuredClone(v);
		} catch {
			return v;
		}
	};
	/** One node-data write through the replicated `nodedata` path; returns the undo
	 * item (the patched keys' previous values) or null when no node has the id.
	 * @param {string} id @param {Record<string, any>} patch */
	const writeNodeData = (id, patch) => {
		const found = findNodeAnyGraph((n) => n.id === id);
		if (!found) return null;
		const after = frozen(patch && typeof patch === 'object' ? patch : {});
		/** @type {Record<string, any>} */
		const before = {};
		for (const key of Object.keys(after)) before[key] = frozen(found.node.data?.[key]);
		sendNodeData(id, patch && typeof patch === 'object' ? patch : {}, found.graphId);
		return { id, graphId: found.graphId, before, after };
	};
	/** ONE `flownodes` data entry for these writes (a no-op until flowGraphs is primed,
	 * which it is long before a module's UI can be pressed).
	 * @param {{id: string, graphId: string, before: any, after: any}[]} items */
	const recordNodeData = (items) => {
		if (!items.length) return;
		flowGraphsRef?.recordFlowNodesEntry({ op: 'data', graphId: items[0].graphId, items, moduleId });
	};
	return {
		/**
		 * R3a: THE GRAPH, for modules whose node needs neighbours — a manager toolbox
		 * listing its instances, a count node reading its siblings, a recipe creating the
		 * node wired to an Object Selector. Reads are DETERMINISTIC because the graph is
		 * replicated; treat them exactly like replicated state (the value-node rule).
		 */
		flow: {
			/** Every node (optionally one type) as plain snapshots:
			 * `{id, type, graphId, x, y, data}` — graphId 'scene' or the owner object's uuid;
			 * x/y the node's position in its graph (R29 S1, read-only — move a node in the
			 * editor, never by writing these). @param {string=} type @returns {any[]} */
			nodes(type) {
				const out = [];
				for (const n of allNodes()) {
					if (type && n.type !== type) continue;
					out.push({
						id: n.id,
						type: n.type,
						graphId: n.__graph ?? SCENE_GRAPH,
						x: Number(n.position?.x) || 0,
						y: Number(n.position?.y) || 0,
						data: { ...(n.data ?? {}) }
					});
				}
				return out;
			},
			/**
			 * R29 S1: where a `w` x `h` block of new nodes can land without covering what is
			 * already in the graph — left-aligned under its lowest card (an empty graph gets
			 * a margin from the origin). Pass the result's x/y to `addNodes`; ask again before
			 * each block, since the answer moves as the graph grows. The rule is core's one
			 * copy (`flowLayout.freeRegion`), shared with the HUD editor's bindings.
			 * @param {{w?: number, h?: number, graphId?: string}=} opts
			 * @returns {{x: number, y: number, w: number, h: number}}
			 */
			freeRegion(opts) {
				const graphId = opts?.graphId ?? SCENE_GRAPH;
				const nodes = get(flowGraphs)?.[graphId]?.nodes ?? [];
				return freeRegionIn(nodes, { w: opts?.w, h: opts?.h });
			},
			/**
			 * R29 S2: `fn()` runs after the flow graphs change — a node or edge created,
			 * deleted, moved or re-parameterised, on this peer or arriving from one — or
			 * after a node FIRES (the trigger log, which is what a latch, a counter or your
			 * own `triggerStamp` read derives from, so a manager listing collected state
			 * needs it as much as it needs the structure). It is
			 * COALESCED to one frame: however many store writes a gesture or a stream of
			 * arriving edits makes, the handler runs once, after them. Live VALUES (`nodeValue`) tick every frame
			 * and deliberately do not fire it. Torn down with the module, or earlier by
			 * calling the returned `off` (a toolbox that mounts and unmounts).
			 * @param {() => void} fn @returns {() => void} off
			 */
			onChange(fn) {
				return owned('flow.onChange', coalescedSubscribe([flowGraphs, flowTriggers], fn));
			},
			/** Every edge, graph-tagged: `{id, source, target, sourceHandle, targetHandle,
			 * graphId}`. @returns {any[]} */
			edges() {
				const out = [];
				for (const [graphId, graph] of Object.entries(get(flowGraphs) ?? {})) {
					for (const e of graph.edges ?? [])
						out.push({
							id: e.id,
							source: e.source,
							target: e.target,
							sourceHandle: e.sourceHandle ?? null,
							targetHandle: e.targetHandle ?? null,
							graphId
						});
				}
				return out;
			},
			/** A node's current evaluated VALUE (what its output socket carries this tick) —
			 * how a module reads a core Latch's round-aware state without reimplementing it.
			 * Undefined for nodes that carry no value. @param {string} id */
			nodeValue(id) {
				return get(flowValues)[id];
			},
			/** A node's OWN round-aware trigger-log entry: `{stamp, age}` or null (never
			 * fired, or retired by `perRound` against the replicated round). The latch read
			 * a collectible-style module polls. @param {string} id */
			triggerStamp(id) {
				return flowRuntimeRef?.nodeTriggerStamp?.(id) ?? null;
			},
			/** Replicated node-data MERGE (the editor's own `nodedata` path — same message,
			 * same merge) that is ALSO one undo step: a `flownodes` data entry holding the
			 * patched keys' previous values, attributed to this module (R29 S3 — before it,
			 * a module's write left the stack untouched and the next Ctrl+Z undid whatever
			 * came before). The manager toolbox's inline param edit. @param {string} id
			 * @param {Record<string, any>} patch @returns {boolean} found */
			setNodeData(id, patch) {
				const item = writeNodeData(id, patch);
				if (!item) return false;
				recordNodeData([item]);
				return true;
			},
			/**
			 * Many node-data writes as ONE undo step (R29 S3): a toolbox's group edit over
			 * sixty collectibles is one Ctrl+Z, not sixty and not none. Each item is
			 * validated exactly as `setNodeData` (an unknown id is skipped) and may live in
			 * any graph. The wire is the ordinary per-node `nodedata` — there is no batched
			 * type, so a peer on any build converges; the measured cost is ~0.1 ms/node.
			 * @param {{id: string, patch: Record<string, any>}[]} list
			 * @returns {number} how many nodes were written
			 */
			setNodesData(list) {
				const items = [];
				for (const entry of Array.isArray(list) ? list : []) {
					const item = entry && writeNodeData(entry.id, entry.patch);
					if (item) items.push(item);
				}
				recordNodeData(items);
				return items.length;
			},
			/**
			 * Create nodes (and edges) the way the editor does: replicated `nodecreate`/
			 * `edgecreate` per item plus ONE `flownodes` undo entry for the batch — so what a
			 * module builds can be undone in one step and taken apart afterwards, because it
			 * is an ordinary graph (the recipe rule).
			 *
			 * `nodes`: `[{type, x, y, data}]` — label defaults to the core spec's (or the
			 * type), data is spread over the spec defaults. `edges`: `[{from, to, handle?,
			 * fromHandle?}]` where from/to are INDICES into `nodes` or existing node ID
			 * strings; `handle` is the target handle. Edge ids take the editor's canonical
			 * handle-qualified shape — peer dedupe depends on it.
			 * @param {{graphId?: string, nodes?: any[], edges?: any[]}} spec
			 * @returns {string[]} the created node ids ([] until the runtime is primed)
			 */
			addNodes(spec) {
				if (!flowGraphsRef) return [];
				const graphId = spec?.graphId ?? SCENE_GRAPH;
				/** @type {any} */
				const peer = get(peers);
				const uuid = () =>
					typeof crypto !== 'undefined' && crypto.randomUUID
						? crypto.randomUUID()
						: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
								const r = (Math.random() * 16) | 0;
								return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
							});
				const created = (spec?.nodes ?? []).map((n) => {
					const nodeSpec = nodeCatalogRef?.findNodeSpec?.(n.type);
					return {
						id: uuid(),
						type: n.type,
						position: { x: Number(n.x) || 0, y: Number(n.y) || 0 },
						data: {
							label: nodeSpec?.label ?? n.data?.label ?? n.type,
							type: n.type,
							...(nodeSpec?.defaults ?? {}),
							...(n.data ?? {})
						},
						class: 'w-[150px]'
					};
				});
				const resolve = (/** @type {any} */ ref) =>
					typeof ref === 'number' ? created[ref]?.id : String(ref ?? '');
				const createdEdges = (spec?.edges ?? [])
					.map((e) => {
						const source = resolve(e.from);
						const target = resolve(e.to);
						if (!source || !target) return null;
						const sh = e.fromHandle ? '.' + e.fromHandle : '';
						const th = e.handle ? '.' + e.handle : '';
						return {
							id: 'e-' + source + sh + '-' + target + th,
							source,
							target,
							...(e.fromHandle ? { sourceHandle: e.fromHandle } : {}),
							...(e.handle ? { targetHandle: e.handle } : {})
						};
					})
					.filter(Boolean);
				// nodes before edges, the editor's own order
				for (const node of created) {
					createFlowNode(node, graphId);
					if (peer) peer.send({ type: 'nodecreate', node: serializeNode(node), graphId });
				}
				for (const edge of createdEdges) {
					createFlowEdge(edge, graphId);
					if (peer) peer.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId });
				}
				if (created.length || createdEdges.length)
					flowGraphsRef.recordFlowNodesEntry({
						op: 'create',
						graphId,
						nodes: created.map(serializeNode),
						edges: createdEdges.map(serializeEdge)
					});
				return created.map((n) => n.id);
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkFlowTriggers.surface = {
	fireObjectClick: 'action',
	fireNodeTrigger: 'action'
};

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkFlow.surface = {
	'flow.nodes': 'read',
	'flow.freeRegion': 'read',
	'flow.onChange': 'registers',
	'flow.edges': 'read',
	'flow.nodeValue': 'read',
	'flow.triggerStamp': 'read',
	'flow.setNodeData': 'content',
	'flow.setNodesData': 'content',
	'flow.addNodes': 'content'
};
