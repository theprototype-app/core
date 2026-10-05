// 37-hdri — the HDRI LAYER of the environment: load an equirect HDRI (bundled or an Explorer
// item by content hash), prefilter it once into a PMREM, and hand that ONE texture to the sky
// (scene.background) and the image-based light (scene.environment).
//
// Reached only through environment.js's `registerHdriLayer` seam (startEnvironment imports
// this module lazily): environment must not import the loader, the Explorer or the quality
// governor — that family is where the SSR prerender TDZ-crashes (CLAUDE.md L4 seam rule).
//
// TIERS (LOCAL, never sent): 'full' = the source at <= 1024 px wide -> a 256 px PMREM;
// 'low' (Quest / a headset browser / in XR / the governor past "post off" / the user's pin)
// = box-filtered to 512 px -> a 128 px PMREM. Both draw the sky FROM the prefiltered PMREM
// (blur 0 samples its sharpest level, the same angular resolution as the equirect), so the
// source texture is disposed right after the prefilter and only one texture stays resident.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { hdriOf, resolveHdriTier, isHeadsetUA, TIER_MAX_WIDTH, downsampleRGBA, isHdriFileName } from './hdriCore.js';
import { bundledHdri } from './catalog.js';
import { skyEnv, envToneMapping, hdriStatus } from './skyEnv.js';
import { pageUrl } from '../export/exportBoot.js';
import { qualityOverrides } from '../qualityGovernor';
import { isVRMode } from '../../stores/sceneStore';
import { hdriQuality } from './hdriPrefs.js';
import { environment, presetPayload } from '../environment';

const HALF_MAX = 65000; // a sun pixel past half-float range becomes Inf and NaNs the PMREM blur

/** @type {() => void} */
let reapply = () => {};

/** raw source bytes per src (re-tiering never refetches) — the two most recent */
/** @type {Map<string, {buffer: ArrayBuffer, name: string}>} */
const sources = new Map();
/** prefiltered textures per `${src}|${tier}` — the two most recent */
/** @type {Map<string, {texture: any, width: number, size: number, ms: number} | {pending: Promise<any>}>} */
const prefiltered = new Map();
/** @type {any} the texture this layer last put on the scene */
let applied = null;
/** @type {string} the key the scene WANTS now (a late load for an older key is dropped) */
let wantKey = '';
/** @type {(() => void) | null} stops watching the Explorer for a missing hash */
let missingWatch = null;

/** @param {Map<string, any>} map @param {string} key @param {any} value @param {(v: any) => void} [drop] */
function remember(map, key, value, drop) {
	map.delete(key);
	map.set(key, value);
	while (map.size > 2) {
		const [oldKey, old] = map.entries().next().value;
		map.delete(oldKey);
		drop?.(old);
	}
}

/** @param {any} renderer */
function currentTier(renderer) {
	let pref = 'auto';
	try {
		pref = get(hdriQuality);
	} catch {}
	return resolveHdriTier({
		pref,
		presenting: !!renderer?.xr?.isPresenting || !!get(isVRMode),
		headset: typeof navigator !== 'undefined' && isHeadsetUA(navigator.userAgent),
		postOff: !!get(qualityOverrides)?.postOff
	});
}

/** @param {string} src @returns {Promise<{buffer: ArrayBuffer, name: string} | null>} null = not here yet */
async function fetchSource(src) {
	const held = sources.get(src);
	if (held) return held;
	const row = bundledHdri(src);
	if (row) {
		const res = await fetch(pageUrl(row.file));
		if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + row.file);
		const got = { buffer: await res.arrayBuffer(), name: row.file };
		remember(sources, src, got);
		return got;
	}
	const hash = src.slice('hash:'.length);
	const { itemByHash, itemBlob, explorerItems } = await import('../explorer.js');
	const item = itemByHash(hash);
	if (!item) {
		// golden rule 9: ask the mesh for the bytes, then WATCH the library — arriving bytes do
		// not change the environment, so nothing else would ever retry (the LUT lesson)
		const { requestAsset } = await import('../assetShare.js');
		requestAsset(hash);
		missingWatch?.();
		missingWatch = explorerItems.subscribe(() => {
			if (!itemByHash(hash)) return;
			missingWatch?.();
			missingWatch = null;
			reapply();
		});
		return null;
	}
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	const got = { buffer: await blob.arrayBuffer(), name: String(item.name ?? '') };
	remember(sources, src, got);
	return got;
}

/** Parse .hdr / .exr bytes to RGBA floats @param {ArrayBuffer} buffer @param {string} name */
async function parse(buffer, name) {
	if (/\.exr$/i.test(name)) {
		const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
		const loader = new EXRLoader().setDataType(THREE.FloatType);
		const t = /** @type {any} */ (loader.parse(buffer));
		if (t.format !== THREE.RGBAFormat) throw new Error('only RGBA .exr files are supported');
		return { data: /** @type {Float32Array} */ (t.data), width: t.width, height: t.height, flipY: t.flipY ?? false };
	}
	const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
	const loader = new HDRLoader().setDataType(THREE.FloatType);
	const t = /** @type {any} */ (loader.parse(buffer));
	return { data: /** @type {Float32Array} */ (t.data), width: t.width, height: t.height, flipY: t.flipY ?? true };
}

