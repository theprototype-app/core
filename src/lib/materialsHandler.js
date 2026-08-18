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

/**
 * A mesh's materials as an array, whatever it wears. An imported .obj/.mtl or a
 * merged mesh carries a material ARRAY (one per `geometry.groups` slot); most
 * objects carry a single material, which is slot 0.
 * @param {any} object @returns {any[]}
 */
export function materialsOf(object) {
	const material = object?.material;
	if (!material) return [];
	return Array.isArray(material) ? material : [material];
}

/**
 * The material at a SLOT. Slot 0 of a single-material object is that material,
 * so every existing caller (and every older peer's slot-less message) keeps
 * today's behaviour. Out-of-range slots resolve to nothing rather than slot 0 —
 * silently texturing the wrong slot is worse than doing nothing.
 * @param {any} object @param {number} [slot] @returns {any}
 */
export function materialAt(object, slot = 0) {
	const materials = materialsOf(object);
	if (!materials.length) return null;
	if (!slot) return materials[0];
	return materials[slot] ?? null;
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
		applyMap(object, state.value, entry.slot ?? 0);
		broadcast({
			type: 'objectParameters',
			parameter: 'map',
			uuid: entry.uuid,
			map: state.value,
			...(entry.slot ? { slot: entry.slot } : {})
		});
	} else if (entry.param === 'materials') {
		applyMaterials(object, state.value, true);
	} else if (entry.param === 'materialParam') {
		setMaterialParam(entry.uuid, entry.key, state.value, true);
	} else if (entry.param === 'color') {
		if (object.material?.color) object.material.color.set(state.value);
		broadcast({ type: 'color', uuid: entry.uuid, color: state.value });
	}
	objectsGroup.update((value) => value);
	return true;
});

// ---- material SLOTS (UV4) --------------------------------------------------
// A mesh's slot list is `object.material` as an ARRAY paired with
// `geometry.groups`; three renders slot N by walking the groups, so a geometry with
// no groups and an array material draws NOTHING. Nothing replicated the array
// itself before: textures/params were slot-addressable, but a slot coming into
// EXISTENCE was purely local, which is why assigning faces to slots could not be
// shared. This is the one message that syncs both halves at once.

/** Serialize a material array for the wire. THREE's own toJSON per material, so
 * textures ride as data-URLs exactly as they do in the object message.
 * @param {any[]} materials @returns {any} */
function serializeMaterials(materials) {
	/** @type {any} */
	const meta = { textures: [], images: [] };
	const list = materials.map((material) => material.toJSON(meta));
	return { materials: list, textures: meta.textures, images: meta.images };
}

/**
 * Apply a serialized material array (+ optional geometry groups) to an object.
 * Rebuilds real THREE materials through ObjectLoader's material parser so textures
 * come back too, then re-applies the groups — WITHOUT them an array material is
 * invisible.
 * @param {any} object @param {any} payload @param {boolean} [replicate]
 */
export function applyMaterials(object, payload, replicate = false) {
	if (!object || !payload?.materials?.length) return;
	const loader = new THREE.ObjectLoader();
	const images = loader.parseImages(payload.images ?? [], () => {});
	const textures = loader.parseTextures(payload.textures ?? [], images);
	const materials = loader.parseMaterials(payload.materials, textures);
	const next = payload.materials.map((/** @type {any} */ entry) => materials[entry.uuid]).filter(Boolean);
	if (!next.length) return;
	// carry the thumbnail dataURL the UI reads (material.toJSON does not keep it)
	next.forEach((/** @type {any} */ material, /** @type {number} */ i) => {
		const url = payload.mapDataUrls?.[i];
		if (url) material.userData.mapDataUrl = url;
	});
	object.material = next.length === 1 ? next[0] : next;
	if (payload.groups && object.geometry) {
		object.geometry.clearGroups();
		for (const group of payload.groups)
			object.geometry.addGroup(group.start, group.count, group.materialIndex);
	}
	object.material.needsUpdate ??= true;
	objectsGroup.update((value) => value);
	if (replicate)
		broadcast({ type: 'objectParameters', parameter: 'materials', uuid: object.uuid, payload });
}

/** Does this object wear a real material ARRAY (more than one slot)?
 * @param {any} object */
export function isMultiMaterial(object) {
	return Array.isArray(object?.material) && object.material.length > 1;
}

