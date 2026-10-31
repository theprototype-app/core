// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen, recordEntry, recordObjectPresence } from './history';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { applyTerrainScatter, scatterPrimitiveSpec } from './terrainSurface';
import { buildHeightGrid, sampleHeight, SCATTER_PRIMITIVES } from './terrainScatterCore';
import { readScatter, blockOf, newSet, sourceKey, totalOf, MAX_INSTANCES, MAX_SETS } from './scatterEditAdapter';
import { deleteSelected, yawOfQuaternion, commonSource, CONVERT_CONFIRM_ABOVE } from './scatterEditCore';
import { selectedInstanceGroups, clearScatterSelection } from './scatterEdit';
import { showConfirm } from './confirmDialog';

// 51 E5 — CONVERT BOTH WAYS.
//
// INSTANCES -> OBJECTS: each picked instance (the Select tool's selection, or a whole set)
// becomes a real object at exactly the pose it was drawn with — same base on the ground, same
// turn, same tilt when the set aligns to slope, same size. The way every object is made is
// one the session already replicates. A source peers receive AT ONCE gets ONE template (a
// `/create` of the primitive, or — a prefab's look that remembers its prefab — `instantiatePrefab`,
// which brings the prefab WITH its logic), then `duplicateObject` per instance (the small
// `duplicate` message + a `move`), then the template goes. A Library model or a pack item
// reaches peers LATE (an import's meshes follow its root on a timer; a pack stub refills from
// the pack), so a duplicate could beat the template there: each of those objects is placed on
// its own (an import of the file, or a pack stub — the Explorer's own placements). The instances
// leave the set. All of it is ONE history batch, so one undo puts the instances back and takes
// the objects away on every peer. More than CONVERT_CONFIRM_ABOVE asks first.
//
// COPIES -> A SCATTER SET: several copies of ONE object (a primitive type, or one Library
// model) standing on a terrain become instances of that terrain's set for that source (made
// if absent), each at its object's ground position, turn and size; the objects are deleted.
// ONE batch again. Each copy becomes a painted record of that set (scatterEditAdapter.blockOf).

const UP = new THREE.Vector3(0, 1, 0);

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {any} message */
function send(message) {
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.(message);
}

/** Commit a terrain's scatter inside the open batch. @param {string} uuid @param {any} before @param {any[]} sets @param {any} bounds */
function commitScatter(uuid, before, sets, bounds) {
	applyTerrainScatter(uuid, blockOf(sets, bounds));
	const after = objectOf(uuid)?.userData?.terrainScatter ?? null;
	send({ type: 'objectParameters', parameter: 'terrainScatter', uuid, terrainScatter: after });
	recordEntry({ kind: 'terrainScatter', uuid, before: { block: before }, after: { block: after ? JSON.parse(JSON.stringify(after)) : null } });
}

/** The world matrix an instance is drawn with (terrainSurface.instanceMatrices, in world).
 * @param {any} terrain @param {any} grid @param {{x: number, z: number, yaw: number, scale: number}} inst @param {boolean} align */
function instanceWorldMatrix(terrain, grid, inst, align) {
	const h = grid ? sampleHeight(grid, inst.x, inst.z) : { y: 0, nx: 0, ny: 1, nz: 0 };
	const qy = new THREE.Quaternion().setFromAxisAngle(UP, inst.yaw);
	const q = align ? new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(h.nx, h.ny, h.nz)).multiply(qy) : qy;
	const local = new THREE.Matrix4().compose(new THREE.Vector3(inst.x, h.y, inst.z), q, new THREE.Vector3(inst.scale, inst.scale, inst.scale));
	terrain.updateWorldMatrix(true, false);
	return new THREE.Matrix4().multiplyMatrices(terrain.matrixWorld, local);
}

/** Pose an object (a child of objectsGroup) so it shows at `world` and tell peers.
 * @param {any} object @param {any} world */
function poseAt(object, world) {
	const parent = object.parent ?? get(objectsGroup);
	parent.updateWorldMatrix(true, false);
	const local = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(world);
	local.decompose(object.position, object.quaternion, object.scale);
	object.updateMatrix();
	send({ type: 'move', uuid: object.uuid, pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() });
}

