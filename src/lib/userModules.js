import { writable, get } from 'svelte/store';
import { unzipSync, strFromU8 } from 'fflate';
import { idbGet, idbPut } from './idb';
import { showToast } from '../stores/appStore';
import {
	initModules,
	isModuleLoaded,
	disabledModules,
	registerModuleAssets
} from './moduleSDK';

// User-installed modules: a zip upload or a URL pointing at a folder with
// manifest.json + a SELF-CONTAINED entry module (no import statements — the
// api object carries everything, incl. api.THREE; see docs/sdk/package.md).
// Files persist in IndexedDB; enabled modules activate on boot.
// SECURITY: modules run code in your session — the UI warns on install.

const KEY = 'user-modules-v1';

/** @type {import('svelte/store').Writable<any[]>} [{id, name, version, description, entry, files, source, installedAt}] */
export const userModules = writable([]);

async function persist() {
	try {
		await idbPut(KEY, get(userModules));
	} catch (error) {
		console.log('user modules persist failed', error);
	}
}

/** github.com browse links → raw.githubusercontent.com base @param {string} url */
export function normalizeRepoUrl(url) {
	const trimmed = url.trim().replace(/\/+$/, '').replace(/\/manifest\.json$/, '');
	const github = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
	if (github) {
		return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}/${github[4]}`;
	}
	return trimmed;
}

/** @param {any} manifest */
function validateManifest(manifest) {
	if (!manifest?.id || !manifest?.name || !manifest?.version)
		throw new Error('manifest.json needs id, name and version');
	return {
		id: String(manifest.id),
		name: String(manifest.name),
		version: String(manifest.version),
		description: manifest.description ? String(manifest.description) : '',
		entry: manifest.entry ? String(manifest.entry) : 'module.js'
	};
}

/** Register one stored record with the SDK @param {any} record */
export async function activateUserModule(record) {
	if (isModuleLoaded(record.id)) return true;
	try {
		const entryBytes = record.files[record.entry];
		if (!entryBytes) throw new Error('entry file "' + record.entry + '" missing');
		// asset blob urls for api.assetUrl('assets/...')
		/** @type {Record<string, string>} */
		const assets = {};
		Object.entries(record.files).forEach(([path, bytes]) => {
			if (path === record.entry || path === 'manifest.json') return;
			assets[path] = URL.createObjectURL(new Blob([bytes]));
		});
		registerModuleAssets(record.id, assets);
		const blobUrl = URL.createObjectURL(
			new Blob([record.files[record.entry]], { type: 'text/javascript' })
		);
		const imported = await import(/* @vite-ignore */ blobUrl);
		URL.revokeObjectURL(blobUrl);
		const mod = imported.default;
		if (!mod?.id || typeof mod.register !== 'function')
			throw new Error('entry must default-export { id, name, version, register }');
		if (mod.id !== record.id) throw new Error('manifest id and module id differ');
		initModules([mod]);
		return isModuleLoaded(record.id);
	} catch (error) {
		console.log('user module ' + record.id + ' failed', error);
		showToast('Module "' + record.name + '" failed to load: ' + error.message);
		disabledModules.update((list) => [...new Set([...list, record.id])]);
		return false;
	}
}

/** @param {any} record */
async function storeAndActivate(record) {
	userModules.update((list) => [...list.filter((m) => m.id !== record.id), record]);
	await persist();
	// installing implies wanting it on
	disabledModules.update((list) => list.filter((id) => id !== record.id));
	if (isModuleLoaded(record.id)) {
		showToast('"' + record.name + '" updated — reload to run the new version');
		return true;
	}
	return activateUserModule(record);
}

/** Install from a .zip file @param {File} file */
export async function installZip(file) {
	try {
		const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
		const manifestBytes = entries['manifest.json'];
		if (!manifestBytes) throw new Error('zip has no manifest.json at its root');
		const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)));
		/** @type {Record<string, Uint8Array>} */
		const files = {};
		Object.entries(entries).forEach(([path, bytes]) => {
			if (!path.endsWith('/')) files[path] = bytes;
		});
		const record = { ...manifest, files, source: 'zip', installedAt: Date.now() };
		const ok = await storeAndActivate(record);
		if (ok) showToast('Module "' + manifest.name + '" installed');
		return ok;
	} catch (error) {
		console.log('zip install failed', error);
		showToast('Install failed: ' + error.message);
		return false;
	}
}

/** Install from a URL serving manifest.json (+ listed files) @param {string} url */
export async function installUrl(url) {
	try {
		const base = normalizeRepoUrl(url);
		const manifestResponse = await fetch(base + '/manifest.json');
		if (!manifestResponse.ok) throw new Error('manifest.json not reachable (' + manifestResponse.status + ')');
		const rawManifest = await manifestResponse.json();
		const manifest = validateManifest(rawManifest);
		const list = Array.isArray(rawManifest.files) && rawManifest.files.length > 0
			? [...new Set([manifest.entry, ...rawManifest.files])]
			: [manifest.entry];
		/** @type {Record<string, Uint8Array>} */
		const files = {};
		for (const path of list) {
			const response = await fetch(base + '/' + path);
			if (!response.ok) throw new Error(path + ' not reachable');
			files[path] = new Uint8Array(await response.arrayBuffer());
		}
		const record = { ...manifest, files, source: base, installedAt: Date.now() };
		const ok = await storeAndActivate(record);
		if (ok) showToast('Module "' + manifest.name + '" installed from URL');
		return ok;
	} catch (error) {
		console.log('url install failed', error);
		showToast('Install failed: ' + error.message);
		return false;
	}
}

/** Re-fetch a URL-installed module @param {any} record */
export async function updateUserModule(record) {
	if (record.source === 'zip') {
		showToast('Zip modules update by uploading a new zip');
		return;
	}
	await installUrl(record.source);
}

/** @param {string} id */
export async function removeUserModule(id) {
	const record = get(userModules).find((m) => m.id === id);
	userModules.update((list) => list.filter((m) => m.id !== id));
	await persist();
	if (record && isModuleLoaded(id)) showToast('"' + record.name + '" removed — reload to fully unload it');
}

/** Boot: load stored records and activate the enabled ones */
export async function loadUserModules() {
	if (typeof indexedDB === 'undefined') return;
	try {
		const stored = (await idbGet(KEY)) ?? [];
		userModules.set(stored);
		const disabled = get(disabledModules);
		for (const record of stored) {
			if (!disabled.includes(record.id)) await activateUserModule(record);
		}
	} catch (error) {
		console.log('user modules load failed', error);
	}
}