/** @param {any} renderer @param {string} src @param {string} tier */
async function prefilter(renderer, src, tier) {
	const t0 = performance.now();
	const source = await fetchSource(src);
	if (!source) return null;
	const img = await parse(source.buffer, source.name);
	const small = downsampleRGBA(img.data, img.width, img.height, TIER_MAX_WIDTH[/** @type {'full'|'low'} */ (tier)]);
	const half = new Uint16Array(small.data.length);
	for (let i = 0; i < half.length; i++) {
		const v = small.data[i];
		half[i] = THREE.DataUtils.toHalfFloat(v > HALF_MAX ? HALF_MAX : v >= 0 ? v : 0);
	}
	const equirect = new THREE.DataTexture(half, small.width, small.height, THREE.RGBAFormat, THREE.HalfFloatType);
	equirect.mapping = THREE.EquirectangularReflectionMapping;
	equirect.colorSpace = THREE.LinearSRGBColorSpace;
	equirect.minFilter = THREE.LinearFilter;
	equirect.magFilter = THREE.LinearFilter;
	equirect.generateMipmaps = false;
	equirect.flipY = img.flipY;
	equirect.needsUpdate = true;
	const generator = new THREE.PMREMGenerator(renderer);
	const target = generator.fromEquirectangular(equirect);
	generator.dispose();
	equirect.dispose();
	const texture = target.texture;
	texture.name = 'hdri:' + src + '|' + tier;
	// the render target owns the GPU memory; keep it reachable for dispose
	texture.userData.hdriTarget = target;
	return { texture, width: small.width, size: target.height / 4 /* cubeSize */, ms: Math.round(performance.now() - t0) };
}

/** @param {any} entry */
function dropEntry(entry) {
	if (!entry?.texture || entry.texture === applied) return;
	entry.texture.userData.hdriTarget?.dispose?.();
	entry.texture.dispose?.();
}

/** Kick a load for `key` if none is running @param {any} renderer @param {string} src @param {string} tier */
function ensure(renderer, src, tier) {
	const key = src + '|' + tier;
	const held = prefiltered.get(key);
	if (held) return held;
	hdriStatus.update((s) => ({ ...s, state: 'loading', src, tier, error: '' }));
	const pending = prefilter(renderer, src, tier).then(
		(entry) => {
			if (!entry) {
				prefiltered.delete(key);
				if (wantKey === key) hdriStatus.update((s) => ({ ...s, state: 'missing', src, tier }));
				return;
			}
			remember(prefiltered, key, entry, dropEntry);
			reapply();
		},
		(err) => {
			prefiltered.delete(key);
			console.warn('[hdri] could not load', src, err);
			if (wantKey === key) hdriStatus.update((s) => ({ ...s, state: 'error', src, tier, error: String(err?.message ?? err) }));
		}
	);
	const entry = { pending };
	prefiltered.set(key, entry);
	return entry;
}

/** a ready entry for the same src at any tier (shown while the wanted tier loads) @param {string} src */
function anyReady(src) {
	for (const [key, entry] of prefiltered) if (key.startsWith(src + '|') && 'texture' in entry) return entry;
	return null;
}

/** Undo everything this layer put on the scene @param {any} scene */
function clear(scene) {
	if (scene && applied) {
		if (scene.environment === applied) scene.environment = null;
		if (scene.background === applied) scene.background = null;
		scene.environmentIntensity = 1;
		scene.environmentRotation?.set(0, 0, 0);
		scene.backgroundBlurriness = 0;
		scene.backgroundRotation?.set(0, 0, 0);
	}
	applied = null;
	wantKey = '';
	missingWatch?.();
	missingWatch = null;
	if (get(skyEnv)) skyEnv.set(null);
	if (get(envToneMapping)) envToneMapping.set(null);
	if (get(hdriStatus).state !== 'off') hdriStatus.set({ state: 'off', src: '', tier: '', width: 0, pmremSize: 0, error: '', ms: 0 });
}

/**
 * THE LAYER (environment.js calls it from applyEnvironment, synchronously). Returns what it
 * did, so the environment knows whether the sky and the ambient are covered.
 * @param {any} scene @param {any} renderer @param {any} payload the preset payload @param {{passthrough: boolean}} opts
 * @returns {{ready: boolean, background: boolean, toneMapping: string, rotation: number}}
 */
