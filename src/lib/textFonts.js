// 64-text TX3 / TX3b — the fonts a text object draws with: the bundled five (static files,
// fetched only when a text uses them) and fonts the USER adds, which are ordinary Library assets
// addressed by content hash (the hudImages / clipAssets shape: an explorer hash resolved to an
// object URL, an assetShare pull on a miss, a WATCH that finishes the job when the bytes land).
//
// A user font is stored ONCE as sfnt bytes (TTF / OTF) or WOFF: troika and opentype.js read
// neither WOFF2 nor anything else, so a WOFF2 — an upload, or the file Google Fonts serves — is
// decoded at import (wawoff2, a lazy WASM chunk) and the TTF is what the Library keeps. A Google
// font is fetched ONCE, at import, by family name and becomes the same kind of asset: peers,
// offline play, reloads and exports read the asset, never Google (TX3).
//
// Fonts a scene's texts use are SCENE ASSETS (registerSceneAssetSource), so a .tpscene and an
// exported game carry their bytes like a sound or a clip does (TX6).
//
// Reached only from the lazy text runtime, the Inspector's Text section, the explorer's
// import hook and the agent tool — never on the boot path.

import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { explorerItems, itemByHash, itemBlob, addItemFromBytes } from './explorer';
import { requestAsset, sendAsset } from './assetShare';
import { registerSceneAssetSource } from './sceneAssets';
import { TEXT_FONTS, TEXT_FONTS_PATH, SOLID_FONTS_PATH, fontById, normalizeTextPath } from './textPathCore.js';
import { sniffFont, fontLicence, licenceLabel, cleanFamilyName, googleCssUrl, pickGoogleFontUrl, fontFileName } from './text3dCore.js';

/** the biggest font file the Library takes (a CJK family runs to ~16 MB; the shared cap is 25) */
export const MAX_FONT_BYTES = 20 * 1024 * 1024;

// ---- URLs --------------------------------------------------------------------------------------

/** @param {string} rel */
const appUrl = (rel) => (typeof document === 'undefined' ? rel : new URL(rel, document.baseURI).href);

/** flat text's bundled file ('sans' = null: troika's resolver, every script) @param {string} id */
export function bundledFlatUrl(id) {
	const f = fontById(id);
	return f.file ? appUrl(TEXT_FONTS_PATH + '/' + f.file) : null;
}

/** extruded text's bundled file @param {string} id */
export function bundledSolidUrl(id) {
	return appUrl(SOLID_FONTS_PATH + '/' + fontById(id).solid);
}

// ---- Library fonts by hash ---------------------------------------------------------------------

/** hash -> object URL @type {Map<string, string>} */
const urls = new Map();
/** @type {Map<string, Promise<string | null>>} */
const loading = new Map();
/** hashes asked of the mesh, still missing @type {Set<string>} */
const awaiting = new Set();
/** @type {Set<() => void>} */
const listeners = new Set();

