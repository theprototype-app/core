// 72 LK1: the textures behind a material's map slots (normal, roughness, metalness, emissive, AO) and
// its tiling / offset / rotation. THREE, the scene poke and the rules leaf only, so materialsHandler can
// import it without a cycle. The write paths (undo + wire) are in materialMaps.js.
//
// A slot's image is deliberately NOT kept on material.userData the way `mapDataUrl` is: userData rides
// every save and every GLTF object sync as extras, beside the texture that already carries the same
// pixels, and five maps would send each image twice. The URL stays in memory; after a reload or a sync
// it is encoded back from the texture when something needs it.
import * as THREE from 'three';
import { pokeScene } from '../stores/sceneStore';
import { MAP_SLOTS, isMapSlotKey, normalizeTexTransform, isIdentityTexTransform, IDENTITY_TEX_TRANSFORM } from './materialParamRules.js';

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
export const TEXTURE_PARAMS = [
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

/** every texture slot a tiling edit reaches: the base colour map plus the five */
const ALL_MAP_KEYS = ['map', ...MAP_SLOTS.map((slot) => slot.key)];

/** @param {any} material */
function firstMapOf(material) {
	for (const key of ALL_MAP_KEYS) if (material?.[key]) return material[key];
	return null;
}

/** does this material show any map at all (the tiling rows have something to move)? @param {any} material */
export function hasAnyMap(material) {
	return !!firstMapOf(material);
}

/** @param {any} texture @param {{repeat: number[], offset: number[], rotation: number}} t */
function writeTransform(texture, t) {
	texture.repeat.set(t.repeat[0], t.repeat[1]);
	texture.offset.set(t.offset[0], t.offset[1]);
	texture.rotation = t.rotation;
	if (!isIdentityTexTransform(t) && (texture.wrapS !== THREE.RepeatWrapping || texture.wrapT !== THREE.RepeatWrapping)) {
		// a texture clamped at its edge smears instead of tiling; only an image re-upload changes the wrap
		texture.wrapS = THREE.RepeatWrapping;
		texture.wrapT = THREE.RepeatWrapping;
		texture.needsUpdate = true;
	}
}

/** the material's tiling / offset / rotation: what was set here, else what its first map already has
 * (an imported model's KHR_texture_transform, a preset's repeat).
 * @param {any} material @returns {{repeat: number[], offset: number[], rotation: number}} */
export function texTransformOf(material) {
	const stored = normalizeTexTransform(material?.userData?.texTransform);
	if (stored) return stored;
	const first = firstMapOf(material);
	if (!first) return { repeat: [1, 1], offset: [0, 0], rotation: 0 };
	return (
		normalizeTexTransform({ repeat: [first.repeat.x, first.repeat.y], offset: [first.offset.x, first.offset.y], rotation: first.rotation }) ?? {
			repeat: [...IDENTITY_TEX_TRANSFORM.repeat],
			offset: [...IDENTITY_TEX_TRANSFORM.offset],
			rotation: 0
		}
	);
}

/** Textures a material owns, by texture. A model's materials can share one Texture object, and tiling
 * lives on the texture, so an edit on a texture this material does not own gets a clone first (the clone
 * shares the image, nothing re-uploads). @type {WeakMap<any, any>} */
const textureOwner = new WeakMap();

/**
 * Put a tiling / offset / rotation on every map of ONE material, and remember it for a map set later.
 * @param {any} material @param {any} raw
 */
export function applyTexTransform(material, raw) {
	const t = normalizeTexTransform(raw);
	if (!material || !t) return false;
	if (isIdentityTexTransform(t)) delete material.userData.texTransform;
	else material.userData.texTransform = t;
	/** @type {Map<any, any>} one clone per source, so a texture used by two slots stays one texture */
	const clones = new Map();
	for (const key of ALL_MAP_KEYS) {
		const texture = material[key];
		if (!texture?.isTexture) continue;
		let own = texture;
		if (textureOwner.get(texture) !== material) {
			own = clones.get(texture);
			if (!own) {
				own = texture.clone();
				clones.set(texture, own);
				textureOwner.set(own, material);
			}
			material[key] = own;
		}
		writeTransform(own, t);
	}
	material.needsUpdate = true;
	pokeScene();
	return true;
}

/** a new base colour map or slot map takes the material's tiling: called once the image has loaded
 * @param {any} material @param {any} texture */
export function adoptTexTransform(material, texture) {
	const t = normalizeTexTransform(material?.userData?.texTransform);
	textureOwner.set(texture, material);
	if (t) writeTransform(texture, t);
}

/** glTF UVs run the other way from three's own, so a texture read with flipY off needs the normal map's
 * green channel turned over when the renderer derives tangents from the UVs. GLTFLoader does this for
 * the models it loads, which leaves a normal map set here on an imported model to do the same.
 * @param {any} material @param {any} object */
function alignNormalScale(material, object) {
	const map = material.normalMap;
	const scale = material.normalScale;
	if (!map || !scale) return;
	const size = Math.abs(scale.x);
	scale.y = map.flipY === false && !object?.geometry?.attributes?.tangent ? -size : size;
}

/** @param {any} material */
export function normalStrengthOf(material) {
	return Math.abs(material?.normalScale?.x ?? 1);
}

/** @param {any} material @param {any} object @param {number} value */
export function applyNormalStrength(material, object, value) {
	if (!material?.normalScale || !Number.isFinite(value)) return false;
	const size = Math.max(0, Math.min(10, value));
	material.normalScale.set(size, size);
	alignNormalScale(material, object);
	pokeScene();
	return true;
}

/** @typedef {{url: string, pending: boolean, token: number}} SlotEntry */
/** the image each slot shows, in memory only (see the file header) @type {WeakMap<any, Record<string, SlotEntry>>} */
const slotEntries = new WeakMap();
let nextToken = 1;

/** @param {any} material @param {any} texture is another slot of this material still using it? */
function stillUsed(material, texture) {
	return ALL_MAP_KEYS.some((key) => material[key] === texture);
}

/**
 * Set (or clear, with null) one map slot of one material. The newest call wins if two images load at
 * once: without that a slow image can land after a Remove and put the map back.
 * @param {any} material @param {string} key @param {string | null} dataURL @param {any} [object]
 */
export function applyMapSlotTo(material, key, dataURL, object) {
	if (!material || !isMapSlotKey(key) || !(key in material)) return false;
	let entries = slotEntries.get(material);
	if (!entries) slotEntries.set(material, (entries = {}));
	if (dataURL == null) {
		delete entries[key];
		const old = material[key];
		material[key] = null;
		if (old && !stillUsed(material, old)) old.dispose();
		material.needsUpdate = true;
		pokeScene();
		return true;
	}
	const token = nextToken++;
	entries[key] = { url: dataURL, pending: true, token };
	// what the new image inherits: this slot's old texture, else a sibling (a normal map added to an
	// imported model must read its UVs the way that model's other maps do)
	const previous = material[key] ?? firstMapOf(material);
	const inherit = previous && {
		...Object.fromEntries(TEXTURE_PARAMS.map((k) => [k, previous[k]])),
		repeat: previous.repeat?.clone?.(),
		offset: previous.offset?.clone?.(),
		center: previous.center?.clone?.()
	};
	const srgb = MAP_SLOTS.find((slot) => slot.key === key)?.srgb;
	new THREE.TextureLoader().load(
		dataURL,
		(texture) => {
			const entry = entries[key];
			if (entry?.token !== token) {
				texture.dispose();
				return;
			}
			entry.pending = false;
			texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
			if (inherit) copyTextureParams(inherit, texture);
			adoptTexTransform(material, texture);
			const old = material[key];
			material[key] = texture;
			if (old && !stillUsed(material, old)) old.dispose();
			if (key === 'normalMap') alignNormalScale(material, object);
			material.needsUpdate = true;
			pokeScene();
		},
		undefined,
		() => {
			if (entries[key]?.token === token) delete entries[key];
			pokeScene();
		}
	);
	return true;
}

/** @param {any} texture @param {number} maxSide @returns {string | null} */
function encodeTexture(texture, maxSide) {
	const image = texture?.image;
	if (!image || typeof document === 'undefined') return null;
	const width = image.width ?? image.videoWidth;
	const height = image.height ?? image.videoHeight;
	// a compressed (KTX2) or raw data texture has no drawable image
	if (!width || !height || image.data !== undefined || texture.isCompressedTexture) return null;
	const scale = Math.min(1, maxSide / Math.max(width, height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	try {
		canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
		const webp = canvas.toDataURL('image/webp', 0.9);
		return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
	} catch {
		return null;
	}
}

/** The image a slot holds as an inline URL: what undo goes back to, what a saved preset stores. Null when
 * the slot is empty or holds a texture with no drawable image.
 * @param {any} material @param {string} key @param {number} [maxSide] @returns {string | null} */
export function mapSlotUrl(material, key, maxSide = 1024) {
	if (!material || !isMapSlotKey(key)) return null;
	const entry = slotEntries.get(material)?.[key];
	if (entry && (entry.pending || material[key])) return entry.url;
	if (!material[key]) return null;
	const url = encodeTexture(material[key], maxSide);
	if (url) {
		let entries = slotEntries.get(material);
		if (!entries) slotEntries.set(material, (entries = {}));
		entries[key] = { url, pending: false, token: nextToken++ };
	}
	return url;
}

/** The URL this session already knows for a slot, without encoding anything: cheap enough for a read on
 * every Inspector poke. @param {any} material @param {string} key @returns {string | null} */
export function mapSlotKnownUrl(material, key) {
	return slotEntries.get(material)?.[key]?.url ?? null;
}

/** small pictures for the Inspector, by texture @type {WeakMap<any, string>} */
const thumbs = new WeakMap();

/** What the Inspector shows for a slot: an imported model's map has no URL anywhere, so it is drawn small
 * once and kept. @param {any} material @param {string} key @returns {string | null} */
export function mapSlotThumb(material, key) {
	if (!material || !isMapSlotKey(key)) return null;
	const entry = slotEntries.get(material)?.[key];
	if (entry && (entry.pending || material[key])) return entry.url;
	const texture = material[key];
	if (!texture) return null;
	let thumb = thumbs.get(texture);
	if (!thumb) {
		thumb = encodeTexture(texture, 64) ?? undefined;
		if (thumb) thumbs.set(texture, thumb);
	}
	return thumb ?? null;
}

/** is the slot set, or about to be? @param {any} material @param {string} key */
export function mapSlotFilled(material, key) {
	return !!(material?.[key] || slotEntries.get(material)?.[key]?.pending);
}

/**
 * A type switch makes a new material: hand it every map it can show. A map the new type has no slot for
 * stays in memory against it, so switching Standard to Basic and back (or undoing that) loses nothing.
 * @param {any} from @param {any} to @param {any} [object]
 */
export function carryMapSlots(from, to, object) {
	if (!from || !to) return;
	const oldEntries = slotEntries.get(from);
	for (const { key } of MAP_SLOTS) {
		const texture = from[key];
		const url = texture ? mapSlotUrl(from, key) : oldEntries?.[key]?.url;
		if (key in to && texture) {
			to[key] = texture;
			textureOwner.set(texture, to);
		} else if (key in to && url) {
			applyMapSlotTo(to, key, url, object);
			continue;
		}
		if (!url) continue;
		let entries = slotEntries.get(to);
		if (!entries) slotEntries.set(to, (entries = {}));
		entries[key] = { url, pending: false, token: nextToken++ };
	}
	if (from.userData?.texTransform) to.userData.texTransform = from.userData.texTransform;
	if (from.normalScale && to.normalScale) to.normalScale.copy(from.normalScale);
	if (typeof from.aoMapIntensity === 'number' && 'aoMapIntensity' in to) to.aoMapIntensity = from.aoMapIntensity;
}
