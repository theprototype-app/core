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
//
// 72 LK2 — THE LIGHT AND THE VISIBLE SKY ARE TWO THINGS NOW. A bundled sky's light comes from its
// small UltraHDR file (the .hdr is the fallback): that PMREM shows first, so a scene is lit and has
// its sky after one small download. Then, if this machine should show more, the larger file
// (resolveSkyQuality) becomes a plain cube on scene.background and swaps in; the light never
// changes, so nothing in the scene shifts at the swap. The cube's face is a quarter of the file's
// width, the same angular resolution as the file, not three's automatic equirect conversion (a
// face as tall as the file: four times the memory). A blurred sky stays on the PMREM: blur reads
// its soft levels, and a sharp cube would have nothing to add. Only one sky cube is ever resident.
// The HDR is recovered ON THE GPU from the two 8-bit pictures (createImageBitmap decodes off the
// main thread), which is why this is not three's UltraHDRLoader: see ultraHdrCore.js.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { hdriOf, resolveHdriTier, resolveSkyQuality, skyFileTier, skyTierWidth, isHeadsetUA, TIER_MAX_WIDTH, downsampleRGBA, isHdriFileName } from './hdriCore.js';
import { bundledHdri, skyTiers, skyTierFile } from './catalog.js';
import { parseUltraHdr } from './ultraHdrCore.js';
import { gameSettingValues } from '../gameSettings';
import { skyEnv, envToneMapping, hdriStatus } from './skyEnv.js';
import { fetchSky, SkyUnavailable } from './skyFetch.js';
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
/** the visible sky's cube per `${src}|${file tier}` — one resident, plus a load on its way
 * @type {Map<string, any>} */
const skyCubes = new Map();
/** @type {any} the cube on scene.background right now, or null (the PMREM draws the sky) */
let appliedSky = null;
/** @type {{maxTexture?: number, maxCube?: number}} what this GPU can hold, once a renderer is seen */
let gpuCaps = {};
/** @type {string} the key the scene WANTS now (a late load for an older key is dropped) */
let wantKey = '';
/** @type {string} the sky cube the scene wants now (a late load for an older key is dropped) */
let wantSkyKey = '';
/** @type {(() => void) | null} stops watching the Explorer for a missing hash */
let missingWatch = null;