/**
 * Serialize a mesh so its material ARRAY and `geometry.groups` actually survive.
 *
 * A material array cannot cross a GLTF round trip at all: the exporter splits groups
 * into one primitive per material and the loader reassembles them as a GROUP of
 * single-material child meshes. `toJSON`/ObjectLoader does round-trip arrays, groups
 * and data-URL textures — with one catch. A PARAMETRIC geometry serializes as its
 * parameters (`{type:'BoxGeometry', ...}`) and the loader RE-RUNS the generator,
 * regenerating the default groups and silently discarding custom ones, which would
 * undo every face-to-slot assignment on a primitive. Copy into a plain
 * BufferGeometry first so real attributes + groups are written.
 *
 * Shared by the peer object sync and the autosave snapshot — both had the same hole.
 * @param {any} element
 */
export function serializeMeshWithGroups(element) {
	const geometry = element.geometry;
	if (!geometry?.parameters) return element.toJSON();
	const flat = new THREE.BufferGeometry().copy(geometry); // attributes, groups, index
	const clone = element.clone();
	clone.uuid = element.uuid; // clone() re-uuids; everything is keyed by this
	clone.children = [];
	clone.geometry = flat;
	const json = clone.toJSON();
	flat.dispose();
	return json;
}

/** The wire payload for an object's CURRENT slots + groups. @param {any} object */
export function materialsPayload(object) {
	const materials = materialsOf(object);
	const serialized = serializeMaterials(materials);
	return {
		...serialized,
		// toJSON drops userData.mapDataUrl, and the Inspector/UV sidebar read it
		mapDataUrls: materials.map((m) => m.userData?.mapDataUrl ?? null),
		groups: (object.geometry?.groups ?? []).map((/** @type {any} */ g) => ({
			start: g.start,
			count: g.count,
			materialIndex: g.materialIndex || 0
		}))
	};
}

/**
 * Replace an object's material slots (and its geometry groups), replicated and
 * undoable as ONE step.
 * @param {string} uuid @param {any[]} materials @param {any[]} [groups]
 * @returns {boolean}
 */
export function setObjectMaterials(uuid, materials, groups) {
	const object = objectOf(uuid);
	if (!object || !materials?.length) return false;
	const before = materialsPayload(object);
	object.material = materials.length === 1 ? materials[0] : materials;
	if (groups && object.geometry) {
		object.geometry.clearGroups();
		for (const group of groups) object.geometry.addGroup(group.start, group.count, group.materialIndex);
	}
	objectsGroup.update((value) => value);
	const after = materialsPayload(object);
	recordEntry({
		kind: 'material',
		uuid,
		param: 'materials',
		before: { value: before },
		after: { value: after }
	});
	broadcast({ type: 'objectParameters', parameter: 'materials', uuid, payload: after });
	return true;
}

/**
 * Append a slot, cloned from the last one so it inherits the look rather than
 * appearing as an untextured default. Existing geometry groups are preserved, so
 * nothing changes visually until faces are assigned to the new slot.
 * @param {string} uuid @returns {number} the new slot index, or -1
 */
export function addMaterialSlot(uuid) {
	const object = objectOf(uuid);
	if (!object) return -1;
	const current = materialsOf(object);
	if (!current.length) return -1;
	const fresh = current[current.length - 1].clone();
	fresh.name = 'slot' + current.length;
	// a cloned material shares its parent's map OBJECT; that is fine (both slots
	// showing one texture until one is re-textured) and keeps the clone cheap
	const materials = [...current, fresh];
	const count = object.geometry?.index?.count ?? object.geometry?.attributes?.position?.count ?? 0;
	// Growing from a SINGLE material: normalise the groups to one covering group on
	// slot 0. three ignores groups entirely for a single material, and the
	// primitives ship them anyway — a plain BoxGeometry has six, materialIndex 0..5 —
	// so keeping them would suddenly point four faces at slots that do not exist and
	// those faces would render nothing. Before the add every face showed the one
	// material; after it, every face must still show slot 0.
	// With an array already present the groups are real and are left alone.
	const groups =
		current.length > 1 ? undefined : [{ start: 0, count, materialIndex: 0 }];
	return setObjectMaterials(uuid, materials, groups) ? materials.length - 1 : -1;
}

/**
 * Record one material history step (also used by the Properties color picker).
 * @param {string} uuid @param {string} param @param {string | null} key
 * @param {any} before @param {any} after
 * @param {number} [slot] which material slot it applied to (omitted = 0, so
 *   existing entries and older autosaves replay exactly as before)
 */