/** Make the ONE template object for a source that peers receive AT ONCE (a primitive's `/create`, a prefab's
 * `object` message). Resolves {uuid, offset} (offset = where the
 * object's own transform relative to the instance base, a matrix in the instance's frame), or null.
 * @param {any} source */
async function makeTemplate(source) {
	const commands = await import('./commandsHandler.svelte');
	const group = /** @type {any} */ (get(objectsGroup));
	const before = new Set((group?.children ?? []).map((/** @type {any} */ c) => c.uuid));
	const fresh = () => (get(objectsGroup)?.children ?? []).find((/** @type {any} */ c) => !before.has(c.uuid)) ?? null;
	if (source.kind === 'primitive') {
		const spec = scatterPrimitiveSpec(source.type);
		commands.sceneCommand(spec.command);
		const object = fresh();
		if (!object) return null;
		const materials = await import('./materialsHandler');
		materials.setObjectColor(object.uuid, spec.color);
		materials.setMaterialParam(object.uuid, 'roughness', spec.roughness);
		return { uuid: object.uuid, offset: new THREE.Matrix4().makeTranslation(0, spec.offset, 0) };
	}
	if (source.kind === 'library' && source.prefab) {
		// a logic prefab scatters its LOOK only (51-sources); a real object is the FULL prefab with
		// its logic (the user's rule) — when this machine's prefab library still holds it (else `placer`)
		const { prefabById, instantiatePrefab } = await import('./prefabs');
		const prefab = prefabById(source.prefab);
		const object = prefab ? instantiatePrefab(prefab) : null;
		if (object) return { uuid: object.uuid, offset: lookOffset(object) };
	}
	return null;
}

/** Does this source reach peers late (bytes or a pack refill), so it cannot be a `duplicate` template?
 * A prefab look whose prefab is here is made from the prefab (an `object` message, applied at once).
 * @param {any} source */
async function reachesPeersLate(source) {
	if (source.kind === 'pack') return true;
	if (source.kind !== 'library') return false;
	if (!source.prefab) return true;
	const { prefabById } = await import('./prefabs');
	return !prefabById(source.prefab);
}

/** A function that places ONE object of `source` at a world matrix (its base there) and resolves its uuid —
 * a pack item as a pack STUB (tiny on the wire, every peer refills it from the pack, the Explorer's own
 * placement), a Library model as an import of its file. Null when the model cannot be had.
 * @param {any} source @returns {Promise<((world: any) => Promise<string | null>) | null>} */
async function placer(source) {
	const { addImported, importFile } = await import('./fileHandler.svelte');
	if (source.kind === 'pack') {
		const refs = await import('./packRefs');
		const url = refs.packRefUrl(source);
		const name = source.item || String(source.path.split('/').pop() ?? 'model').replace(/\.\w+$/, '');
		const ref = refs.packRefFromUrl(url, { pack: source.pack, item: name });
		if (!ref) return null;
		void import('./packCache').then((m) => m.fetchPackBuffer(url)).catch(() => {});
		return async (world) => {
			const stub = new THREE.Group();
			stub.userData = { packRef: { ...ref }, packStub: true };
			localPose(stub, world);
			addImported(stub, name, stub.position.toArray());
			poseAt(stub, world); // the `move` carries the turn and size whatever the stub element keeps
			return stub.uuid;
		};
	}
	const explorer = await import('./explorer');
	const item = explorer.itemByHash(source.hash);
	const blob = item ? await explorer.itemBlob(item.id) : null;
	if (!item || !blob) return null;
	const name = String(item.name).replace(/\.\w+$/, '');
	return async (world) => {
		const at = new THREE.Object3D();
		localPose(at, world);
		const uuid = await importFile(new File([blob], item.name), name, undefined, at.position.toArray(), undefined, { noOptimize: true, quaternion: at.quaternion.toArray() });
		const object = uuid ? objectOf(uuid) : null;
		if (object) poseAt(object, world);
		return uuid ?? null;
	};
}

/** Set an object's local transform (a child of objectsGroup) so it shows at `world`, no message. @param {any} object @param {any} world */
function localPose(object, world) {
	const parent = /** @type {any} */ (get(objectsGroup));
	parent.updateWorldMatrix(true, false);
	new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(world).decompose(object.position, object.quaternion, object.scale);
}

