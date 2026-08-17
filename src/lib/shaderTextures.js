// Texture references for shader graphs (plan SH1's remaining owed item): an Explorer
// content HASH resolved to a real THREE.Texture.
//
// WHY A HASH AND NOT AN EMBEDDED dataURL, which is how material textures work
// (`applyMap` keeps one on `material.userData.mapDataUrl`): a shader graph document
// replicates WHOLE on every edit, so an embedded image would re-send the entire texture
// to every peer on each slider nudge. A hash is 64 characters and the BYTES travel once,
// through assetShare's push-on-assign / pull-on-demand (golden rule 9) — which is also
// what covers late joiners and restores, since a graph can name a hash the receiver has
// never seen.
//
// Nothing here touches the scene or a material: this module answers "what texture is
// that hash", and `shaderGraph.js` decides which uniform slot it lands in. That keeps
// the retry story in one place too — a texture that arrives LATER notifies listeners,
// and the store re-fills every installed material.

import * as THREE from 'three';
import { explorerItems, itemByHash, itemBlob } from './explorer';
import { requestAsset, sendAsset } from './assetShare';

/** hash -> the loaded texture. Shared: two graphs naming one image share one upload. */
/** @type {Map<string, any>} */
const cache = new Map();

/** hash -> the in-flight load, so N uniforms on one hash decode ONCE. */
/** @type {Map<string, Promise<any>>} */
const loading = new Map();

/** hashes we have asked the mesh for and are still missing locally. @type {Set<string>} */
const awaiting = new Set();

/** Called whenever a texture becomes available, so consumers can re-fill. */
/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Be told when a texture lands (the assetShare pull completing, or a local import).
 * The store uses this to re-fill installed materials — a uniform whose bytes were
 * missing at compile time must not stay empty forever.
 * @param {() => void} fn @returns {() => void}
 */
