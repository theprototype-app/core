import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject, globalCamera, isVRMode } from '../stores/sceneStore';
import { peers, showToast, modulesOpen } from '../stores/appStore';
import { syncedAnimations } from '../stores/flowStore';
import { customGeometryBuilders } from './customGeometries';
import { APP_VERSION } from './version.js';

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
/** @type {string[]} scene-root group names that receive viewport clicks */
export const moduleInteractiveGroups = [];
/** @type {string[]} scene-root object names listed under the object list's System filter */
export const systemGroupNames = [];

/** @param {string} name */
export function registerSystemGroup(name) {
	if (!systemGroupNames.includes(name)) systemGroupNames.push(name);
}
/** @type {(() => void)[]} scene-clear hooks (modules remove their content) */
const sceneClearHandlers = [];

/** Called by the clear-scene path (local and remote) */
export function runSceneClearHandlers() {
	sceneClearHandlers.forEach((fn) => {
		try {
			fn();
		} catch (error) {
			console.log('module scene-clear handler failed', error);
		}
	});
}

/** @type {{id: string, name: string, version: string}[]} */
export const loadedModules = [];
/** @type {Record<string, ((data: any) => void)[]>} */
const messageHandlers = {};
/** @type {Record<string, {getState: () => any, applyState: (state: any) => void}>} */
const stateSyncs = {};

// input/physics are reached via primed DYNAMIC imports: static edges would close
// cycles back into this module (flowRuntime -> moduleSDK; physics -> flowRuntime)
// — the vite-dev TDZ trap. The refs resolve at boot, long before any module
// frame task polls them; the fallbacks cover the first few frames.
/** @type {any} */ let inputRuntimeRef = null;
/** @type {any} */ let physicsRef = null;
/** @type {any} */ let possessRef = null;
/** @type {any} */ let vrControlsRef = null;
if (typeof window !== 'undefined') {
	import('./inputRuntime').then((m) => (inputRuntimeRef = m));
	import('./physics').then((m) => (physicsRef = m));
	import('./possess').then((m) => (possessRef = m));
	import('./vrControls').then((m) => (vrControlsRef = m));
}