/** Where an object sits relative to the base of its LOOK, as a matrix in the instance's frame:
 * scatterSources.lookSource stands the look centred on x/z with its lowest point at y 0, unturned,
 * with the root's own scale baked in — so the real object is that offset, then its own scale.
 * @param {any} object */
function lookOffset(object) {
	const saved = { p: object.position.clone(), q: object.quaternion.clone() };
	object.position.set(0, 0, 0);
	object.quaternion.identity();
	object.updateMatrixWorld(true);
	const box = new THREE.Box3();
	object.traverse((/** @type {any} */ n) => {
		if (n.isMesh) box.expandByObject(n);
	});
	object.position.copy(saved.p);
	object.quaternion.copy(saved.q);
	object.updateMatrixWorld(true);
	const at = box.isEmpty() ? new THREE.Vector3() : new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
	return new THREE.Matrix4().compose(at, new THREE.Quaternion(), object.scale.clone());
}

/**
 * Instances → real objects. `scope` 'selection' = the Select tool's picks; 'set' = every
 * instance of `setId` on terrain `uuid`. Resolves the new objects' uuids ([] when nothing
 * was made or the person cancelled).
 * @param {{scope: 'selection'} | {scope: 'set', uuid: string, setId: string}} what
 * @param {{confirm?: boolean}} [opts] confirm:false skips the large-count ask (a suite)
 */
export async function instancesToObjects(what, opts = {}) {
	/** @type {{uuid: string, data: any, items: {set: any, ids: Set<number>}[]} | null} */
	let picked = null;
	if (what.scope === 'selection') picked = selectedInstanceGroups();
	else {
		const terrain = objectOf(what.uuid);
		const data = terrain ? readScatter(terrain) : null;
		const set = data?.sets.find((s) => s.id === what.setId);
		if (data && set) picked = { uuid: what.uuid, data, items: [{ set, ids: new Set(set.list.map((/** @type {any} */ _, /** @type {number} */ i) => i)) }] };
	}
	const terrain = picked ? objectOf(picked.uuid) : null;
	if (!picked || !terrain || !picked.items.length) {
		showToast('Select scattered instances first (Scatter ▸ Select)');
		return [];
	}
	if (!canEditObject(terrain)) {
		warnViewerReadOnly();
		return [];
	}
	const count = picked.items.reduce((n, p) => n + p.ids.size, 0);
	if (count > CONVERT_CONFIRM_ABOVE && opts.confirm !== false) {
		const ok = await showConfirm({
			title: 'Make ' + count + ' objects?',
			message:
				count +
				' instances become ' +
				count +
				' separate objects. Every one is synced, saved and drawn on its own — a scatter draws them together. One undo turns them back.',
			confirmLabel: 'Make ' + count + ' objects'
		});
		if (!ok) return [];
	}
	const terrainUuid = picked.uuid;
	const before = terrain.userData.terrainScatter ? JSON.parse(JSON.stringify(terrain.userData.terrainScatter)) : null;
	const grid = buildHeightGrid(terrain.geometry.attributes.position.array);
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	/** @type {string[]} */
	const made = [];
	try {
		const { duplicateObject, deleteObjectsByUuid } = await import('./objectActions');
		for (const { set, ids } of picked.items) {
			// 51-union: a MIXED set (51-sources) makes each instance from the model it drew
			/** @type {Map<number, number[]>} */
			const bySource = new Map();
			for (const i of ids) {
				const src = set.list[i]?.src ?? 0;
				bySource.set(src, [...(bySource.get(src) ?? []), i]);
			}
			for (const [src, list] of bySource) {
				const source = set.sources?.[src]?.source ?? set.source;
				// the set's sink pushes each instance down its own up axis (terrainSurface.instanceMatrices)
				const sink = new THREE.Matrix4().makeTranslation(0, -(set.sink ?? 0), 0);
				if (await reachesPeersLate(source)) {
					// 51-int: a Library model or a pack item reaches peers LATE (an import's meshes follow its root
					// after a timer; a pack stub refills from the pack), so a `duplicate` of a template could reach a
					// peer before the template has anything to copy — each object is placed on its own instead
					const one = await placer(source);
					if (!one) {
						showToast('Could not make ' + (source.name || source.item || 'the model') + (source.kind === 'pack' ? ' — its pack could not be reached' : ' — it is not in your Library'));
						continue;
					}
					for (const i of list) {
						const inst = set.list[i];
						if (!inst) continue;
						const uuid = await one(instanceWorldMatrix(terrain, grid, inst, set.align).multiply(sink));
						if (uuid) made.push(uuid);
					}
					continue;
				}
				const template = await makeTemplate(source);
				if (!template) {
					showToast('Could not make ' + (source.name || source.type || source.item || 'the model') + (source.kind === 'pack' ? ' — its pack could not be reached' : ' — it is not in your Library'));
					continue;
				}
				const lift = sink.multiply(template.offset);
				for (const i of list) {
					const inst = set.list[i];
					if (!inst) continue;
					// the copy's name rides the `duplicate` message (renaming it afterwards stayed on this peer)
					const clone = duplicateObject(template.uuid, { select: false, history: false, carryCables: false, name: objectOf(template.uuid)?.name });
					if (!clone) continue;
					poseAt(clone, instanceWorldMatrix(terrain, grid, inst, set.align).multiply(lift));
					recordObjectPresence('create', clone);
					made.push(clone.uuid);
				}
				deleteObjectsByUuid([template.uuid]);
			}
		}
		// the converted instances leave their sets
		const sets = picked.data.sets.map((/** @type {any} */ set) => {
			const p = picked?.items.find((x) => x.set.id === set.id);
			return p ? { ...set, list: deleteSelected(set.list, p.ids).list } : set;
		});
		clearScatterSelection();
		commitScatter(terrainUuid, before, sets, picked.data.bounds);
	} finally {
		if (own) endHistoryBatch('Instances to objects');
	}
	if (made.length) {
		const { exitSculpt } = await import('./terrainSculpt');
		exitSculpt();
		const { applySelectionSet } = await import('./objectActions');
		applySelectionSet(made);
		showToast(made.length === 1 ? 'Made 1 object' : 'Made ' + made.length + ' objects');
	}
	return made;
}

