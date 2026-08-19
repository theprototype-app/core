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
	// 21-C1: a spec may BUILD itself. Without this, buildGeometry can only make a
	// geometry three has a constructor for, so a custom one (Terrain) could not be
	// parametric at all — its params had nothing to rebuild them with.
	if (spec.build) {
		try {
			return spec.build(params);
		} catch (error) {
			console.log('buildGeometry (custom) failed', gtype, error);
			return null;
		}
	}
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

/** Defaults-plus-measurements for an UNSTAMPED terrain. A flat terrain grid is
 * indexed with (segments + 1)² vertices and spans `size` in X and Z, so both are
 * readable off the mesh; anything that does not match that shape (a sculpted or
 * re-imported mesh) keeps the registry defaults, and its rows are locked by the
 * meshgeo stamp anyway. @param {any} object */
function terrainParamsOf(object) {
	const spec = geometrySpec('Terrain');
	/** @type {any} */
	const params = {};
	for (const p of spec?.params ?? []) params[p.key] = p.def;
	const position = object?.geometry?.attributes?.position;
	if (position && object.geometry.index) {
		const side = Math.round(Math.sqrt(position.count)) - 1;
		if (side >= 2 && side <= 48 && (side + 1) * (side + 1) === position.count) {
			params.segments = side;
			object.geometry.computeBoundingBox();
			const box = object.geometry.boundingBox;
			const width = box ? box.max.x - box.min.x : 0;
			if (width > 0) params.size = width;
		}
	}
	return { gtype: 'Terrain', params };
}

/** Current editable params for a mesh (userData first, live geometry second)
 * @param {any} object */
export function geometryParamsOf(object) {
	if (object?.userData?.geometryParams?.gtype) return object.userData.geometryParams;
	// 21-C1: userData.terrain is a creation-time marker (the userData.colliderHint
	// precedent), and it must be read BEFORE the geometry.type fallback below —
	// otherwise a terrain resolves to whatever three type its baked geometry
	// reports and the Inspector offers the wrong primitive's rows. Params are
	// derived from the mesh so a terrain built before this existed (or by an older
	// peer, which stamped nothing) resolves to what it IS rather than to defaults.
	if (object?.userData?.terrain) return terrainParamsOf(object);
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
	// a rebuild discards any recorded vertex edits — the flag resets. faceEdited
	// (which every meshgeo commit stamps, so every sculpt stroke too) goes with
	// it: it is the same lock, and leaving it set means the parametric rows stay
	// disabled after a rebuild that just threw those edits away.
	delete object.userData.vertexEdited;
	delete object.userData.faceEdited;
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
	delete object.userData.faceEdited; // same lock, same reset as the local path
	objectsGroup.update((value) => value);
}

// undo/redo replays the full param set — `state` is the recorded
// {gtype, params} side (history passes entry.before/.after by value)
registerHistoryKind('geometry', (entry, state) => {
	return applyGeometry(entry.uuid, state.params, { record: false, replicate: true });
});

export { GEOMETRY_PARAMS };
