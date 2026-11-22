// 72 LK1: Inspector ▸ Material ▸ Maps. Set a material's normal, roughness, metalness, emissive and AO maps
// plus its tiling / offset / rotation; every edit reaches every peer and undoes as one step. The textures
// themselves are in materialMapTextures.js. Its body registers a history kind, so nothing in history's
// import subtree may reach this module (the shaderSync rule).
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import {
	materialAt,
	broadcastMaterial,
	decodeTextureFile,
	setMaterialParam,
	setObjectsTexture
} from './materialsHandler';
import { recordEntry, registerHistoryKind, registerHistoryMerge, beginHistoryBatch, endHistoryBatch, historyBatchOpen, sameJson } from '$lib/history';
import { isMapSlotKey, isMapSlotImage, normalizeTexTransform, guessMapSlot, MAP_SLOTS, NORMAL_STRENGTH_MAX } from './materialParamRules.js';
import { applyMapSlotTo, applyTexTransform, applyNormalStrength, mapSlotFilled, mapSlotUrl, normalStrengthOf, texTransformOf } from './materialMapTextures.js';

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty?.('uuid', uuid) ?? null;
}

/** @param {string} uuid @param {string} key @param {string | null} url @param {number} slot */
function sendSlot(uuid, key, url, slot) {
	broadcastMaterial({ type: 'objectParameters', parameter: 'mapSlot', uuid, key, map: url, ...(slot ? { slot } : {}) });
}

registerHistoryKind('materialmaps', (entry, state) => {
	const object = objectOf(entry.uuid);
	const material = object && materialAt(object, entry.slot ?? 0);
	if (!material) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	if (entry.param === 'slot') {
		applyMapSlotTo(material, entry.key, state.value, object);
		sendSlot(entry.uuid, entry.key, state.value, entry.slot ?? 0);
	} else if (entry.param === 'transform') {
		sendTransform(entry.uuid, material, state.value, entry.slot ?? 0);
	} else if (entry.param === 'normalStrength') {
		applyNormalStrength(material, object, state.value);
		broadcastMaterial({ type: 'objectParameters', parameter: 'normalStrength', uuid: entry.uuid, value: state.value, ...(entry.slot ? { slot: entry.slot } : {}) });
	}
	pokeScene();
	return true;
});

// a scrub on a tiling or strength row is one undo step (the first before, the latest after)
registerHistoryMerge('materialmaps', {
	merge(top, next) {
		if (top.param === 'slot' || top.param !== next.param || top.uuid !== next.uuid || (top.slot ?? 0) !== (next.slot ?? 0)) return false;
		top.after = next.after;
		return true;
	},
	noop: (entry) => sameJson(entry.before, entry.after)
});

/** @param {string} uuid @param {any} material @param {any} transform @param {number} slot */
function sendTransform(uuid, material, transform, slot) {
	applyTexTransform(material, transform);
	broadcastMaterial({ type: 'objectParameters', parameter: 'texTransform', uuid, transform, ...(slot ? { slot } : {}) });
}

/**
 * A map multiplies a value, so on the wrong value it shows nothing at all: metalness 0 hides a metalness
 * map whatever it holds, and a black emissive colour hides an emissive map. Setting the map lifts the
 * value it needs, in the same undo step.
 * @param {any} object @param {string} key
 */
function liftValueFor(object, key) {
	const material = object.material;
	if (!material || Array.isArray(material)) return;
	if (key === 'metalnessMap' && material.metalness === 0) setMaterialParam(object.uuid, 'metalness', 1);
	if (key === 'roughnessMap' && material.roughness === 0) setMaterialParam(object.uuid, 'roughness', 1);
	if (key === 'emissiveMap' && material.emissive?.getHex?.() === 0) setMaterialParam(object.uuid, 'emissive', '#ffffff');
}

/** run `fn` as ONE undo step, inside a caller's open batch when there is one
 * @template T @param {string} label @param {() => Promise<T>} fn @returns {Promise<T>} */
async function asOneStep(label, fn) {
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		return await fn();
	} finally {
		if (own) endHistoryBatch(label);
	}
}

/** @param {string[]} uuids @param {string} key @param {string} url @param {number} slot @returns {number} */
function applyUrlToSlot(uuids, key, url, slot) {
	let applied = 0;
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const material = object && materialAt(object, slot);
		if (!material || !(key in material)) continue;
		const before = mapSlotUrl(material, key);
		recordEntry({ kind: 'materialmaps', uuid, param: 'slot', key, ...(slot ? { slot } : {}), before: { value: before }, after: { value: url } });
		applyMapSlotTo(material, key, url, object);
		material.userData.tpEdited = true; // 59 T1: a material changed in the app survives a Replace model
		sendSlot(uuid, key, url, slot);
		liftValueFor(object, key);
		applied++;
	}
	return applied;
}

