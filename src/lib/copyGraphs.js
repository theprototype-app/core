// 92-correct row 2 — A SPAWNED COPY RUNS ITS TEMPLATE'S FLOW. Imports nothing (unit-tested).
//
// A Spawn copy (transientObjects.js) carries no flow document of its own, on purpose: a graph
// replicates whole, and a copy a second would put one on the wire per spawn. So a click on a copy
// reached nothing in the template's own flow (2.0-eval2: "click an enemy kills it" was unbuildable).
//
// The runtime now evaluates an INSTANCE of the template's object graph per copy: the same nodes and
// edges under ids `<copy>~<node id>`, owned by the copy (`__graph` = the copy's uuid), so every
// "this object" rule — an unwired effect drives its owner, an Object Selector naming the template
// means this copy — lands on the copy. Instances are RUNTIME ONLY: never in flowGraphs, never saved,
// never sent as a document. Their stamps ride the ordinary `nodetrigger` under the instance id,
// which every peer derives the same way because a copy has the same uuid everywhere (`duplicate`
// carries it). A latch, a counter or a Once in the template is per copy for free.
//
// ONLY THE EVENT PART is instanced: what an object event (a click, a hover, a grab, an overlap, a
// hit, an animation end) drives, plus whatever feeds those nodes a value. An always-on effect in the
// template's flow (a Spin, a Visibility that hides the template off-stage) stays the template's, so
// a scene whose copies did not move before does not start moving now.

/** the per-object EVENT nodes a copy hears (flowRuntime's fire* entry points) */
export const COPY_EVENT_TYPES = new Set(['onclick', 'onhover', 'ongrab', 'onenter', 'onexit', 'onimpact', 'onhit', 'onrest', 'animfinished', 'animmarker', 'onanimstate']);

/** the ids of one graph's event part: downstream of an event node, plus everything upstream of that
 * @param {any[]} graphNodes @param {any[]} graphEdges @returns {Set<string>} */
export function eventPart(graphNodes, graphEdges) {
	/** @type {Map<string, string[]>} */ const out = new Map();
	/** @type {Map<string, string[]>} */ const inn = new Map();
	for (const e of graphEdges) {
		(out.get(e.source) ?? out.set(e.source, []).get(e.source)).push(e.target);
		(inn.get(e.target) ?? inn.set(e.target, []).get(e.target)).push(e.source);
	}
	/** @type {Set<string>} */ const down = new Set();
	const stack = graphNodes.filter((n) => COPY_EVENT_TYPES.has(n.type)).map((n) => n.id);
	while (stack.length) {
		const id = /** @type {string} */ (stack.pop());
		if (down.has(id)) continue;
		down.add(id);
		for (const t of out.get(id) ?? []) stack.push(t);
	}
	const part = new Set(down);
	const up = [...down];
	while (up.length) {
		const id = /** @type {string} */ (up.pop());
		for (const s of inn.get(id) ?? []) if (!part.has(s)) (part.add(s), up.push(s));
	}
	return part;
}

export const INSTANCE_SEP = '~';

/** @param {string} owner @param {string} id */
export function instanceId(owner, id) {
	return owner + INSTANCE_SEP + id;
}

/** the template node id an instance id stands for (an ordinary id answers itself) @param {string} id */
export function instanceBaseId(id) {
	if (typeof id !== 'string') return id;
	const i = id.indexOf(INSTANCE_SEP);
	return i > 0 ? id.slice(i + 1) : id;
}

/** the copy an instance id belongs to, or null @param {string} id */
export function instanceOwnerOf(id) {
	if (typeof id !== 'string') return null;
	const i = id.indexOf(INSTANCE_SEP);
	return i > 0 ? id.slice(0, i) : null;
}

/** the key that changes exactly when the set of instances would @param {{uuid: string, from: string}[]} copies @param {Set<string>} graphs */
export function instanceKey(copies, graphs) {
	return copies
		.filter((c) => graphs.has(c.from))
		.map((c) => c.uuid + '>' + c.from)
		.sort()
		.join(',');
}

