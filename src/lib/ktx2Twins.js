import { embeddedOnlyManager, checkGltf } from './loadGuard.js';
import { get } from 'svelte/store';
import { CompressedTexture, LinearFilter, RGBAFormat } from 'three';
import { globalRenderer } from '../stores/sceneStore';
import { getKtx2Loader, parseGltf, createGltfLoader } from './gltfLoader';
import { registerTwinPass } from './lod';
import { unpackGlb, ktx2Textures, asBytes } from './gltfOptimize/glbPost.js';

// 46 P1 — KTX2 TWINS: GPU-compressed textures in a scene whose every serializer wants pictures.
//
// THE PROBLEM. three's `toJSON` (undo, sessions, .tpscene, part of the wire) cannot write a
// CompressedTexture — it serializes `{width, height}` and an ObjectLoader brings back a texture
// with no pixels — and GLTFExporter (the wire, autosave, every GLB this app writes) throws on one
// unless somebody hands it a decompressor. So a KTX2 texture must never BE a scene object's
// texture, and yet the whole point of the 46 pipeline is that the GPU holds the compressed one
// (a 2048² colour map is 22 MB as RGBA8 and 2.8 MB as ETC1S on a Quest).
//
// THE ANSWER, the 31-perf shape (lod.js): the document keeps an ORDINARY texture with an ordinary
// picture, and the KTX2 bytes ride beside it as its TWIN — local, in a WeakMap, never serialized.
// Inside the render bracket lod.js already owns (scene.onBeforeRender / onAfterRender, so every
// pass of a frame and an XR eye pair) the texture wears the twin's compressed format and mipmaps;
// outside it, every serializer, picker, editor and fingerprint sees the plain picture.
//
// WHY THAT IS ENOUGH FOR THE GPU (three r186, WebGLTextures): the GL texture a Texture binds is
// chosen at UPLOAD time by a cache key over its sampler/format parameters, and an upload happens
// only when `texture.version` moves. So the first bracket that sees a twin bumps the version once
// with the compressed parameters on: the compressed data goes up under the compressed key and the
// plain GL texture (if a thumbnail render had uploaded one) is released. Every later draw — inside
// the bracket or not — binds the compressed one without uploading anything. The plain picture
// stays in CPU memory for the serializers; GPU memory is the twin's.
//
// A TWIN ONLY LIVES AS LONG AS THE PICTURE IT WAS MADE FROM: anything that changes a texture's
// pixels (painting, a resize, a material editor) calls `needsUpdate`, which moves `source.version`
// — and a twin whose source moved under it is dropped on the spot, so the next draw uploads the
// edited picture. Our own version bumps are recorded per SOURCE (clones share one).
//
// HOW TWINS ARRIVE: `attachTwinsFromGltf` after a parse of a file whose textures carry
// KHR_texture_basisu WITH a plain fallback (what the optimizer writes for an import, and what the
// GLTFExporter plugin below writes for the wire and autosave — so peers and a reload get the twin
// too); `sceneSafeGltf` after a parse of a KTX2-ONLY file (the Quest/web export loaded back, a
// foreign KTX2 GLB): each CompressedTexture is drawn into an ordinary picture once and becomes its
// own twin. Undo and .tpscene go through toJSON and come back with the plain picture only — the
// texture-size saving survives, the GPU compression does not (stated in the docs).

/**
 * @typedef {{bytes: Uint8Array, compressed: any, ready: Promise<any> | null, saved: any, failed?: boolean}} Twin
 */

/** texture -> its twin @type {WeakMap<any, Twin>} */
const twins = new WeakMap();
/** the textures that have one, held WEAKLY so a texture the scene dropped can be collected
 * @type {Set<WeakRef<any>>} */
const live = new Set();
/** source -> the version our own uploads left it at @type {WeakMap<any, number>} */
const ownVersion = new WeakMap();
/** KTX2 bytes -> the transcoded texture (one transcode per file image, however many clones)
 * @type {WeakMap<Uint8Array, Promise<any>>} */
const transcodes = new WeakMap();

const stats = {
	attached: 0,
	ready: 0,
	dropped: 0,
	uploads: 0,
	swapped: 0,
	failed: 0,
	decompressed: 0
};

/** The parameters a twin lends its texture for a render. */
const SWAP_KEYS = [
	'isCompressedTexture',
	'mipmaps',
	'format',
	'type',
	'internalFormat',
	'generateMipmaps',
	'minFilter',
	'flipY',
	'premultiplyAlpha'
];