// ---- copies -> a scatter set --------------------------------------------------------------

const GEOMETRY_TYPE = /** @type {Record<string, string>} */ ({
	BoxGeometry: 'Box',
	SphereGeometry: 'Sphere',
	ConeGeometry: 'Cone',
	CylinderGeometry: 'Cylinder',
	CapsuleGeometry: 'Capsule',
	DodecahedronGeometry: 'Dodecahedron'
});

/** A Library model by the object's name (an import is named after its file; a duplicate
 * adds " copy"). @param {any} object @param {any[]} items */
function libraryItemOf(object, items) {
	const base = String(object.name ?? '').replace(/( copy)+$/, '');
	const hits = items.filter((it) => it?.kind === 'object' && it.hash && String(it.name).replace(/\.\w+$/, '') === base);
	return hits.length === 1 ? hits[0] : null;
}

/** The scatter source an object would be, or null. @param {any} object @param {any[]} items */
export function sourceOfObject(object, items) {
	if (!object || object.userData?.terrain) return null;
	if (object.isMesh && !Array.isArray(object.material)) {
		const type = object.userData?.geometryParams?.gtype ?? GEOMETRY_TYPE[object.geometry?.type] ?? '';
		if (SCATTER_PRIMITIVES.includes(type)) return { kind: 'primitive', type };
	}
	const item = libraryItemOf(object, items);
	return item ? { kind: 'library', hash: item.hash, name: item.name } : null;
}

/** The terrain the objects stand on: one in the list, else the one whose ground holds their
 * centre. @param {any[]} objects */
function terrainUnder(objects) {
	const group = /** @type {any} */ (get(objectsGroup));
	const centre = new THREE.Vector3();
	for (const o of objects) centre.add(o.getWorldPosition(new THREE.Vector3()));
	centre.divideScalar(Math.max(1, objects.length));
	/** @type {any} */
	let found = null;
	group?.traverse((/** @type {any} */ t) => {
		if (found || !t.userData?.terrain || !t.geometry) return;
		const data = readScatter(t);
		if (!data) return;
		const p = t.worldToLocal(centre.clone());
		const b = data.bounds;
		if (p.x >= b.minX && p.x <= b.minX + b.sizeX && p.z >= b.minZ && p.z <= b.minZ + b.sizeZ) found = t;
	});
	return found;
}

