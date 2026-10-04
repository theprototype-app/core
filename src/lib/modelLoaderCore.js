// 34 R7 (E1) — the RULES of api.loadModel, with no three, no store and no DOM, so the unit
// layer covers them (tests/unit/modelLoaderCore.test.js). The runtime is modelLoader.js.
//
// THE OPTIONS, normalized once at the boundary (a module's typo must not reach the loader):
//   lod          undefined | true | 'auto' -> 31-perf's generated levels on this instance
//                                             (and P1's pack-file levels when the URL is a
//                                             pack item whose row carries `lods`)
//                false                     -> no levels (every mesh opts out)
//                {ratios?, distances?, minTriangles?} -> generated levels with these options
//                [{file, ratio}, ...]       -> contract P1: pre-built level FILES beside the
//                                             model (resolved like the model's own path)
//   castShadow / receiveShadow   boolean, applied to every mesh; absent = as the file says
//   collider     'box'|'sphere'|'capsule'|'cylinder'|'cone'|'hull' -> the physics shape the
//                instance takes WHEN it is scene content with physics (userData.colliderHint,
//                which rides the wire); anything else = none
//   ownMaterials true -> each instance gets its own material copies (a hit flash paints
//                one enemy, not every copy); default false = shared, the cheap default

/** @typedef {{file: string, ratio?: number}} LodFile */
/**
 * @typedef {{lod: 'auto' | false | {ratios?: number[], distances?: number[], minTriangles?: number} | LodFile[],
 *   castShadow: boolean | null, receiveShadow: boolean | null, collider: string | null, ownMaterials: boolean}} ModelOptions
 */

/** the collider kinds a userData.colliderHint may request (colliderSpec's HINT_KINDS) */
export const COLLIDER_KINDS = Object.freeze(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull']);

/** @param {unknown} v */
const finiteList = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** @param {any} lod @returns {ModelOptions['lod']} */
function normalizeLod(lod) {
	if (lod === false || lod === 'off' || lod === 'none') return false;
	if (Array.isArray(lod)) {
		const files = lod
			.filter((l) => l && typeof l.file === 'string' && l.file.trim())
			.map((l) => {
				/** @type {LodFile} */
				const out = { file: l.file.trim() };
				if (typeof l.ratio === 'number' && Number.isFinite(l.ratio) && l.ratio > 0 && l.ratio < 1) out.ratio = l.ratio;
				return out;
			});
		return files.length ? files : 'auto';
	}
	if (lod && typeof lod === 'object') {
		/** @type {{ratios?: number[], distances?: number[], minTriangles?: number}} */
		const out = {};
		if (finiteList(lod.ratios)) out.ratios = lod.ratios.slice();
		if (finiteList(lod.distances)) out.distances = lod.distances.slice();
		if (typeof lod.minTriangles === 'number' && Number.isFinite(lod.minTriangles) && lod.minTriangles >= 0) out.minTriangles = lod.minTriangles;
		return out;
	}
	return 'auto';
}

/** @param {any} [opts] @returns {ModelOptions} */
export function normalizeModelOptions(opts) {
	const o = opts && typeof opts === 'object' ? opts : {};
	return {
		lod: normalizeLod(o.lod),
		castShadow: typeof o.castShadow === 'boolean' ? o.castShadow : null,
		receiveShadow: typeof o.receiveShadow === 'boolean' ? o.receiveShadow : null,
		collider: COLLIDER_KINDS.includes(o.collider) ? o.collider : null,
		ownMaterials: o.ownMaterials === true
	};
}

/**
 * Where a model's bytes live. A path the module PACKAGED ('assets/x.glb') resolves to its blob
 * URL; anything else (http(s), blob:, data:, a same-origin '/path') passes through. A packaged
 * path the module does not have is null — the caller says so instead of fetching the page.
 * @param {string} url @param {Record<string, string> | null | undefined} assets
 * @returns {string | null}
 */
export function resolveModelUrl(url, assets) {
	if (typeof url !== 'string' || !url.trim()) return null;
	const u = url.trim();
	if (assets && Object.prototype.hasOwnProperty.call(assets, u)) return assets[u];
	if (/^(https?:|blob:|data:)/i.test(u) || u.startsWith('/')) return u;
	if (assets) {
		const bare = u.replace(/^\.\//, '');
		if (Object.prototype.hasOwnProperty.call(assets, bare)) return assets[bare];
	}
	return null;
}

/**
 * Where a P1 level FILE lives, given what the model was asked for by. A packaged model's level
 * sits beside it in the package ('assets/tree.glb' + 'tree.lod1.glb' -> 'assets/tree.lod1.glb',
 * looked up in the module's files); a URL model's level sits beside the URL. An absolute file
 * passes through. null = nowhere to find it.
 * @param {string} asked the url/path the module passed to loadModel
 * @param {string} resolved what that resolved to
 * @param {string} file @param {Record<string, string> | null | undefined} assets
 * @returns {string | null}
 */
export function levelFileUrl(asked, resolved, file, assets) {
	if (typeof file !== 'string' || !file) return null;
	if (/^(https?:|blob:|data:)/i.test(file) || file.startsWith('/')) return file;
	const a = String(asked ?? '').trim();
	if (assets && Object.prototype.hasOwnProperty.call(assets, a)) {
		const dir = a.includes('/') ? a.slice(0, a.lastIndexOf('/') + 1) : '';
		return resolveModelUrl(dir + file, assets);
	}
	if (/^(blob|data):/i.test(resolved)) return null;
	return resolved.slice(0, resolved.lastIndexOf('/') + 1) + file;
}

/**
 * Does a glTF file use extension `name`? Reads the JSON chunk of a .glb (or the whole text of
 * a .gltf) without parsing anything else; false for anything unexpected (the loader then
 * decides — this only says whether a decoder must be attached first).
 * @param {ArrayBuffer | Uint8Array} bytes @param {string} name
 */
export function gltfUsesExtension(bytes, name) {
	try {
		const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		let text = '';
		const dec = new TextDecoder();
		if (u8.length >= 20 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
			const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
			const len = view.getUint32(12, true);
			text = dec.decode(u8.subarray(20, 20 + len));
		} else if (u8.length && u8[0] === 0x7b) {
			text = dec.decode(u8);
		} else return false;
		const json = JSON.parse(text);
		return [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])].includes(name);
	} catch {
		return false;
	}
}

/**
 * The pack folder (`<pack>/<item folder>`) of a URL under `packsBase`, or '' when it is not a
 * pack item there (a pack item lives at <base>/<pack>/<item>/glTF-Binary/<file>).
 * @param {string} url @param {string} packsBase
 */
export function packRowKeyOf(url, packsBase) {
	const base = String(packsBase ?? '').replace(/\/+$/, '') + '/';
	if (!base || base === '/' || typeof url !== 'string' || !url.startsWith(base)) return '';
	const parts = url.slice(base.length).split('/');
	return parts.length >= 3 && parts[0] && parts[1] ? parts[0] + '/' + parts[1] : '';
}