/** three r186 WebGLTextures.getTextureCacheKey, verbatim: the key under which a Texture's GL
 * texture lives. Used to tell whether the GL texture bound now is the compressed one. @param {any} t */
function cacheKeyOf(t) {
	return [
		t.wrapS,
		t.wrapT,
		t.wrapR || 0,
		t.magFilter,
		t.minFilter,
		t.anisotropy,
		t.internalFormat,
		t.format,
		t.type,
		t.generateMipmaps,
		t.premultiplyAlpha,
		t.flipY,
		t.unpackAlignment,
		t.colorSpace
	].join();
}

/** @param {Uint8Array} bytes @returns {Promise<any>} */
function transcode(bytes) {
	let job = transcodes.get(bytes);
	if (!job) {
		job = (async () => {
			const loader = await getKtx2Loader();
			if (!loader) throw new Error('no renderer to transcode KTX2 for');
			// KTX2Loader transfers the buffer to its worker: hand it a copy
			const copy = bytes.slice().buffer;
			return await new Promise((resolve, reject) => loader.parse(copy, resolve, reject));
		})();
		transcodes.set(bytes, job);
	}
	return job;
}

/** @param {any} texture */
function onDispose(texture) {
	dropTwin(texture);
}

/**
 * Give `texture` a KTX2 twin. `compressed` = an already transcoded texture of those bytes (the
 * KTX2-only path has one); otherwise the bytes are transcoded on the live renderer's KTX2 loader.
 * A twin that would gain nothing (the device transcodes to plain RGBA) is dropped once known.
 * @param {any} texture @param {Uint8Array} bytes @param {any} [compressed]
 * @returns {Twin | null}
 */
export function attachTwin(texture, bytes, compressed) {
	if (!texture?.isTexture || texture.isCompressedTexture || !bytes?.byteLength) return null;
	const held = twins.get(texture);
	if (held && held.bytes === bytes) return held;
	if (held) dropTwin(texture);
	/** @type {Twin} */
	const twin = { bytes, compressed: null, ready: null, saved: null };
	twins.set(texture, twin);
	live.add(new WeakRef(texture));
	ownVersion.set(texture.source, texture.source.version);
	texture.addEventListener('dispose', () => onDispose(texture));
	stats.attached++;
	registerTwinPass(twinPass);
	const settle = (/** @type {any} */ c) => {
		if (twins.get(texture) !== twin) return c;
		// a texture the GPU cannot take compressed comes back as plain RGBA: no saving, no twin
		if (!c?.isCompressedTexture || c.format === RGBAFormat || !c.mipmaps?.length) {
			twin.failed = true;
			dropTwin(texture);
			return c;
		}
		twin.compressed = c;
		stats.ready++;
		return c;
	};
	twin.ready = compressed
		? Promise.resolve(settle(compressed))
		: transcode(bytes).then(settle, (error) => {
				stats.failed++;
				twin.failed = true;
				if (twins.get(texture) === twin) dropTwin(texture);
				console.log('KTX2 twin skipped:', error?.message ?? error);
				return null;
			});
	return twin;
}

/** The live twin of a texture, or null. @param {any} texture */
export function twinOf(texture) {
	return (texture && twins.get(texture)) || null;
}

/** The KTX2 bytes a texture's twin carries — what the exporter plugin writes. @param {any} texture */
export function ktx2BytesOf(texture) {
	return twinOf(texture)?.bytes ?? null;
}

/** Forget a texture's twin (its next upload is the plain picture again). @param {any} texture */
export function dropTwin(texture) {
	const twin = twins.get(texture);
	if (!twin) return;
	if (twin.saved) restore(texture, twin);
	twins.delete(texture);
	stats.dropped++;
	for (const ref of live) if (ref.deref() === texture || !ref.deref()) live.delete(ref);
	// the GL texture bound may be the compressed one: the plain picture must go up again
	if (!twin.failed) texture.needsUpdate = true;
}

/** GPU bytes a texture takes: its twin's compressed mip chain when it has one, else RGBA8 with
 * mips. What 46-meter's texture-memory row can read. @param {any} texture */
export function gpuBytesOf(texture) {
	const c = twinOf(texture)?.compressed;
	if (c) {
		let sum = 0;
		for (const m of c.mipmaps) sum += m.data?.byteLength ?? 0;
		return sum;
	}
	const w = texture?.image?.width ?? 0;
	const h = texture?.image?.height ?? 0;
	return Math.round(w * h * 4 * (texture?.generateMipmaps === false ? 1 : 4 / 3));
}

