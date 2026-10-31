// 47-cc0 (C1/C2) — THE FREE CC0 ASSET BROWSER, the pure half: no imports, no DOM, no stores, so
// vitest covers it whole (tests/unit/cc0Core.test.js).
//
// Two sources, both public, both CC0, neither needing a key:
//   · Poly Haven (api.polyhaven.com) — models, HDRIs, textures. Its API, its downloads
//     (dl.polyhaven.org) and its thumbnails (cdn.polyhaven.com) all answer `Access-Control-Allow-Origin: *`,
//     so the browser talks to it directly (MEASURED 2026-10-16, curl with an Origin header).
//   · ambientCG (ambientcg.com) — PBR materials. Its JSON API (v2 and v3) and its `/get?file=` download
//     redirect send NO CORS header, while the CDN the redirect lands on (acg-download.…) echoes the
//     Origin and the thumbnails (acg-media.…) answer `*`. So exactly two things go through the community
//     Worker (`<proxy>/acg/assets`, `<proxy>/acg/resolve`) and the zip itself comes straight from the CDN.
//
// A ROW is what the browser grid draws, whichever source it came from:
//   {source: 'polyhaven'|'ambientcg', kind: 'models'|'hdris'|'textures'|'materials', id, name,
//    categories: string[], tags: string[], authors: string[], thumb, url, downloads?, popularity}
// A SOURCE RECORD is what an imported asset keeps (Library item `source`, a GLB's scene extras, a
// material preset's `source`, an object's `userData.source`) — small, plain, safe to replicate:
//   {site, id, name, authors: string[], license: 'CC0', url}

/** the two sites, by key */
export const CC0_SITES = {
	polyhaven: { label: 'Poly Haven', home: 'https://polyhaven.com', license: 'CC0' },
	ambientcg: { label: 'ambientCG', home: 'https://ambientcg.com', license: 'CC0' },
	// 57 M5: VRM avatars from the Open Source Avatars registry (licence per collection: CC0, or CC-BY on request)
	osa: { label: 'Open Source Avatars', home: 'https://github.com/ToxSam/open-source-avatars', license: 'CC0' },
	motion: { label: 'Motion pack', home: 'https://quaternius.com', license: 'CC0' }
};

/** the browser's tabs: what each lists and where it comes from */
export const CC0_KINDS = [
	{ key: 'models', label: 'Models', source: 'polyhaven', phType: 'models' },
	{ key: 'hdris', label: 'HDRIs', source: 'polyhaven', phType: 'hdris' },
	{ key: 'textures', label: 'Textures', source: 'polyhaven', phType: 'textures' },
	{ key: 'materials', label: 'Materials', source: 'ambientcg', phType: null },
	{ key: 'avatars', label: 'Avatars', source: 'osa', phType: null },
	{ key: 'motion', label: 'Motion', source: 'motion', phType: null }
];

export const PH_API = 'https://api.polyhaven.com';
/** ambientCG's own API — only ever reached THROUGH the proxy (it has no CORS) */
export const ACG_API = 'https://ambientcg.com/api/v3';
/** the community Worker's CC0 routes (cloud worker-community, `/cc0/*`) */
export const DEFAULT_CC0_PROXY = 'https://theprototype.app/cc0';

/** the resolutions the picker offers; a source missing one falls back to the nearest LOWER */
export const RESOLUTIONS = ['1k', '2k', '4k'];

/** an ambientCG page — the grid pages in this many */
export const ACG_PAGE = 60;

/**
 * The default resolution for this device (the user's ruling: 1k on a Quest or a phone, 2k on a
 * desktop). A headset UA or a coarse pointer without a fine one is "small".
 * @param {{headset?: boolean, coarse?: boolean, fine?: boolean}} d
 */
export function defaultResolution(d) {
	if (d?.headset) return '1k';
	if (d?.coarse && !d?.fine) return '1k';
	return '2k';
}

/** a Poly Haven thumbnail (their CDN resizes) @param {string} id @param {number} [size] */
export function phThumb(id, size = 256) {
	return 'https://cdn.polyhaven.com/asset_img/thumbs/' + encodeURIComponent(id) + '.png?width=' + size + '&height=' + size;
}

/** @param {any} v @returns {string[]} */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 80)) : [];
}

/**
 * Poly Haven's `/assets?t=<type>` map -> rows, most downloaded first (their own "popular").
 * Authors come as `{name: role}`.
 * @param {any} map @param {'models'|'hdris'|'textures'} kind
 */
