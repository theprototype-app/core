import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from './history';
import { GEOMETRY_PARAMS, geometrySpec } from './geometryParams';

// Live geometry parameter editing (phase 78). Params live in
// object.userData.geometryParams = { gtype, params } — userData survives the
// GLTF sync round-trip (extras), so peers and late joiners keep an editable
// Geometry section. Edits rebuild locally, replicate via a `geometry` message
// (registry is code-identical on every peer) and record one undo entry.

/** Build a fresh geometry from registry params @param {string} gtype @param {any} params */
export function buildGeometry(gtype, params) {
	const spec = geometrySpec(gtype);
	if (!spec) return null;
	const args = spec.order.map((key) =>
		key === 'points' || key === 'path' ? undefined : params[key]
	);
	try {
		return new (/** @type {any} */ (THREE))[gtype + 'Geometry'](...args);
	} catch (error) {
		console.log('buildGeometry failed', gtype, error);
		return null;
	}
}

/** Current editable params for a mesh (userData first, live geometry second)
 * @param {any} object */
export function geometryParamsOf(object) {
	if (object?.userData?.geometryParams?.gtype) return object.userData.geometryParams;
	const gtype = object?.geometry?.type?.replace('Geometry', '');
	const spec = gtype && geometrySpec(gtype);
	if (!spec || !object.geometry.parameters) return null;
	/** @type {any} */
	const params = {};
	for (const p of spec.params)
		params[p.key] = object.geometry.parameters[p.key] ?? p.def;
	return { gtype, params };
}

/** Stamp fresh creations so the params survive sync @param {any} object */
export function stampGeometryParams(object) {
	const current = geometryParamsOf(object);
	if (current) object.userData.geometryParams = current;
}

/**
 * Apply a param patch: rebuild, stamp, replicate, record.
 * @param {string} uuid @param {any} patch
 * @param {{replicate?: boolean, record?: boolean}=} options
 */
export function applyGeometry(uuid, patch, options = {}) {
	const { replicate = true, record = true } = options;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object?.geometry) return false;
	const current = geometryParamsOf(object);
	if (!current) return false;
	const before = { gtype: current.gtype, params: { ...current.params } };
	const params = { ...current.params, ...patch };
	const fresh = buildGeometry(current.gtype, params);
	if (!fresh) return false;
	object.geometry.dispose();
	object.geometry = fresh;
	object.userData.geometryParams = { gtype: current.gtype, params };
	// a rebuild discards any recorded vertex edits — the flag resets
	delete object.userData.vertexEdited;
	objectsGroup.update((value) => value);
	if (record)
		recordEntry({ kind: 'geometry', uuid, before, after: { gtype: current.gtype, params } });
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'geometry', uuid, gtype: current.gtype, params });
	}
	return true;
}

/** Receive-side applier @param {any} data */
export function applyRemoteGeometry(data) {
	if (!data?.uuid || !data?.gtype) return;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', data.uuid);
	if (!object?.geometry) return;
	const fresh = buildGeometry(data.gtype, data.params ?? {});
	if (!fresh) return;
	object.geometry.dispose();
	object.geometry = fresh;
	object.userData.geometryParams = { gtype: data.gtype, params: { ...data.params } };
	delete object.userData.vertexEdited;
	objectsGroup.update((value) => value);
}

// undo/redo replays the full param set — `state` is the recorded
// {gtype, params} side (history passes entry.before/.after by value)
registerHistoryKind('geometry', (entry, state) => {
	return applyGeometry(entry.uuid, state.params, { record: false, replicate: true });
});

export { GEOMETRY_PARAMS };
