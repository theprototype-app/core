import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, recordTransformSet, beginHistoryBatch, endHistoryBatch, historyBatchOpen, registerHistoryKind } from './history';
import { withWireBatch } from './wireBatch';
import { applySelectionSet, renameObject } from './objectActions';
import { canEditObject } from './objectPermissions';
import { scenePhysicsState_, setScenePhysics } from './scenePhysics';
import { normalizeLayers, LAYER_COLORS, LAYERS_MAX } from './layersCore.js';
import { similarKey, matchesSimilar, renamePlan, randomisePlan } from './tidyCore.js';
import { linkOf } from './prefabSync';
import { materialIdOf } from './materialSharing';
import { carrierKindOf } from './proxyCarrier.js'; // 102-int-2

// 102b-arrange row 2 — TIDY BIG SCENES, the write path (a lazy chunk: the Inspector's Layers and Tidy
// sections, the object menu and the agent reach it). Layers: the table rides the scenePhysics
// singleton (no new message), an object's layer is `userData.layer` (objectParameters 'layer', props
// undo). Every multi-object op is ONE history batch and ONE wire envelope.

/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;

// ---- the layer table -----------------------------------------------------------------------------

/** the scene's layers (never null) @returns {import('./layersCore.js').Layer[]} */
export function sceneLayers() {
	return normalizeLayers(get(scenePhysicsState_)?.layers) ?? [];
}

// one undo step per table edit: the whole table before and after (small, at most 64 rows)
registerHistoryKind('layertable', (/** @type {any} */ _entry, /** @type {any} */ state) => {
	setScenePhysics({ layers: state ?? null });
	return true;
});

/** @param {any[] | null} next */
function writeTable(next) {
	const before = get(scenePhysicsState_)?.layers ?? null;
	const after = normalizeLayers(next);
	if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return false;
	setScenePhysics({ layers: after });
	recordEntry({ kind: 'layertable', before, after });
	return true;
}

/** add a layer (named, the next colour) @param {string} [name] @returns {string | null} its id */
export function addLayer(name) {
	const list = sceneLayers();
	if (list.length >= LAYERS_MAX) {
		showToast(`A scene holds up to ${LAYERS_MAX} layers`);
		return null;
	}
	const id = crypto.randomUUID();
	writeTable([...list, { id, name: name?.trim() || `Layer ${list.length + 1}`, color: LAYER_COLORS[list.length % LAYER_COLORS.length] }]);
	return id;
}

/** change one layer's name / colour / lock @param {string} id @param {{name?: string, color?: string, locked?: boolean}} patch */
export function updateLayer(id, patch) {
	const list = sceneLayers();
	return writeTable(
		list.map((l) => {
			if (l.id !== id) return l;
			const next = { ...l, ...patch };
			if (patch.locked === false) delete next.locked;
			return next;
		})
	);
}

/** remove a layer: its objects go back to no layer (one undo for both) @param {string} id */
export function removeLayer(id) {
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		withWireBatch(() => {
			setObjectsLayer(membersOf(id), null);
			writeTable(sceneLayers().filter((l) => l.id !== id));
		});
	} finally {
		if (own) endHistoryBatch('Remove layer');
	}
}

/** every object on a layer (any depth) @param {string} id @returns {string[]} */
export function membersOf(id) {
	const group = /** @type {any} */ (get(objectsGroup));
	/** @type {string[]} */
	const out = [];
	group?.traverse((/** @type {any} */ o) => {
		if (o !== group && o.userData?.layer === id) out.push(o.uuid);
	});
	return out;
}

/**
 * Put objects on a layer (null = no layer): one props entry each inside ONE batch, one envelope.
 * @param {string[]} uuids @param {string | null} id @returns {number} how many changed
 */
export function setObjectsLayer(uuids, id) {
	const objects = uuids.map(objectOf).filter((o) => o && canEditObject(o) && (o.userData.layer ?? null) !== (id ?? null));
	if (!objects.length) return 0;
	const own = !historyBatchOpen() && objects.length > 1;
	if (own) beginHistoryBatch();
	/** @type {any} */
	const peer = get(peers);
	try {
		withWireBatch(() => {
			for (const o of objects) {
				const before = o.userData.layer ?? null;
				if (id) o.userData.layer = id;
				else delete o.userData.layer;
				recordEntry({ kind: 'props', uuid: o.uuid, before: { layer: before }, after: { layer: id ?? null } });
				peer?.send?.({ type: 'objectParameters', parameter: 'layer', uuid: o.uuid, layer: id ?? null });
			}
		});
	} finally {
		if (own) endHistoryBatch('Set layer');
	}
	pokeScene();
	return objects.length;
}

/** select every object on a layer @param {string} id */
export function selectLayer(id) {
	const list = membersOf(id);
	applySelectionSet(list, true);
	return list.length;
}

/** hide / show a layer on THIS screen (lazy runtime) @param {string} id @param {boolean} hide */
export async function setLayerHidden(id, hide) {
	const m = await import('./layersRuntime.js');
	m.setLayerHidden(id, hide);
}

// ---- select similar --------------------------------------------------------------------------------

