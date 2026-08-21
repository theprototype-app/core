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
import { SCENE_GRAPH, flowGraphs, allNodes } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import { findNodeSpec } from './nodeCatalog';
// 21-F2: both LEAVES (svelte stores only), so neither closes a cycle back into history
import { gameState } from './gameState';
import { showCollectibleOptions } from './recipeDialog';

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
/** 21-F2: and the respawn branch hangs under THAT one, for the same reason */
const RESPAWN_Y = 184;

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
 * 21-F2: every MESH under a group, the group itself excluded. Running the recipe on a
 * Group means "make the things in it collectible" — a Group has no geometry to click,
 * so the alternative is a menu entry that silently does nothing.
 * @param {any} object @returns {string[]}
 */
function meshDescendants(object) {
	/** @type {string[]} */
	const out = [];
	object?.traverse?.((/** @type {any} */ child) => {
		if (child !== object && child.isMesh) out.push(child.uuid);
	});
	return out;
}

/**
 * 21-F2: every variable name a collectible could sensibly count into — what the game
 * already HOLDS plus every name any Set/Get Variable node in any graph mentions. The
 * picker offers these and still takes free text: a name that exists nowhere yet is the
 * normal case for the first pickup of a new kind.
 * @returns {string[]}
 */
export function collectibleVariables() {
	const names = new Set([COLLECT_VAR, ...Object.keys(get(gameState).vars ?? {})]);
	for (const node of allNodes()) {
		if (node.type !== 'setvariable' && node.type !== 'getvariable') continue;
		const name = String(node.data?.name ?? '').trim();
		if (name) names.add(name);
	}
	return [...names].sort();
}

/**
 * ONE collectible's nodes and edges, unrecorded and unsent — the caller decides how they
 * are BATCHED into undo entries, which is the only thing that differs between a lone
 * object and a group.
 * @param {string} uuid @param {number} y @param {string} variable @param {number} respawn
 */
