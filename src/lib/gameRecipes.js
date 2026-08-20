// 21-E8 — GAME RECIPES: a whole authored behaviour, built from the object menu.
//
// THE PROBLEM THIS SOLVES. E4 shipped the logic a game loop is made of, E6 the character
// controller and 21-D7 the HUD actions — so by now every PIECE of "collect the gems"
// exists, and assembling it is still five nodes and four wires in the node editor, done
// once per collectible. That is the same gap 21-D7 closed for a HUD button, one domain
// over: the loop exists and is undiscoverable.
//
// THE MODEL is 21-D7's exactly, and deliberately not a new one: a recipe is NOT a new kind
// of behaviour, it is the flow nodes a user would have drawn, created through
// `ai/flowTools.js:createFlowNodesTool`'s construction (crypto ids, handle-qualified edge
// ids that peer dedupe depends on) and recorded as ONE replicated `flownodes` undo entry.
// So it replicates, saves, undoes and can be TAKEN APART afterwards, because what it leaves
// behind is an ordinary graph.
//
// WHY IT IS NOT IN `objectMenu.js`: that module is a lean builder of menu descriptors and
// reaches its heavy collaborators (physics, terrainSculpt, cameraPreview…) through dynamic
// `import()`. A recipe writes to the flow graph and records history, so it belongs on the
// other side of that seam — the same reason `hudActions.js` is not inside
// `HudActionsSection.svelte`.

import { get } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { SCENE_GRAPH, flowGraphs } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import { findNodeSpec } from './nodeCatalog';

/** The variable a collectible counts into with nothing else said. A recipe needs a default
 * that is a real answer rather than an empty field, and the toast names it out loud so the
 * next step (show it in a HUD Text) is obvious. */
export const COLLECT_VAR = 'gems';

/** layout: one horizontal chain per object, each object on its own row */
const COL = 210;
const ROW = 190;
/** the counting branch hangs UNDER the chain rather than extending it — it is a second
 * thing the click does, not a later step in the same one */
const BRANCH_Y = 92;

/** A fresh uuid, flowTools' helper verbatim. @returns {string} */
function genUuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** The scene graph's nodes and edges (hudActions' reader). */
function sceneGraph() {
	const doc = get(flowGraphs)[SCENE_GRAPH];
	return { nodes: doc?.nodes ?? [], edges: doc?.edges ?? [] };
}

/** Node data exactly like the editor builds it: label + type + spec defaults, then ours.
 * @param {string} type @param {Record<string, any>} [data] */
function nodeData(type, data) {
	const spec = findNodeSpec(type);
	return { label: spec?.label ?? type, type, ...(spec?.defaults ?? {}), ...(data ?? {}) };
}

/** @param {string} type @param {number} x @param {number} y @param {Record<string, any>} [data] */
function makeNode(type, x, y, data) {
	return { id: genUuid(), type, position: { x, y }, data: nodeData(type, data), class: 'w-[150px]' };
}

/** The editor's edge-id format, handle-qualified. It MUST match, or peer dedupe diverges.
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
 * Is this object ALREADY driven by a hide/show chain? The cheapest honest test: an Object
 * Selector naming it, fed by a Visibility node. It cannot tell a collectible from a
 * hand-built hide chain — and it does not need to, because a SECOND one would double-count
 * every pickup while leaving the object visibly hidden by the first, which is nobody's
 * intent either way.
 * @param {string} uuid
 */
function alreadyCollectible(uuid) {
	const { nodes, edges } = sceneGraph();
	const selectors = nodes
		.filter((/** @type {any} */ n) => n.type === 'objectselector' && String(n.data?.selected ?? '') === uuid)
		.map((/** @type {any} */ n) => n.id);
	if (!selectors.length) return false;
	return edges.some((/** @type {any} */ e) => {
		if (!selectors.includes(e.target)) return false;
		return nodes.find((/** @type {any} */ n) => n.id === e.source)?.type === 'visibility';
	});
}