/** be told when a font's bytes land (the runtime re-lays its texts out) @param {() => void} fn */
export function onFontLanded(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** the object URL for a Library font, or null while it is missing / loading. SYNCHRONOUS. @param {string} hash */
export function fontAssetUrl(hash) {
	return hash ? (urls.get(hash) ?? null) : null;
}

/** whether a Library font is still on its way (asked, not landed) @param {string} hash */
export function fontAssetAwaited(hash) {
	return awaiting.has(hash);
}

/**
 * Resolve a Library font to an object URL, pulling it from a peer when it is not here.
 * @param {string} hash @returns {Promise<string | null>}
 */
export async function resolveFontAsset(hash) {
	if (!hash) return null;
	const hit = urls.get(hash);
	if (hit) return hit;
	const busy = loading.get(hash);
	if (busy) return busy;
	const item = itemByHash(hash);
	if (!item) {
		awaiting.add(hash);
		startWatch();
		requestAsset(hash);
		return null;
	}
	const job = (async () => {
		try {
			const blob = await itemBlob(item.id);
			if (!blob) return null;
			const url = URL.createObjectURL(blob);
			urls.set(hash, url);
			return url;
		} catch (error) {
			console.log('font asset read failed', error);
			return null;
		} finally {
			loading.delete(hash);
		}
	})();
	loading.set(hash, job);
	return job;
}

/** @type {(() => void) | null} */
let stopWatch = null;
function startWatch() {
	if (stopWatch) return;
	stopWatch = explorerItems.subscribe((items) => {
		if (!awaiting.size || !Array.isArray(items)) return;
		const landed = [...awaiting].filter((hash) => items.some((it) => it?.hash === hash));
		if (!landed.length) return;
		for (const hash of landed) awaiting.delete(hash);
		void Promise.all(landed.map((hash) => resolveFontAsset(hash))).then(() => {
			for (const fn of listeners) {
				try {
					fn();
				} catch (error) {
					console.log('font listener failed', error);
				}
			}
		});
	});
}

/** push a font's bytes to the session on assign (a peer need not ask first) @param {string} hash */
export function shareFontAsset(hash) {
	if (hash) void sendAsset(hash);
}

// ---- reading fonts (opentype.js, lazy) ---------------------------------------------------------

/** @type {Promise<any> | null} */
let opentypeMod = null;
function opentype() {
	// @ts-ignore - opentype.js ships no types
	opentypeMod ??= import('opentype.js').then((m) => m.default ?? m);
	return opentypeMod;
}

/** url -> parsed Font @type {Map<string, Promise<any>>} */
const parsed = new Map();

/**
 * A parsed opentype.js Font for a URL (bundled file or a Library font's object URL), cached.
 * @param {string} url @returns {Promise<any>}
 */
export function fontFromUrl(url) {
	let job = parsed.get(url);
	if (!job) {
		job = (async () => {
			const res = await fetch(url);
			if (!res.ok) throw new Error('font fetch ' + res.status);
			const ot = await opentype();
			return ot.parse(await res.arrayBuffer());
		})();
		parsed.set(url, job);
		job.catch(() => parsed.delete(url));
	}
	return job;
}

/** @param {ArrayBuffer | Uint8Array} bytes */
async function parseBytes(bytes) {
	const ot = await opentype();
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return ot.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

/** how long the decoder may take to start + decode before the import says so (it never hangs a caller) */
const WOFF2_TIMEOUT_MS = 20000;

/**
 * WOFF2 -> TTF bytes, once at import (a lazy chunk: Google's decoder as wasm, vendored — the npm wrapper only
 * works under Node, see src/lib/vendor/wawoff2/decompress.js). Throws on bytes it cannot decode or on the timeout.
 * @param {Uint8Array} bytes @returns {Promise<Uint8Array>}
 */
export async function decodeWoff2(bytes) {
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('the WOFF2 decoder did not answer')), WOFF2_TIMEOUT_MS);
	});
	try {
		const work = (async () => {
			const { default: loadWoff2 } = await import('./vendor/wawoff2/decompress.js');
			const decoder = await loadWoff2();
			const out = decoder.decompress(bytes);
			if (out === false || !out) throw new Error('not a WOFF2 font');
			// a copy: the result can be a view into the decoder's memory
			return new Uint8Array(out);
		})();
		return /** @type {Uint8Array} */ (await Promise.race([work, timeout]));
	} finally {
		clearTimeout(timer);
	}
}

// ---- adding fonts ------------------------------------------------------------------------------

/**
 * @typedef {{hash: string, id?: string, name: string, family: string, licence: string, url: string, noEmbed: boolean, format: string}} FontAsset
 */

/**
 * Bytes -> a Library font asset. WOFF2 is decoded to TTF first (what troika and opentype.js read);
 * anything that does not parse as a font is refused with a plain message.
 * @param {ArrayBuffer | Uint8Array} raw @param {string} name a file name or family
 * @param {{folderId?: string | null}=} opts
 * @returns {Promise<{ok: true, font: FontAsset} | {ok: false, error: string}>}
 */