/** Can these objects become scatter? (the menu row asks; a reason when not)
 * @param {string[]} uuids @param {any[]} items explorer items */
export function scatterableSelection(uuids, items) {
	const all = uuids.map(objectOf).filter(Boolean);
	const terrains = all.filter((o) => o.userData?.terrain);
	const objects = all.filter((o) => !o.userData?.terrain);
	const verdict = commonSource(objects, (o) => {
		const s = sourceOfObject(o, items);
		return s ? sourceKey(s) : '';
	});
	if (!verdict.ok) return { ok: false, reason: verdict.reason };
	const terrain = terrains.length === 1 ? terrains[0] : terrainUnder(objects);
	if (!terrain) return { ok: false, reason: 'The copies must stand on a Terrain' };
	return { ok: true, objects, terrain, source: /** @type {any} */ (sourceOfObject(objects[0], items)) };
}

/** Copies of one object → instances of that source's set on the terrain under them.
 * Resolves the number of instances made. @param {string[]} uuids */
export async function objectsToScatter(uuids) {
	const explorer = await import('./explorer');
	const items = /** @type {any[]} */ (get(explorer.explorerItems)) ?? [];
	const v = scatterableSelection(uuids, items);
	if (!v.ok) {
		showToast(/** @type {string} */ (v.reason));
		return 0;
	}
	const { objects, terrain, source } = /** @type {any} */ (v);
	if (!canEditObject(terrain) || objects.some((/** @type {any} */ o) => !canEditObject(o))) {
		warnViewerReadOnly();
		return 0;
	}
	const data = readScatter(terrain);
	if (!data) return 0;
	const key = sourceKey(source);
	let set = data.sets.find((s) => sourceKey(s.source) === key) ?? null;
	if (!set && data.sets.length >= MAX_SETS) {
		showToast('A terrain holds up to ' + MAX_SETS + ' scatter models');
		return 0;
	}
	if (totalOf(data.sets) + objects.length > MAX_INSTANCES) {
		showToast('That would pass ' + MAX_INSTANCES + ' instances on this terrain');
		return 0;
	}
	const before = terrain.userData.terrainScatter ? JSON.parse(JSON.stringify(terrain.userData.terrainScatter)) : null;
	// a primitive's size relative to the scatter's unit primitive (an object made with
	// /create Cone defaults is twice the scatter cone's radius): measure height in local units
	const unit = source.kind === 'primitive' ? unitHeight(source.type) : 0;
	terrain.updateWorldMatrix(true, false);
	const tq = terrain.getWorldQuaternion(new THREE.Quaternion()).invert();
	const ts = terrain.getWorldScale(new THREE.Vector3());
	const list = objects.map((/** @type {any} */ o) => {
		o.updateWorldMatrix(true, false);
		const local = terrain.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
		const q = tq.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
		const ws = o.getWorldScale(new THREE.Vector3());
		let scale = (ws.x + ws.y + ws.z) / 3 / ((ts.x + ts.y + ts.z) / 3);
		if (unit && o.geometry) {
			if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
			const bb = o.geometry.boundingBox;
			scale *= (bb.max.y - bb.min.y) / unit;
		}
		return { x: local.x, z: local.z, yaw: yawOfQuaternion(q), scale };
	});
	const sets = set
		? data.sets.map((s) => (s === set ? { ...s, list: [...s.list, ...list] } : s))
		: [...data.sets, newSet(source, list)];
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		commitScatter(terrain.uuid, before, sets, data.bounds);
		const { deleteObjectsByUuid } = await import('./objectActions');
		deleteObjectsByUuid(objects.map((/** @type {any} */ o) => o.uuid));
	} finally {
		if (own) endHistoryBatch('Objects to scatter');
	}
	showToast(list.length + ' copies are now scatter on ' + (terrain.name || 'the terrain'));
	return list.length;
}

/** @param {string} type */
function unitHeight(type) {
	return 2 * scatterPrimitiveSpec(type).offset;
}
