import * as THREE from 'three';
import { get, derived } from 'svelte/store';
import { objectsGroup, TControls, selectedObjects, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { graphOf, updateGraph } from '../stores/flowStore';
import { registerHistoryKind, recordEntry } from './history';
import { applySelectionSet } from './objectActions';
import { deleteObjectGraph } from './flowGraphs';
import { serializeNode, serializeEdge } from './nodesHandler';
import { parkEditOverlays, stripEditOverlays } from './editOverlays';
import { keepSet, disposeTree } from './disposeTree';
import { prefabs, prefabById, prefabRevision, updatePrefab } from './prefabs';
import { linkOf, mergeInstance, overridesOf, unlinkPatch, instanceKey, elementKey, same } from './prefabSync';

// 37 R4 — PREFAB UPDATE PROPAGATION, the runtime half (prefabSync.js is the merge).
//
// An update REPLACES each instance in place: same uuid, same parent, the merged element.
// That is a message every peer already understands — `{type:'object', element, override}`,
// the arrival heal's replace — so the wire learns nothing new and an older peer applies it.
// Peers do not need the prefab: the library is local, the instances are scene content.
//
// The whole update is ONE history entry (`prefabsync`): every instance's element before and
// after, plus the flow graphs the update installed or replaced, so one Ctrl+Z puts every
// instance back and replicates that too. Graph documents replace through the messages the
// flownodes kind already sends (nodedelete/edgedelete, then graphcreate + a `nodes`
// snapshot), because a `nodes` snapshot alone MERGES and could never remove a node.

const loader = new THREE.ObjectLoader();

/** Every instance root of `id` in the scene (nested ones included). @param {string} id
 * @returns {any[]} */
export function prefabInstances(id) {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	group?.traverse((/** @type {any} */ node) => {
		if (node !== group && linkOf(node)?.id === id) out.push(node);
	});
	return out;
}

/** The nearest instance root at or above `object` (any prefab), or null. @param {any} object */
export function instanceRootOf(object) {
	const group = get(objectsGroup);
	for (let o = object; o && o !== group; o = o.parent) if (linkOf(o)) return o;
	return null;
}

/** instance counts per prefab id, for the Library cards (re-read on every scene poke) */
export const prefabInstanceCounts = derived([objectsGroup, prefabs], ([$group]) => {
	/** @type {Record<string, number>} */
	const counts = {};
	/** @type {any} */ ($group)?.traverse((/** @type {any} */ node) => {
		const link = node !== $group ? linkOf(node) : null;
		if (link) counts[link.id] = (counts[link.id] ?? 0) + 1;
	});
	return counts;
});

/** The serialized element of a live object, as the merge and the wire want it. @param {any} object */
function elementOf(object) {
	const unpark = parkEditOverlays(object);
	try {
		object.updateMatrixWorld(true);
		return JSON.parse(JSON.stringify(object.toJSON()));
	} finally {
		unpark();
	}
}

/** @param {any} graph @returns {{nodes: any[], edges: any[]}|null} */
function serializedGraph(graph) {
	if (!graph || (!graph.nodes?.length && !graph.edges?.length)) return null;
	return { nodes: graph.nodes.map(serializeNode), edges: graph.edges.map(serializeEdge) };
}

/** A graph's CONTENT: types, data and wiring by position in the list — node ids are minted
 * per copy, and where a node sits on the canvas is layout, not logic. @param {any} graph */
function graphContent(graph) {
	if (!graph || (!graph.nodes?.length && !graph.edges?.length)) return null;
	/** @type {Record<string, number>} */
	const at = {};
	graph.nodes.forEach((/** @type {any} */ n, /** @type {number} */ i) => (at[n.id] = i));
	return {
		nodes: graph.nodes.map((/** @type {any} */ n) => ({ type: n.type, data: n.data ?? {} })),
		edges: graph.edges.map((/** @type {any} */ e) => [at[e.source], e.sourceHandle ?? '', at[e.target], e.targetHandle ?? ''])
	};
}

/** A copy with fresh node ids and canonical edge ids (copyGraphFrom's rule). @param {any} doc */
function freshGraph(doc) {
	/** @type {Record<string, string>} */
	const idMap = {};
	const nodes = doc.nodes.map((/** @type {any} */ node) => {
		const id = crypto.randomUUID();
		idMap[node.id] = id;
		return { ...node, id, position: node.position ? { ...node.position } : { x: 0, y: 0 }, data: { ...node.data } };
	});
	const edges = doc.edges
		.map((/** @type {any} */ edge) => {
			const source = idMap[edge.source];
			const target = idMap[edge.target];
			if (!source || !target) return null;
			return {
				...edge,
				id: 'e-' + source + (edge.sourceHandle ? '.' + edge.sourceHandle : '') + '-' + target + (edge.targetHandle ? '.' + edge.targetHandle : ''),
				source,
				target
			};
		})
		.filter(Boolean);
	return { nodes, edges };
}

/** Replace one object's flow document, replicated. null = no document. @param {string} uuid @param {any} doc */
function setGraphDoc(uuid, doc) {
	/** @type {any} */
	const peer = get(peers);
	const current = graphOf(uuid);
	if (!doc) {
		if (current) deleteObjectGraph(uuid, { record: false });
		return;
	}
	if (current && peer) {
		const edgeIds = current.edges.map((/** @type {any} */ e) => e.id);
		const nodeIds = current.nodes.map((/** @type {any} */ n) => n.id);
		if (edgeIds.length) peer.send({ type: 'edgedelete', ids: edgeIds, graphId: uuid });
		if (nodeIds.length) peer.send({ type: 'nodedelete', ids: nodeIds, graphId: uuid });
	}
	updateGraph(uuid, () => ({
		nodes: doc.nodes.map((/** @type {any} */ n) => ({ ...n, data: { ...n.data } })),
		edges: doc.edges.map((/** @type {any} */ e) => ({ ...e }))
	}));
	if (peer) {
		peer.send({ type: 'graphcreate', uuid });
		peer.send({ type: 'nodes', graphs: { [uuid]: doc } });
	}
}

/**
 * Put `element` in place of the object with its root uuid, locally and on every peer.
 * The receive path is the override replace (commandsHandler.applyCreateObject); locally
 * the same steps run synchronously so the history applier can report what happened.
 * @param {any} element @param {string|null} parentUuid where it lives when it is not found
 * @returns {boolean}
 */
function replaceInPlace(element, parentUuid) {
	const group = get(objectsGroup);
	if (!group || !element?.object) return false;
	const uuid = element.object.uuid;
	const existing = group.getObjectByProperty('uuid', uuid);
	let object;
	try {
		object = loader.parse(element);
		stripEditOverlays(object);
	} catch (error) {
		console.log('prefab instance parse failed', error);
		return false;
	}
	const parent = existing?.parent ?? (parentUuid ? group.getObjectByProperty('uuid', parentUuid) : null) ?? group;
	/** @type {any} */
	const controls = get(TControls);
	if (existing && controls?.object && instanceContains(existing, controls.object)) controls.detach();
	if (existing) existing.parent?.remove(existing);
	parent.add(object);
	if (existing) {
		let root = group;
		while (root.parent) root = root.parent;
		disposeTree(existing, { keep: keepSet(root, existing) });
	}
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element, override: true, ...(parent !== group ? { groupuuid: parent.uuid } : {}) });
	return true;
}

