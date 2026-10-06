import { writable, get } from 'svelte/store';
import { prefabs, patchPrefabs } from './prefabs';
import { idbGet, idbPut } from './idb';
import { showToast } from '../stores/appStore';
import { normFolder, normFolderName, parseTags, folderPaths, freeFolderName, rebase, parentOf, within } from './prefabLibraryCore';

// 37 R4 — FOLDERS AND TAGS IN THE LIBRARY'S PREFAB TAB. The pure half is
// prefabLibraryCore.js; this is the state and the writes. All LOCAL: the library is
// personal, so nothing here replicates, saves into a scene or undoes.

/** where the Prefabs view stands ('' = its root) */
export const prefabFolder = writable('');
/** the tags the view is filtered by (AND) @type {import('svelte/store').Writable<string[]>} */
export const prefabTagFilter = writable([]);
/** folders made on purpose — an empty folder is a place too @type {import('svelte/store').Writable<string[]>} */
export const prefabFolderList = writable([]);

const KEY = 'prefab-folders-v1';
let loaded = false;

export async function loadPrefabFolders() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		const list = await idbGet(KEY);
		if (Array.isArray(list)) prefabFolderList.set(list.map(normFolder).filter(Boolean));
	} catch (error) {
		console.log('prefab folders load failed', error);
	}
}

async function persistFolders() {
	try {
		await idbPut(KEY, get(prefabFolderList));
	} catch (error) {
		console.log('prefab folders persist failed', error);
	}
}

/** @returns {Set<string>} */
function existing() {
	return folderPaths(get(prefabs), get(prefabFolderList));
}

/** Make a folder under `parent`. Returns its path. @param {string} parent @param {string} [name] */
export async function createPrefabFolder(parent, name) {
	const base = normFolder(parent);
	const leaf = normFolderName(name) || freeFolderName(existing(), base);
	const path = base ? base + '/' + leaf : leaf;
	if (existing().has(path)) {
		showToast('A folder called "' + leaf + '" is already here');
		return path;
	}
	prefabFolderList.update((list) => [...list, path]);
	await persistFolders();
	return path;
}

/** Rename the folder at `path` (its contents and sub-folders go with it). @param {string} path @param {string} name */
export async function renamePrefabFolder(path, name) {
	const from = normFolder(path);
	const leaf = normFolderName(name);
	if (!from || !leaf) return null;
	const parent = parentOf(from);
	const to = parent ? parent + '/' + leaf : leaf;
	if (to === from) return to;
	if (existing().has(to)) {
		showToast('A folder called "' + leaf + '" is already here');
		return null;
	}
	return moveFolder(from, to);
}

/** @param {string} from @param {string} to */
async function moveFolder(from, to) {
	prefabFolderList.update((list) => [...new Set(list.map((p) => rebase(p, from, to)).filter(Boolean))]);
	await persistFolders();
	await patchPrefabs((p) => {
		const f = normFolder(p.folder);
		if (!within(f, from) || !f) return undefined;
		const next = rebase(f, from, to);
		const out = { ...p, folder: next };
		if (!next) delete out.folder;
		return out;
	});
	const here = get(prefabFolder);
	if (within(here, from)) prefabFolder.set(rebase(here, from, to));
	return to;
}

/** Delete a folder: whatever it held moves up to its parent (nothing is deleted with it).
 * @param {string} path */
export async function deletePrefabFolder(path) {
	const from = normFolder(path);
	if (!from) return;
	const parent = parentOf(from);
	prefabFolderList.update((list) => list.filter((p) => !within(p, from)));
	await persistFolders();
	await patchPrefabs((p) => {
		const f = normFolder(p.folder);
		if (!f || !within(f, from)) return undefined;
		// sub-folders keep their shape one level up
		const next = rebase(f, from, parent);
		const out = { ...p, folder: next };
		if (!next) delete out.folder;
		return out;
	});
	if (within(get(prefabFolder), from)) prefabFolder.set(parent);
}

/** Move prefabs into a folder ('' = the root). @param {string[]} ids @param {string} path */
export async function movePrefabsTo(ids, path) {
	const to = normFolder(path);
	const set = new Set(ids);
	await patchPrefabs((p) => {
		if (!set.has(p.id)) return undefined;
		const out = { ...p, folder: to };
		if (!to) delete out.folder;
		return out;
	});
}

/** Replace a prefab's tags. @param {string} id @param {string[]|string} tags */
export async function setPrefabTags(id, tags) {
	const list = Array.isArray(tags) ? parseTags(tags.join(',')) : parseTags(tags);
	await patchPrefabs((p) => {
		if (p.id !== id) return undefined;
		const out = { ...p, tags: list };
		if (!list.length) delete out.tags;
		return out;
	});
	// a filter on a tag nobody carries any more would show an empty view with no way to
	// see why — drop it
	const used = new Set(get(prefabs).flatMap((p) => p.tags ?? []));
	prefabTagFilter.update((f) => f.filter((t) => used.has(t)));
}

/** Add tags to several prefabs at once. @param {string[]} ids @param {string} text */
export async function addPrefabTags(ids, text) {
	const add = parseTags(text);
	if (!add.length) return;
	const set = new Set(ids);
	await patchPrefabs((p) => (set.has(p.id) ? { ...p, tags: [...new Set([...(p.tags ?? []), ...add])] } : undefined));
}

/** Toggle one tag in the view's filter. @param {string} tag */
export function toggleTagFilter(tag) {
	prefabTagFilter.update((f) => (f.includes(tag) ? f.filter((t) => t !== tag) : [...f, tag]));
}
