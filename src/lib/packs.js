import { writable, get } from 'svelte/store';
import { addItemFromBytes } from './explorer';

// N6 (roadmap 7 / ship-qa D1): object packs. Two sources, one normalized model:
//  - DEFAULT packs from static/libraryList.json (bundled today; the model bytes
//    move off-bundle to jsDelivr later by pointing PACKS_BASE at the repo CDN).
//  - IMPORTED packs from a self-describing manifest.json (.zip via fflate), stored
//    as real Explorer items in IndexedDB (persist across sessions).
// Packs stay LOCAL — the library is never replicated to peers (a future "Share"
// may change that). PLACING a pack item goes through the normal import path and
// replicates like any object. Thumbnails resolve lazily when a pack is opened,
// webp -> png -> the item's committed screenshot -> a placeholder.
//
// The pack repo/manifest structure is documented in PACKS.md.

/** Off-bundle base for remote packs (RP): the tagged jsDelivr mirror of
 * github.com/theprototype-app/packs. Bump the tag when pack content changes —
 * jsDelivr caches tags aggressively, so released builds stay stable. */
export const PACKS_BASE = 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@v1';

const INSTALLED_KEY = 'installedPacks';

/** normalized pack list (defaults + imported) @type {import('svelte/store').Writable<any[]>} */
export const packs = writable([]);
/** items of the currently open pack @type {import('svelte/store').Writable<any[]>} */
export const openPackItems = writable([]);

/** @type {Record<string, any[]>} per-pack item cache (fetched once on open) */
const itemCache = {};

/** @returns {any[]} imported packs persisted locally */
function getInstalled() {
	try {
		return JSON.parse(localStorage.getItem(INSTALLED_KEY) || '[]');
	} catch {
		return [];
	}
}
/** @param {any[]} list */
function setInstalled(list) {
	try {
		localStorage.setItem(INSTALLED_KEY, JSON.stringify(list));
	} catch {}
}

// P2: remember which thumbnail URL actually loaded per pack item, so switching
// packs shows them instantly (no re-probing webp->png->screenshot, no 404 flashes).
// Persisted; dropped when a pack is removed. (The browser HTTP-caches the bytes; this
// caches the RESOLUTION.)
const THUMB_KEY = 'packThumbCache';
/** @returns {Record<string, string>} */
function getThumbCache() {
	try {
		return JSON.parse(localStorage.getItem(THUMB_KEY) || '{}');
	} catch {
		return {};
	}
}
/** @param {string} packName @param {string} itemName */
export function cachedThumb(packName, itemName) {
	return getThumbCache()[`${packName}/${itemName}`] || null;
}
/** @param {string} packName @param {string} itemName @param {string} url */
export function rememberThumb(packName, itemName, url) {
	const c = getThumbCache();
	if (c[`${packName}/${itemName}`] === url) return;
	c[`${packName}/${itemName}`] = url;
	try {
		localStorage.setItem(THUMB_KEY, JSON.stringify(c));
	} catch {}
}
/** @param {string} packName */
function dropPackThumbs(packName) {
	const c = getThumbCache();
	const prefix = `${packName}/`;
	let changed = false;
	for (const k of Object.keys(c)) if (k.startsWith(prefix)) (delete c[k], (changed = true));
	if (changed)
		try {
			localStorage.setItem(THUMB_KEY, JSON.stringify(c));
		} catch {}
}

/**
 * Normalize a pack-index row. Two shapes feed this (RP):
 *  - the REMOTE `${PACKS_BASE}/index.json` — value/attribution/zip are repo-relative
 *    paths that must be prefixed with PACKS_BASE (the old code never prefixed
 *    listUrl/attributionUrl — the latent bug this fixes);
 *  - the BUNDLED /library/libraryList.json fallback — app-origin '/library/...'
 *    paths that pass through untouched (offline / fresh clones).
 * Absolute http(s) URLs always pass through.
 * @param {any} entry @param {boolean} remote
 */