export async function addFontBytes(raw, name, opts = {}) {
	let bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	if (!bytes.length) return { ok: false, error: 'That font file is empty.' };
	if (bytes.length > MAX_FONT_BYTES) return { ok: false, error: `That font is too big (${(bytes.length / 1048576).toFixed(1)} MB; up to 20 MB).` };
	let format = sniffFont(bytes);
	if (!format) return { ok: false, error: 'That is not a font file (TTF, OTF, WOFF or WOFF2).' };
	if (format === 'woff2') {
		try {
			bytes = await decodeWoff2(bytes);
		} catch (error) {
			console.log('woff2 decode failed', error);
			return { ok: false, error: 'Could not read that WOFF2 font.' };
		}
		format = sniffFont(bytes) ?? 'ttf';
	}
	let font;
	try {
		font = await parseBytes(bytes);
	} catch (error) {
		console.log('font parse failed', error);
		return { ok: false, error: 'Could not read that font.' };
	}
	const lic = fontLicence(font);
	const family = lic.family || String(name ?? '').replace(/\.[a-z0-9]+$/i, '') || 'Font';
	const ext = format === 'otf' ? 'otf' : format === 'woff' ? 'woff' : 'ttf';
	const fileName = fontFileName(family, ext);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const item = await addItemFromBytes(/** @type {ArrayBuffer} */ (buffer), fileName, opts.folderId ?? null, { imported: true, kind: 'font' });
	if (!item?.hash) return { ok: false, error: 'Could not add the font to the Library.' };
	infoByHash.set(item.hash, { family, licence: licenceLabel(lic.licence, lic.url), url: lic.url, noEmbed: lic.noEmbed });
	return { ok: true, font: { hash: item.hash, id: item.id, name: item.name ?? fileName, family, licence: licenceLabel(lic.licence, lic.url), url: lic.url, noEmbed: lic.noEmbed, format: ext } };
}

/** what a Library font says about itself, cached per hash @type {Map<string, {family: string, licence: string, url: string, noEmbed: boolean}>} */
const infoByHash = new Map();

/**
 * A Library font's family + licence (reads the file once).
 * @param {string} hash @returns {Promise<{family: string, licence: string, url: string, noEmbed: boolean} | null>}
 */
export async function fontAssetInfo(hash) {
	const hit = infoByHash.get(hash);
	if (hit) return hit;
	const url = await resolveFontAsset(hash);
	if (!url) return null;
	try {
		const lic = fontLicence(await fontFromUrl(url));
		const info = { family: lic.family || itemByHash(hash)?.name || 'Font', licence: licenceLabel(lic.licence, lic.url), url: lic.url, noEmbed: lic.noEmbed };
		infoByHash.set(hash, info);
		return info;
	} catch {
		return null;
	}
}

/** test seam: what Google Fonts fetches go through (Playwright mocks the network instead) */
let fetcher = /** @type {typeof fetch} */ ((/** @type {any} */ u, /** @type {any} */ o) => fetch(u, o));

/**
 * A Google font by family name: fetched ONCE now, kept as a Library font asset. The CSS2 API's
 * latin subset (WOFF2) is decoded to TTF; nothing calls Google again — peers, reloads, offline
 * play and exports read the asset.
 * @param {string} familyRaw @param {{bold?: boolean, italic?: boolean}=} face
 * @returns {Promise<{ok: true, font: FontAsset} | {ok: false, error: string}>}
 */