export function registerShaderTextureListener(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function notify() {
	for (const fn of [...listeners]) {
		try {
			fn();
		} catch (error) {
			console.log('shader texture listener failed', error);
		}
	}
}

/**
 * The texture for a hash if we already hold it — a SYNCHRONOUS accessor, so the common
 * case (the image is in the Explorer) fills the uniform without a frame of blankness.
 * @param {string} hash @returns {any}
 */
export function shaderTextureFor(hash) {
	return (hash && cache.get(hash)) ?? null;
}

/** @type {any} */
let placeholder = null;

/**
 * A 1x1 opaque WHITE texture, used while a hash is still being pulled.
 *
 * The alternative is leaving the sampler null, and three then substitutes its own empty
 * texture, which samples to ZERO — so an object whose image has not arrived yet renders
 * BLACK. That is the state a late joiner sits in for as long as the transfer takes, and
 * black reads as "broken" rather than "loading". White is the identity for the albedo
 * multiply, so the object simply looks untextured until the bytes land, and nothing has
 * to recompile when they do (only the uniform's value changes).
 * @returns {any}
 */
export function shaderPlaceholderTexture() {
	if (placeholder) return placeholder;
	placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
	placeholder.colorSpace = THREE.SRGBColorSpace;
	placeholder.needsUpdate = true;
	return placeholder;
}

/**
 * Resolve a hash to a texture. Returns null when the bytes are not here — and in that
 * case ASKS the mesh for them (once per hash, assetShare dedupes) so the retry can
 * happen when they arrive rather than the node silently showing nothing forever.
 * @param {string} hash @returns {Promise<any>}
 */
export async function resolveShaderTexture(hash) {
	if (!hash) return null;
	const hit = cache.get(hash);
	if (hit) return hit;
	const inFlight = loading.get(hash);
	if (inFlight) return inFlight;
	const item = itemByHash(hash);
	if (!item) {
		// not local: pull it. `requestAsset` is a no-op when we already asked or already
		// hold it, so this is safe to reach on every compile.
		awaiting.add(hash);
		requestAsset(hash);
		return null;
	}
	const job = loadTexture(item)
		.then((texture) => {
			if (texture) {
				cache.set(hash, texture);
				awaiting.delete(hash);
			}
			loading.delete(hash);
			// notify on EVERY successful resolve, not only the awaited-from-a-peer path: a
			// decode is async even for a local import, so anything reading `shaderTextureFor`
			// (the store's uniform refill, the picker's ready state) has no other signal that
			// it finished — a plain Map read is not reactive
			if (texture) notify();
			return texture;
		})
		.catch((error) => {
			loading.delete(hash);
			console.log('shader texture failed to load', error);
			return null;
		});
	loading.set(hash, job);
	return job;
}

/**
 * Decode one Explorer item into a texture.
 *
 * Sampler state matches `applyMap`'s (SRGBColorSpace, and TextureLoader's own flipY),
 * with ONE deliberate difference: wrap is REPEAT rather than three's ClampToEdge
 * default, because a shader graph is exactly where tiling is authored — the Tiling &
 * offset and Panner nodes push uv outside 0..1 by design, and clamping would smear the
 * border instead of tiling.
 * @param {any} item @returns {Promise<any>}
 */
async function loadTexture(item) {
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	const url = URL.createObjectURL(blob);
	try {
		const texture = await new Promise((resolve, reject) =>
			new THREE.TextureLoader().load(url, resolve, undefined, reject)
		);
		/** @type {any} */
		const tex = texture;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.wrapS = THREE.RepeatWrapping;
		tex.wrapT = THREE.RepeatWrapping;
		tex.name = item.name ?? '';
		tex.needsUpdate = true;
		return tex;
	} finally {
		// the loader has decoded into a GPU-bound image by now; holding the blob URL
		// leaks one entry per import
		URL.revokeObjectURL(url);
	}
}

/**
 * PUSH the bytes once, when a hash is assigned — the assetShare contract (push on
 * assign, pull on demand). Without this a peer only gets the image after asking, which
 * costs a round trip on every fresh assignment.
 * @param {string} hash
 */
export function shareShaderTexture(hash) {
	if (hash) void sendAsset(hash);
}

/** @type {(() => void)|null} */
let itemsStop = null;

/**
 * Watch the Explorer for a hash we are waiting on. This is the retry half of golden
 * rule 9: `applyAssetFile` lands pulled bytes as a new Explorer item, and until that is
 * noticed the uniform holds null and the object renders untextured with no explanation.
 * Idempotent; call once at boot.
 */
export function startShaderTextures() {
	if (itemsStop) return;
	itemsStop = explorerItems.subscribe((items) => {
		if (!awaiting.size || !Array.isArray(items)) return;
		// read the wanted set first: resolving notifies listeners, which read stores, and
		// writing a store from inside its own subscriber is the documented flush loop
		const landed = [...awaiting].filter((hash) => items.some((item) => item?.hash === hash));
		if (!landed.length) return;
		for (const hash of landed) awaiting.delete(hash);
		void Promise.all(landed.map((hash) => resolveShaderTexture(hash))).then((textures) => {
			if (textures.some(Boolean)) notify();
		});
	});
}

/** Test seam. */
export function stopShaderTextures() {
	if (itemsStop) itemsStop();
	itemsStop = null;
}

/** Test/debug seam: what is resolved, what is still missing. */
export function shaderTextureDebug() {
	return {
		cached: [...cache.keys()],
		awaiting: [...awaiting],
		loading: [...loading.keys()],
		listeners: listeners.size
	};
}

/**
 * Drop a hash's cached texture (an item deleted, or a test resetting). Disposes, since
 * this module is what created the upload.
 * @param {string} [hash] omitted = every one
 */
export function forgetShaderTexture(hash) {
	const keys = hash ? [hash] : [...cache.keys()];
	for (const key of keys) {
		cache.get(key)?.dispose?.();
		cache.delete(key);
		awaiting.delete(key);
		loading.delete(key);
	}
}
