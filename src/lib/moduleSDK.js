import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { syncedAnimations } from '../stores/flowStore';
import { customGeometryBuilders } from './customGeometries';

// Module SDK v1 — in-repo modules under src/modules/<name>/ register through
// the api object passed to their register(api). See MODULES.md for the guide.
//
// Replication model: a module runs on EVERY peer. Deterministic effects
// (driven by node data + synced time) need no messages at all; discrete
// module events go through api.send()/api.onMessage() and full state through
// registerStateSync (late joiners receive it in the connection handshake).

// --- registries the host app consumes ---

// reactive (UI lists render before modules load, so these are stores)
/** @type {import('svelte/store').Writable<any[]>} node palette groups */
export const moduleNodeGroups = writable([]);
/** @type {import('svelte/store').Writable<any[]>} sidebar primitive groups */
export const modulePrimitiveGroups = writable([]);
/** @type {import('svelte/store').Writable<{moduleId: string, label: string, action: () => void}[]>} */
export const moduleMenuItems = writable([]);

// plain registries (hot runtime paths)
/** @type {Record<string, (object: any, base: any, data: any, time: number) => void>} */
export const moduleEffects = {};
/** @type {Record<string, any>} node type -> Svelte component */
export const moduleNodeComponents = {};
/** @type {((object: any) => boolean)[]} */
export const moduleClickHandlers = [];
/** @type {((time: number) => void)[]} */
export const moduleFrameTasks = [];

/** @type {{id: string, name: string, version: string}[]} */
export const loadedModules = [];
/** @type {Record<string, ((data: any) => void)[]>} */
const messageHandlers = {};
/** @type {Record<string, {getState: () => any, applyState: (state: any) => void}>} */
const stateSyncs = {};

/** @param {string} moduleId */
function makeApi(moduleId) {
	return {
		/**
		 * Add a node group to the flow palette/context menu. Items follow the
		 * nodeCatalog spec ({type, label, defaults, params?}); items with
		 * `params` render with the generic AnimationNode controls, or pass
		 * `components` ({type: SvelteComponent}) for custom node UIs.
		 * @param {{group: string, items: any[]}} group
		 * @param {Record<string, any>=} components
		 */
		registerNodeGroup(group, components) {
			moduleNodeGroups.update((list) => {
				const existing = list.find((g) => g.group === group.group);
				if (existing)
					return list.map((g) => (g === existing ? { ...g, items: [...g.items, ...group.items] } : g));
				return [...list, group];
			});
			if (components) Object.assign(moduleNodeComponents, components);
		},
		/**
		 * Per-frame effect for edges `your-node -> objectselector`. The runtime
		 * restores `base` before every frame; apply offsets relative to it.
		 * @param {string} type @param {(object: any, base: any, data: any, time: number) => void} fn
		 */
		registerEffect(type, fn) {
			moduleEffects[type] = fn;
		},
		/**
		 * Creatable geometry: `/create <Name> ...args` works locally and on
		 * peers. `entry` ({label, command, group?}) lists it in the sidebar.
		 * @param {string} name @param {(...args: any[]) => any} builder @param {{label: string, command: string, group?: string}=} entry
		 */
		registerPrimitive(name, builder, entry) {
			customGeometryBuilders[name] = builder;
			if (!entry) return;
			modulePrimitiveGroups.update((list) => {
				const groupName = entry.group ?? 'Modules';
				const existing = list.find((g) => g.group === groupName);
				if (existing)
					return list.map((g) =>
						g === existing ? { ...g, items: [...g.items, entry] } : g
					);
				return [...list, { group: groupName, items: [entry] }];
			});
		},
		/**
		 * Intercept viewport clicks (desktop click + VR trigger). Receives the
		 * exact mesh hit; return true to consume the click (no selection).
		 * @param {(object: any) => boolean} fn
		 */
		registerClickHandler(fn) {
			moduleClickHandlers.push(fn);
		},
		/** Runs every frame with the synced time (seconds) @param {(time: number) => void} fn */
		registerFrameTask(fn) {
			moduleFrameTasks.push(fn);
		},
		/** Handle messages other peers sent with api.send() @param {(data: any) => void} fn */
		onMessage(fn) {
			(messageHandlers[moduleId] ??= []).push(fn);
		},
		/** Broadcast to all peers; arrives at their onMessage handlers @param {any} payload */
		send(payload) {
			/** @type {any} */
			const peer = get(peers);
			if (peer) peer.send({ type: 'module', moduleId, ...payload });
		},
		/**
		 * Late-joiner sync: getState() is sent to new peers on connect,
		 * applyState(state) applies it on their side.
		 * @param {{getState: () => any, applyState: (state: any) => void}} sync
		 */
		registerStateSync(sync) {
			stateSyncs[moduleId] = sync;
		},
		/** Adds a button to the sidebar "Modules" section @param {string} label @param {() => void} action */
		registerMenu(label, action) {
			moduleMenuItems.update((list) => [...list, { moduleId, label, action }]);
		},
		scene: () => get(globalScene),
		objectsGroup: () => get(objectsGroup),
		peerId: () => /** @type {any} */ (get(peers))?.peer?.id,
		toast: showToast,
		now: runtimeNow
	};
}

/**
 * The clock the effect runtime runs on (seconds). Stamp replicated timestamps
 * with this so time-based effects agree across peers.
 */
export function runtimeNow() {
	return get(syncedAnimations) ? (Date.now() % 86400000) / 1000 : performance.now() / 1000;
}

let initialized = false;

/** Load the enabled modules (once) @param {any[]} modules */
export function initModules(modules) {
	if (initialized) return;
	initialized = true;
	modules.forEach((mod) => {
		try {
			mod.register(makeApi(mod.id));
			loadedModules.push({ id: mod.id, name: mod.name, version: mod.version });
			console.log('module loaded: ' + mod.id + ' v' + mod.version);
		} catch (error) {
			console.log('module ' + mod.id + ' failed to register', error);
		}
	});
}

// --- peer plumbing (used by peerHandler) ---

/** Route an incoming {type:'module'} message to its module @param {any} data */
export function applyModuleMessage(data) {
	(messageHandlers[data.moduleId] ?? []).forEach((fn) => {
		try {
			fn(data);
		} catch (error) {
			console.log('module ' + data.moduleId + ' message handler failed', error);
		}
	});
}

export function moduleVersions() {
	return loadedModules.map((m) => ({ id: m.id, version: m.version }));
}

/** Toast when a peer runs different modules @param {{id: string, version: string}[]} remote */
export function checkModuleVersions(remote) {
	if (!Array.isArray(remote)) return;
	remote.forEach((r) => {
		const local = loadedModules.find((m) => m.id === r.id);
		if (!local) showToast('Peer uses module "' + r.id + '" you do not have — things may look different');
		else if (local.version !== r.version)
			showToast('Module "' + r.id + '" version differs (you ' + local.version + ', peer ' + r.version + ')');
	});
	loadedModules.forEach((m) => {
		if (!remote.find((r) => r.id === m.id))
			showToast('Peer does not have module "' + m.id + '" — things may look different');
	});
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
			console.log('module ' + id + ' getState failed', error);
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
			console.log('module ' + id + ' applyState failed', error);
		}
	});
}
