// Module SDK — the public face. 34 R4 (A1): the api object a module's register(api)
// receives is assembled in src/lib/sdk/ from ONE table (sdk/index.js), a file per namespace;
// this file keeps the module LIFECYCLE (init / deactivate / enable / disable) and the peer
// plumbing, and re-exports everything the app imported from here before the split — every
// importer of './moduleSDK' is unchanged.
//
// Module SDK v1 — in-repo modules under src/modules/<name>/ register through
// the api object passed to their register(api). See MODULES.md for the guide.
//
// Replication model: a module runs on EVERY peer. Deterministic effects
// (driven by node data + synced time) need no messages at all; discrete
// module events go through api.send()/api.onMessage() and full state through
// registerStateSync (late joiners receive it in the connection handshake).

import { get, writable } from 'svelte/store';
import { peers, showToast, modulesOpen } from '../stores/appStore';
import { APP_VERSION } from './version.js';
// 27-B: recovery paths report through the diagnostics ring (hardening audit H4)
import { log } from './diagnostics';
import { safeStorage } from './safeStorage';
import { makeApi } from './sdk/index.js';
import { loadedModules, messageHandlers, stateSyncs, moduleDisposals, moduleAssets } from './sdk/registries.js';
import { registerPerfContext } from './perf/perfMarks.js';
export {
	moduleNodeGroups,
	modulePrimitiveGroups,
	moduleMenuItems,
	moduleEffects,
	moduleNodeComponents,
	moduleClickHandlers,
	CLICK_MODES,
	DEFAULT_CLICK_MODES,
	normalizeClickModes,
	clickHandlerRunsIn,
	runClickHandlers,
	clickHandlerModesOf,
	moduleClickMissHandlers,
	fireClickMiss,
	moduleDropHandlers,
	moduleFrameTasks,
	moduleInteractiveGroups,
	systemGroupNames,
	registerSystemGroup,
	runSceneClearHandlers,
	loadedModules
} from './sdk/registries.js';
/** exported for tests (__stores.moduleSDK.pointerRayNow) */
export { pointerRayNow } from './sdk/pointer.js';
export { runtimeNow } from './sdk/core.js';
export { moduleContentDebug } from './moduleContent';
export { SDK_TABLE } from './sdk/index.js';

/** Used by the user-module loader to expose packaged files @param {string} id @param {Record<string, string>} assets */
export function registerModuleAssets(id, assets) {
	moduleAssets[id] = assets;
}

/**
 * Register modules. Re-callable: already-loaded ids are skipped, so the
 * manager can live-enable additional modules after boot. Disabling only
 * takes effect on reload (SDK v1 registries have no unregister).
 * @param {any[]} modules
 */
export function initModules(modules) {
	modules.forEach((mod) => {
		if (loadedModules.some((m) => m.id === mod.id)) return;
		try {
			mod.register(makeApi(mod.id, mod.name || mod.id));
			loadedModules.push({ id: mod.id, name: mod.name, version: mod.version, description: mod.description });
			log('info', 'module', 'loaded ' + mod.id + ' v' + mod.version);
		} catch (error) {
			log('warn', 'module', mod.id + ' failed to register', String(error));
			showToast('Module "' + mod.id + '" failed to load');
		}
	});
	loadedModulesChanged.update((n) => n + 1);
}

/**
 * A2: genuinely unload a module — run its teardown journal in reverse
 * (registries, message/state-sync handlers, input claims + bindings, VR menu
 * entries, module-owned scene-root viewport groups), then drop its assets and
 * loadedModules entry so initModules can re-register fresh code. Scene objects
 * the module CREATED inside objectsGroup stay (replicated user content).
 * Used by the user-module dev reload / live disable; CORE modules keep
 * reload-to-disable — they may wire registries outside the api surface
 * (vrsleeve's vrControls hook registries).
 * @param {string} id
 */
export function deactivateModule(id) {
	const disposals = moduleDisposals[id] ?? [];
	moduleDisposals[id] = [];
	for (let i = disposals.length - 1; i >= 0; i--) {
		try {
			disposals[i]();
		} catch (error) {
			log('warn', 'module', id + ' teardown step failed', String(error));
		}
	}
	Object.values(moduleAssets[id] ?? {}).forEach((url) => {
		try {
			URL.revokeObjectURL(url);
		} catch {}
	});
	delete moduleAssets[id];
	const index = loadedModules.findIndex((m) => m.id === id);
	if (index >= 0) loadedModules.splice(index, 1);
	loadedModulesChanged.update((n) => n + 1);
}