function normalizeDefault(entry, remote) {
	/** @param {string} value */
	const resolve = (value) => {
		if (!value) return '';
		if (/^https?:\/\//.test(value)) return value;
		return remote ? `${PACKS_BASE}/${value.replace(/^\//, '')}` : value;
	};
	return {
		name: entry.name,
		title: entry.title || entry.name,
		source: 'default',
		base: remote ? `${PACKS_BASE}/${entry.name}` : `/library/${entry.name}`,
		listUrl: resolve(entry.value),
		// M-2: a `zip` entry is a self-describing .zip pack (manifest.json + assets/)
		// rather than the model-list format — installed via importPackZip on demand,
		// so it can carry audio/texture/text items, not just glTF models
		zip: resolve(entry.zip),
		attributionUrl: resolve(entry.attribution),
		// RP: where the content comes from (Source button); named sourceUrl because
		// `source` is already the default/imported discriminator
		sourceUrl: entry.source || '',
		copyright: entry.copyright || '',
		license: entry.license || ''
	};
}

/** Install a default-list `zip` pack: fetch the .zip and run it through the
 * normal import path (kind-agnostic, so audio/SFX packs work). @param {any} pack */
export async function installDefaultPackZip(pack) {
	if (!pack?.zip) throw new Error('this pack has no .zip to install');
	const res = await fetch(pack.zip);
	if (!res.ok) throw new Error('could not fetch the pack (' + res.status + ')');
	const file = new File([await res.blob()], (pack.zip.split('/').pop() || pack.name) + '.zip');
	return importPackZip(file);
}

/** Load the pack list: the remote CDN index first, the bundled libraryList.json
 * starter as the offline fallback, plus locally imported packs. */
export async function loadPacks() {
	let defaults = [];
	try {
		const res = await fetch(`${PACKS_BASE}/index.json`);
		if (res.ok) defaults = (await res.json()).map((/** @type {any} */ e) => normalizeDefault(e, true));
	} catch {
		/* CDN unreachable — fall back to the bundled starter below */
	}
	if (!defaults.length) {
		try {
			const res = await fetch('/library/libraryList.json');
			if (res.ok) defaults = (await res.json()).map((/** @type {any} */ e) => normalizeDefault(e, false));
		} catch {
			/* offline / no packs bundled — imported packs still work */
		}
	}
	packs.set([...defaults, ...getInstalled()]);
}

/** Ordered thumbnail URL candidates for a default-pack item. An ABSOLUTE
 * screenshot URL (khronos upstream) is the only candidate; otherwise the
 * committed screenshot leads (it always exists in our packs — probing
 * thumb.webp first spammed 404s on the CDN) with webp/png as extras.
 * @param {any} pack @param {any} item */
export function thumbCandidates(pack, item) {
	if (/^https?:\/\//.test(item.screenshot || '')) return [item.screenshot];
	const dir = `${pack.base}/${item.name}`;
	const list = [];
	if (item.screenshot) list.push(`${dir}/${item.screenshot}`);
	list.push(`${dir}/thumb.webp`, `${dir}/thumb.png`);
	return list;
}

/**
 * Fetch + normalize a pack's items (cached; publishes to openPackItems).
 * Default packs read their item-list JSON; imported packs list their stored
 * Explorer items. @param {any} pack @returns {Promise<any[]>}
 */
export async function loadPackItems(pack) {
	if (!pack) {
		openPackItems.set([]);
		return [];
	}
	if (itemCache[pack.name]) {
		openPackItems.set(itemCache[pack.name]);
		return itemCache[pack.name];
	}
	let items = [];
	if (pack.source === 'imported') {
		// imported packs already hold real Explorer item ids
		items = (pack.items || []).map((/** @type {any} */ it) => ({ ...it, packName: pack.name, imported: true }));
	} else {
		let raw = [];
		try {
			const res = await fetch(pack.listUrl);
			if (res.ok) raw = await res.json();
		} catch {
			/* pack list unreachable */
		}
		items = (Array.isArray(raw) ? raw : [])
			.filter((o) => o?.variants?.['glTF-Binary'])
			.map((o) => {
				// RP: item lists may carry ABSOLUTE glb URLs (khronos entries resolve to
				// the upstream KhronosGroup repo); relative ones resolve against the pack
				const glb = o.variants['glTF-Binary'];
				return {
					name: o.name,
					label: o.label || o.name,
					kind: 'object',
					glbUrl: /^https?:\/\//.test(glb) ? glb : `${pack.base}/${o.name}/glTF-Binary/${glb}`,
					thumbs: thumbCandidates(pack, o),
					resolvedThumb: cachedThumb(pack.name, o.name), // P2: skip re-probing if known
					packName: pack.name
				};
			});
	}
	itemCache[pack.name] = items;
	openPackItems.set(items);
	return items;
}

/** Look up a normalized pack by name. @param {string} name */
export function packByName(name) {
	return get(packs).find((/** @type {any} */ p) => p.name === name) ?? null;
}

/**
 * Import a .zip pack (manifest.json + assets/) as a LOCAL pack: unzip, store each
 * asset as a real Explorer item (IndexedDB, content-hash deduped), register the
 * pack. @param {File} file @returns {Promise<any>} the imported pack
 */
export async function importPackZip(file) {
	const { unzipSync, strFromU8 } = await import('fflate');
	let entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
	// P3: GitHub "Download ZIP" (and many bundlers) wrap everything in ONE top-level
	// folder, so manifest.json isn't at the root — descend into it. (assets/ + metadata/
	// live inside that wrapper.)
	if (!entries['manifest.json']) {
		const tops = new Set(Object.keys(entries).map((/** @type {string} */ k) => k.split('/')[0]));
		if (tops.size === 1) {
			const prefix = [...tops][0] + '/';
			/** @type {Record<string, any>} */
			const stripped = {};
			for (const [k, v] of Object.entries(entries)) if (k.startsWith(prefix)) stripped[k.slice(prefix.length)] = v;
			entries = stripped;
		}
	}
	const manifestRaw = entries['manifest.json'];
	if (!manifestRaw) throw new Error('pack .zip has no manifest.json (at the root or in one wrapper folder)');
	const manifest = JSON.parse(strFromU8(manifestRaw));
	const id = manifest.id || file.name.replace(/\.zip$/i, '');
	/** @type {any[]} */
	const items = [];
	for (const decl of manifest.items || []) {
		const bytes = entries[decl.file];
		if (!bytes) continue;
		// slice the VIEW (byteOffset..length) so fflate's shared buffer can't corrupt
		// the content hash (sessions.js gotcha)
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const name = decl.file.split('/').pop() || decl.name || 'item';
		const stored = await addItemFromBytes(buf, name, null);
		items.push({
			id: stored.id,
			name: decl.name || stored.name,
			kind: stored.kind,
			thumbnail: stored.thumbnail,
			license: decl.license || manifest.license || '',
			author: decl.author || manifest.author || '',
			source: decl.source || ''
		});
	}
	const pack = {
		name: id,
		title: manifest.name || id,
		source: 'imported',
		items,
		copyright: manifest.author ? `© ${manifest.author}` : '',
		license: manifest.license || '',
		homepage: manifest.homepage || '',
		attributionHtml: attributionHtmlFrom(manifest)
	};
	const installed = getInstalled().filter((/** @type {any} */ p) => p.name !== id);
	installed.push(pack);
	setInstalled(installed);
	delete itemCache[id];
	packs.update((list) => [...list.filter((/** @type {any} */ p) => p.name !== id), pack]);
	return pack;
}

/** Build a simple attribution HTML fragment from a manifest (imported packs). @param {any} manifest */
function attributionHtmlFrom(manifest) {
	const rows = (manifest.items || [])
		.filter((/** @type {any} */ i) => i.author || i.source || i.license)
		.map(
			(/** @type {any} */ i) =>
				`<li>${i.name}${i.author ? ' — ' + i.author : ''}${i.license ? ' (' + i.license + ')' : ''}${
					i.source ? ` <a href="${i.source}" target="_blank" rel="noopener">source</a>` : ''
				}</li>`
		)
		.join('');
	return (
		`<h3>${manifest.name || 'Pack'}</h3>` +
		(manifest.author ? `<p>By ${manifest.author}</p>` : '') +
		(manifest.license ? `<p>License: ${licenseLabel(manifest.license)}</p>` : '') +
		(manifest.homepage ? `<p><a href="${manifest.homepage}" target="_blank" rel="noopener">${manifest.homepage}</a></p>` : '') +
		(rows ? `<ul>${rows}</ul>` : '')
	);
}

/** B3 (.tpscene): the imported packs, for bundling into a scene export. */
export function installedPacksSnapshot() {
	return getInstalled();
}

/** B3: (re)register an imported pack (e.g. restored from a .tpscene) locally. @param {any} pack */
export function registerImportedPack(pack) {
	const installed = getInstalled().filter((/** @type {any} */ p) => p.name !== pack.name);
	installed.push({ ...pack, source: 'imported' });
	setInstalled(installed);
	delete itemCache[pack.name];
	packs.update((list) => [...list.filter((/** @type {any} */ p) => p.name !== pack.name), { ...pack, source: 'imported' }]);
}

/** Remove an imported pack (its item blobs stay in the Explorer library). @param {string} name */
export function removeImportedPack(name) {
	setInstalled(getInstalled().filter((/** @type {any} */ p) => p.name !== name));
	delete itemCache[name];
	dropPackThumbs(name); // P2: forget cached thumbnails so a re-import re-resolves
	packs.update((list) => list.filter((/** @type {any} */ p) => p.name !== name));
}

/** SPDX id -> human label (falls back to the raw id). @param {string} id */
export function licenseLabel(id) {
	/** @type {Record<string, string>} */
	const map = {
		'CC0-1.0': 'CC0 1.0 (Public Domain)',
		'CC-BY-4.0': 'Creative Commons Attribution 4.0',
		'CC-BY-SA-4.0': 'Creative Commons Attribution-ShareAlike 4.0',
		'CC-BY-NC-4.0': 'Creative Commons Attribution-NonCommercial 4.0',
		MIT: 'MIT License',
		'Apache-2.0': 'Apache License 2.0'
	};
	return map[id] || id;
}