/** the plain descriptor tidyCore matches on @param {any} o */
export function describeForSimilar(o) {
	// 102-int-2: a decal / splat carrier's mesh is an invisible proxy: match it as what it shows
	const kind = carrierKindOf(o);
	if (kind) {
		const id = kind === 'decal' ? o.userData.decal.image || 'none' : o.userData.splat.hash || 'none';
		return { gtype: kind, geomType: null, verts: 0, materialId: kind + ':' + id, matType: null, color: null, mapped: false, prefab: linkOf(o)?.id ?? null, tags: Array.isArray(o?.userData?.tags) ? o.userData.tags : null, layer: o?.userData?.layer ?? null };
	}
	let mesh = o?.isMesh ? o : null;
	if (!mesh) o?.traverse?.((/** @type {any} */ n) => (mesh ??= n.isMesh ? n : null));
	const material = mesh && !Array.isArray(mesh.material) ? mesh.material : null;
	return {
		gtype: o?.userData?.geometryParams?.gtype ?? null,
		geomType: mesh?.geometry?.type ?? null,
		verts: mesh?.geometry?.attributes?.position?.count ?? 0,
		materialId: mesh ? materialIdOf(mesh) : null,
		matType: material?.type ?? null,
		color: material?.color?.getHexString?.() ?? null,
		mapped: !!material?.map,
		prefab: linkOf(o)?.id ?? null,
		tags: Array.isArray(o?.userData?.tags) ? o.userData.tags : null,
		layer: o?.userData?.layer ?? null
	};
}

/**
 * Select every top-level object like `uuid` by one rule (shape / material / prefab / tag / layer).
 * @param {string} by @param {string} [uuid] defaults to the last picked object @returns {number}
 */
export function selectSimilar(by, uuid) {
	const sel = /** @type {string[]} */ (get(selectedObjects));
	const from = objectOf(uuid ?? sel[sel.length - 1]);
	if (!from) {
		showToast('Select an object first');
		return 0;
	}
	const key = similarKey(describeForSimilar(from), by);
	if (key == null) {
		showToast(`This object has no ${by} to match`);
		return 0;
	}
	const group = /** @type {any} */ (get(objectsGroup));
	const list = group.children.filter((/** @type {any} */ o) => o === from || matchesSimilar(describeForSimilar(o), by, key)).map((/** @type {any} */ o) => o.uuid);
	// the object we matched FROM stays the primary (last)
	applySelectionSet([...list.filter((/** @type {string} */ u) => u !== from.uuid), from.uuid], true);
	showToast(`${list.length} object${list.length === 1 ? '' : 's'} with the same ${by}`);
	return list.length;
}

// ---- rename many -----------------------------------------------------------------------------------

/** rename a set by pattern ({n} counter, {name} old name) in selection order, ONE undo
 * @param {string[]} uuids @param {string} pattern @param {number} [start] @param {number} [pad] */
export function renameMany(uuids, pattern, start = 1, pad = 0) {
	const objects = uuids.map(objectOf).filter((o) => o && canEditObject(o));
	if (!objects.length) return 0;
	const names = renamePlan(
		objects.map((o) => o.name || o.type),
		pattern,
		start,
		pad
	);
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		withWireBatch(() => objects.forEach((o, i) => renameObject(o.uuid, names[i])));
	} finally {
		if (own) endHistoryBatch('Rename');
	}
	showToast(`Renamed ${objects.length} object${objects.length === 1 ? '' : 's'} (one undo)`);
	return objects.length;
}

// ---- randomise -------------------------------------------------------------------------------------

/**
 * Randomise turn / size / place within ranges (degrees, factors, metres), ONE undo and ONE envelope.
 * @param {string[]} uuids @param {{rot?: number[], scale?: number[], offset?: number[], seed?: number}} opts
 */
export function randomise(uuids, opts) {
	const objects = uuids.map(objectOf).filter((o) => o && canEditObject(o));
	if (!objects.length) return 0;
	const before = objects.map((o) => ({ pos: o.position.toArray(), rot: o.rotation.toArray().slice(0, 3), scale: o.scale.toArray() }));
	const after = randomisePlan(before, opts);
	/** @type {{uuid: string, before: any, after: any}[]} */
	const items = [];
	objects.forEach((o, i) => {
		const a = after[i];
		if (JSON.stringify(a) === JSON.stringify(before[i])) return;
		o.position.fromArray(a.pos);
		o.rotation.set(a.rot[0], a.rot[1], a.rot[2]);
		o.scale.fromArray(a.scale);
		o.updateMatrixWorld(true);
		items.push({ uuid: o.uuid, before: { pos: before[i].pos, rot: [...before[i].rot, 'XYZ'], scale: before[i].scale }, after: { pos: a.pos, rot: o.rotation.toArray(), scale: a.scale } });
	});
	if (!items.length) {
		showToast('Randomise: set a range first');
		return 0;
	}
	recordTransformSet(items);
	/** @type {any} */
	const peer = get(peers);
	if (peer) withWireBatch(() => items.forEach((it) => peer.send({ type: 'move', uuid: it.uuid, pos: it.after.pos, rot: it.after.rot, scale: it.after.scale })));
	pokeScene();
	showToast(`Randomised ${items.length} object${items.length === 1 ? '' : 's'} (one undo)`);
	return items.length;
}