/** @param {any} texture @param {Twin} twin */
function restore(texture, twin) {
	for (const key of SWAP_KEYS) texture[key] = twin.saved[key];
	twin.saved = null;
}

/** The render-bracket pass lod.js runs first-in, last-out. */
const twinPass = {
	/** @param {any} renderer */
	before(renderer) {
		let swapped = 0;
		for (const ref of live) {
			const texture = ref.deref();
			if (!texture) {
				live.delete(ref);
				continue;
			}
			const twin = twins.get(texture);
			if (!twin?.compressed) continue;
			if (texture.source.version !== ownVersion.get(texture.source)) {
				// somebody changed the picture: the twin no longer shows it
				dropTwin(texture);
				continue;
			}
			const c = twin.compressed;
			twin.saved = {};
			for (const key of SWAP_KEYS) twin.saved[key] = texture[key];
			texture.isCompressedTexture = true;
			texture.mipmaps = c.mipmaps;
			texture.format = c.format;
			texture.type = c.type;
			texture.internalFormat = null;
			texture.generateMipmaps = false;
			if (c.mipmaps.length < 2) texture.minFilter = LinearFilter;
			texture.flipY = false;
			texture.premultiplyAlpha = c.premultiplyAlpha;
			swapped++;
			const props = renderer?.properties?.get?.(texture);
			// uploaded before, under some other key (the plain picture): upload the twin now
			if (props?.__webglInit && props.__cacheKey !== cacheKeyOf(texture)) {
				texture.needsUpdate = true;
				ownVersion.set(texture.source, texture.source.version);
				stats.uploads++;
			}
		}
		stats.swapped = swapped;
	},
	after() {
		for (const ref of live) {
			const texture = ref.deref();
			const twin = texture && twins.get(texture);
			if (twin?.saved) restore(texture, twin);
		}
	}
};

/**
 * What one texture's twin is doing, for the suite: ready, its GPU format, and whether the GL
 * texture three holds for it is the COMPRESSED one (its upload cache key says so).
 * @param {any} texture
 */
export function twinState(texture) {
	const twin = twinOf(texture);
	if (!twin) return null;
	const c = twin.compressed;
	const props = get(globalRenderer)?.properties?.get?.(texture);
	let key = null;
	if (c) {
		/** @type {any} */
		const probe = {};
		for (const k of [
			'wrapS',
			'wrapT',
			'wrapR',
			'magFilter',
			'minFilter',
			'anisotropy',
			'unpackAlignment',
			'colorSpace'
		])
			probe[k] = texture[k];
		Object.assign(probe, {
			internalFormat: null,
			format: c.format,
			type: c.type,
			generateMipmaps: false,
			flipY: false,
			premultiplyAlpha: c.premultiplyAlpha
		});
		if (c.mipmaps.length < 2) probe.minFilter = LinearFilter;
		key = cacheKeyOf(probe);
	}
	return {
		ready: !!c,
		format: c?.format ?? null,
		mips: c?.mipmaps?.length ?? 0,
		bytes: twin.bytes.byteLength,
		uploadedCompressed: !!key && props?.__cacheKey === key,
		gpuBytes: gpuBytesOf(texture)
	};
}

/** For the suite and the stats plate. */
export function twinStats() {
	let count = 0;
	for (const ref of live) if (ref.deref()) count++;
	return { ...stats, live: count };
}

const MAP_SLOTS = [
	'map',
	'normalMap',
	'roughnessMap',
	'metalnessMap',
	'emissiveMap',
	'aoMap',
	'alphaMap',
	'bumpMap',
	'displacementMap',
	'lightMap',
	'specularIntensityMap',
	'specularColorMap',
	'clearcoatMap',
	'clearcoatNormalMap',
	'clearcoatRoughnessMap',
	'sheenColorMap',
	'sheenRoughnessMap',
	'transmissionMap',
	'thicknessMap',
	'iridescenceMap',
	'anisotropyMap'
];

/** Every (material, slot, texture) under a parsed tree. @param {any} root */
function textureSlots(root) {
	/** @type {{material: any, slot: string, texture: any}[]} */
	const out = [];
	const seen = new Set();
	root?.traverse?.((/** @type {any} */ o) => {
		for (const material of Array.isArray(o.material)
			? o.material
			: o.material
				? [o.material]
				: []) {
			if (seen.has(material)) continue;
			seen.add(material);
			for (const slot of MAP_SLOTS)
				if (material[slot]?.isTexture) out.push({ material, slot, texture: material[slot] });
		}
	});
	return out;
}