export function recordMaterialChange(uuid, param, key, before, after, slot = 0) {
	if (before === after) return;
	recordEntry({
		kind: 'material',
		uuid,
		param,
		...(key ? { key } : {}),
		...(slot ? { slot } : {}),
		before: { value: before },
		after: { value: after }
	});
	autoKeyMaterial(uuid);
}

// 17-E: with REC armed, a material edit KEYS the channel it changed, the same as
// posing the object with the gizmo does.
//
// It hooks in HERE, at the one funnel every material edit already passes through on
// its way to the undo stack, rather than control by control. The Inspector's rows
// go through `fanOn`, which keys them; the object COLOUR picker writes the material
// inline instead (it owns a debounced gesture, so a drag is ONE undo entry rather
// than one per pointer move) — which made picking a colour the single edit that
// never keyed, with the channel only turning up later when clicking the object
// happened to run a capture. Anything added later that records a material change
// now gets this for free.
//
// PRIMED DYNAMIC import: a static edge to animationPreview would close a cycle back
// through history -> flowRuntime (the moduleSDK pattern).
/** @type {any} */
let animRef = null;
import('./animationPreview')
	.then((module) => (animRef = module))
	.catch(() => {});

/**
 * @param {string} uuid
 *
 * Deferred by a microtask, because the two callers write in OPPOSITE orders:
 * `setMaterialParam` records the history entry BEFORE mutating the material, while
 * the colour picker mutates first and records at the end of its gesture. Reading
 * the material synchronously here would therefore see the OLD value half the time —
 * measured: a roughness edit keyed nothing while a colour edit keyed correctly.
 * A microtask runs after the caller's current block either way, so what auto-key
 * reads is always the value that was actually applied.
 */
function autoKeyMaterial(uuid) {
	if (!animRef?.captureAutoKey || !uuid) return;
	queueMicrotask(() => {
		try {
			animRef.captureAutoKey(uuid, animRef.playheadOf?.(uuid) ?? 0);
		} catch (error) {
			console.log('auto-key after a material change failed', error);
		}
	});
}

/**
 * SAMPLER STATE that must survive replacing a material's map.
 *
 * Every texture write here used to set `colorSpace` and nothing else, so painting
 * over an IMPORTED texture silently re-mapped it three ways at once: GLTFLoader
 * sets `flipY = false` (the glTF convention) while three's CanvasTexture and
 * TextureLoader default to `true`, so the image flipped vertically; glTF's default
 * sampler wrap is REPEAT while three's is CLAMP, so anything relying on tiling
 * smeared its border; and KHR_texture_transform's repeat/offset/rotation plus
 * `channel` (which UV set the map reads) were dropped entirely. The user-visible
 * result was "the UV map broke" after one brush stroke.
 * @type {string[]}
 */
const TEXTURE_PARAMS = [
	'flipY',
	'wrapS',
	'wrapT',
	'rotation',
	'channel',
	'anisotropy',
	'magFilter',
	'minFilter',
	'generateMipmaps',
	'premultiplyAlpha',
	'unpackAlignment'
];

/**
 * Copy sampler state from one texture to another. Vector-valued params
 * (repeat/offset/center) are COPIED, never aliased — sharing the Vector2 would let
 * a later edit of one texture move the other. Capture `from` BEFORE disposing it.
 * @param {any} from @param {any} to
 */
export function copyTextureParams(from, to) {
	if (!from || !to) return;
	for (const key of TEXTURE_PARAMS) if (from[key] !== undefined) to[key] = from[key];
	for (const key of ['repeat', 'offset', 'center'])
		if (from[key] && to[key]?.copy) to[key].copy(from[key]);
	to.needsUpdate = true;
}

/**
 * Apply (or remove, with null) a texture dataURL to one material SLOT of an
 * object. The dataURL is kept in material.userData so the UI can show a
 * thumbnail. UV2: `slot` addresses a material ARRAY (an imported .obj/.mtl, a
 * merged mesh); omitted means slot 0, which for a single-material object is
 * exactly the old behaviour — so older peers' slot-less messages still land.
 * @param {any} object @param {string | null} dataURL @param {number} [slot]
 */
