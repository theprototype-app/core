import { writable } from 'svelte/store';

// 17-A3: the module gallery — a Browse tab in ModulesManager listing the
// community modules repo (github.com/theprototype-app/modules) off its
// index.json. PACKS_BASE precedent: off-bundle jsDelivr CDN, fetched on tab
// open, quiet empty state on failure (never a blocking error). Installing
// goes through the existing installUrl with the entry's source folder, so the
// record keeps a real URL — Update and the A2 dev reload work unchanged.

/** Off-bundle base for the community modules repo. @main (not a tag): the
 * gallery should list new modules without a core release; module CODE is
 * versioned by each manifest, and installs snapshot the fetched bytes. */
export const MODULES_BASE = 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main';

/** normalized gallery entries @type {import('svelte/store').Writable<any[]>} */
export const galleryModules = writable([]);
/** 'idle' | 'loading' | 'ready' | 'error' — error renders as a quiet empty
 * state @type {import('svelte/store').Writable<string>} */
export const galleryState = writable('idle');

/** @param {any} entry */
function normalizeEntry(entry) {
	if (!entry?.id || !entry?.name) return null;
	return {
		id: String(entry.id),
		name: String(entry.name),
		version: String(entry.version ?? ''),
		description: String(entry.description ?? ''),
		author: String(entry.author ?? ''),
		source: entry.source ? String(entry.source) : '',
		zip: entry.zip ? String(entry.zip) : ''
	};
}

let loaded = false;
/** Fetch + normalize the gallery index (once per session; force re-fetches).
 * @param {boolean=} force */
export async function loadModuleGallery(force = false) {
	if (loaded && !force) return;
	galleryState.set('loading');
	try {
		const response = await fetch(`${MODULES_BASE}/index.json`);
		if (!response.ok) throw new Error('index.json ' + response.status);
		const list = await response.json();
		galleryModules.set((Array.isArray(list) ? list : []).map(normalizeEntry).filter(Boolean));
		galleryState.set('ready');
		loaded = true;
	} catch (error) {
		console.log('module gallery unavailable', error);
		galleryModules.set([]);
		galleryState.set('error');
	}
}

/** The URL installUrl pulls an entry from (its source folder on the CDN).
 * @param {any} entry */
export function galleryInstallUrl(entry) {
	return entry?.source ? `${MODULES_BASE}/${entry.source.replace(/^\//, '')}` : '';
}

/** true when `a` is a newer dotted version than `b` @param {string} a @param {string} b */
export function versionNewer(a, b) {
	const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
	const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	}
	return false;
}