/** source -> glTF texture index, from a parse's associations. @param {any} gltf */
function indexBySource(gltf) {
	/** @type {Map<any, number>} */
	const out = new Map();
	for (const [object, ref] of gltf?.parser?.associations ?? []) {
		if (object?.isTexture && Number.isInteger(ref?.textures) && !out.has(object.source))
			out.set(object.source, ref.textures);
	}
	return out;
}

/** The glTF JSON + BIN of what was parsed: GLB bytes, .gltf bytes, or the JSON object the wire
 * carries. @param {any} input */
function containerOf(input) {
	if (!input) return null;
	if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return unpackGlb(asBytes(input));
	if (typeof input === 'object' && input.asset) return { json: input, bin: null };
	if (typeof input === 'string') return { json: JSON.parse(input), bin: null };
	return null;
}

/** Does a parsed file carry KHR_texture_basisu at all? Cheap (no image decode). @param {any} input */
export function hasKtx2(input) {
	try {
		const c = containerOf(input);
		return !!c && (c.json.extensionsUsed ?? []).includes('KHR_texture_basisu');
	} catch {
		return false;
	}
}

/**
 * After parsing a file whose KTX2 textures carry a PLAIN FALLBACK (the loader drew the plain
 * image): give each such texture its twin. Resolves how many textures got one.
 * @param {any} gltf three's parse result @param {any} input the bytes / JSON that were parsed
 */
export async function attachTwinsFromGltf(gltf, input) {
	const c = containerOf(input);
	if (!c) return 0;
	const ktx = ktx2Textures(c.json, c.bin);
	if (!ktx.size) return 0;
	const bySource = indexBySource(gltf);
	let n = 0;
	for (const { texture } of textureSlots(gltf.scene)) {
		if (texture.isCompressedTexture || twins.has(texture)) continue;
		const index = bySource.get(texture.source);
		const entry = index === undefined ? null : ktx.get(index);
		if (entry?.fallback && attachTwin(texture, entry.bytes)) n++;
	}
	return n;
}

/**
 * After parsing a file with the KTX2 loader on: every CompressedTexture in a material is replaced
 * by an ordinary texture drawn from it ONCE (three's WebGLTextureUtils.decompress, on its own
 * throwaway context — never the live canvas, which it would resize) and becomes that texture's
 * twin, so the tree is safe for every serializer and the GPU still holds the compressed data.
 * Resolves how many were replaced.
 * @param {any} gltf @param {any} input
 */
export async function sceneSafeGltf(gltf, input) {
	const slots = textureSlots(gltf?.scene).filter((s) => s.texture.isCompressedTexture);
	if (!slots.length) return 0;
	const c = containerOf(input);
	const ktx = c ? ktx2Textures(c.json, c.bin) : new Map();
	const bySource = indexBySource(gltf);
	// @ts-ignore - three addons ship no declarations here (project-wide)
	const { decompress } = await import('three/addons/utils/WebGLTextureUtils.js');
	/** @type {Map<any, any>} */
	const plainOf = new Map();
	let n = 0;
	for (const { material, slot, texture } of slots) {
		let plain = plainOf.get(texture);
		if (!plain) {
			plain = decompress(texture, 4096);
			stats.decompressed++;
			// decompress copies filters/wrap/colour space; the rest of the sampler state too
			plain.channel = texture.channel;
			plain.offset.copy(texture.offset);
			plain.repeat.copy(texture.repeat);
			plain.center.copy(texture.center);
			plain.rotation = texture.rotation;
			plain.matrixAutoUpdate = texture.matrixAutoUpdate;
			plain.anisotropy = texture.anisotropy;
			plain.userData = { ...(texture.userData ?? {}) };
			plain.generateMipmaps = true;
			if (plain.minFilter === LinearFilter && texture.mipmaps?.length > 1)
				plain.minFilter = texture.minFilter;
			const index = bySource.get(texture.source);
			const bytes = index === undefined ? null : ktx.get(index)?.bytes;
			if (bytes) attachTwin(plain, bytes, texture);
			plainOf.set(texture, plain);
		}
		material[slot] = plain;
		material.needsUpdate = true;
		n++;
	}
	return n;
}

