import { writable, get } from 'svelte/store';
import { unzipSync, strFromU8 } from 'fflate';
import { idbGet, idbPut } from './idb';
import { showToast } from '../stores/appStore';
import { showConfirm } from './confirmDialog';
import { APP_VERSION } from './version.js';
import {
	initModules,
	isModuleLoaded,
	disabledModules,
	registerModuleAssets,
	deactivateModule
} from './moduleSDK';

// User-installed modules: a zip upload or a URL pointing at a folder with
// manifest.json + a SELF-CONTAINED entry module (no import statements — the
// api object carries everything, incl. api.THREE; see docs/sdk/package.md).
// Files persist in IndexedDB; enabled modules activate on boot.
// SECURITY: modules run code in your session — the UI warns on install.

const KEY = 'user-modules-v1';

/** @type {import('svelte/store').Writable<any[]>} [{id, name, version, description, entry, files, source, installedAt}] */
export const userModules = writable([]);

// Install feedback lives INLINE under the install field, not in a toast: an
// install can fail for a dozen boring reasons (404, no CORS, no manifest at the
// root, wrong format) and the user needs to READ the reason while fixing the
// URL. A toast is gone in 5s and stacks badly with retries.
/** @type {import('svelte/store').Writable<{kind: 'idle'|'busy'|'ok'|'error', text: string, detail?: string}>} */
export const installStatus = writable({ kind: 'idle', text: '' });

/** @param {'idle'|'busy'|'ok'|'error'} kind @param {string} text @param {string=} detail */
function setStatus(kind, text, detail) {
	installStatus.set({ kind, text, detail });
}
export function clearInstallStatus() {
	setStatus('idle', '');
}

/** id of the most recently installed/updated module — the manager scrolls to it
 * and flashes its card the next time the User tab is shown, and clears this.
 * @type {import('svelte/store').Writable<string | null>} */
export const lastInstalled = writable(null);

/** @param {number} bytes */
function humanSize(bytes) {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB';
	return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** "3 files, 12.4 kB" @param {Record<string, any>} files */
function describeFiles(files) {
	const list = Object.values(files ?? {});
	const total = list.reduce((sum, bytes) => sum + (bytes?.byteLength ?? bytes?.length ?? 0), 0);
	return list.length + (list.length === 1 ? ' file, ' : ' files, ') + humanSize(total);
}

/** Turn a fetch failure into something the user can act on. @param {string} url @param {any} error */
function networkHint(url, error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/Failed to fetch|NetworkError|CORS/i.test(message))
		return message + ' — the host must allow cross-origin requests (CORS). Check the URL opens in a browser tab.';
	return message + ' — tried ' + url;
}

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

/** V5: the .tpmodule manifest format this build understands (absent = 0). */
export const MODULE_FORMAT = 1;

/** @param {any} manifest */
function validateManifest(manifest) {
	if (!manifest?.id || !manifest?.name || !manifest?.version)
		throw new Error('manifest.json needs id, name and version');
	return {
		id: String(manifest.id),
		name: String(manifest.name),
		version: String(manifest.version),
		format: Number(manifest.format) || 0,
		description: manifest.description ? String(manifest.description) : '',
		entry: manifest.entry ? String(manifest.entry) : 'module.js'
	};
}

/** V5: install-time gate — a NEWER manifest format asks before installing;
 * older/absent installs silently. @param {any} manifest */
async function confirmModuleFormat(manifest) {
	if (!(manifest.format > MODULE_FORMAT)) return true;
	return showConfirm({
		title: 'Newer module format',
		message:
			'"' + manifest.name + '" uses module format ' + manifest.format + '; this app supports format ' +
			MODULE_FORMAT + '. It may not work correctly.',
		confirmLabel: 'Install anyway'
	});
}

/** Import a record's entry file as a module object and validate its shape.
 * A fresh blob URL per call, so re-imports always evaluate fresh code (A2).
 * @param {Record<string, any>} files @param {string} entry */