function applyLayer(scene, renderer, payload, opts) {
	const hdri = hdriOf(payload);
	if (!hdri || opts.passthrough || !renderer) {
		clear(scene);
		return { ready: false, background: false, toneMapping: '', rotation: 0 };
	}
	const tier = currentTier(renderer);
	const key = hdri.src + '|' + tier;
	if (wantKey !== key) {
		missingWatch?.();
		missingWatch = null;
	}
	wantKey = key;
	const entry = ensure(renderer, hdri.src, tier);
	const ready = 'texture' in entry ? entry : anyReady(hdri.src);
	if (!ready) {
		// still loading: the payload's flat sky shows meanwhile (the environment's own path)
		if (applied && scene.environment === applied) scene.environment = null;
		if (applied && scene.background === applied) scene.background = null;
		applied = null;
		if (get(skyEnv)) skyEnv.set(null);
		if (get(envToneMapping)) envToneMapping.set(null);
		return { ready: false, background: false, toneMapping: '', rotation: 0 };
	}
	const texture = ready.texture;
	const rot = (hdri.rotation * Math.PI) / 180;
	applied = texture;
	scene.environment = texture;
	scene.environmentIntensity = hdri.intensity;
	scene.environmentRotation.set(0, rot, 0);
	if (hdri.background) {
		scene.background = texture;
		scene.backgroundBlurriness = hdri.blur;
		scene.backgroundIntensity = 1;
		scene.backgroundRotation.set(0, rot, 0);
	} else {
		scene.backgroundBlurriness = 0;
		scene.backgroundRotation.set(0, 0, 0);
	}
	const sky = get(skyEnv);
	if (!sky || sky.texture !== texture || sky.rotationY !== rot || sky.intensity !== hdri.intensity)
		skyEnv.set({ texture, rotationY: rot, intensity: hdri.intensity, size: ready.size });
	const tm = get(envToneMapping);
	if (tm?.mode !== hdri.toneMapping) envToneMapping.set({ mode: hdri.toneMapping });
	const status = get(hdriStatus);
	const isWanted = 'texture' in entry;
	const state = isWanted ? 'ready' : 'loading';
	if (status.state !== state || status.src !== hdri.src || status.tier !== tier || status.width !== ready.width)
		hdriStatus.set({ state, src: hdri.src, tier, width: ready.width, pmremSize: ready.size, error: '', ms: ready.ms });
	return { ready: true, background: hdri.background, toneMapping: hdri.toneMapping, rotation: hdri.rotation };
}

let installed = false;
/**
 * Plug the layer into the environment. `register` is environment.registerHdriLayer, `apply`
 * its applyEnvironment (called when a load lands or the tier changes).
 * @param {(layer: any) => void} register @param {() => void} apply
 */
export function installHdriLayer(register, apply) {
	reapply = apply;
	register(applyLayer);
	if (installed) return;
	installed = true;
	// the tier follows XR entry/exit, the governor and the local pin — a re-apply picks the new
	// key; the old texture stays on screen until the new one is prefiltered
	let lastTier = '';
	const retier = () => {
		const t = currentTier(null);
		if (t !== lastTier) {
			lastTier = t;
			if (wantKey) reapply();
		}
	};
	isVRMode.subscribe(retier);
	qualityOverrides.subscribe(retier);
	hdriQuality.subscribe(retier);
	// a CUSTOM HDRI is an Explorer file the scene references by hash: list it as a scene asset,
	// so a .tpscene save / an export bundles its bytes (the music-track precedent). Re-registered
	// when the hash changes, which is what makes the asset list recompute right away.
	import('../sceneAssets.js')
		.then(({ registerSceneAssetSource }) => {
			/** @type {(() => void) | null} */
			let dispose = null;
			let lastHash = '';
			environment.subscribe((state) => {
				const hdri = hdriOf(presetPayload(state));
				const hash = hdri?.src.startsWith('hash:') ? hdri.src.slice(5) : '';
				if (hash === lastHash) return;
				lastHash = hash;
				dispose?.();
				dispose = hash ? registerSceneAssetSource(() => [{ hash, name: hdri?.name || 'sky.hdr', kind: 'hdri' }]) : null;
			});
		})
		.catch(() => {});
}

/** For the UI: is this Explorer item an HDRI? @param {any} item */
export function isHdriItem(item) {
	return item?.kind === 'hdri' || isHdriFileName(item?.name);
}

/** TEST/EVIDENCE: what is cached and applied */
export const hdriDebug = {
	sources: () => [...sources.keys()],
	prefiltered: () => [...prefiltered.entries()].map(([k, v]) => ({ key: k, ready: 'texture' in v, ...('texture' in v ? { width: v.width, size: v.size, ms: v.ms } : {}) })),
	applied: () => applied?.name ?? null,
	tier: () => currentTier(null),
	/** wait for the current load to settle */
	settle: async () => {
		for (let i = 0; i < 400; i++) {
			const s = get(hdriStatus).state;
			if (s === 'ready' || s === 'off' || s === 'error' || s === 'missing') return s;
			await new Promise((r) => setTimeout(r, 50));
		}
		return get(hdriStatus).state;
	}
};