export function normalizePolyHaven(map, kind) {
	if (!map || typeof map !== 'object') return [];
	/** @type {any[]} */
	const rows = [];
	for (const [id, a] of Object.entries(map)) {
		if (!a || typeof a !== 'object' || !/^[\w.-]+$/.test(id)) continue;
		rows.push({
			source: 'polyhaven',
			kind,
			id,
			name: typeof a.name === 'string' && a.name ? a.name.slice(0, 120) : id,
			categories: strings(a.categories),
			tags: strings(a.tags),
			authors: a.authors && typeof a.authors === 'object' ? Object.keys(a.authors).slice(0, 8) : [],
			thumb: phThumb(id),
			url: 'https://polyhaven.com/a/' + encodeURIComponent(id),
			popularity: Number.isFinite(a.download_count) ? a.download_count : 0
		});
	}
	rows.sort((x, y) => y.popularity - x.popularity || x.id.localeCompare(y.id));
	return rows;
}

/**
 * ambientCG v3 `/assets` page -> rows. Every ambientCG asset is by its one author.
 * @param {any} page
 */
export function normalizeAmbientCg(page) {
	const list = Array.isArray(page?.assets) ? page.assets : [];
	/** @type {any[]} */
	const rows = [];
	for (const a of list) {
		const id = typeof a?.id === 'string' ? a.id : '';
		if (!/^[\w.-]+$/.test(id)) continue;
		const thumbs = a.thumbnails && typeof a.thumbnails === 'object' ? a.thumbnails : {};
		rows.push({
			source: 'ambientcg',
			kind: 'materials',
			id,
			name: typeof a.title === 'string' && a.title ? a.title.slice(0, 120) : id,
			categories: typeof a.category === 'string' ? [a.category] : [],
			tags: strings(a.tags),
			authors: ['Lennart Demes'],
			thumb: thumbs['256-JPG-242424'] || thumbs['256-PNG'] || thumbs['128-PNG'] || '',
			url: 'https://ambientcg.com/a/' + encodeURIComponent(id),
			downloads: Array.isArray(a.downloads) ? a.downloads : [],
			popularity: 0
		});
	}
	return rows;
}

/** the total an ambientCG page reports (for "load more") @param {any} page */
export function ambientCgTotal(page) {
	return Number.isFinite(page?.totalResults) ? page.totalResults : 0;
}

/**
 * Poly Haven `/categories/<type>` -> [{id, label, count}] without the `all` row, biggest first.
 * `collection: …` rows are left out — they name a set, not a kind of thing.
 * @param {any} map
 */