/** @param {any} root @param {any} node */
function instanceContains(root, node) {
	for (let o = node; o; o = o.parent) if (o === root) return true;
	return false;
}

/** After replacing, the selection's gizmo is attached to a removed object: re-seat it. */
function reseatSelection() {
	const set = get(selectedObjects);
	if (set.length) applySelectionSet([...set]);
}

/** @param {any} entry @param {'before'|'after'} side */
function applySync(entry, side) {
	let any = false;
	for (const item of entry.items) if (replaceInPlace(item[side], item.parentUuid)) any = true;
	for (const g of entry.graphs ?? []) setGraphDoc(g.uuid, g[side]);
	reseatSelection();
	if (!any) showToast('Cannot undo/redo: those instances no longer exist');
	return any;
}

registerHistoryKind('prefabsync', (entry, state) => applySync(entry, state === entry.before ? 'before' : 'after'));

/**
 * The element an instance's overrides are measured against: the revision it was placed
 * from when that is still known, else `fallback` (the element the caller replaced), else
 * null — no overrides detected, which the merge documents.
 * @param {string} id @param {number} rev @param {any} fallback
 */
async function baseFor(id, rev, fallback) {
	const known = await prefabRevision(id, rev);
	return known ?? fallback ?? null;
}

/**
 * Bring instances of prefab `id` up to its current element, keeping their overrides unless
 * `reset`. ONE undo step, replicated per instance. Returns what happened.
 * @param {string} id
 * @param {{reset?: boolean, uuids?: string[]|null, fallback?: {element: any, graphs: any}|null, label?: string, quiet?: boolean}} [opts]
 *   `uuids` limits the update to those instance roots; `fallback` is the base for an
 *   instance whose own revision is no longer kept
 */