function buildChain(uuid, y, variable, respawn) {
	const click = makeNode('onclick', 60, y);
	// 21-F2: `perRound` is what makes a collected gem come back when a new round starts
	// or the game returns to its menu — a param on the card, derived from the replicated
	// round, with no reset edge to draw and nothing sent
	const latch = makeNode('latch', 60 + COL, y, { perRound: true });
	const gate = makeNode('gate', 60 + COL * 2, y, { op: 'not' });
	// and `whilePlaying` is what stops it holding the object hidden once you leave play
	const vis = makeNode('visibility', 60 + COL * 3, y, { whilePlaying: true });
	const selector = makeNode('objectselector', 60 + COL * 4, y, { selected: uuid });
	const once = makeNode('once', 60 + COL, y + BRANCH_Y, { perRound: true });
	const count = makeNode('setvariable', 60 + COL * 2, y + BRANCH_Y, {
		name: variable,
		op: 'add',
		value: 1
	});
	const nodes = [click, latch, gate, vis, selector, once, count];
	const edges = [
		makeEdge(click, latch, 'set'),
		makeEdge(latch, gate, 'a'),
		makeEdge(gate, vis, 'on'),
		// an Object Selector takes the UNNAMED target handle, like every effect node
		makeEdge(vis, selector),
		makeEdge(click, once, 'trigger'),
		makeEdge(once, count, 'trigger')
	];

	// 21-F2 RESPAWN, and it is BUILT rather than hidden: the seam the Once comment named.
	// A Delay off the click resets the Latch — which brings the object back — and rearms
	// the Once, which is what lets the return be counted again. Every peer derives the
	// same moment from the same replicated click stamp, so the return needs no message.
	//
	// THE SOURCE HAS TO BE THE CLICK, NOT THE ONCE, and it took a red suite to see why: a
	// Delay has no state, so `stampOfSource` RE-DERIVES its fire moment from its trigger's
	// stamp every single time the Latch reads it — and the rearm DELETES the Once's entry.
	// Wired to the Once, the Delay therefore erased its own trigger at the exact moment it
	// fired, so the reset stamp existed for one tick and then could not be read at all:
	// the gem counted a second time (proving the rearm landed) and never came back.
	// Sourcing it from the click, whose log entry persists until the next click, keeps the
	// reset readable — and gives the right behaviour for a re-click during the wait, which
	// restarts the timer rather than stacking a second return.
	if (respawn > 0) {
		const back = makeNode('delay', 60 + COL * 3, y + RESPAWN_Y, { seconds: respawn });
		nodes.push(back);
		edges.push(makeEdge(click, back, 'trigger'), makeEdge(back, latch, 'reset'), makeEdge(back, once, 'rearm'));
	}
	return { nodes, edges };
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
 * 21-F2 GROUPS: a Group expands to its child MESHES, all sharing the group's variable and
 * landing as ONE undo entry — a group is ONE thing the user acted on. Separate objects
 * keep one entry EACH, which is the original reasoning above and still right. Re-running
 * it after adding a member skips the children that already have a chain, so growing a
 * group is a repeat of the same click.
 *
 * @param {string[]} uuids
 * @param {{variable?: string, respawn?: number, quiet?: boolean}} [opts]
 * @returns {{built: string[], skipped: string[], variable: string, respawn: number, entries: number}}
 */
export function makeCollectible(uuids, opts = {}) {
	const variable = String(opts.variable ?? COLLECT_VAR).trim() || COLLECT_VAR;
	const respawn = Math.max(0, Number(opts.respawn) || 0);
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
	// a respawning chain is one row taller, so rows cannot be a fixed stride
	const rowHeight = respawn > 0 ? RESPAWN_Y + 96 : ROW;

	// ONE batch per thing the user acted on: a mesh is itself, a group is its meshes
	/** @type {string[][]} */
	const batches = targets.map((uuid) => {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return [uuid]; // resolved (and skipped) below, where the reason is one place
		return object.type === 'Group' ? meshDescendants(object) : [uuid];
	});

	let row = 0;
	let entries = 0;
	for (const batch of batches) {
		/** @type {any[]} */ const created = [];
		/** @type {any[]} */ const createdEdges = [];
		for (const uuid of batch) {
			if (!group?.getObjectByProperty('uuid', uuid) || alreadyCollectible(uuid)) {
				skipped.push(uuid);
				continue;
			}
			const chain = buildChain(uuid, baseY + row * rowHeight, variable, respawn);
			row++;
			created.push(...chain.nodes);
			createdEdges.push(...chain.edges);
			built.push(uuid);
		}
		if (!created.length) continue;

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
		entries++;
	}

	if (!opts.quiet) {
		if (!built.length)
			showToast(
				skipped.length
					? 'Already collectible — clicking it already hides it and counts it.'
					: 'Nothing to make collectible.'
			);
		else
			showToast(
				(built.length === 1 ? '1 collectible' : built.length + ' collectibles') +
					' added' +
					(skipped.length ? ', ' + skipped.length + ' skipped (already collectible)' : '') +
					'. Counting into the variable "' +
					variable +
					'"' +
					(respawn > 0 ? ', back after ' + respawn + 's' : '') +
					' — show it with a HUD Text (Show a variable).'
			);
	}
	return { built, skipped, variable, respawn, entries };
}

/**
 * The same recipe, ASKED FOR: which variable, and does it come back. Resolves what
 * `makeCollectible` returned, or null if the dialog was cancelled — a cancel must build
 * nothing at all, which is why the prompt runs BEFORE any node is created.
 * @param {string[]} uuids @param {{variable?: string, respawn?: number}} [opts]
 */
export async function makeCollectiblePrompt(uuids, opts = {}) {
	const targets = (Array.isArray(uuids) ? uuids : [uuids]).filter(Boolean);
	const answer = await showCollectibleOptions({
		variables: collectibleVariables(),
		variable: opts.variable ?? COLLECT_VAR,
		respawn: opts.respawn ?? 0,
		count: targets.length
	});
	if (!answer) return null;
	return makeCollectible(targets, { variable: answer.variable, respawn: answer.respawn });
}