// --- api.pointerRay (190): where the user is POINTING, as a world ray --------
// Desktop: the mouse over the viewport (tracked window-wide in NDC, same math
// as Scene.svelte's selection raycast). VR: the pointer hand's controller ray
// (vrControls, resolved by handedness). A FRESH Raycaster every call.
const pointerNdc = { x: 0, y: 0, seen: false };
if (typeof window !== 'undefined') {
	window.addEventListener('pointermove', (event) => {
		pointerNdc.x = (event.clientX / window.innerWidth) * 2 - 1;
		pointerNdc.y = -(event.clientY / window.innerHeight) * 2 + 1;
		pointerNdc.seen = true;
	});
}
function pointerRayNow() {
	if (get(isVRMode)) return vrControlsRef?.pointerHandRay?.() ?? null;
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera || !pointerNdc.seen) return null;
	const fresh = new THREE.Raycaster();
	fresh.setFromCamera(new THREE.Vector2(pointerNdc.x, pointerNdc.y), camera);
	return fresh;
}
/** exported for tests (__stores.moduleSDK.pointerRayNow) */
export { pointerRayNow };
function inputApi() {
	return (
		inputRuntimeRef ?? {
			getInput: () => ({ codes: new Set(), axes: { lx: 0, ly: 0, rx: 0, ry: 0 }, vrButtons: {} })
		}
	);
}
function physicsApi() {
	return physicsRef;
}

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
		 * H2 (flow v2): ship CODE-EDITABLE node definitions with the module. Each
		 * def becomes a regular custom node (NodeDesigner-editable, listed in the
		 * palette's Custom section, replicated like user defs) with the id
		 * `mod-<moduleId>-<key>`. Seeding is ABSENT-ONLY: a def the user edited
		 * (same id already in the store) is never clobbered on module reload.
		 * Def shape mirrors the NodeDesigner: {key, name, params: [{key,
		 * kind:'range'|'select', min?, max?, step?, options?}], code} — the code
		 * runs like a Script node (pure function of object/base/data/time; keep
		 * it deterministic, golden rule).
		 * @param {{key: string, name: string, params?: any[], code: string}[]} defs
		 */
		registerNodeDefs(defs) {
			import('./customNodes').then((m) => {
				for (const def of defs ?? []) {
					const id = 'mod-' + moduleId + '-' + def.key;
					if (m.findNodeDef(id)) continue; // user edits win over reseeds
					m.applyNodeDef({ id, name: def.name ?? def.key, params: def.params ?? [], code: def.code ?? '' });
				}
			});
		},
		/**
		 * Creatable geometry: `/create <Name> ...args` works locally and on
		 * peers. `entry` ({label, command, group?}) lists it in the sidebar.
		 * @param {string} name @param {(...args: any[]) => any} builder @param {{label: string, command: string, group?: string}=} entry
		 */
		registerPrimitive(name, builder, entry) {
			customGeometryBuilders[name] = builder;
			if (!entry) return;
			const tagged = { ...entry, moduleId };
			modulePrimitiveGroups.update((list) => {
				const groupName = entry.group ?? 'Modules';
				const existing = list.find((g) => g.group === groupName);
				if (existing)
					return list.map((g) =>
						g === existing ? { ...g, items: [...g.items, tagged] } : g
					);
				return [...list, { group: groupName, items: [tagged] }];
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
		/**
		 * Click handlers only see the replicated objects root by default;
		 * register your scene-root group's name to make it clickable too.
		 * @param {string} name
		 */
		registerInteractiveGroup(name) {
			moduleInteractiveGroups.push(name);
			registerSystemGroup(name); // clickable module content is also listable
		},
		/** List a scene-root group under the object list's System filter @param {string} name */
		registerSystemGroup(name) {
			registerSystemGroup(name);
		},
		/**
		 * Runs when the scene is cleared (locally or by a peer) — remove your
		 * viewport content and reset module state here.
		 * @param {() => void} fn
		 */
		onSceneClear(fn) {
			sceneClearHandlers.push(fn);
		},
		/**
		 * Where the user is POINTING, as a THREE.Raycaster in world space —
		 * desktop mouse over the viewport, or the VR pointer hand's ray. A fresh
		 * instance per call (safe to keep). Null before the first pointer event.
		 * The drag recipe (190/untangle): click to pick, follow pointerRay() in a
		 * frame task, click to drop. (190)
		 */
		pointerRay() {
			return pointerRayNow();
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
		/**
		 * Add a sector to the VR radial menu (74). group 'root' extends the base
		 * ring; any other group name becomes a sub-ring reachable via a nav
		 * entry ({ring: '<group>'}).
		 * @param {{id: string, group?: string, label: string, order?: number,
		 *   ring?: string, action?: () => void, active?: () => boolean,
		 *   color?: string, closes?: boolean}} entry
		 */
		registerVRMenuEntry(entry) {
			// dynamic import: a static edge here closes a module cycle back into
			// history via materialsHandler (TDZ crash at boot)
			import('./vrRadialMenu').then((menu) =>
				menu.registerVRMenuEntry({ ...entry, id: moduleId + ':' + entry.id })
			);
		},
		/**
		 * Declare key bindings so they list in Settings ▸ Shortcuts under this
		 * module (display-only — poll api.input() / subscribe api.onInput).
		 * @param {{label: string, keys: string}[]} bindings
		 */
		registerBindings(bindings) {
			import('./inputRuntime').then((m) => m.registerBindings(moduleId, bindings));
		},
		/** Per-frame input snapshot: {codes: Set<'KeyW'...>, axes: {lx,ly,rx,ry}, vrButtons} */
		input() {
			return inputApi().getInput();
		},
		/** Key down/up events; returns an unsubscribe. @param {(kind: 'down'|'up', code: string) => void} fn */
		onInput(fn) {
			let unsub = () => {};
			import('./inputRuntime').then((m) => (unsub = m.onInput(fn)));
			return () => unsub();
		},
		/** Pause the host's own use of an input scope while your module drives:
		 * 'keys' (WASD camera fly / play movement) or 'locomotion' (VR left stick).
		 * ALWAYS release (module disable/error releases everything).
		 * @param {'keys'|'locomotion'} scope */
		claimInput(scope) {
			import('./inputRuntime').then((m) => m.claimInput(scope));
		},
		/** @param {'keys'|'locomotion'} scope */
		releaseInput(scope) {
			import('./inputRuntime').then((m) => m.releaseInput(scope));
		},
		/**
		 * Physics access (P-A/P-B). All mutations are INITIATOR-ONLY (the peer
		 * that started the simulation steps the world — golden rule 8): forward
		 * inputs to the initiator via api.send and let IT call these.
		 */
		physics: {
			/** true while THIS peer runs the simulation */
			simulating: () => physicsApi()?.isInitiator() ?? false,
			isInitiator: () => physicsApi()?.isInitiator() ?? false,
			/** push a dynamic body @param {string} uuid @param {number[]} impulse */
			applyImpulse: (uuid, impulse) => physicsApi()?.applyImpulse(uuid, impulse) ?? false,
			/** spin a dynamic body (C2) @param {string} uuid @param {number[]} torque world-space */
			applyTorqueImpulse: (uuid, torque) =>
				physicsApi()?.applyTorqueImpulse(uuid, torque) ?? false,
			/** drive a revolute joint's motor (P-B) @param {string} jointId @param {number} vel @param {number=} maxForce */
			setJointMotor: (jointId, vel, maxForce) =>
				physicsApi()?.setJointMotor(jointId, vel, maxForce) ?? false,
			/** the replicated joint defs @returns {Promise<any[]>} */
			joints: () => import('./joints').then((m) => m.jointsSnapshot())
		},
		/**
		 * Buzz the VR controllers (press feedback). No-op on desktop / when
		 * the session's gamepads lack haptics. `hand` targets one controller
		 * ('left'|'right', resolved by handedness); omit to pulse both.
		 * Reaches vrControls via the primed dynamic import (a static edge
		 * would close a module cycle - same rule as vrRadialMenu). (17-A1)
		 * @param {number=} intensity 0..1 @param {number=} durationMs
		 * @param {'left'|'right'=} hand
		 */
		haptic(intensity = 0.5, durationMs = 50, hand = undefined) {
			vrControlsRef?.hapticPulse?.(intensity, durationMs, hand);
		},
		/** In a VR session right now? (DEVX #6) @returns {boolean} */
		isVR() {
			return !!get(isVRMode);
		},
		/**
		 * One VR hand's WORLD pose + button state, or null when untracked / not
		 * in VR (DEVX #2): {position:[x,y,z], quaternion:[x,y,z,w], trigger,
		 * gripped, connected}. Poll it from a frame task (a fresh plain object
		 * per call — safe to keep). @param {'left'|'right'} hand
		 */
		vrHand(hand) {
			return vrControlsRef?.handSnapshot?.(hand) ?? null;
		},
		/**
		 * Fire the replicated flow click trigger on an object (DEVX #4, the
		 * essentials pattern) — user graphs with an On Click node targeting the
		 * object react to your module's events on every peer. @param {string} uuid
		 */
		fireObjectClick(uuid) {
			// dynamic: flowRuntime statically imports moduleSDK (cycle rule)
			import('./flowRuntime').then((m) => m.fireObjectClick(uuid));
		},
		/**
		 * Possess an object: WASD/arrows or the VR left stick drive it (tank
		 * controls) with a follow camera; Esc releases. Possessing selects it
		 * (selection = lock), suspends its flow effects and records ONE undo
		 * entry on release. @param {string} uuid
		 * @param {{camera?: 'chase'|'orbit'|'none', speed?: number, turnSpeed?: number}=} opts
		 */
		possess(uuid, opts) {
			return possessRef?.possess(uuid, opts) ?? false;
		},
		releasePossess() {
			possessRef?.release();
		},
		/** Camera modes this build's possess supports (DEVX #1) — feature-detect
		 * 'first' here; an unknown mode degrades silently. */
		get possessModes() {
			return possessRef?.possessModes ?? ['chase', 'orbit', 'none'];
		},
		/** the currently selected object's uuid (undefined when none) */
		selectedUuid() {
			return /** @type {any} */ (get(selectedObject))?.uuid;
		},
		scene: () => get(globalScene),
		objectsGroup: () => get(objectsGroup),
		/** The assets the shared scene uses right now — [{group, name, kind, hash}] (108) */
		sceneAssets: () => {
			// dynamic to stay outside the module graph cycle guard
			return import('./sceneAssets').then((m) => m.sceneAssetList());
		},
		peerId: () => /** @type {any} */ (get(peers))?.peer?.id,
		toast: showToast,
		now: runtimeNow,
		// user modules are self-contained (no imports) — THREE + assets come via the api
		THREE: THREE,
		/** blob URL for a packaged file, e.g. api.assetUrl('assets/pling.mp3') @param {string} path */
		assetUrl: (path) => moduleAssets[moduleId]?.[path] ?? null
	};
}

/** @type {Record<string, Record<string, string>>} moduleId -> {path: blobUrl} */
const moduleAssets = {};

/** Used by the user-module loader to expose packaged files @param {string} id @param {Record<string, string>} assets */
export function registerModuleAssets(id, assets) {
	moduleAssets[id] = assets;
}

/**
 * The clock the effect runtime runs on (seconds). Stamp replicated timestamps
 * with this so time-based effects agree across peers.
 */
export function runtimeNow() {
	return get(syncedAnimations) ? (Date.now() % 86400000) / 1000 : performance.now() / 1000;
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
			mod.register(makeApi(mod.id));
			loadedModules.push({ id: mod.id, name: mod.name, version: mod.version, description: mod.description });
			console.log('module loaded: ' + mod.id + ' v' + mod.version);
		} catch (error) {
			console.log('module ' + mod.id + ' failed to register', error);
			showToast('Module "' + mod.id + '" failed to load');
		}
	});
	loadedModulesChanged.update((n) => n + 1);
}

/** bumps whenever loadedModules changes (loadedModules is a plain array) */
export const loadedModulesChanged = writable(0);

/** @param {string} id */
export function isModuleLoaded(id) {
	return loadedModules.some((m) => m.id === id);
}

// --- enable/disable (persisted; disable applies on reload) ---

function readDisabled() {
	try {
		return JSON.parse(localStorage.getItem('disabledModules') ?? '[]');
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
		localStorage.setItem('disabledModules', JSON.stringify(list));
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