/** bumps whenever loadedModules changes (loadedModules is a plain array) */
export const loadedModulesChanged = writable(0);

// 34 PF/R1: a performance recording (and a beacon report) names every loaded module's version
registerPerfContext('modules', () => Object.fromEntries(loadedModules.map((m) => [String(m.id), String(m.version ?? '')])));

/** @param {string} id */
export function isModuleLoaded(id) {
	return loadedModules.some((m) => m.id === id);
}

// --- enable/disable (persisted; disable applies on reload) ---

function readDisabled() {
	try {
		return JSON.parse(safeStorage.getItem('disabledModules') ?? '[]');
	} catch {
		return [];
	}
}

/** @type {import('svelte/store').Writable<string[]>} */
export const disabledModules = writable(
	typeof localStorage === 'undefined' ? [] : readDisabled()
);
disabledModules.subscribe((list) => {
	if (typeof localStorage !== 'undefined')
		safeStorage.setItem('disabledModules', JSON.stringify(list));
});

/**
 * Toggle a module. Enabling registers it live (pass the module object);
 * disabling persists and asks for a reload.
 * @param {any} mod @param {boolean} enabled
 */
export function setModuleEnabled(mod, enabled) {
	disabledModules.update((list) =>
		enabled ? list.filter((id) => id !== mod.id) : [...new Set([...list, mod.id])]
	);
	if (enabled) {
		if (!isModuleLoaded(mod.id)) initModules([mod]);
	} else if (isModuleLoaded(mod.id)) {
		showToast('"' + mod.name + '" disabled — reload the page to fully remove it');
	}
}

// --- peer plumbing (used by peerHandler) ---

/** Route an incoming {type:'module'} message to its module @param {any} data */
export function applyModuleMessage(data) {
	(messageHandlers[data.moduleId] ?? []).forEach((fn) => {
		try {
			fn(data);
		} catch (error) {
			log('warn', 'module', data.moduleId + ' message handler failed', String(error));
		}
	});
}

export function moduleVersions() {
	return loadedModules.map((m) => ({ id: m.id, version: m.version }));
}

/** Toast when a peer runs different modules @param {{id: string, version: string}[]} remote */
export function checkModuleVersions(remote) {
	if (!Array.isArray(remote)) return;
	const openManager = [{ label: 'Modules', action: () => modulesOpen.set(true) }];
	remote.forEach((r) => {
		const local = loadedModules.find((m) => m.id === r.id);
		if (!local)
			showToast('Peer uses module "' + r.id + '" you do not have — things may look different', openManager);
		else if (local.version !== r.version)
			showToast(
				'Module "' + r.id + '" version differs (you ' + local.version + ', peer ' + r.version + ')',
				openManager
			);
	});
	loadedModules.forEach((m) => {
		if (!remote.find((r) => r.id === m.id))
			showToast('Peer does not have module "' + m.id + '" — things may look different', openManager);
	});
}

/** V3: app versions already warned about this session — showToast's U-3 dedupe only
 * collapses while the previous toast is visible, so reconnects would re-spam. */
const warnedAppVersions = new Set();

/** V3: toast ONCE per differing peer app version per session. @param {any} remote */
export function checkPeerAppVersion(remote) {
	if (!remote || typeof remote !== 'string') return; // pre-1.0 peers omit the field
	if (remote === APP_VERSION || warnedAppVersions.has(remote)) return;
	warnedAppVersions.add(remote);
	showToast('Peer runs app ' + remote + ' (you have ' + APP_VERSION + ') — features may behave differently.');
}

/** Send all module states to a peer (handshake reply) @param {string} peerId */
export function sendModuleStates(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const states = {};
	Object.entries(stateSyncs).forEach(([id, sync]) => {
		try {
			const state = sync.getState();
			if (state != null) states[id] = state;
		} catch (error) {
			log('warn', 'module', id + ' getState failed', String(error));
		}
	});
	if (Object.keys(states).length === 0) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendModuleStates(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'modulestate', states: states });
}

/** @param {Record<string, any>} states */
export function applyModuleStates(states) {
	if (!states) return;
	Object.entries(states).forEach(([id, state]) => {
		try {
			stateSyncs[id]?.applyState(state);
		} catch (error) {
			log('warn', 'module', id + ' applyState failed', String(error));
		}
	});
}
