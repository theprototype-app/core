import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from './history';
import { GEOMETRY_PARAMS, geometrySpec, boundGeometryParams } from './geometryParams';
import { matchRoundedBox, bakedRoundedBox } from './roundedBox.js';

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

/** 37 R3: a spec with a `clean` hook stores only what its builder reads (clamped, known keys)
 * @param {string} gtype @param {any} params */
function cleanFor(gtype, params) {
	const clean = geometrySpec(gtype)?.clean;
	return clean ? clean(params) : boundGeometryParams(gtype, params);
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
	for (const p of spec.params) {
		// 102b: an optional row the geometry does not carry stays out (a square box keeps its six params)
		if (p.optional && object.geometry.parameters[p.key] === undefined) continue;
		params[p.key] = object.geometry.parameters[p.key] ?? p.def;
	}
	return { gtype, params };
}

/** Stamp fresh creations so the params survive sync @param {any} object */
export function stampGeometryParams(object) {
	const current = geometryParamsOf(object);
	if (current) object.userData.geometryParams = current;
}

/** a registry type's default params @param {string} gtype */
export function defaultGeometryParams(gtype) {
	/** @type {any} */
	const params = {};
	for (const p of geometrySpec(gtype)?.params ?? []) if (!p.optional) params[p.key] = p.def;
	return params;
}

/**
 * Apply a param patch: rebuild, stamp, replicate, record.
 * 85 G1: `gtype` changes the primitive's TYPE in place (box → cylinder): the patch then lands
 * on the new type's defaults, and the object keeps its uuid, transform, material and flows.
 * The same `geometry` message and history kind carry it (both already hold the gtype).
 * @param {string} uuid @param {any} patch
 * @param {{replicate?: boolean, record?: boolean, gtype?: string}=} options
 */
export function applyGeometry(uuid, patch, options = {}) {
	const { replicate = true, record = true } = options;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object?.geometry) return false;
	const current = geometryParamsOf(object);
	if (!current) return false;
	const gtype = options.gtype && geometrySpec(options.gtype) ? options.gtype : current.gtype;
	const before = { gtype: current.gtype, params: { ...current.params } };
	const base = gtype === current.gtype ? current.params : defaultGeometryParams(gtype);
	const params = cleanFor(gtype, { ...base, ...patch });
	const fresh = buildGeometry(gtype, params);
	if (!fresh) return false;
	object.geometry.dispose();
	object.geometry = fresh;
	object.userData.geometryParams = { gtype, params };
	// a rebuild discards any recorded vertex edits — the flag resets. faceEdited
	// (which every meshgeo commit stamps, so every sculpt stroke too) goes with
	// it: it is the same lock, and leaving it set means the parametric rows stay
	// disabled after a rebuild that just threw those edits away.
	delete object.userData.vertexEdited;
	delete object.userData.faceEdited;
	pokeScene();
	if (record)
		recordEntry({ kind: 'geometry', uuid, before, after: { gtype, params } });
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'geometry', uuid, gtype, params });
	}
	return true;
}

/** Receive-side applier @param {any} data */
export function applyRemoteGeometry(data) {
	if (!data?.uuid || !data?.gtype) return;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', data.uuid);
	if (!object?.geometry) return;
	// 102b: an undone Convert goes back to the BAKED mesh (`baked` is additive: an older peer builds the box)
	if (data.baked) {
		unconvertLocal(object, data.params);
		return;
	}
	// 85 G2/G4: a profile / outline rides `params` — the builder gets the cleaned set, never the raw wire
	const fresh = buildGeometry(data.gtype, cleanFor(data.gtype, { ...data.params }));
	if (!fresh) return;
	object.geometry.dispose();
	object.geometry = fresh;
	object.userData.geometryParams = { gtype: data.gtype, params: cleanFor(data.gtype, { ...data.params }) };
	delete object.userData.vertexEdited;
	delete object.userData.faceEdited; // same lock, same reset as the local path
	pokeScene();
}

/**
 * 102b-papercuts: is this baked mesh a rounded box the Inspector can OFFER to convert? The params, or null.
 * Cached per geometry (the check rebuilds one box to compare). Never converts anything.
 * @type {WeakMap<object, any>} */
const matchCache = new WeakMap();
/** @param {any} object */
export function roundedBoxOffer(object) {
	const g = object?.geometry;
	if (!object?.isMesh || !g || object.userData?.geometryParams || object.userData?.terrain || Array.isArray(object.material)) return null;
	if (g.type !== 'BufferGeometry') return null;
	if (!matchCache.has(g)) matchCache.set(g, matchRoundedBox(g));
	return matchCache.get(g);
}

/**
 * Turn a baked rounded box into a Box with a corner radius: same vertices, now two numbers in the file.
 * One undo step (undo puts the baked mesh back), replicated as the ordinary `geometry` message.
 * @param {string} uuid @param {{replicate?: boolean, record?: boolean}} [options] @returns {boolean}
 */
export function convertToRoundedBox(uuid, options = {}) {
	const { replicate = true, record = true } = options;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const params = roundedBoxOffer(object);
	if (!params) return false;
	const full = cleanFor('Box', { ...defaultGeometryParams('Box'), ...params });
	const fresh = buildGeometry('Box', full);
	if (!fresh) return false;
	const g = /** @type {any} */ (object).geometry;
	// what the mesh carried that a rebuild would not (material groups are refused above; keep its userData)
	fresh.userData = { ...(g.userData ?? {}) };
	g.dispose();
	/** @type {any} */ (object).geometry = fresh;
	/** @type {any} */ (object).userData.geometryParams = { gtype: 'Box', params: full };
	pokeScene();
	if (record) recordEntry({ kind: 'roundconvert', uuid, params: full, before: { baked: true }, after: { baked: false } });
	if (replicate) /** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid, gtype: 'Box', params: full });
	return true;
}

/** back to the baked mesh (undo of a Convert, here or from a peer) @param {any} object @param {any} params */
function unconvertLocal(object, params) {
	const baked = bakedRoundedBox(cleanFor('Box', { ...params }));
	if (!baked) return;
	object.geometry.dispose();
	object.geometry = baked;
	delete object.userData.geometryParams;
	pokeScene();
}

registerHistoryKind('roundconvert', (entry, state) => {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
	if (!object) return false;
	if (!state?.baked) {
		const params = entry.params;
		const fresh = buildGeometry('Box', params);
		if (!fresh) return false;
		/** @type {any} */ (object).geometry.dispose();
		/** @type {any} */ (object).geometry = fresh;
		/** @type {any} */ (object).userData.geometryParams = { gtype: 'Box', params };
		pokeScene();
		/** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid: entry.uuid, gtype: 'Box', params });
		return true;
	}
	unconvertLocal(object, entry.params);
	/** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid: entry.uuid, gtype: 'Box', params: entry.params, baked: true });
	return true;
});

// undo/redo replays the full param set — `state` is the recorded
// {gtype, params} side (history passes entry.before/.after by value)
registerHistoryKind('geometry', (entry, state) => {
	// 85 G1: the recorded side's TYPE too — undoing a box → cylinder brings the box back
	return applyGeometry(entry.uuid, state.params, { record: false, replicate: true, gtype: state.gtype });
});

export { GEOMETRY_PARAMS };