async function importModuleObject(files, entry) {
	const entryBytes = files[entry];
	if (!entryBytes) throw new Error('entry file "' + entry + '" missing');
	const blobUrl = URL.createObjectURL(new Blob([entryBytes], { type: 'text/javascript' }));
	try {
		const imported = await import(/* @vite-ignore */ blobUrl);
		const mod = imported.default;
		if (!mod?.id || typeof mod.register !== 'function')
			throw new Error('entry must default-export { id, name, version, register }');
		return mod;
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

/** Expose a record's packaged files as blob urls for api.assetUrl('assets/...')
 * @param {any} record */
function registerRecordAssets(record) {
	/** @type {Record<string, string>} */
	const assets = {};
	Object.entries(record.files).forEach(([path, bytes]) => {
		if (path === record.entry || path === 'manifest.json') return;
		assets[path] = URL.createObjectURL(new Blob([bytes]));
	});
	registerModuleAssets(record.id, assets);
}

/** Register one stored record with the SDK @param {any} record */
export async function activateUserModule(record) {
	if (isModuleLoaded(record.id)) return true;
	try {
		const mod = await importModuleObject(record.files, record.entry);
		if (mod.id !== record.id) throw new Error('manifest id and module id differ');
		registerRecordAssets(record);
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
	lastInstalled.set(record.id); // the manager points at it from the User tab
	await persist();
	// installing implies wanting it on
	disabledModules.update((list) => list.filter((id) => id !== record.id));
	if (isModuleLoaded(record.id)) {
		// A2: live-swap — evaluate the new entry FIRST, only then tear down
		try {
			const mod = await importModuleObject(record.files, record.entry);
			if (mod.id !== record.id) throw new Error('manifest id and module id differ');
			deactivateModule(record.id);
			registerRecordAssets(record);
			initModules([mod]);
			showToast('"' + record.name + '" updated');
			return isModuleLoaded(record.id);
		} catch (error) {
			console.log('module live update failed', error);
			const message = error instanceof Error ? error.message : String(error);
			showToast(
				'"' + record.name + '" stored, but the new code failed to run (' + message +
				') — the previous version keeps running until a reload'
			);
			return true;
		}
	}
	return activateUserModule(record);
}

/** Install from a .zip file @param {File} file */
export async function installZip(file) {
	try {
		setStatus('busy', 'Reading ' + file.name + '…');
		const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
		const manifestBytes = entries['manifest.json'];
		if (!manifestBytes)
			throw new Error(
				'no manifest.json at the zip root — zip the CONTENTS of the module folder, not the folder itself'
			);
		const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)));
		if (!(await confirmModuleFormat(manifest))) {
			clearInstallStatus();
			return false;
		}
		/** @type {Record<string, Uint8Array>} */
		const files = {};
		Object.entries(entries).forEach(([path, bytes]) => {
			if (!path.endsWith('/')) files[path] = bytes;
		});
		const previous = get(userModules).find((m) => m.id === manifest.id);
		const record = { ...manifest, files, source: 'zip', installedAt: Date.now(), appVersion: APP_VERSION };
		const ok = await storeAndActivate(record);
		if (ok)
			setStatus(
				'ok',
				(previous ? 'Updated ' : 'Installed ') + manifest.name + ' v' + manifest.version +
					(previous && previous.version !== manifest.version ? ' (was v' + previous.version + ')' : ''),
				describeFiles(files) + ' · from ' + file.name
			);
		else setStatus('error', 'Install failed', 'The module was stored but did not register — see the console.');
		return ok;
	} catch (error) {
		console.log('zip install failed', error);
		const message = error instanceof Error ? error.message : String(error);
		setStatus('error', 'Could not install ' + file.name, message);
		return false;
	}
}