export async function addGoogleFont(familyRaw, face = {}) {
	const family = cleanFamilyName(familyRaw);
	if (!family) return { ok: false, error: 'A Google Fonts family name is letters, digits and spaces (e.g. "Lobster").' };
	// already in the Library under that family? reuse it
	const held = libraryFonts().find((f) => f.family.toLowerCase() === family.toLowerCase());
	if (held) return { ok: true, font: { ...held, format: 'ttf' } };
	let css;
	try {
		const res = await fetcher(googleCssUrl(family, face));
		if (res.status === 400 || res.status === 404) return { ok: false, error: `Google Fonts has no family called "${family}".` };
		if (!res.ok) return { ok: false, error: `Google Fonts did not answer (${res.status}). Try again in a moment.` };
		css = await res.text();
	} catch {
		return { ok: false, error: 'Could not reach Google Fonts (offline?). A font added once works offline afterwards.' };
	}
	const url = pickGoogleFontUrl(css);
	if (!url) return { ok: false, error: `Google Fonts sent no file for "${family}".` };
	let bytes;
	try {
		const res = await fetcher(url);
		if (!res.ok) return { ok: false, error: `Could not download "${family}" (${res.status}).` };
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch {
		return { ok: false, error: `Could not download "${family}".` };
	}
	const out = await addFontBytes(bytes, family);
	if (out.ok) {
		// the name the person typed is the name they will look for
		const info = infoByHash.get(out.font.hash);
		if (info) info.family = family;
		out.font.family = family;
	}
	return out;
}

// ---- listing -----------------------------------------------------------------------------------

/** every font in the Library @returns {{hash: string, name: string, family: string, licence: string, url: string, noEmbed: boolean}[]} */
export function libraryFonts() {
	const items = /** @type {any[]} */ (get(explorerItems) ?? []);
	return items
		.filter((it) => it?.hash && (it.kind === 'font' || /\.(ttf|otf|woff2?)$/i.test(String(it.name ?? ''))))
		.map((it) => {
			const info = infoByHash.get(it.hash);
			return {
				hash: it.hash,
				name: String(it.name ?? ''),
				family: info?.family ?? String(it.name ?? 'Font').replace(/\.[a-z0-9]+$/i, ''),
				licence: info?.licence ?? '',
				url: info?.url ?? '',
				noEmbed: !!info?.noEmbed
			};
		});
}

/** the bundled list as the Inspector / agent see it */
export function bundledFonts() {
	return TEXT_FONTS.map((f) => ({ id: f.id, label: f.label, kind: f.kind, licence: 'SIL Open Font License' }));
}

/** every text object's record in the scene @returns {{uuid: string, name: string, rec: any}[]} */
export function sceneTexts() {
	/** @type {{uuid: string, name: string, rec: any}[]} */
	const out = [];
	const group = /** @type {any} */ (get(objectsGroup));
	group?.traverse?.((/** @type {any} */ o) => {
		if (o?.userData?.textPath && typeof o.userData.textPath === 'object') out.push({ uuid: o.uuid, name: o.name, rec: normalizeTextPath(o.userData.textPath) });
	});
	return out;
}

/** the fonts this scene's texts use: bundled ids + Library hashes */
export function sceneFonts() {
	/** @type {Map<string, {hash: string, family: string, texts: number, noEmbed: boolean}>} */
	const assets = new Map();
	/** @type {Map<string, number>} */
	const bundled = new Map();
	for (const t of sceneTexts()) {
		if (t.rec.fontAsset) {
			const row = assets.get(t.rec.fontAsset) ?? { hash: t.rec.fontAsset, family: t.rec.fontName || 'Font', texts: 0, noEmbed: !!t.rec.fontMeta?.noEmbed };
			row.texts++;
			assets.set(t.rec.fontAsset, row);
		} else bundled.set(t.rec.font, (bundled.get(t.rec.font) ?? 0) + 1);
	}
	return {
		assets: [...assets.values()],
		bundled: [...bundled.entries()].map(([id, texts]) => ({ id, label: fontById(id).label, texts }))
	};
}

// ---- saves and exports carry the fonts the scene uses (TX6) ------------------------------------

registerSceneAssetSource(() =>
	sceneFonts().assets.map((f) => ({ hash: f.hash, name: itemByHash(f.hash)?.name ?? fontFileName(f.family, 'ttf'), kind: 'font' }))
);

/** TEST seams */
export const textFontsForTest = {
	/** @param {typeof fetch} fn */
	setFetcher(fn) {
		fetcher = fn;
	},
	debug() {
		return { urls: [...urls.keys()], awaiting: [...awaiting], parsed: [...parsed.keys()] };
	}
};
