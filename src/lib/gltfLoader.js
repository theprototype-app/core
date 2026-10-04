// @ts-ignore - three addons ship no declarations here (project-wide)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// @ts-ignore
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
// @ts-ignore
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { get } from 'svelte/store';
import { globalRenderer } from '../stores/sceneStore';
import { gltfUsesExtension } from './modelLoaderCore';
// 36-export: decoder paths resolve against the PAGE, so an export served from a subpath finds them
import { pageUrl } from './export/exportBoot.js';

// 34 R7 (E1) — THE app's glTF loader, configured in ONE place. Four files used to build
// their own (packRefs, lodGroup, animatedImports, api.loadModel's predecessors in modules
// that bundled a SECOND copy of three's loader), each wiring Draco + Meshopt by hand and
// none of them KTX2. Every loader here shares one DRACOLoader (its worker pool is the
// expensive part) and the Meshopt decoder.
//
// KTX2 is LAZY: the Basis transcoder is ~585 KB (static/basis/, copied from three), so it
// is fetched only when a file actually carries KHR_texture_basisu — `parseGltf` sniffs the
// file's JSON first and attaches a KTX2Loader (detectSupport on the live renderer) before
// parsing. A plain GLB never loads it.

/** @type {any} */
let draco = null;
/** @type {Promise<any> | null} */
let ktx2 = null;
/** what parseGltf did, for the suite (a plain GLB must never fetch the transcoder) */
const stats = { parses: 0, ktx2Files: 0 };

function sharedDraco() {
	if (draco) return draco;
	draco = new DRACOLoader();
	draco.setDecoderPath(pageUrl('draco/'));
	return draco;
}

/** A GLTFLoader with Draco + Meshopt wired (KTX2 is attached by parseGltf when needed). */
export function createGltfLoader() {
	const loader = new GLTFLoader();
	loader.setDRACOLoader(sharedDraco());
	loader.setMeshoptDecoder(MeshoptDecoder);
	return loader;
}

/** The KTX2 loader, made once — null when there is no renderer to detect support on.
 * @returns {Promise<any>} */
function ktx2Loader() {
	if (!ktx2)
		ktx2 = (async () => {
			const renderer = get(globalRenderer);
			if (!renderer) return null;
			// @ts-ignore
			const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
			const loader = new KTX2Loader();
			loader.setTranscoderPath(pageUrl('basis/'));
			loader.detectSupport(renderer);
			return loader;
		})().catch((error) => {
			ktx2 = null;
			throw error;
		});
	return ktx2;
}

/**
 * Parse glTF bytes (a .glb or a .gltf JSON) with the app's loader. `resourcePath` is where a
 * .gltf's external buffers/images are resolved (the folder of its URL).
 * @param {ArrayBuffer} bytes @param {string} [resourcePath]
 * @returns {Promise<any>} three's `{scene, animations, ...}`
 */
export async function parseGltf(bytes, resourcePath = '') {
	const loader = createGltfLoader();
	stats.parses++;
	if (gltfUsesExtension(bytes, 'KHR_texture_basisu')) {
		stats.ktx2Files++;
		const k = await ktx2Loader();
		if (k) loader.setKTX2Loader(k);
	}
	return new Promise((resolve, reject) => loader.parse(bytes, resourcePath, resolve, reject));
}

/** Fetch + parse a glTF URL (blob:, data:, same-origin or CORS). @param {string} url */
export async function loadGltf(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
	const bytes = await response.arrayBuffer();
	const dir = /^(blob|data):/.test(url) ? '' : url.slice(0, url.lastIndexOf('/') + 1);
	return parseGltf(bytes, dir);
}

/** For the suite. */
export function gltfLoaderStats() {
	return { ...stats, ktx2Loader: !!ktx2 };
}