/** Install from a URL serving manifest.json (+ listed files) @param {string} url */
export async function installUrl(url) {
	const base = normalizeRepoUrl(url);
	try {
		setStatus('busy', 'Fetching manifest.json…', base);
		let manifestResponse;
		try {
			manifestResponse = await fetch(base + '/manifest.json');
		} catch (error) {
			throw new Error(networkHint(base + '/manifest.json', error));
		}
		if (!manifestResponse.ok)
			throw new Error(
				'manifest.json returned ' + manifestResponse.status + ' ' + manifestResponse.statusText +
					' — the URL must be the FOLDER holding manifest.json (not the file, not the repo root)'
			);
		const rawManifest = await manifestResponse.json();
		const manifest = validateManifest(rawManifest);
		if (!(await confirmModuleFormat(manifest))) {
			clearInstallStatus();
			return false;
		}
		const list = Array.isArray(rawManifest.files) && rawManifest.files.length > 0
			? [...new Set([manifest.entry, ...rawManifest.files])]
			: [manifest.entry];
		/** @type {Record<string, Uint8Array>} */
		const files = {};
		for (const path of list) {
			setStatus('busy', 'Downloading ' + path + '…', manifest.name + ' v' + manifest.version);
			let response;
			try {
				response = await fetch(base + '/' + path);
			} catch (error) {
				throw new Error(networkHint(base + '/' + path, error));
			}
			if (!response.ok)
				throw new Error(path + ' returned ' + response.status + ' ' + response.statusText);
			files[path] = new Uint8Array(await response.arrayBuffer());
		}
		const previous = get(userModules).find((m) => m.id === manifest.id);
		const record = { ...manifest, files, source: base, installedAt: Date.now(), appVersion: APP_VERSION };
		const ok = await storeAndActivate(record);
		if (ok)
			setStatus(
				'ok',
				(previous ? 'Updated ' : 'Installed ') + manifest.name + ' v' + manifest.version +
					(previous && previous.version !== manifest.version ? ' (was v' + previous.version + ')' : ''),
				describeFiles(files) + ' · from ' + base
			);
		else setStatus('error', 'Install failed', 'The module was stored but did not register — see the console.');
		return ok;
	} catch (error) {
		console.log('url install failed', error);
		const message = error instanceof Error ? error.message : String(error);
		setStatus('error', 'Could not install from that URL', message);
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

// --- A2: dev-mode live reload -------------------------------------------------
// Reload from URL = fetch fresh files (cache-busted), evaluate the NEW entry
// FIRST, then deactivateModule (the moduleSDK teardown journal) and re-register
// — no page reload. A parse/shape error keeps the OLD instance running. A
// version bump re-triggers the peer {id,version} mismatch toast: correct, the
// dev peer genuinely differs.

/** ids auto-polling their dev URL (session-only — not persisted)
 * @type {import('svelte/store').Writable<string[]>} */
export const devPolling = writable([]);
/** @type {Record<string, any>} id -> poll interval handle */
const devPollTimers = {};

/** The URL a dev reload pulls from: the record's devUrl, else where it was
 * installed from (zip installs have no URL until one is set). @param {any} record */
export function devSourceOf(record) {
	return record?.devUrl || (record?.source !== 'zip' ? record?.source : '') || '';
}

/** Persist a dev URL on an installed record @param {string} id @param {string} url */
export async function setDevUrl(id, url) {
	userModules.update((list) => list.map((m) => (m.id === id ? { ...m, devUrl: url.trim() } : m)));
	await persist();
}

/** Fetch fresh code from the record's dev URL and swap it in live.
 * @param {any} record @returns {Promise<boolean>} */
export async function reloadUserModule(record) {
	const current = get(userModules).find((m) => m.id === record.id) ?? record;
	const url = devSourceOf(current);
	if (!url) {
		showToast('Set a dev URL first (zip modules have no source URL)');
		return false;
	}
	try {
		const base = normalizeRepoUrl(url);
		const bust = '?t=' + Date.now();
		const manifestResponse = await fetch(base + '/manifest.json' + bust, { cache: 'no-store' });
		if (!manifestResponse.ok)
			throw new Error('manifest.json not reachable (' + manifestResponse.status + ')');
		const rawManifest = await manifestResponse.json();
		const manifest = validateManifest(rawManifest);
		if (manifest.id !== current.id)
			throw new Error('dev URL serves module "' + manifest.id + '", not "' + current.id + '"');
		const list = Array.isArray(rawManifest.files) && rawManifest.files.length > 0
			? [...new Set([manifest.entry, ...rawManifest.files])]
			: [manifest.entry];
		/** @type {Record<string, Uint8Array>} */
		const files = {};
		for (const path of list) {
			const response = await fetch(base + '/' + path + bust, { cache: 'no-store' });
			if (!response.ok) throw new Error(path + ' not reachable');
			files[path] = new Uint8Array(await response.arrayBuffer());
		}
		// evaluate BEFORE teardown — any error above leaves the old instance running
		const mod = await importModuleObject(files, manifest.entry);
		if (mod.id !== current.id) throw new Error('manifest id and module id differ');
		deactivateModule(current.id);
		const updated = { ...current, ...manifest, files, updatedAt: Date.now(), appVersion: APP_VERSION };
		registerRecordAssets(updated);
		initModules([mod]);
		userModules.update((records) => records.map((m) => (m.id === current.id ? updated : m)));
		await persist();
		showToast('Module "' + manifest.name + '" reloaded (v' + manifest.version + ')');
		return isModuleLoaded(current.id);
	} catch (error) {
		console.log('module dev reload failed', error);
		const message = error instanceof Error ? error.message : String(error);
		showToast('Reload failed: ' + message + ' — the previous version keeps running');
		return false;
	}
}

/** @param {Uint8Array=} a @param {Uint8Array=} b */
function sameBytes(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Auto-poll the dev URL (~2s cache-busted GET of the entry file) and reload
 * when the served bytes differ from the installed ones. Session-only.
 * @param {any} record @param {boolean} on */
export function setDevPoll(record, on) {
	clearInterval(devPollTimers[record.id]);
	delete devPollTimers[record.id];
	devPolling.update((ids) =>
		on ? [...new Set([...ids, record.id])] : ids.filter((id) => id !== record.id)
	);
	if (!on) return;
	/** @type {Uint8Array | null} a served body that already FAILED to reload — don't retry it every tick */
	let lastFailed = null;
	let busy = false;
	devPollTimers[record.id] = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			const current = get(userModules).find((m) => m.id === record.id);
			const url = devSourceOf(current);
			if (!current || !url) return;
			const base = normalizeRepoUrl(url);
			const entry = current.entry ?? 'module.js';
			const response = await fetch(base + '/' + entry + '?t=' + Date.now(), { cache: 'no-store' });
			if (!response.ok) return;
			const served = new Uint8Array(await response.arrayBuffer());
			if (sameBytes(served, current.files?.[entry])) return;
			if (lastFailed && sameBytes(served, lastFailed)) return;
			lastFailed = (await reloadUserModule(current)) ? null : served;
		} catch {
			// dev server away — keep polling quietly
		} finally {
			busy = false;
		}
	}, 2000);
}

/** @param {string} id */
export async function removeUserModule(id) {
	const record = get(userModules).find((m) => m.id === id);
	if (record) setDevPoll(record, false);
	userModules.update((list) => list.filter((m) => m.id !== id));
	await persist();
	if (record && isModuleLoaded(id)) {
		deactivateModule(id);
		showToast('"' + record.name + '" removed');
	}
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