/** @param {Map<string, any>} map @param {string} key @param {any} value @param {(v: any) => void} [drop] */
function remember(map, key, value, drop) {
	map.delete(key);
	map.set(key, value);
	while (map.size > 2) {
		const oldest = map.entries().next().value;
		if (!oldest) break;
		map.delete(oldest[0]);
		drop?.(oldest[1]);
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

/** @returns {{phone: boolean, slowNet: boolean, memoryGB: number}} the facts Auto reads off this device */
function deviceFacts() {
	if (typeof navigator === 'undefined') return { phone: false, slowNet: false, memoryGB: 0 };
	const nav = /** @type {any} */ (navigator);
	const net = nav.connection;
	return {
		phone: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
		slowNet: !!net?.saveData || /(^|-)(2g|3g)$/.test(String(net?.effectiveType ?? '')),
		memoryGB: Number(nav.deviceMemory) || 0
	};
}

/**
 * The sky file this machine should SHOW for this hdri, or '' when the light's PMREM draws it.
 * @param {any} hdri the normalized hdri @param {any} renderer may be null (a re-tier check)
 */
function wantedSkyFile(hdri, renderer) {
	const row = bundledHdri(hdri.src);
	if (!row || !hdri.background || hdri.blur > 0) return '';
	const { phone, slowNet, memoryGB } = deviceFacts();
	const presenting = !!renderer?.xr?.isPresenting || !!get(isVRMode);
	const headset = typeof navigator !== 'undefined' && isHeadsetUA(navigator.userAgent);
	const devicePref = get(hdriQuality);
	const quality = resolveSkyQuality({
		scene: hdri.quality,
		minimum: hdri.minQuality,
		gamePref: /** @type {any} */ (get(gameSettingValues))?.skyQuality,
		devicePref,
		presenting,
		headset,
		phone,
		slowNet,
		postOff: !!get(qualityOverrides)?.postOff
	});
	const file = skyFileTier(quality, skyTiers(row), { ...gpuCaps, memoryGB, phone });
	// 1K: the full light's map already has that sharpness; the headset's small map does not, and a
	// sky is the largest thing in a headset — unless the person pinned Low on purpose
	if (file === '1k') return (presenting || headset) && devicePref !== 'low' ? file : '';
	return file;
}

/** @param {{target?: any}} entry */
function dropSky(entry) {
	entry?.target?.dispose?.();
}

/**
 * Recover the HDR of an UltraHDR file into a half-float equirect target, on the GPU.
 * @param {any} renderer @param {ArrayBuffer} buffer @param {number} maxWidth the target's width cap
 * @returns {Promise<any>} a THREE.WebGLRenderTarget the caller disposes; throws on a bad file
 */
async function recoverUltraHdr(renderer, buffer, maxWidth) {
	const parsed = parseUltraHdr(buffer);
	if (!parsed) throw new Error('not an UltraHDR file');
	// flipY HERE: WebGL ignores UNPACK_FLIP_Y for an ImageBitmap
	/** @param {Uint8Array} bytes */
	const bitmap = (bytes) =>
		createImageBitmap(new Blob([/** @type {any} */ (bytes)], { type: 'image/jpeg' }), {
			imageOrientation: 'flipY',
			premultiplyAlpha: 'none',
			colorSpaceConversion: 'none'
		});
	const [sdrImage, gainImage] = await Promise.all([bitmap(parsed.primary), bitmap(parsed.gain)]);
	const texture = (/** @type {any} */ image, /** @type {string} */ colorSpace) => {
		const t = new THREE.Texture(image);
		t.flipY = false;
		t.generateMipmaps = false;
		t.minFilter = THREE.LinearFilter;
		t.magFilter = THREE.LinearFilter;
		t.colorSpace = colorSpace;
		t.needsUpdate = true;
		return t;
	};
	const sdr = texture(sdrImage, THREE.SRGBColorSpace);
	const gain = texture(gainImage, THREE.NoColorSpace);
	const width = Math.min(sdrImage.width, maxWidth);
	const target = new THREE.WebGLRenderTarget(width, Math.round((width * sdrImage.height) / sdrImage.width), {
		type: THREE.HalfFloatType,
		format: THREE.RGBAFormat,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		generateMipmaps: false,
		depthBuffer: false,
		colorSpace: THREE.LinearSRGBColorSpace
	});
	target.texture.mapping = THREE.EquirectangularReflectionMapping;
	const material = new THREE.ShaderMaterial({
		uniforms: {
			tSdr: { value: sdr },
			tGain: { value: gain },
			uMin: { value: parsed.meta.gainMapMin },
			uMax: { value: parsed.meta.gainMapMax },
			uInvGamma: { value: 1 / parsed.meta.gamma },
			uOffSdr: { value: parsed.meta.offsetSDR },
			uOffHdr: { value: parsed.meta.offsetHDR },
			uHalfMax: { value: HALF_MAX }
		},
		vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
		fragmentShader: `
			varying vec2 vUv;
			uniform sampler2D tSdr, tGain;
			uniform float uMin, uMax, uInvGamma, uOffSdr, uOffHdr, uHalfMax;
			void main() {
				vec3 log2Gain = mix(vec3(uMin), vec3(uMax), pow(texture2D(tGain, vUv).rgb, vec3(uInvGamma)));
				vec3 hdr = (texture2D(tSdr, vUv).rgb + uOffSdr) * pow(vec3(2.0), log2Gain) - uOffHdr;
				gl_FragColor = vec4(clamp(hdr, 0.0, uHalfMax), 1.0);
			}`,
		depthTest: false,
		depthWrite: false,
		blending: THREE.NoBlending,
		toneMapped: false
	});
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
	quad.frustumCulled = false;
	const scene = new THREE.Scene();
	scene.add(quad);
	const previous = renderer.getRenderTarget();
	const xrWas = renderer.xr.enabled;
	renderer.xr.enabled = false; // a one-off into a target, never through the XR cameras
	try {
		renderer.setRenderTarget(target);
		renderer.render(scene, new THREE.Camera());
	} finally {
		renderer.xr.enabled = xrWas;
		renderer.setRenderTarget(previous);
		quad.geometry.dispose();
		material.dispose();
		sdr.dispose();
		gain.dispose();
		sdrImage.close();
		gainImage.close();
	}
	return target;
}

/**
 * Load the visible sky's cube if nobody is. A file that cannot be fetched or read is quiet: the
 * PMREM keeps drawing the sky (a CDN ref without the new files, an export that did not carry this size).
 * @param {any} renderer @param {string} src @param {string} file '2k'...
 */
function ensureSkyCube(renderer, src, file) {
	const key = src + '|' + file;
	const held = skyCubes.get(key);
	if (held) return held;
	const row = bundledHdri(src);
	const pending = (async () => {
		const buffer = await fetchSky(skyTierFile(/** @type {any} */ (row), file));
		const equirect = await recoverUltraHdr(renderer, buffer, skyTierWidth(file));
		try {
			const width = equirect.width;
			const target = new THREE.WebGLCubeRenderTarget(width / 4, {
				type: THREE.HalfFloatType,
				format: THREE.RGBAFormat,
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				generateMipmaps: false
			});
			target.fromEquirectangularTexture(renderer, equirect.texture);
			target.texture.name = 'hdri:' + src + '|sky-' + file;
			return { target, texture: target.texture, width };
		} finally {
			equirect.dispose();
		}
	})().then(
		(entry) => {
			if (wantSkyKey !== key) {
				skyCubes.delete(key);
				dropSky(entry);
				return;
			}
			skyCubes.set(key, entry);
			reapply();
		},
		(err) => {
			// stays in the map as a failure, so it is not fetched again on every re-apply; a re-tier
			// or the `online` event clears it
			skyCubes.set(key, { failed: true });
			console.info('[hdri] keeping the smaller sky:', String(err?.message ?? err));
		}
	);
	/** @type {any} */
	const entry = { pending };
	skyCubes.set(key, entry);
	return entry;
}

/** Everything but this key leaves the GPU @param {string} keep @param {any} [scene] */
function retainSkyCube(keep, scene) {
	for (const [key, entry] of skyCubes) {
		if (key === keep || 'pending' in entry || 'failed' in entry) continue;
		if ('texture' in entry && entry.texture === appliedSky) {
			if (scene?.background === appliedSky) scene.background = applied;
			appliedSky = null;
		}
		dropSky(/** @type {any} */ (entry));
		skyCubes.delete(key);
	}
}

/** @param {string} src @returns {Promise<{buffer: ArrayBuffer, name: string} | null>} null = not here yet */
async function fetchSource(src) {
	const held = sources.get(src);
	if (held) return held;
	const row = bundledHdri(src);
	if (row) {
		// 72 LK2: the small UltraHDR file is the light; the .hdr answers while a CDN ref (or an old
		// export) does not have it. 59 T3: off the bundle — Cache Storage, else the CDN.
		const small = skyTierFile(row, '1k');
		/** @type {{buffer: ArrayBuffer, name: string}} */
		let got;
		try {
			got = { buffer: await fetchSky(small), name: small };
			if (!parseUltraHdr(got.buffer)) throw new SkyUnavailable('not an UltraHDR file');
		} catch {
			got = { buffer: await fetchSky(row.file), name: row.file };
		}
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
	if (/\.jpg$/i.test(source.name)) {
		// the GPU path: recovered at the tier's width (a bilinear halving is the low tier's filter)
		const recovered = await recoverUltraHdr(renderer, source.buffer, TIER_MAX_WIDTH[/** @type {'full'|'low'} */ (tier)]);
		const generator = new THREE.PMREMGenerator(renderer);
		const target = generator.fromEquirectangular(recovered.texture);
		generator.dispose();
		const width = recovered.width;
		recovered.dispose();
		const texture = target.texture;
		texture.name = 'hdri:' + src + '|' + tier;
		texture.userData.hdriTarget = target;
		return { texture, width, size: target.height / 4, ms: Math.round(performance.now() - t0) };
	}
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
			// 59 T3: a bundled sky the CDN could not deliver is not an error — the preset's flat
			// colours show (what an older peer shows) and the next `online` event tries again
			if (err instanceof SkyUnavailable) {
				console.info('[hdri] sky unavailable, showing the flat preset:', err.message);
				if (wantKey === key) hdriStatus.update((s) => ({ ...s, state: 'unavailable', src, tier, error: '' }));
				return;
			}
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
	if (scene && appliedSky && scene.background === appliedSky) scene.background = null;
	appliedSky = null;
	wantSkyKey = '';
	retainSkyCube('');
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
	if (get(hdriStatus).state !== 'off') hdriStatus.set({ state: 'off', src: '', tier: '', width: 0, pmremSize: 0, error: '', ms: 0, sky: '', skyWidth: 0 });
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
	gpuCaps = { maxTexture: renderer.capabilities?.maxTextureSize, maxCube: renderer.capabilities?.maxCubemapSize };
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
		if (appliedSky && scene.background === appliedSky) scene.background = null;
		applied = null;
		appliedSky = null;
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
	// 72 LK2: the light is up, so the larger sky may start; until it lands the PMREM draws the sky
	const skyFile = wantedSkyFile(hdri, renderer);
	const skyKey = skyFile ? hdri.src + '|' + skyFile : '';
	wantSkyKey = skyKey;
	const skyEntry = skyKey && 'texture' in entry ? ensureSkyCube(renderer, hdri.src, skyFile) : null;
	const cube = skyEntry && 'texture' in skyEntry ? skyEntry : null;
	// a new sky, or a machine asked to come down (the governor, a pin): the old cube goes right away
	retainSkyCube(skyKey, scene);
	appliedSky = cube ? cube.texture : null;
	if (hdri.background) {
		scene.background = appliedSky ?? texture;
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
	const skyWidth = cube ? cube.width : 0;
	if (status.state !== state || status.src !== hdri.src || status.tier !== tier || status.width !== ready.width || status.sky !== skyFile || status.skyWidth !== skyWidth)
		hdriStatus.set({ state, src: hdri.src, tier, width: ready.width, pmremSize: ready.size, error: '', ms: ready.ms, sky: skyFile, skyWidth });
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
		// 72 LK2: the light's tier and the sky's quality move on the same signals, and the sky's also
		// on this game's menu row
		const hdri = hdriOf(presetPayload(get(environment)));
		const t = currentTier(null) + '|' + (hdri ? wantedSkyFile(hdri, null) : '');
		if (t !== lastTier) {
			lastTier = t;
			if (wantKey) reapply();
		}
	};
	isVRMode.subscribe(retier);
	qualityOverrides.subscribe(retier);
	hdriQuality.subscribe(retier);
	gameSettingValues.subscribe(retier);
	// 59 T3: back online -> a sky that could not be fetched gets another try
	if (typeof window !== 'undefined')
		window.addEventListener('online', () => {
			for (const [k, e] of skyCubes) if ('failed' in e) skyCubes.delete(k);
			if (wantKey && (get(hdriStatus).state === 'unavailable' || wantSkyKey)) reapply();
		});
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
	skyCubes: () => [...skyCubes.entries()].map(([k, v]) => ({ key: k, ready: 'texture' in v, ...('texture' in v ? { width: v.width, face: v.target.width } : {}) })),
	skyOnScreen: () => appliedSky?.name ?? null,
	tier: () => currentTier(null),
	/** wait for the current load to settle */
	settle: async () => {
		for (let i = 0; i < 400; i++) {
			const s = get(hdriStatus).state;
			if (s === 'ready' || s === 'off' || s === 'error' || s === 'missing' || s === 'unavailable') return s;
			await new Promise((r) => setTimeout(r, 50));
		}
		return get(hdriStatus).state;
	}
};