/**
 * The instance nodes and edges for `copies`, from the runtime's own (already filtered) graph.
 * @param {{uuid: string, from: string}[]} copies
 * @param {any[]} nodes the runtime nodes, each tagged with `__graph`
 * @param {any[]} edges
 * @returns {{nodes: any[], edges: any[]}}
 */
export function instanceGraphs(copies, nodes, edges) {
	/** @type {Map<string, any[]>} */
	const byGraph = new Map();
	for (const n of nodes) {
		const g = n?.__graph;
		if (!g || g === 'scene' || n.__instanceOf) continue;
		const list = byGraph.get(g);
		if (list) list.push(n);
		else byGraph.set(g, [n]);
	}
	/** @type {any[]} */ const outNodes = [];
	/** @type {any[]} */ const outEdges = [];
	if (!byGraph.size) return { nodes: outNodes, edges: outEdges };
	/** @type {Map<string, any[]>} */
	const edgesByGraph = new Map();
	const graphOfNode = new Map(nodes.map((n) => [n.id, n.__graph]));
	for (const e of edges) {
		const g = graphOfNode.get(e.source);
		if (!g || g !== graphOfNode.get(e.target) || !byGraph.has(g)) continue;
		const list = edgesByGraph.get(g);
		if (list) list.push(e);
		else edgesByGraph.set(g, [e]);
	}
	/** @type {Map<string, {nodes: any[], edges: any[]}>} */
	const parts = new Map();
	for (const { uuid, from } of copies) {
		if (!uuid || uuid === from || !byGraph.has(from)) continue;
		let part = parts.get(from);
		if (!part) {
			const all = /** @type {any[]} */ (byGraph.get(from));
			const allEdges = edgesByGraph.get(from) ?? [];
			const ids = eventPart(all, allEdges);
			part = { nodes: all.filter((n) => ids.has(n.id)), edges: allEdges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
			parts.set(from, part);
		}
		if (!part.nodes.length) continue;
		for (const n of part.nodes) {
			let data = n.data;
			// "this object": a selector or a named target that means the template means this copy
			if (n.type === 'objectselector' && data?.selected === from) data = { ...data, selected: uuid };
			else if (data?.target === from) data = { ...data, target: uuid };
			outNodes.push({ ...n, id: instanceId(uuid, n.id), __graph: uuid, __instanceOf: n.id, __instanceFrom: from, data });
		}
		for (const e of part.edges)
			outEdges.push({ ...e, id: instanceId(uuid, e.id), source: instanceId(uuid, e.source), target: instanceId(uuid, e.target) });
	}
	return { nodes: outNodes, edges: outEdges };
}

// ---- copies that are not scene objects (kit entities) ------------------------------------------
// A kit entity is drawn as a LOCAL copy of its template (kit/entityApp.js): no uuid every peer shares,
// no `duplicate`. Its shared name is the entity id, so the kit registers id -> template here and the
// runtime instances the template's event part under that id; a kit action in it fills its object
// input with the id (kit/nodes.js withOwner), so "this object" is the entity.

/** owner id -> template uuid @type {Map<string, string>} */
const extraCopies = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();
let notifyQueued = false;
function notify() {
	if (notifyQueued) return;
	notifyQueued = true;
	queueMicrotask(() => {
		notifyQueued = false;
		for (const fn of listeners) fn();
	});
}

/** @param {string} id @param {string} from */
export function registerCopy(id, from) {
	if (!id || !from || extraCopies.get(id) === from) return;
	extraCopies.set(id, from);
	notify();
}
/** @param {string} id */
export function unregisterCopy(id) {
	if (extraCopies.delete(id)) notify();
}
/** @returns {{uuid: string, from: string}[]} */
export function extraCopyList() {
	return [...extraCopies].map(([uuid, from]) => ({ uuid, from }));
}
/** the template of a registered copy, or null @param {string} id */
export function extraCopyFrom(id) {
	return extraCopies.get(id) ?? null;
}
/** @param {() => void} fn @returns {() => void} */
export function onCopiesChanged(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