/**
 * MAKE COLLECTIBLE: clicking the object hides it for everyone and adds one to a shared
 * variable, and it stays collected.
 *
 * The graph, per object:
 *
 *     On Click ──set──> Latch ──a──> Gate(not) ──on──> Visibility ──> Object Selector(uuid)
 *         └──trigger──> Once ──trigger──> Set Variable(gems, add 1)
 *
 * WHY EACH PIECE. `Latch` is what makes "collected" PERSIST: every trigger in this app is a
 * ~0.3s pulse, so wiring the click straight at Visibility would blink the object and hand it
 * back. `Gate` on `not` inverts it, because the latch means COLLECTED and the socket wants
 * VISIBLE — one node instead of a second authoring concept. And the counting is a separate
 * branch off the same click rather than a later step in the chain, because it is a second
 * thing the click does.
 *
 * `Once` IS LOAD-BEARING AND WAS NOT OBVIOUS. The Latch holds the object hidden, so a second
 * click LOOKS like it does nothing — but Set Variable acts on the trigger STAMP EDGE, and a
 * second click is a new stamp, so without Once the same gem could be banked over and over
 * (measured: gems 1 -> 2 on the second click of an object that never came back). Gating it
 * with a Gate is not available: a Gate outputs a BOOLEAN and `trigger` is an EVENT input, a
 * direction the coercion table deliberately does not allow. Once is exactly E4’s answer to
 * "first time only", it is pure (the first stamp is frozen on the node’s own entry), and its
 * `rearm` input is the seam a respawning pickup will need.
 *
 * WHAT REPLICATES: nothing new. The click already rides `nodetrigger`, so every peer latches
 * from the same stamp and hides the object itself; the variable rides the game-state
 * singleton it always did. One replicated `flownodes` batch and ONE undo entry PER OBJECT —
 * per object on purpose, so undoing a mis-click on a ring of ten gems does not throw the
 * other nine away.
 *
 * @param {string[]} uuids @param {{variable?: string, quiet?: boolean}} [opts]
 * @returns {{built: string[], skipped: string[], variable: string}}
 */
export function makeCollectible(uuids, opts = {}) {
	const variable = String(opts.variable ?? COLLECT_VAR).trim() || COLLECT_VAR;
	const targets = (Array.isArray(uuids) ? uuids : [uuids]).filter(Boolean);
	/** @type {any} */
	const peer = get(peers);
	const group = get(objectsGroup);
	/** @type {string[]} */ const built = [];
	/** @type {string[]} */ const skipped = [];

	// start below everything already in the graph, so a recipe never lands on top of the
	// nodes a user placed by hand
	const existing = sceneGraph().nodes;
	const baseY = existing.reduce((max, n) => Math.max(max, Number(n.position?.y) || 0), 0) + (existing.length ? ROW : 40);

	targets.forEach((uuid, index) => {
		if (!group?.getObjectByProperty('uuid', uuid)) {
			skipped.push(uuid);
			return;
		}
		if (alreadyCollectible(uuid)) {
			skipped.push(uuid);
			return;
		}
		const y = baseY + index * ROW;
		const click = makeNode('onclick', 60, y);
		const latch = makeNode('latch', 60 + COL, y);
		const gate = makeNode('gate', 60 + COL * 2, y, { op: 'not' });
		const vis = makeNode('visibility', 60 + COL * 3, y);
		const selector = makeNode('objectselector', 60 + COL * 4, y, { selected: uuid });
		const once = makeNode('once', 60 + COL, y + BRANCH_Y);
		const count = makeNode('setvariable', 60 + COL * 2, y + BRANCH_Y, {
			name: variable,
			op: 'add',
			value: 1
		});
		const created = [click, latch, gate, vis, selector, once, count];
		const createdEdges = [
			makeEdge(click, latch, 'set'),
			makeEdge(latch, gate, 'a'),
			makeEdge(gate, vis, 'on'),
			// an Object Selector takes the UNNAMED target handle, like every effect node
			makeEdge(vis, selector),
			makeEdge(click, once, 'trigger'),
			makeEdge(once, count, 'trigger')
		];

		// nodes before edges, the editor's own order
		for (const node of created) {
			createFlowNode(node, SCENE_GRAPH);
			if (peer) peer.send({ type: 'nodecreate', node: serializeNode(node), graphId: SCENE_GRAPH });
		}
		for (const edge of createdEdges) {
			createFlowEdge(edge, SCENE_GRAPH);
			if (peer) peer.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId: SCENE_GRAPH });
		}
		// SERIALIZED copies, so a replayed re-broadcast hashes identically on every peer
		recordFlowNodesEntry({
			op: 'create',
			graphId: SCENE_GRAPH,
			nodes: created.map(serializeNode),
			edges: createdEdges.map(serializeEdge)
		});
		built.push(uuid);
	});

	if (!opts.quiet) {
		if (!built.length)
			showToast(
				skipped.length
					? 'Already collectible — clicking it already hides it and counts it.'
					: 'Nothing to make collectible.'
			);
		else
			showToast(
				(built.length === 1 ? 'Collectible' : built.length + ' collectibles') +
					' created. Counting into the variable "' +
					variable +
					'" — show it with a HUD Text (Show a variable).'
			);
	}
	return { built, skipped, variable };
}