export async function updateInstances(id, opts = {}) {
	const { reset = false, uuids = null, fallback = null, quiet = false } = opts;
	const entry = prefabById(id);
	if (!entry?.element) return { updated: 0, overrides: 0, total: 0 };
	const rev = entry.rev ?? 0;
	const roots = prefabInstances(id).filter((o) => !uuids || uuids.includes(o.uuid));
	const group = get(objectsGroup);
	/** @type {any[]} */
	const items = [];
	/** @type {any[]} */
	const graphs = [];
	let overrides = 0;
	/** @type {Map<number, any>} */
	const bases = new Map();
	for (const root of roots) {
		// a nested instance inside another instance being replaced in this same pass would
		// be replaced twice; the outer element already carries the inner one
		const link = linkOf(root);
		if (!link) continue;
		if (!bases.has(link.rev)) bases.set(link.rev, await baseFor(id, link.rev, fallback));
		const base = bases.get(link.rev);
		const before = elementOf(root);
		const merged = mergeInstance(before, base?.element ?? null, entry.element, { prefabId: id, rev, reset });
		overrides += merged.overrides.length;
		const parentUuid = root.parent && root.parent !== group ? root.parent.uuid : null;
		if (!same(before.object, merged.element.object) || !same(before.materials, merged.element.materials) || !same(before.geometries, merged.element.geometries))
			items.push({ uuid: root.uuid, parentUuid, before, after: merged.element });
		// the flow graphs, node by node of the merged instance
		// the merged ROOT carries no key of its own (it is the link) — it is the element's root
		const rootKey = elementKey(entry.element.object);
		const walk = (/** @type {any} */ node) => {
			const key = node === merged.element.object ? rootKey : instanceKey(node, id);
			if (key !== undefined) {
				const nextG = entry.graphs?.[key] ?? null;
				const baseG = base?.graphs?.[key] ?? null;
				if (nextG || baseG) {
					const mine = serializedGraph(graphOf(node.uuid));
					const kept = !reset && !!base && !same(graphContent(mine), graphContent(baseG));
					if (kept) overrides++;
					else if (!same(graphContent(mine), graphContent(nextG)))
						graphs.push({ uuid: node.uuid, before: mine, after: nextG ? freshGraph(nextG) : null });
				}
			}
			for (const c of node.children ?? []) walk(c);
		};
		walk(merged.element.object);
	}
	// nested instances of THIS prefab inside another of its instances are replaced with the
	// outer one; drop the inner items so nothing is applied twice
	const outer = new Set(items.map((i) => i.uuid));
	const flat = items.filter((item) => {
		const node = group?.getObjectByProperty('uuid', item.uuid);
		for (let o = node?.parent; o && o !== group; o = o.parent) if (outer.has(o.uuid)) return false;
		return true;
	});
	if (!flat.length && !graphs.length) {
		if (!quiet) showToast(roots.length ? 'Every instance already matches "' + entry.name + '"' : 'No instances of "' + entry.name + '" in this scene');
		return { updated: 0, overrides, total: roots.length };
	}
	const record = {
		kind: 'prefabsync',
		label: (reset ? 'Reset ' : 'Update ') + roots.length + ' instance' + (roots.length === 1 ? '' : 's') + ' of ' + entry.name,
		items: flat,
		graphs,
		before: 'before',
		after: 'after'
	};
	applySync(record, 'after');
	recordEntry(record);
	if (!quiet)
		showToast(
			(reset ? 'Reset ' : 'Updated ') +
				flat.length +
				' instance' +
				(flat.length === 1 ? '' : 's') +
				' of "' +
				entry.name +
				'"' +
				(!reset && overrides ? ' — kept ' + overrides + ' override' + (overrides === 1 ? '' : 's') : '')
		);
	return { updated: flat.length, overrides, total: roots.length };
}

/**
 * After a prefab's bytes changed: offer to bring its instances along. `exclude` are the
 * objects the edit was made FROM — they are updated silently (their revision has to move)
 * and not counted.
 * @param {string} id @param {{exclude?: string[], fallback?: any, extra?: any[]}} [opts]
 */