export function applyMap(object, dataURL, slot = 0) {
	const material = materialAt(object, slot);
	if (!material || !('map' in material)) return;
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
	// capture the OUTGOING sampler state now: the load callback runs after we would
	// have disposed it, and the new texture must inherit flipY/wrap/repeat or an
	// imported texture is re-mapped by the replacement (see TEXTURE_PARAMS)
	const previous = material.map;
	const inherit = previous && {
		...Object.fromEntries(TEXTURE_PARAMS.map((k) => [k, previous[k]])),
		repeat: previous.repeat?.clone?.(),
		offset: previous.offset?.clone?.(),
		center: previous.center?.clone?.()
	};
	new THREE.TextureLoader().load(dataURL, (texture) => {
		texture.colorSpace = THREE.SRGBColorSpace;
		if (inherit) copyTextureParams(inherit, texture);
		material.map?.dispose();
		material.map = texture;
		material.needsUpdate = true;
		objectsGroup.update((value) => value);
	});
}

/** Downscale an image file to maxSize px and encode as a compact dataURL
 * (exported since 17-D2 — the OBJ/.mtl import path reuses it for its textures)
 * @param {File} file @param {number} maxSize */
export async function downscaleImage(file, maxSize) {
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

/**
 * Set one image file as the texture of MANY objects (17-D1) and replicate.
 * The file is decoded and downscaled ONCE and the resulting dataURL applied per
 * uuid — same per-object history entry and `objectParameters` message as the
 * single-object path, so nothing new goes on the wire. Decoding once is also the
 * robust order: re-reading the same File per object is both wasteful and
 * unreliable (the third `createImageBitmap` of one picked file can reject).
 * UV2: `slot` picks the material slot, so a multi-material mesh is no longer
 * refused — it used to toast "not supported yet" and skip.
 * @param {string[]} uuids @param {File} file @param {number} [slot]
 * @returns {Promise<number>} how many were textured
 */
export async function setObjectsTexture(uuids, file, slot = 0) {
	if (file.size > 8 * 1024 * 1024) {
		showToast('Image is too large (max 8 MB)');
		return 0;
	}
	/** @type {string} */
	let dataURL;
	try {
		dataURL = await downscaleImage(file, 1024);
	} catch (error) {
		console.log(error);
		showToast('Could not read the image file');
		return 0;
	}
	let applied = 0;
	let missingSlot = 0;
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const material = materialAt(object, slot);
		if (!material) {
			if (object?.material) missingSlot++;
			continue;
		}
		recordMaterialChange(uuid, 'map', null, material.userData?.mapDataUrl ?? null, dataURL, slot);
		applyMap(object, dataURL, slot);
		broadcast({
			type: 'objectParameters',
			parameter: 'map',
			uuid: uuid,
			map: dataURL,
			...(slot ? { slot } : {})
		});
		applied++;
	}
	if (missingSlot) showToast('That object has no material slot ' + slot);
	return applied;
}

/** Set an image file as the object's texture and replicate
 * @param {string} uuid @param {File} file @param {number} [slot] */
export async function setObjectTexture(uuid, file, slot = 0) {
	await setObjectsTexture([uuid], file, slot);
}

/** @param {string} uuid @param {number} [slot] */
export function removeObjectTexture(uuid, slot = 0) {
	const object = objectOf(uuid);
	if (!object) return;
	const material = materialAt(object, slot);
	if (!material) return;
	const previous = material.userData?.mapDataUrl ?? null;
	if (previous) recordMaterialChange(uuid, 'map', null, previous, null, slot);
	applyMap(object, null, slot);
	broadcast({
		type: 'objectParameters',
		parameter: 'map',
		uuid: uuid,
		map: null,
		...(slot ? { slot } : {})
	});
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
	// A multi-material mesh used to fall through here and have its whole slot array
	// replaced by ONE fresh material — silently, on both sides, with no history entry
	// (the carry-over and recordMaterialChange both skip arrays). Refuse instead;
	// per-slot type switching would need a slot argument and a materials commit.
	if (Array.isArray(old) && old.length > 1) {
		if (replicate) showToast('Cannot change the material type of a multi-slot object yet');
		return;
	}
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
 * Set an object's base material color and replicate + record (the missing
 * counterpart to setMaterialParam — color previously lived inline in the
 * Properties picker and vrControls; both can call this now).
 * @param {string} uuid @param {string} hex @param {boolean} replicate
 */
export function setObjectColor(uuid, hex, replicate = true) {
	const object = objectOf(uuid);
	const material = object?.material;
	if (!material || Array.isArray(material) || !material.color) return;
	const before = '#' + material.color.getHexString();
	material.color.set(hex);
	material.needsUpdate = true;
	objectsGroup.update((v) => v);
	if (replicate) {
		recordMaterialChange(uuid, 'color', null, before, hex);
		broadcast({ type: 'color', uuid: uuid, color: hex });
	}
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
