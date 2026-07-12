import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from '$lib/history';

// Custom materials and image textures for scene objects, replicated to peers
// through the existing objectParameters message. Textures travel as dataURLs
// after client-side downscaling (max 1024px), so messages stay small and late
// joiners get them for free via the GLTF full-object sync.

const MATERIAL_TYPES = [
	'MeshBasicMaterial',
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshPhongMaterial',
	'MeshLambertMaterial',
	'MeshToonMaterial',
	'MeshMatcapMaterial',
	'MeshNormalMaterial',
	'MeshDepthMaterial',
	'ShadowMaterial'
];

// numeric params carried across a type switch when BOTH sides have them
const SHARED_MATERIAL_PARAMS = [
	'opacity',
	'roughness',
	'metalness',
	'shininess',
	'clearcoat',
	'clearcoatRoughness',
	'transmission',
	'ior',
	'emissiveIntensity'
];

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** @param {any} data */
function broadcast(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

// Undo entries replay through the same replicated actions below
// (recordEntry no-ops while history is being applied).
registerHistoryKind('material', (entry, state) => {
	const object = objectOf(entry.uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	if (entry.param === 'type') {
		switchMaterialType(entry.uuid, state.value, true);
	} else if (entry.param === 'map') {
		applyMap(object, state.value);
		broadcast({ type: 'objectParameters', parameter: 'map', uuid: entry.uuid, map: state.value });
	} else if (entry.param === 'materialParam') {
		setMaterialParam(entry.uuid, entry.key, state.value, true);
	} else if (entry.param === 'color') {
		if (object.material?.color) object.material.color.set(state.value);
		broadcast({ type: 'color', uuid: entry.uuid, color: state.value });
	}
	objectsGroup.update((value) => value);
	return true;
});

/**
 * Record one material history step (also used by the Properties color picker).
 * @param {string} uuid @param {string} param @param {string | null} key @param {any} before @param {any} after
 */
export function recordMaterialChange(uuid, param, key, before, after) {
	if (before === after) return;
	recordEntry({
		kind: 'material',
		uuid,
		param,
		...(key ? { key } : {}),
		before: { value: before },
		after: { value: after }
	});
}

/**
 * Apply (or remove, with null) a texture dataURL to an object's material.
 * The dataURL is kept in material.userData so the UI can show a thumbnail.
 * @param {any} object @param {string | null} dataURL
 */
export function applyMap(object, dataURL) {
	const material = object?.material;
	if (!material || Array.isArray(material) || !('map' in material)) return;
	if (dataURL == null) {
		material.map?.dispose();
		material.map = null;
		delete material.userData.mapDataUrl;
		material.needsUpdate = true;
		objectsGroup.update((value) => value);
		return;
	}
	// set synchronously so the UI thumbnail appears immediately
	material.userData.mapDataUrl = dataURL;
	new THREE.TextureLoader().load(dataURL, (texture) => {
		texture.colorSpace = THREE.SRGBColorSpace;
		material.map?.dispose();
		material.map = texture;
		material.needsUpdate = true;
		objectsGroup.update((value) => value);
	});
}

/** Downscale an image file to maxSize px and encode as a compact dataURL @param {File} file @param {number} maxSize */
async function downscaleImage(file, maxSize) {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const webp = canvas.toDataURL('image/webp', 0.8);
	// browsers without webp encoding fall back to png silently
	return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}

/** Set an image file as the object's texture and replicate @param {string} uuid @param {File} file */
export async function setObjectTexture(uuid, file) {
	const object = objectOf(uuid);
	if (!object?.material) return;
	if (Array.isArray(object.material)) {
		showToast('Multi-material objects are not supported yet');
		return;
	}
	if (file.size > 8 * 1024 * 1024) {
		showToast('Image is too large (max 8 MB)');
		return;
	}
	try {
		const dataURL = await downscaleImage(file, 1024);
		recordMaterialChange(uuid, 'map', null, object.material.userData?.mapDataUrl ?? null, dataURL);
		applyMap(object, dataURL);
		broadcast({ type: 'objectParameters', parameter: 'map', uuid: uuid, map: dataURL });
	} catch (error) {
		console.log(error);
		showToast('Could not read the image file');
	}
}

/** @param {string} uuid */
export function removeObjectTexture(uuid) {
	const object = objectOf(uuid);
	if (!object) return;
	const previous = object.material?.userData?.mapDataUrl ?? null;
	if (previous) recordMaterialChange(uuid, 'map', null, previous, null);
	applyMap(object, null);
	broadcast({ type: 'objectParameters', parameter: 'map', uuid: uuid, map: null });
}

/**
 * Switch the material type, carrying over color/map/opacity so peers do not
 * lose them (the old behavior recreated a default material on the receivers).
 * @param {string} uuid @param {string} type @param {boolean} replicate
 */
export function switchMaterialType(uuid, type, replicate = true) {
	const object = objectOf(uuid);
	if (!object || !MATERIAL_TYPES.includes(type)) return;
	const old = object.material;
	if (replicate && old && !Array.isArray(old)) recordMaterialChange(uuid, 'type', null, old.type, type);
	/** @type {any} */
	const fresh = new (/** @type {any} */ (THREE))[type]();
	if (old && !Array.isArray(old)) {
		if (old.color && fresh.color) fresh.color.copy(old.color);
		if (old.emissive && fresh.emissive) fresh.emissive.copy(old.emissive);
		if ('map' in fresh && old.map) {
			fresh.map = old.map;
			fresh.userData.mapDataUrl = old.userData?.mapDataUrl;
		}
		fresh.transparent = old.transparent;
		if ('wireframe' in fresh && old.wireframe !== undefined) fresh.wireframe = old.wireframe;
		// carry shared numeric params only where the TARGET type has them
		for (const key of SHARED_MATERIAL_PARAMS) {
			if (key in fresh && key in old && typeof old[key] === 'number') fresh[key] = old[key];
		}
	}
	object.material = fresh;
	fresh.needsUpdate = true;
	objectsGroup.update((value) => value);
	if (replicate)
		broadcast({ type: 'objectParameters', parameter: 'material', uuid: uuid, material: type });
}

/**
 * Set a single material parameter (roughness, metalness, shininess, wireframe, ...)
 * @param {string} uuid @param {string} key @param {any} value @param {boolean} replicate
 */
export function setMaterialParam(uuid, key, value, replicate = true) {
	const object = objectOf(uuid);
	const material = object?.material;
	if (!material || Array.isArray(material) || !(key in material)) return;
	// Color-typed params (emissive, ...) travel as a hex string and are applied
	// through .set() on both sides, so they replicate + undo like any other.
	const current = material[key];
	const isColor = !!(current && current.isColor);
	const before = isColor ? '#' + current.getHexString() : current;
	if (replicate) recordMaterialChange(uuid, 'materialParam', key, before, value);
	if (isColor) material[key].set(value);
	else material[key] = value;
	material.needsUpdate = true;
	objectsGroup.update((v) => v);
	if (replicate)
		broadcast({ type: 'objectParameters', parameter: 'materialParam', uuid: uuid, key: key, value: value });
}