export function offerInstanceUpdate(id, opts = {}) {
	const entry = prefabById(id);
	if (!entry) return;
	const exclude = new Set(opts.exclude ?? []);
	const all = prefabInstances(id);
	const others = all.filter((o) => !exclude.has(o.uuid));
	const sources = all.filter((o) => exclude.has(o.uuid)).map((o) => o.uuid);
	// the instance the edit came from IS the new revision: re-link it now, no question asked
	if (sources.length) void updateInstances(id, { uuids: sources, fallback: opts.fallback, quiet: true });
	if (!others.length) {
		showToast(`Updated "${entry.name}"`, opts.extra);
		return;
	}
	const n = others.length;
	const uuids = others.map((o) => o.uuid);
	showToast(`Updated "${entry.name}" — ${n} other instance${n === 1 ? '' : 's'} in this scene`, [
		{ label: `Update ${n} instance${n === 1 ? '' : 's'}`, action: () => void updateInstances(id, { uuids, fallback: opts.fallback }) },
		{ label: 'Update, reset overrides', action: () => void updateInstances(id, { uuids, fallback: opts.fallback, reset: true }) },
		...(opts.extra ?? [])
	]);
}

/** "Apply to prefab": the instance's state becomes the prefab's next revision, then the
 * other instances are offered the update. @param {string} uuid */
export async function applyInstanceToPrefab(uuid) {
	const group = get(objectsGroup);
	const root = group?.getObjectByProperty('uuid', uuid);
	const link = linkOf(root);
	if (!root || !link) return null;
	const entry = prefabById(link.id);
	if (!entry) {
		showToast('That prefab is not in your library');
		return null;
	}
	const previous = { element: entry.element, graphs: entry.graphs ?? null };
	const next = await updatePrefab(link.id, [uuid], { toast: false });
	if (!next) return null;
	offerInstanceUpdate(link.id, { exclude: [uuid], fallback: previous });
	return next;
}

/** Reset one instance to its prefab (placement kept). @param {string} uuid */
export function resetInstance(uuid) {
	const link = linkOf(get(objectsGroup)?.getObjectByProperty('uuid', uuid));
	if (!link) return Promise.resolve(null);
	return updateInstances(link.id, { uuids: [uuid], reset: true });
}

/** Bring one instance up to its prefab, overrides kept. @param {string} uuid */
export function syncInstance(uuid) {
	const link = linkOf(get(objectsGroup)?.getObjectByProperty('uuid', uuid));
	if (!link) return Promise.resolve(null);
	return updateInstances(link.id, { uuids: [uuid] });
}

/** What an instance overrides (field labels), or null when its base is unknown.
 * @param {string} uuid @returns {Promise<string[]|null>} */
export async function instanceOverrides(uuid) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const link = linkOf(root);
	if (!link) return null;
	const base = await prefabRevision(link.id, link.rev);
	if (!base) return null;
	return overridesOf(elementOf(root), base.element, link.id);
}

/** Cut an instance loose from its prefab: an ordinary object from now on. ONE undo step.
 * @param {string} uuid */
export function unlinkInstance(uuid) {
	const group = get(objectsGroup);
	const root = group?.getObjectByProperty('uuid', uuid);
	const link = linkOf(root);
	if (!root || !link) return false;
	const before = elementOf(root);
	const after = JSON.parse(JSON.stringify(before));
	const patch = unlinkPatch(after.object, link.id);
	const walk = (/** @type {any} */ node) => {
		if (patch[node.uuid]) {
			node.userData = patch[node.uuid];
			if (!Object.keys(node.userData).length) delete node.userData;
		}
		for (const c of node.children ?? []) walk(c);
	};
	walk(after.object);
	const parentUuid = root.parent && root.parent !== group ? root.parent.uuid : null;
	const record = { kind: 'prefabsync', label: 'Unlink from prefab', items: [{ uuid, parentUuid, before, after }], graphs: [], before: 'before', after: 'after' };
	applySync(record, 'after');
	recordEntry(record);
	showToast(`Unlinked from "${prefabById(link.id)?.name ?? 'its prefab'}" — updates will not reach it`);
	return true;
}

/** Select every instance of a prefab. @param {string} id */
export function selectInstances(id) {
	const uuids = prefabInstances(id).map((o) => o.uuid);
	if (uuids.length) applySelectionSet(uuids);
	return uuids.length;
}
