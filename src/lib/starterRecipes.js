// 78 F27 — STARTER RECIPES: one-click inserts in the node search ("Recipes") that turn the selected
// object into something that works when you press Play, built only from nodes that already exist:
//   · Door (click)       On Click → Toggle Animation (closed = where it stands, open = a quarter turn)
//   · Door (walk up)     a sensor zone around the door; On Enter (player) opens, On Exit closes
//                        (85-nodes Q9 "On Near": shared, because sensor edges replicate)
//   · Bell               On Click / On Hover / On Hit → Hover Animate (swing + ring)
//   · Guard              a closed Path around it + Path patrol; a sensor "sight" box (8 x 8 m) walks the
//                        same route, and a player stepping into it → Announce "Spotted!" + a whistle
//                        (shared: sensor edges replicate; a chase waits for 61-nav)
// Everything a recipe makes — the extra objects, their settings and the nodes in the object's own
// flow — is ONE undo step (a history batch), and every write goes through the replicated paths
// (`/create`, setPhysicsFor, setMaterialParam, nodecreate / edgecreate), so peers see it at once.

import { get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';
import { flowGraphs } from '../stores/flowStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry, createObjectGraph } from './flowGraphs';
import { findNodeSpec } from './nodeCatalog';
import { freeRegion } from './flowLayout';
import { spawnAtPoint } from './addObjects';
import { setPhysicsFor } from './physics';
import { setMaterialParam } from './materialsHandler';
import { applySelectionSet, renameObject } from './objectActions';
import { createPath } from './path/pathActions.js';

/** @typedef {{id: string, label: string, icon: string, tooltip: string}} StarterRecipe */

/** the catalog, in menu order (data: the menu and the docs read it) @type {StarterRecipe[]} */
export const STARTER_RECIPES = [
	{ id: 'door', label: 'Door (click to open)', icon: 'door-open', tooltip: 'On Click opens and closes it: a quarter turn, shared and saved' },
	{ id: 'door-walk', label: 'Door (opens when you walk up)', icon: 'door-open', tooltip: 'A sensor zone around the door: walking in opens it, walking out closes it' },
	{ id: 'bell', label: 'Bell', icon: 'bell', tooltip: 'Click, point at or knock it: it swings and rings for everyone' },
	{ id: 'guard', label: 'Guard', icon: 'shield', tooltip: 'Walks a loop path around where it stands; says "Spotted!" when a player steps into its sight' }
];

let seq = 0;
/** @param {string} type */
function newId(type) {
	seq++;
	return 'rcp-' + type + '-' + seq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** the editor's node shape: spec defaults, then ours @param {string} type @param {number} x @param {number} y @param {Record<string, any>} [data] */
function makeNode(type, x, y, data) {
	const spec = findNodeSpec(type);
	return { id: newId(type), type, position: { x, y }, data: { label: spec?.label ?? type, type, ...(spec?.defaults ?? {}), ...(data ?? {}) }, class: 'w-[150px]' };
}

/** the editor's edge-id format (peer dedupe depends on it) @param {any} s @param {any} t @param {string} [handle] */
function makeEdge(s, t, handle) {
	return { id: 'e-' + s.id + '-' + t.id + (handle ? '.' + handle : ''), source: s.id, target: t.id, ...(handle ? { targetHandle: handle } : {}) };
}

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** a translucent sensor box around a world point, `size` [x, y, z] metres
 * @param {string} name @param {number[]} at @param {number[]} size @param {number} [opacity] */
function makeZone(name, at, size, opacity = 0.15) {
	const zone = spawnAtPoint('/create Box', [at[0], at[1], at[2]]);
	if (!zone?.uuid) return null;
	zone.scale.set(size[0], size[1], size[2]);
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'move', uuid: zone.uuid, pos: zone.position.toArray(), rot: zone.rotation.toArray(), scale: zone.scale.toArray() });
	renameObject(zone.uuid, name);
	setMaterialParam(zone.uuid, 'transparent', true);
	setMaterialParam(zone.uuid, 'opacity', opacity);
	setPhysicsFor(zone.uuid, { mode: 'static', sensor: true });
	return zone;
}

/**
 * The nodes + edges + extra objects of one recipe for `owner` (an object uuid). Pure apart from the
 * objects it creates; positions are relative (the caller lays the block out).
 * @param {string} id @param {any} owner the object
 * @returns {{nodes: any[], edges: any[], made: string[]} | {error: string}}
 */