/**
 * Parse glTF bytes for THE SCENE: like gltfLoader.parseGltf, but no CompressedTexture is left in
 * a material. A file whose KTX2 textures all carry a plain fallback parses WITHOUT the transcoder
 * (the plain images load) and gets its twins; a KTX2-only file parses with it and every
 * compressed texture is drawn into a plain one (`sceneSafeGltf`). A file with no KTX2 is
 * parseGltf exactly.
 * @param {ArrayBuffer} bytes @param {string} [resourcePath] @returns {Promise<any>}
 */
export async function parseGltfSceneSafe(bytes, resourcePath = '') {
	if (!hasKtx2(bytes)) return parseGltf(bytes, resourcePath);
	const c = containerOf(bytes);
	const ktx = c ? ktx2Textures(c.json, c.bin) : new Map();
	const required = (c?.json?.extensionsRequired ?? []).includes('KHR_texture_basisu');
	const allFallback = !required && ktx.size > 0 && [...ktx.values()].every((e) => e.fallback);
	if (allFallback) {
		if (!resourcePath && !checkGltf(bytes, 'file', 'model', { uris: false })) throw new Error('model refused by the load check');
		/** @type {any} */
		const gltf = await new Promise((resolve, reject) =>
			createGltfLoader(resourcePath ? undefined : embeddedOnlyManager('file', 'model')).parse(bytes, resourcePath, resolve, reject)
		);
		await attachTwinsFromGltf(gltf, bytes);
		return gltf;
	}
	const gltf = await parseGltf(bytes, resourcePath);
	await sceneSafeGltf(gltf, bytes);
	return gltf;
}

/**
 * A loaded .tpscene's KTX2 sidecars (sessions.applySession): each texture under `root` whose uuid
 * the index names gets its twin. Resolves how many did.
 * @param {any} root @param {Record<string, Uint8Array>} byTextureUuid
 */
export function attachTwinsByTextureUuid(root, byTextureUuid) {
	if (!byTextureUuid) return 0;
	let n = 0;
	for (const { texture } of textureSlots(root)) {
		const bytes = byTextureUuid[texture.uuid];
		if (bytes && !twins.has(texture) && attachTwin(texture, bytes)) n++;
	}
	return n;
}

/** The compressed texture types three ships (a sanity hook for the suite). */
export const isCompressed = (/** @type {any} */ t) => t instanceof CompressedTexture;

// ---- the exporter half ------------------------------------------------------------------------

/** @param {Uint8Array} bytes */
function base64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
	return btoa(s);
}

/**
 * A GLTFExporter plugin: a texture with a twin is written with BOTH sources — the plain image the
 * exporter already wrote, and `extensions.KHR_texture_basisu` pointing at the twin's KTX2 bytes
 * (used, not required). So the wire, autosave and a saved GLB carry the twin; a receiver parses
 * the fallback and `attachTwinsFromGltf` re-forms the twin there.
 * @param {any} writer
 */
export function twinExporterPlugin(writer) {
	/** @type {Map<Uint8Array, number>} */
	const written = new Map();
	return {
		name: 'TP_ktx2_twins',
		/** @param {any} map @param {any} textureDef */
		async writeTexture(map, textureDef) {
			const bytes = ktx2BytesOf(map);
			if (!bytes) return;
			const json = writer.json;
			let image = written.get(bytes);
			if (image === undefined) {
				json.images = json.images ?? [];
				/** @type {any} */
				const def = { mimeType: 'image/ktx2' };
				if (writer.options.binary === true)
					def.bufferView = await writer.processBufferViewImage(
						new Blob([/** @type {any} */ (bytes)])
					);
				else def.uri = 'data:image/ktx2;base64,' + base64(bytes);
				image = json.images.push(def) - 1;
				written.set(bytes, /** @type {number} */ (image));
			}
			textureDef.extensions = {
				...(textureDef.extensions ?? {}),
				KHR_texture_basisu: { source: image }
			};
			writer.extensionsUsed.KHR_texture_basisu = true;
		}
	};
}

/** Register the twin plugin on an exporter (every exporter that writes the SCENE: the wire,
 * autosave, gltfBytesFor). @template T @param {T} exporter @returns {T} */
export function withTwins(exporter) {
	/** @type {any} */ (exporter).register(twinExporterPlugin);
	return exporter;
}

/** The renderer the twins upload on (for the suite). */
export function twinRenderer() {
	return get(globalRenderer);
}