export function normalizePhCategories(map) {
	if (!map || typeof map !== 'object') return [];
	return Object.entries(map)
		.filter(([k, v]) => k !== 'all' && !k.startsWith('collection:') && Number.isFinite(v))
		.map(([k, v]) => ({ id: k, label: k.charAt(0).toUpperCase() + k.slice(1), count: /** @type {number} */ (v) }))
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/** ambientCG `/categories` -> the material ones @param {any} list */
export function normalizeAcgCategories(list) {
	if (!Array.isArray(list)) return [];
	return list
		.filter((c) => c && c.type === 'material' && typeof c.id === 'string')
		.map((c) => ({ id: c.id, label: typeof c.title === 'string' ? c.title : c.id, count: Number.isFinite(c.numberOfAssets) ? c.numberOfAssets : 0 }))
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * Search + category over rows (Poly Haven lists arrive whole, so this runs locally). Every word
 * of the query must hit the name, the id, a tag or a category.
 * @param {any[]} rows @param {{query?: string, category?: string}} [f]
 */
export function filterRows(rows, f = {}) {
	const words = String(f.query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const cat = String(f.category ?? '');
	return rows.filter((r) => {
		if (cat && !r.categories.includes(cat)) return false;
		if (!words.length) return true;
		const hay = [r.name, r.id, ...r.tags, ...r.categories].join(' ').toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** @param {any} byRes @param {string} res @returns {string | null} the key to use */
function pickRes(byRes, res) {
	if (!byRes || typeof byRes !== 'object') return null;
	if (byRes[res]) return res;
	const want = RESOLUTIONS.indexOf(res);
	const have = Object.keys(byRes)
		.map((k) => ({ k, n: parseInt(k, 10) }))
		.filter((x) => Number.isFinite(x.n))
		.sort((a, b) => a.n - b.n);
	if (!have.length) return null;
	// nearest LOWER first (a smaller file is the safe fallback), else the smallest there is
	const target = want >= 0 ? parseInt(RESOLUTIONS[want], 10) : 1;
	const lower = have.filter((x) => x.n <= target);
	return (lower.length ? lower[lower.length - 1] : have[0]).k;
}

/** only Poly Haven's own download host — a files document naming anything else is refused
 * @param {any} u */
export function isPhDownload(u) {
	return typeof u === 'string' && /^https:\/\/dl\.polyhaven\.org\//.test(u);
}

/**
 * What to download for one Poly Haven asset at a resolution, from its `/files/<id>` document.
 *   models   -> {res, gltf: {url, size}, include: [{path, url, size}], total}
 *   hdris    -> {res, url, size, fileName}
 *   textures -> {res, maps: {map, normalMap, roughness, metalness, ao}: {url, size}, total}
 * null when the document has nothing usable.
 * @param {any} files @param {string} kind @param {string} res
 */
export function phFilePlan(files, kind, res) {
	if (!files || typeof files !== 'object') return null;
	if (kind === 'models') {
		const at = pickRes(files.gltf, res);
		const g = at && files.gltf[at]?.gltf;
		if (!g || !isPhDownload(g.url)) return null;
		const include = Object.entries(g.include ?? {})
			.filter(([, v]) => isPhDownload(/** @type {any} */ (v)?.url))
			.map(([path, v]) => ({ path, url: /** @type {any} */ (v).url, size: /** @type {any} */ (v).size ?? 0 }));
		const total = (g.size ?? 0) + include.reduce((s, x) => s + (x.size || 0), 0);
		return { res: at, gltf: { url: g.url, size: g.size ?? 0 }, include, total };
	}
	if (kind === 'hdris') {
		const at = pickRes(files.hdri, res);
		const h = at && files.hdri[at]?.hdr;
		if (!h || !isPhDownload(h.url)) return null;
		return { res: at, url: h.url, size: h.size ?? 0, fileName: decodeURIComponent(h.url.split('/').pop() ?? 'sky.hdr') };
	}
	if (kind === 'textures') {
		const at = pickRes(files.Diffuse ?? files.diff, res);
		if (!at) return null;
		/** @type {Record<string, {url: string, size: number}>} */
		const maps = {};
		const take = (/** @type {string} */ slot, /** @type {string[]} */ keys) => {
			for (const k of keys) {
				const j = files[k]?.[at]?.jpg ?? files[k]?.[at]?.png;
				if (j && isPhDownload(j.url)) {
					maps[slot] = { url: j.url, size: j.size ?? 0 };
					return;
				}
			}
		};
		take('map', ['Diffuse', 'diff']);
		take('normalMap', ['nor_gl', 'Normal']);
		take('roughness', ['Rough', 'rough']);
		take('metalness', ['Metal', 'metal']);
		take('ao', ['AO', 'ao']);
		if (!maps.map) return null;
		const total = Object.values(maps).reduce((s, m) => s + (m.size || 0), 0);
		return { res: at, maps, total };
	}
	return null;
}

/**
 * The ambientCG download for a resolution: the JPG zip (PNG is ~2.5x the bytes for the same look),
 * nearest lower resolution when the asked one is missing.
 * @param {any[]} downloads @param {string} res @returns {{file: string, size: number, attributes: string, res: string} | null}
 */
export function acgDownloadFor(downloads, res) {
	if (!Array.isArray(downloads)) return null;
	/** @type {Record<string, any>} */
	const byRes = {};
	for (const d of downloads) {
		const m = /^(\d+)K-JPG$/i.exec(String(d?.attributes ?? ''));
		if (!m || String(d?.extension ?? 'zip').toLowerCase() !== 'zip') continue;
		const file = /[?&]file=([\w.-]+\.zip)$/i.exec(String(d.url ?? ''))?.[1] ?? '';
		if (file) byRes[m[1] + 'k'] = { file, size: d.size ?? 0, attributes: d.attributes };
	}
	const at = pickRes(byRes, res);
	return at ? { ...byRes[at], res: at } : null;
}

/** an ambientCG zip's file names -> which one is which map (the GL normal, never DX)
 * @param {string[]} names */
export function acgMapsFromNames(names) {
	/** @type {Record<string, string>} */
	const out = {};
	const find = (/** @type {RegExp} */ re) => names.find((n) => re.test(n) && /\.(jpe?g|png)$/i.test(n));
	const pairs = /** @type {[string, RegExp][]} */ ([
		['map', /_Color\./i],
		['normalMap', /_NormalGL\./i],
		['roughness', /_Roughness\./i],
		['metalness', /_Metalness\./i],
		['ao', /_AmbientOcclusion\./i],
		['opacity', /_Opacity\./i]
	]);
	for (const [slot, re] of pairs) {
		const hit = find(re);
		if (hit) out[slot] = hit;
	}
	return out;
}

/** @param {any} row the browser row @returns {{site: string, id: string, name: string, authors: string[], license: 'CC0', url: string}} */
export function sourceRecord(row) {
	return {
		site: row?.source === 'ambientcg' ? 'ambientcg' : 'polyhaven',
		id: String(row?.id ?? '').slice(0, 80),
		name: String(row?.name ?? row?.id ?? '').slice(0, 120),
		authors: strings(row?.authors).slice(0, 8),
		license: 'CC0',
		url: typeof row?.url === 'string' && /^https:\/\/(polyhaven\.com|ambientcg\.com)\//.test(row.url) ? row.url : ''
	};
}

/**
 * A source record as it arrives from anywhere (a stored item, a peer's object, a preset) — the
 * same shape or null. The one boundary every reader passes through.
 * @param {any} s
 */
export function normalizeSource(s) {
	if (!s || typeof s !== 'object') return null;
	const site = s.site === 'ambientcg' || s.site === 'polyhaven' ? s.site : null;
	if (!site) return null;
	return sourceRecord({ source: site, id: s.id, name: s.name, authors: s.authors, url: s.url });
}

/** "Wooden Crate 02 — James Ray Cock (Poly Haven, CC0)" @param {any} s */
export function creditLine(s) {
	const src = normalizeSource(s);
	if (!src) return '';
	const site = CC0_SITES[/** @type {'polyhaven'|'ambientcg'} */ (src.site)].label;
	return src.name + (src.authors.length ? ' — ' + src.authors.join(', ') : '') + ' (' + site + ', CC0)';
}

/** a file name a Library card can show @param {string} name @param {string} ext */
export function assetFileName(name, ext) {
	const base =
		String(name ?? 'asset')
			.replace(/[^\w -]+/g, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 60) || 'asset';
	return base + '.' + ext;
}

/**
 * Why a fetch failed, in words a person can act on. `online` is navigator.onLine at the time.
 * @param {any} err @param {boolean} online
 * @returns {{code: 'offline'|'http'|'proxy'|'network'|'size'|'format', message: string}}
 */
export function classifyError(err, online) {
	if (err?.code === 'size' || err?.code === 'format') return { code: err.code, message: String(err.message ?? '') };
	if (!online) return { code: 'offline', message: 'You are offline — the browser shows what it has cached. Connect to download.' };
	if (err?.code === 'proxy') return { code: 'proxy', message: 'The ambientCG relay did not answer (' + (err.status ?? 'no response') + '). Try again in a minute.' };
	if (Number.isFinite(err?.status)) return { code: 'http', message: 'The asset site answered ' + err.status + '. Try again in a minute.' };
	return { code: 'network', message: 'Could not reach the asset site. Check the connection and try again.' };
}

// ---- glTF -> GLB ----------------------------------------------------------------------------
//
// Poly Haven ships a model as a .gltf JSON plus a .bin and its texture images beside it. The
// import entry (the Explorer drop) takes ONE file, and a Library item is one blob, so the browser
// packs the set into a single binary glTF: every buffer and every image becomes a slice of ONE
// BIN chunk, images keep their own bytes (no re-encode — a JPG stays a JPG), and the credit rides
// `asset.copyright` and the default scene's `extras.source` (GLTFLoader puts scene extras on the
// root's userData, so a placed copy carries it through the ordinary object sync).

const MIME = /** @type {Record<string, string>} */ ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', ktx2: 'image/ktx2' });

/** @param {number} n */
const pad4 = (n) => (4 - (n % 4)) % 4;

/** @param {string} uri */
function decodeDataUri(uri) {
	const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
	if (!m) return null;
	if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]));
	const bin = atob(m[2]);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** the relative uris a .gltf needs fetched (buffers + images; data: uris excluded) @param {any} gltf */
export function gltfExternalUris(gltf) {
	const out = new Set();
	for (const b of gltf?.buffers ?? []) if (typeof b?.uri === 'string' && !b.uri.startsWith('data:')) out.add(b.uri);
	for (const im of gltf?.images ?? []) if (typeof im?.uri === 'string' && !im.uri.startsWith('data:')) out.add(im.uri);
	return [...out];
}

/**
 * Pack a .gltf document and its resources into GLB bytes.
 * @param {any} gltf the parsed .gltf JSON (not mutated)
 * @param {(uri: string) => Uint8Array | null | undefined} resource the bytes for a relative uri
 * @param {{source?: any}} [opts]
 * @returns {Uint8Array}
 */
export function packGlb(gltf, resource, opts = {}) {
	const doc = JSON.parse(JSON.stringify(gltf ?? {}));
	/** @type {Uint8Array[]} */
	const parts = [];
	let length = 0;
	const append = (/** @type {Uint8Array} */ bytes) => {
		const offset = length;
		parts.push(bytes);
		length += bytes.byteLength;
		const p = pad4(length);
		if (p) {
			parts.push(new Uint8Array(p));
			length += p;
		}
		return offset;
	};
	const bytesOf = (/** @type {string} */ uri) => {
		const data = uri.startsWith('data:') ? decodeDataUri(uri) : (resource(uri) ?? resource(decodeURIComponent(uri)));
		if (!data) throw Object.assign(new Error('missing ' + uri), { code: 'format' });
		return data;
	};
	const bufferOffsets = (doc.buffers ?? []).map((/** @type {any} */ b) => {
		if (typeof b?.uri !== 'string') throw Object.assign(new Error('a buffer without a uri'), { code: 'format' });
		const data = bytesOf(b.uri);
		if (Number.isFinite(b.byteLength) && data.byteLength < b.byteLength) throw Object.assign(new Error('short buffer ' + b.uri), { code: 'format' });
		return append(data);
	});
	for (const view of doc.bufferViews ?? []) {
		view.byteOffset = (view.byteOffset ?? 0) + (bufferOffsets[view.buffer ?? 0] ?? 0);
		view.buffer = 0;
	}
	if (!doc.bufferViews) doc.bufferViews = [];
	for (const image of doc.images ?? []) {
		if (typeof image?.uri !== 'string') continue;
		const ext = image.uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
		const data = bytesOf(image.uri);
		const offset = append(data);
		image.bufferView = doc.bufferViews.length;
		image.mimeType = image.mimeType ?? MIME[ext] ?? 'image/png';
		delete image.uri;
		doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
	}
	doc.buffers = length ? [{ byteLength: length }] : [];
	if (!doc.buffers.length) delete doc.buffers;
	const source = normalizeSource(opts.source);
	if (source) {
		doc.asset = { ...(doc.asset ?? { version: '2.0' }), copyright: creditLine(source) };
		const si = Number.isInteger(doc.scene) ? doc.scene : 0;
		if (Array.isArray(doc.scenes) && doc.scenes[si]) doc.scenes[si].extras = { ...(doc.scenes[si].extras ?? {}), source };
	}
	const json = new TextEncoder().encode(JSON.stringify(doc));
	const jsonPad = pad4(json.byteLength);
	const jsonLen = json.byteLength + jsonPad;
	const total = 12 + 8 + jsonLen + (length ? 8 + length : 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, 0x46546c67, true); // 'glTF'
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonLen, true);
	dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
	out.set(json, 20);
	out.fill(0x20, 20 + json.byteLength, 20 + jsonLen);
	if (length) {
		let at = 20 + jsonLen;
		dv.setUint32(at, length, true);
		dv.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
		at += 8;
		for (const p of parts) {
			out.set(p, at);
			at += p.byteLength;
		}
	}
	return out;
}

/** read a GLB's JSON chunk back (tests + the import check) @param {Uint8Array} bytes */
export function glbJson(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== 0x46546c67) return null;
	const len = dv.getUint32(12, true);
	return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
}

/** the BIN chunk of a GLB @param {Uint8Array} bytes */
export function glbBin(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const jsonLen = dv.getUint32(12, true);
	const at = 20 + jsonLen;
	if (at + 8 > bytes.byteLength) return new Uint8Array(0);
	const len = dv.getUint32(at, true);
	return bytes.subarray(at + 8, at + 8 + len);
}