/**
 * Set one image file as a map slot of many objects: decoded once, one undo step.
 * @param {string[]} uuids @param {string} key @param {File | Blob} file @param {number} [slot]
 * @returns {Promise<number>} how many took it
 */
export async function setObjectsMapSlot(uuids, key, file, slot = 0) {
	if (!isMapSlotKey(key)) return 0;
	const url = await decodeTextureFile(file, 0.9);
	if (!url) return 0;
	const label = MAP_SLOTS.find((entry) => entry.key === key)?.label ?? 'Map';
	const applied = await asOneStep(label + ' map', async () => applyUrlToSlot(uuids, key, url, slot));
	pokeScene();
	return applied;
}

/**
 * Clear a map slot on many objects, one undo step. A compressed (KTX2) map has no image to keep, so undo
 * cannot bring that one back.
 * @param {string[]} uuids @param {string} key @param {number} [slot]
 */
export async function removeObjectsMapSlot(uuids, key, slot = 0) {
	if (!isMapSlotKey(key)) return;
	await asOneStep('Remove map', async () => {
		for (const uuid of uuids) {
			const object = objectOf(uuid);
			const material = object && materialAt(object, slot);
			// an image still loading counts as set: the Remove has to beat it
			if (!mapSlotFilled(material, key)) continue;
			recordEntry({ kind: 'materialmaps', uuid, param: 'slot', key, ...(slot ? { slot } : {}), before: { value: mapSlotUrl(material, key) }, after: { value: null } });
			applyMapSlotTo(material, key, null, object);
			sendSlot(uuid, key, null, slot);
		}
	});
}

/**
 * Change part of a material's tiling / offset / rotation.
 * @param {string} uuid @param {{repeat?: number[], offset?: number[], rotation?: number}} patch @param {number} [slot]
 */
export function setTexTransform(uuid, patch, slot = 0) {
	const material = materialAt(objectOf(uuid), slot);
	if (!material) return false;
	const before = texTransformOf(material);
	const after = normalizeTexTransform({ ...before, ...patch });
	if (!after) return false;
	recordEntry({ kind: 'materialmaps', uuid, param: 'transform', ...(slot ? { slot } : {}), before: { value: before }, after: { value: after } });
	material.userData.tpEdited = true;
	sendTransform(uuid, material, after, slot);
	return true;
}

/** @param {string} uuid @param {number} value @param {number} [slot] */
export function setNormalStrength(uuid, value, slot = 0) {
	const object = objectOf(uuid);
	const material = materialAt(object, slot);
	if (!material?.normalScale || !Number.isFinite(value)) return false;
	const next = Math.max(0, Math.min(NORMAL_STRENGTH_MAX, value));
	recordEntry({ kind: 'materialmaps', uuid, param: 'normalStrength', ...(slot ? { slot } : {}), before: { value: normalStrengthOf(material) }, after: { value: next } });
	applyNormalStrength(material, object, next);
	material.userData.tpEdited = true;
	broadcastMaterial({ type: 'objectParameters', parameter: 'normalStrength', uuid, value: next, ...(slot ? { slot } : {}) });
	return true;
}

/**
 * A set of images in one go (a PBR export, an AI tool's output): each goes to the slot named by the map
 * given, or by its file name. One undo step for the lot.
 * @param {string[]} uuids
 * @param {{file: File | Blob, name?: string, slot?: string | null}[]} files `slot` = 'map' or a slot key
 * @returns {Promise<{placed: {name: string, slot: string}[], unknown: string[]}>}
 */
export async function setObjectsMapSet(uuids, files) {
	/** @type {{name: string, slot: string}[]} */
	const placed = [];
	/** @type {string[]} */
	const unknown = [];
	await asOneStep('Material maps', async () => {
		for (const entry of files) {
			const name = entry.name ?? /** @type {any} */ (entry.file).name ?? 'image';
			const slot = entry.slot ?? guessMapSlot(name);
			if (slot === 'map') {
				if (await setObjectsTexture(uuids, entry.file)) placed.push({ name, slot });
			} else if (slot && isMapSlotKey(slot)) {
				if (await setObjectsMapSlot(uuids, slot, entry.file)) placed.push({ name, slot });
			} else unknown.push(name);
		}
	});
	return { placed, unknown };
}

// ---- the receive side ----------------------------------------------------------------------------

/** @param {any} data an objectParameters message that wireValidate has passed */
export function receiveMapSlot(data) {
	const object = objectOf(data.uuid);
	if (!object || !isMapSlotKey(data.key) || !isMapSlotImage(data.map)) return;
	applyMapSlotTo(materialAt(object, data.slot ?? 0), data.key, data.map, object);
}

/** @param {any} data */
export function receiveTexTransform(data) {
	applyTexTransform(materialAt(objectOf(data.uuid), data.slot ?? 0), data.transform);
}

/** @param {any} data */
export function receiveNormalStrength(data) {
	const object = objectOf(data.uuid);
	applyNormalStrength(materialAt(object, data.slot ?? 0), object, Number(data.value));
}
