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
import { linkedEdit, linkedOthers } from './slotLinks.js'; // 105-slots LINK

/**
 * 105-slots LINK: the (uuid, slot) pairs a write reaches — the ones asked for, then every other holder of a linked
 * slot among them (once each). An unlinked selection is exactly `uuids` at `slot`.
 * @param {string[]} uuids @param {number} slot @returns {[string, number][]}
 */
function withLinked(uuids, slot) {
	/** @type {[string, number][]} */
	const out = uuids.map((u) => [u, slot]);
	const seen = new Set(out.map(([u, s]) => u + ':' + s));
	for (const uuid of uuids)
		for (const h of linkedOthers(objectOf(uuid), slot)) {
			const key = h.object.uuid + ':' + h.index;
			if (!seen.has(key)) seen.add(key), out.push([h.object.uuid, h.index]);
		}
	return out;
}

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
 * 105-slots: on the slot the map went to (it used to skip a slot list).
 * @param {any} object @param {string} key @param {number} [slot]
 */
function liftValueFor(object, key, slot = 0) {
	const material = materialAt(object, slot);
	if (!material) return;
	if (key === 'metalnessMap' && material.metalness === 0) setMaterialParam(object.uuid, 'metalness', 1, true, slot);
	if (key === 'roughnessMap' && material.roughness === 0) setMaterialParam(object.uuid, 'roughness', 1, true, slot);
	if (key === 'emissiveMap' && material.emissive?.getHex?.() === 0) setMaterialParam(object.uuid, 'emissive', '#ffffff', true, slot);
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
	const asked = new Set(uuids);
	for (const [uuid, at] of withLinked(uuids, slot)) {
		const object = objectOf(uuid);
		const material = object && materialAt(object, at);
		if (!material || !(key in material)) continue;
		const before = mapSlotUrl(material, key);
		recordEntry({ kind: 'materialmaps', uuid, param: 'slot', key, ...(at ? { slot: at } : {}), before: { value: before }, after: { value: url } });
		applyMapSlotTo(material, key, url, object);
		material.userData.tpEdited = true; // 59 T1: a material changed in the app survives a Replace model
		sendSlot(uuid, key, url, at);
		liftValueFor(object, key, at);
		if (asked.has(uuid)) applied++;
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
 * 102 M6: commit a PAINTED map slot. The brush has been drawing on a canvas installed as the slot's texture, so
 * the slot's current image is no longer what undo should go back to: the caller passes the image it held when
 * the stroke began (`before`, null when the stroke made the map). Records, applies and sends (the send fans to a
 * shared material's other users, `broadcastMaterial`). Inside a caller's history batch when one is open.
 * @param {string} uuid @param {string} key @param {string | null} before @param {string} url @param {number} [slot]
 */
export function commitPaintedMapSlot(uuid, key, before, url, slot = 0) {
	// a painted map on a linked slot becomes every holder's map (each records its own before)
	return linkedEdit(
		objectOf(uuid),
		slot,
		() => commitPaintedMapSlotOne(uuid, key, before, url, slot),
		(other, at) => {
			const m = materialAt(objectOf(other), at);
			commitPaintedMapSlotOne(other, key, m ? mapSlotUrl(m, key) : null, url, at);
		},
		'Paint'
	);
}

/** @param {string} uuid @param {string} key @param {string | null} before @param {string} url @param {number} slot */
function commitPaintedMapSlotOne(uuid, key, before, url, slot) {
	const object = objectOf(uuid);
	const material = object && materialAt(object, slot);
	if (!material || !isMapSlotKey(key) || !(key in material) || !isMapSlotImage(url)) return false;
	recordEntry({ kind: 'materialmaps', uuid, param: 'slot', key, ...(slot ? { slot } : {}), before: { value: before }, after: { value: url } });
	applyMapSlotTo(material, key, url, object);
	material.userData.tpEdited = true;
	sendSlot(uuid, key, url, slot);
	return true;
}

/**
 * Clear a map slot on many objects, one undo step. A compressed (KTX2) map has no image to keep, so undo
 * cannot bring that one back.
 * @param {string[]} uuids @param {string} key @param {number} [slot]
 */
export async function removeObjectsMapSlot(uuids, key, slot = 0) {
	if (!isMapSlotKey(key)) return;
	await asOneStep('Remove map', async () => {
		for (const [uuid, at] of withLinked(uuids, slot)) {
			const object = objectOf(uuid);
			const material = object && materialAt(object, at);
			// an image still loading counts as set: the Remove has to beat it
			if (!mapSlotFilled(material, key)) continue;
			recordEntry({ kind: 'materialmaps', uuid, param: 'slot', key, ...(at ? { slot: at } : {}), before: { value: mapSlotUrl(material, key) }, after: { value: null } });
			applyMapSlotTo(material, key, null, object);
			sendSlot(uuid, key, null, at);
		}
	});
}

/**
 * Change part of a material's tiling / offset / rotation.
 * @param {string} uuid @param {{repeat?: number[], offset?: number[], rotation?: number}} patch @param {number} [slot]
 */
export function setTexTransform(uuid, patch, slot = 0) {
	return linkedEdit(objectOf(uuid), slot, () => setTexTransformOne(uuid, patch, slot), (other, at) => setTexTransformOne(other, patch, at), 'Tiling');
}

/** @param {string} uuid @param {any} patch @param {number} slot */
function setTexTransformOne(uuid, patch, slot) {
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
	return linkedEdit(objectOf(uuid), slot, () => setNormalStrengthOne(uuid, value, slot), (other, at) => setNormalStrengthOne(other, value, at), 'Normal strength');
}

/** @param {string} uuid @param {number} value @param {number} slot */
function setNormalStrengthOne(uuid, value, slot) {
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
 * @param {number} [materialSlot] 105-slots: which MATERIAL slot of a slot list (here `slot` names a map)
 * @returns {Promise<{placed: {name: string, slot: string}[], unknown: string[]}>}
 */
export async function setObjectsMapSet(uuids, files, materialSlot = 0) {
	/** @type {{name: string, slot: string}[]} */
	const placed = [];
	/** @type {string[]} */
	const unknown = [];
	await asOneStep('Material maps', async () => {
		for (const entry of files) {
			const name = entry.name ?? /** @type {any} */ (entry.file).name ?? 'image';
			const slot = entry.slot ?? guessMapSlot(name);
			if (slot === 'map') {
				if (await setObjectsTexture(uuids, entry.file, materialSlot)) placed.push({ name, slot });
			} else if (slot && isMapSlotKey(slot)) {
				if (await setObjectsMapSlot(uuids, slot, entry.file, materialSlot)) placed.push({ name, slot });
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