function buildRecipe(id, owner) {
	const at = owner.getWorldPosition(owner.position.clone()).toArray();
	if (id === 'door') {
		const click = makeNode('onclick', 0, 0);
		const door = makeNode('toggleanim', 240, 0, { openSound: 'door', closeSound: 'door' });
		return { nodes: [click, door], edges: [makeEdge(click, door, 'trigger')], made: [] };
	}
	if (id === 'door-walk') {
		const zone = makeZone((owner.name || 'Door') + ' zone', [at[0], 1.2, at[2]], [3, 2.4, 3]);
		if (!zone) return { error: 'Could not add the zone.' };
		const enter = makeNode('onenter', 0, 0, { who: 'player' });
		const exit = makeNode('onexit', 0, 160, { who: 'player' });
		const selA = makeNode('objectselector', -240, 0, { label: 'Zone', selected: zone.uuid });
		const selB = makeNode('objectselector', -240, 160, { label: 'Zone', selected: zone.uuid });
		const door = makeNode('toggleanim', 260, 60, { openSound: 'door', closeSound: 'door' });
		return {
			nodes: [enter, exit, selA, selB, door],
			edges: [makeEdge(enter, selA), makeEdge(exit, selB), makeEdge(enter, door, 'open'), makeEdge(exit, door, 'close')],
			made: [zone.uuid]
		};
	}
	if (id === 'bell') {
		const click = makeNode('onclick', 0, 0);
		const hover = makeNode('onhover', 0, 140, { on: 'enter', who: 'anyone', cooldown: 0.5 });
		const hit = makeNode('onhit', 0, 300);
		const swing = makeNode('hoveranimate', 260, 120, { style: 'swing', mode: 'energy', amount: 20, axis: 'z', sound: 'start', soundName: 'ring' });
		return { nodes: [click, hover, hit, swing], edges: [makeEdge(click, swing, 'trigger'), makeEdge(hover, swing, 'trigger'), makeEdge(hit, swing, 'trigger')], made: [] };
	}
	if (id === 'guard') {
		const r = 3;
		const y = Math.max(0, at[1]);
		const points = [
			[at[0] - r, y, at[2] - r],
			[at[0] + r, y, at[2] - r],
			[at[0] + r, y, at[2] + r],
			[at[0] - r, y, at[2] + r]
		].map((pos) => ({ pos }));
		const made = createPath({ points, closed: true, mode: 'loop', speed: 1.2, name: (owner.name || 'Guard') + ' route' });
		if ('error' in made) return { error: made.error };
		const pathUuid = made.object.uuid;
		// its SIGHT: a sensor box walking the same route in step (same path, same clock, so the same pose on
		// every peer). Proximity is a VALUE and an Announce acts on a pulse, so the pulse is the sight's On Enter
		// (who: player) — the walk-up door's pattern, and shared, because sensor edges replicate.
		const sight = makeZone((owner.name || 'Guard') + ' sight', [at[0], y, at[2]], [8, 2.4, 8], 0.08);
		if (!sight) return { error: 'Could not add the guard\'s sight.' };
		// two rows, side by side: a Path patrol card is ~320 units tall, so a 160 step stacked them over each other
		const patrol = makeNode('pathpatrol', 260, 0, { path: pathUuid, face: true });
		const sightPatrol = makeNode('pathpatrol', 560, 0, { path: pathUuid, face: false });
		const sightSel = makeNode('objectselector', 860, 0, { label: 'Sight', selected: sight.uuid });
		const spot = makeNode('onenter', 0, 380, { who: 'player' });
		const spotSel = makeNode('objectselector', -240, 380, { label: 'Sight', selected: sight.uuid });
		const spotted = makeNode('announce', 260, 380, { text: 'Spotted!', sub: '', seconds: 1.5, color: '#ff6a5a' });
		const alarm = makeNode('gamesound', 560, 380, { sound: 'whistle' });
		const nodes = [patrol, sightPatrol, sightSel, spot, spotSel, spotted, alarm];
		const edges = [makeEdge(sightPatrol, sightSel), makeEdge(spot, spotSel), makeEdge(spot, spotted, 'trigger'), makeEdge(spot, alarm, 'trigger')];
		return { nodes, edges, made: [pathUuid, sight.uuid] };
	}
	return { error: 'Unknown recipe.' };
}

/**
 * Insert a recipe into `ownerUuid`'s own flow (created when missing), below whatever it holds.
 * One undo step. The selection is put back on the owner (creating an object selects it).
 * @param {string} id @param {string} ownerUuid
 * @returns {{ok: true, nodes: string[], made: string[]} | {ok: false, error: string}}
 */
export function insertStarterRecipe(id, ownerUuid) {
	const owner = objectOf(ownerUuid);
	if (!owner) return { ok: false, error: 'Select the object first: a recipe goes into its own flow.' };
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		createObjectGraph(ownerUuid);
		const built = buildRecipe(id, owner);
		if ('error' in built) return { ok: false, error: built.error };
		const existing = get(flowGraphs)[ownerUuid]?.nodes ?? [];
		const origin = freeRegion(existing, { side: 'below' });
		const minX = Math.min(...built.nodes.map((n) => n.position.x));
		for (const n of built.nodes) n.position = { x: origin.x + n.position.x - minX, y: origin.y + n.position.y };
		/** @type {any} */
		const peer = get(peers);
		for (const node of built.nodes) {
			createFlowNode(node, ownerUuid);
			peer?.send({ type: 'nodecreate', node: serializeNode(node), graphId: ownerUuid });
		}
		for (const edge of built.edges) {
			createFlowEdge(edge, ownerUuid);
			peer?.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId: ownerUuid });
		}
		recordFlowNodesEntry({ op: 'create', graphId: ownerUuid, nodes: built.nodes.map(serializeNode), edges: built.edges.map(serializeEdge) });
		return { ok: true, nodes: built.nodes.map((n) => n.id), made: built.made };
	} finally {
		if (own) endHistoryBatch('Add recipe');
		applySelectionSet([ownerUuid]);
	}
}
