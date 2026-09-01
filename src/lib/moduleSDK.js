import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject, selectedObjects, globalCamera, isVRMode, isLocked } from '../stores/sceneStore';
import { peers, showToast, modulesOpen, userdata } from '../stores/appStore';
import { syncedAnimations, flowGraphs, flowValues, allNodes, findNodeAnyGraph, SCENE_GRAPH } from '../stores/flowStore';
import { customGeometryBuilders } from './customGeometries';
// A1: moduleNodeIO imports NOTHING, so a static edge to it closes no cycle
import {
	registerModuleValueNode,
	unregisterModuleValueNode,
	registerModuleNodeInputs,
	unregisterModuleNodeInputs
} from './moduleNodeIO';
// A5: moduleToolboxes is store-only, same reasoning
import {
	registerModuleToolbox,
	unregisterModuleToolbox,
	openModuleToolbox,
	closeModuleToolbox,
	toggleModuleToolbox,
	isToolboxOpen
} from './moduleToolboxes';
// 21-E7.4: store-only leaf, the moduleToolboxes precedent
import {
	registerModuleHudKind,
	unregisterModuleHudKind,
	registerModuleDebugLine,
	registerModuleHudAction
} from './moduleHudKinds';
// R3a: all three are LEAVES (svelte stores only — gameState/peerVars say so in their own
// headers; nodesHandler reaches only flowStore + appStore), so none of these edges can
// close the history cycle. flowGraphs/nodeCatalog are NOT leaves and stay primed below.
import { roundCutoff, roundUnderway, gameVar, setGameVar } from './gameState';
import { setPeerVar, myPeerVar, leaderboardRows } from './peerVars';
import { createFlowNode, createFlowEdge, serializeNode, serializeEdge, setNodeData as sendNodeData } from './nodesHandler';
import { APP_VERSION } from './version.js';
import { ndcFromClient } from './canvasRect';

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
/** A1: the 5th arg ({id, graphId}) is OPTIONAL — a four-parameter effect, which is
 * every shipped module, is byte-unchanged.
 * @type {Record<string, (object: any, base: any, data: any, time: number, ctx?: any) => void>} */
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

/** A2: per-module teardown journal — every api.register* records an undo thunk
 * here so deactivateModule() can genuinely dispose a module (the dev-mode live
 * reload tears down and re-registers with fresh code, no page reload).
 * @type {Record<string, (() => void)[]>} */
const moduleDisposals = {};

/** remove one value from a plain registry array, in place
 * @param {any[]} arr @param {any} value */
function arrayRemove(arr, value) {
	const index = arr.indexOf(value);
	if (index >= 0) arr.splice(index, 1);
}

/** A2: drop a module-owned viewport group at teardown. SCENE-ROOT only (golden
 * rule 5) — anything inside objectsGroup is replicated user content and stays.
 * @param {string} name */
function removeSceneRootGroup(name) {
	const scene = get(globalScene);
	const target = scene?.getObjectByName(name);
	if (!target) return;
	const objects = get(objectsGroup);
	for (let node = target; node; node = node.parent) {
		if (objects && node === objects) return;
	}
	target.parent?.remove(target);
}

// input/physics are reached via primed DYNAMIC imports: static edges would close
// cycles back into this module (flowRuntime -> moduleSDK; physics -> flowRuntime)
// — the vite-dev TDZ trap. The refs resolve at boot, long before any module
// frame task polls them; the fallbacks cover the first few frames.
/** @type {any} */ let inputRuntimeRef = null;
/** @type {any} */ let physicsRef = null;
/** @type {any} */ let possessRef = null;
/** @type {any} */ let vrControlsRef = null;
/** @type {any} */ let addObjectsRef = null;
/** @type {any} */ let jointsRef = null;
/** @type {any} */ let objectActionsRef = null;
/** @type {any} */ let pingAudioRef = null;
/** 21-E7.1: primed for api.hud.rows — a fresh import().then() per push drops the first
 * seconds of them (the DEVX #8 family). @type {any} */
let flowRuntimeRef = null;
/** R3a: primed for api.flow.addNodes — flowGraphs' BODY calls registerHistoryKind, so a
 * static edge from here (which history reaches through flowRuntime) TDZ-crashes the SSR
 * prerender. @type {any} */
let flowGraphsRef = null;
/** R3a: primed for api.flow.addNodes' spec defaults — nodeCatalog statically imports
 * THIS module, so a static edge back is a direct cycle. @type {any} */
let nodeCatalogRef = null;
if (typeof window !== 'undefined') {
	import('./inputRuntime').then((m) => (inputRuntimeRef = m));
	import('./physics').then((m) => (physicsRef = m));
	import('./possess').then((m) => (possessRef = m));
	import('./vrControls').then((m) => (vrControlsRef = m));
	import('./addObjects').then((m) => (addObjectsRef = m));
	import('./joints').then((m) => (jointsRef = m));
	import('./objectActions').then((m) => (objectActionsRef = m));
	import('./pingAudio').then((m) => (pingAudioRef = m));
	import('./flowRuntime').then((m) => (flowRuntimeRef = m));
	import('./flowGraphs').then((m) => (flowGraphsRef = m));
	import('./nodeCatalog').then((m) => (nodeCatalogRef = m));
}

// --- api.pointerRay (190): where the user is POINTING, as a world ray --------
// Desktop: the mouse over the viewport (tracked window-wide in NDC, same math
// as Scene.svelte's selection raycast). VR: the pointer hand's controller ray
// (vrControls, resolved by handedness). A FRESH Raycaster every call.
//
// W9: the listener records CLIENT pixels and the conversion to NDC happens at ray
// time, against the canvas. Converting on the way in would freeze the viewport's
// geometry into the stored value, and the viewport can change with the pointer
// perfectly still — opening the bottom dock shrinks it — leaving the last-known ray
// pointing at a viewport that no longer exists.
const pointerClient = { x: 0, y: 0, seen: false };
if (typeof window !== 'undefined') {
	window.addEventListener('pointermove', (event) => {
		pointerClient.x = event.clientX;
		pointerClient.y = event.clientY;
		pointerClient.seen = true;
	});
}
function pointerRayNow() {
	if (get(isVRMode)) return vrControlsRef?.pointerHandRay?.() ?? null;
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera || !pointerClient.seen) return null;
	const fresh = new THREE.Raycaster();
	const ndc = ndcFromClient(pointerClient.x, pointerClient.y);
	fresh.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
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

/** @param {string} moduleId @param {string} [moduleName] the DISPLAY name, needed while
 * register() runs: loadedModules is not appended until it RETURNS, so anything reading the
 * name from there during registration gets the raw id (which is how a module HUD kind was
 * filed under 'hudmod' instead of 'HUD extras'). */
function makeApi(moduleId, moduleName = moduleId) {
	const disposals = (moduleDisposals[moduleId] ??= []);
	/** record an undo thunk deactivateModule runs at teardown (A2) @param {() => void} fn */
	const onDispose = (fn) => disposals.push(fn);
	/** input scopes this module still holds — released at teardown
	 * @type {Set<'keys'|'locomotion'>} */
	const claimedScopes = new Set();
	let possessing = false;
	/** list elements this module has pushed rows into, so teardown clears exactly those and
	 * one disposer is journalled per element rather than one per push @type {Set<string>} */
	const hudRowsOwned = new Set();
	onDispose(() => {
		claimedScopes.forEach((scope) => import('./inputRuntime').then((m) => m.releaseInput(scope)));
		claimedScopes.clear();
		if (possessing) possessRef?.release();
		import('./inputRuntime').then((m) => m.unregisterBindings(moduleId));
	});
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
			// A6: TAG each item with its module, the way registerPrimitive already
			// does — moduleRequirements() answers "which modules does this scene
			// need" by walking the graphs' node types back to their owner, and an
			// untagged item makes that underivable. Tagged copies are built ONCE so
			// the onDispose filter below can still match them by identity.
			const items = group.items.map((/** @type {any} */ item) => ({ ...item, moduleId }));
			moduleNodeGroups.update((list) => {
				const existing = list.find((g) => g.group === group.group);
				if (existing)
					return list.map((g) => (g === existing ? { ...g, items: [...g.items, ...items] } : g));
				return [...list, { ...group, items }];
			});
			if (components) Object.assign(moduleNodeComponents, components);
			onDispose(() => {
				moduleNodeGroups.update((list) =>
					list
						.map((g) =>
							g.group === group.group
								? { ...g, items: g.items.filter((/** @type {any} */ item) => !items.includes(item)) }
								: g
						)
						.filter((g) => g.items.length > 0)
				);
				Object.keys(components ?? {}).forEach((type) => delete moduleNodeComponents[type]);
			});
		},
		/**
		 * Per-frame effect for edges `your-node -> objectselector`. The runtime
		 * restores `base` before every frame; apply offsets relative to it.
		 *
		 * A1: `fn` receives a 5th arg `{id, graphId}` — its own node id and the graph
		 * it sits in, so one module can host many instances of the same node type. The
		 * arg is ADDITIVE: a four-parameter effect is byte-unchanged.
		 *
		 * A1: `opts.inputs` declares typed named inputs ({handle: socketType}). Without
		 * them every handle reads as 'number', which REFUSES an Object Selector wire
		 * (object -> number is not a coercion) and renders no target socket on the card.
		 * @param {string} type
		 * @param {(object: any, base: any, data: any, time: number, ctx?: any) => void} fn
		 * @param {{inputs?: Record<string, string>}=} opts
		 */
		registerEffect(type, fn, opts) {
			moduleEffects[type] = fn;
			if (opts?.inputs) registerModuleNodeInputs(type, opts.inputs);
			onDispose(() => {
				if (moduleEffects[type] === fn) delete moduleEffects[type];
				if (opts?.inputs) unregisterModuleNodeInputs(type, opts.inputs);
			});
		},
		/**
		 * A1 (DEVX #9): a node that OUTPUTS a value, so module state can drive core
		 * nodes — a score into a HUD Text, a level into Map Range, a flag into a Gate.
		 *
		 * `fn(data, time, {id, graphId})` MUST be a pure function of its arguments (the
		 * script-node rule): values are never sent, every peer evaluates the node from
		 * the replicated node data and the shared clock. Reading unreplicated local
		 * state here desyncs every downstream consumer with no error anywhere — keep
		 * mutable module state in a replicated store (registerStateSync / api.send) and
		 * read THAT, or let the value ride the node's own data.
		 *
		 * `vtype` is the output socket type ('number' by default; also 'boolean',
		 * 'vector3', 'color', 'object', 'event'). `inputs` declares typed named inputs
		 * the same way registerEffect does; each is resolved before `fn` runs, so
		 * `data.<handle>` is the wired value when wired and the node's param when not.
		 * @param {string} type
		 * @param {(data: any, time: number, ctx: any) => any} fn
		 * @param {{vtype?: string, inputs?: Record<string, string>}=} opts
		 */
		registerValueNode(type, fn, opts) {
			registerModuleValueNode(type, fn, opts?.vtype ?? 'number');
			if (opts?.inputs) registerModuleNodeInputs(type, opts.inputs);
			onDispose(() => {
				unregisterModuleValueNode(type, fn);
				if (opts?.inputs) unregisterModuleNodeInputs(type, opts.inputs);
			});
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
					const seeded = { id, name: def.name ?? def.key, params: def.params ?? [], code: def.code ?? '' };
					m.applyNodeDef(seeded);
					const seededJson = JSON.stringify(seeded);
					// teardown removes ONLY a def still byte-equal to what we seeded —
					// a user-edited def survives (mirrors the absent-only seeding rule),
					// and the re-register then leaves it alone too.
					onDispose(() => {
						const current = m.findNodeDef(id);
						if (!current) return;
						const snapshot = JSON.stringify({
							id: current.id,
							name: current.name,
							params: current.params ?? [],
							code: current.code ?? ''
						});
						if (snapshot === seededJson) m.applyNodeDefDelete(id);
					});
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
			onDispose(() => {
				if (customGeometryBuilders[name] === builder) delete customGeometryBuilders[name];
			});
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
			onDispose(() =>
				modulePrimitiveGroups.update((list) =>
					list
						.map((g) => ({ ...g, items: g.items.filter((/** @type {any} */ item) => item !== tagged) }))
						.filter((g) => g.items.length > 0)
				)
			);
		},
		/**
		 * Intercept viewport clicks (desktop click + VR trigger). Receives the
		 * exact mesh hit; return true to consume the click (no selection).
		 * @param {(object: any) => boolean} fn
		 */
		registerClickHandler(fn) {
			moduleClickHandlers.push(fn);
			onDispose(() => arrayRemove(moduleClickHandlers, fn));
		},
		/** Runs every frame with the synced time (seconds) @param {(time: number) => void} fn */
		registerFrameTask(fn) {
			moduleFrameTasks.push(fn);
			onDispose(() => arrayRemove(moduleFrameTasks, fn));
		},
		/**
		 * Click handlers only see the replicated objects root by default;
		 * register your scene-root group's name to make it clickable too.
		 * @param {string} name
		 */
		registerInteractiveGroup(name) {
			moduleInteractiveGroups.push(name);
			registerSystemGroup(name); // clickable module content is also listable
			onDispose(() => {
				arrayRemove(moduleInteractiveGroups, name);
				arrayRemove(systemGroupNames, name);
				removeSceneRootGroup(name); // module-owned viewport content goes with the module
			});
		},
		/** List a scene-root group under the object list's System filter @param {string} name */
		registerSystemGroup(name) {
			registerSystemGroup(name);
			onDispose(() => {
				arrayRemove(systemGroupNames, name);
				removeSceneRootGroup(name);
			});
		},
		/**
		 * Runs when the scene is cleared (locally or by a peer) — remove your
		 * viewport content and reset module state here.
		 * @param {() => void} fn
		 */
		onSceneClear(fn) {
			sceneClearHandlers.push(fn);
			onDispose(() => arrayRemove(sceneClearHandlers, fn));
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
			onDispose(() => arrayRemove(messageHandlers[moduleId] ?? [], fn));
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
			onDispose(() => {
				if (stateSyncs[moduleId] === sync) delete stateSyncs[moduleId];
			});
		},
		/** Adds a button to the sidebar "Modules" section @param {string} label @param {() => void} action */
		registerMenu(label, action) {
			const item = { moduleId, label, action };
			moduleMenuItems.update((list) => [...list, item]);
			onDispose(() => moduleMenuItems.update((list) => list.filter((entry) => entry !== item)));
		},
		/**
		 * A5: a real UI surface — a floating TOOLBOX on the app's own shared shell.
		 *
		 * Before this, module controls could only live behind `registerMenu`: two clicks
		 * deep inside the Modules MODAL, which then has to be CLOSED before the module's
		 * own overlay is usable. So modules hand-rolled fixed overlays at z-indexes they
		 * do not own. Write plain DOM into the node `mount` receives and you inherit
		 * dragWindow position persistence, focusStack z-banding, the <=640px bottom sheet
		 * and the whole `.tbx-*` CSS contract (`.tbx-label`, `.tbx-row`, `.tbx-btn`,
		 * `.tbx-primary`, `.tbx-check`, …) with no CSS of your own.
		 *
		 * `mount` returns its cleanup, and re-registering re-runs it, so 17-A2's dev-mode
		 * live reload rebuilds the contents in place.
		 *
		 * The user opens it from the sidebar's Modules section AND the viewport menu
		 * (one builder, two hosts), plus `shortcut` if you name one — which also lists it
		 * in Settings > Shortcuts. It is CLOSED at first: a palette that appears
		 * uninvited is the thing registerMenu was avoiding.
		 *
		 * LOCAL, always: a toolbox is this viewer's window. Nothing about it replicates
		 * or is saved with the scene, so what it CHANGES must still go through the
		 * replicated paths (api.send / api.create / api.physics.set).
		 *
		 * `playMode: true` keeps it visible in Play mode (host settings for a game);
		 * the default hides it, because a tool palette over a running game is in the way.
		 *
		 * `sidebar: false` leaves it OUT of the burger menu's Modules section and keeps
		 * its viewport-menu row — for a window that belongs to a workflow rather than to
		 * the app's permanent chrome. Pair it with a `registerMenu` button (which renders
		 * on your card in the Modules manager, beside Update/Remove) and
		 * `api.openToolbox(id)`, so the way in is where the module already is.
		 * @param {{id: string, title: string, key?: string, width?: number, minW?: number,
		 *   defaultRect?: {left?: number, top?: number, right?: number, bottom?: number},
		 *   mount: (el: HTMLElement) => (() => void) | void,
		 *   onOpen?: () => void, onClose?: () => void,
		 *   playMode?: boolean, shortcut?: string, sidebar?: boolean}} box
		 * @returns {string} the namespaced toolbox id (open/close it with this)
		 */
		registerToolbox(box) {
			const id = registerModuleToolbox({ ...box, moduleId });
			// hoisted: the `if` narrowing does not reach inside the closure below
			const keys = box.shortcut;
			if (keys) {
				// dynamic: shortcuts' subtree reaches history, the TDZ cycle family
				import('./shortcuts').then((m) =>
					m.registerShortcut({
						keys,
						group: 'Modules',
						label: box.title,
						action: () => import('./moduleToolboxes').then((t) => t.toggleModuleToolbox(id))
					})
				);
			}
			// force-close + unregister, so disable / update / dev-reload never leave a
			// window on screen backed by a mount fn that no longer exists
			onDispose(() => unregisterModuleToolbox(id));
			return id;
		},
		/**
		 * R3a follow-up: OPEN one of your own toolboxes. `registerToolbox` has always
		 * returned its id documented as "open/close it with this" — and there was nothing
		 * to open it with, so the promise was unkeepable (the `api.hud.rows` family: a
		 * surface whose own docs claim an API that does not exist). These are that half.
		 *
		 * `openToolbox` also DISMISSES the Modules manager when it is open, because the
		 * manager is the one piece of chrome that can cover a toolbox — a button on your
		 * module's card that opens a window behind the dialog it was clicked in is the
		 * exact complaint `registerToolbox` was built to answer. It is a no-op when the
		 * manager is closed, so nothing else changes.
		 * @param {string} id the id `registerToolbox` returned
		 */
		openToolbox(id) {
			modulesOpen.set(false);
			return openModuleToolbox(id);
		},
		/** @param {string} id */
		closeToolbox(id) {
			return closeModuleToolbox(id);
		},
		/** Open it if closed, close it if open — what a menu row or a card button wants.
		 * @param {string} id */
		toggleToolbox(id) {
			if (!isToolboxOpen(id)) modulesOpen.set(false);
			return toggleModuleToolbox(id);
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
			const id = moduleId + ':' + entry.id;
			import('./vrRadialMenu').then((menu) => menu.registerVRMenuEntry({ ...entry, id }));
			// same-module import promises resolve in .then order, so this always
			// runs after the registration even when teardown fires immediately
			onDispose(() =>
				import('./vrRadialMenu').then((menu) => menu.unregisterVRMenuEntry(id, entry.group ?? 'root'))
			);
		},
		/**
		 * Declare key bindings so they list in Settings ▸ Shortcuts under this
		 * module (display-only — poll api.input() / subscribe api.onInput).
		 * @param {{label: string, keys: string}[]} bindings
		 */
		registerBindings(bindings) {
			if (inputRuntimeRef) inputRuntimeRef.registerBindings(moduleId, bindings);
			else import('./inputRuntime').then((m) => m.registerBindings(moduleId, bindings));
		},
		/** Per-frame input snapshot: {codes: Set<'KeyW'...>, axes: {lx,ly,rx,ry}, vrButtons} */
		input() {
			return inputApi().getInput();
		},
		/** Key down/up events; returns an unsubscribe. @param {(kind: 'down'|'up', code: string) => void} fn */
		onInput(fn) {
			// DEVX #8: subscribe SYNCHRONOUSLY through the primed ref (it resolves
			// at boot, before any module registers) — routing through a fresh
			// import().then() dropped keys pressed in the first seconds after a
			// user-module install. The promise path stays as an SSR-safe fallback,
			// and unsubscribing before it settles must stick (the `dead` flag).
			let unsub = () => {};
			let dead = false;
			if (inputRuntimeRef) {
				unsub = inputRuntimeRef.onInput(fn);
			} else {
				import('./inputRuntime').then((m) => {
					if (!dead) unsub = m.onInput(fn);
				});
			}
			const off = () => {
				dead = true;
				unsub(); // idempotent (Set.delete)
			};
			onDispose(off);
			return off;
		},
		/** Pause the host's own use of an input scope while your module drives:
		 * 'keys' (WASD camera fly / play movement) or 'locomotion' (VR left stick).
		 * ALWAYS release (module disable/error releases everything).
		 * @param {'keys'|'locomotion'} scope */
		claimInput(scope) {
			claimedScopes.add(scope);
			if (inputRuntimeRef) inputRuntimeRef.claimInput(scope);
			else import('./inputRuntime').then((m) => m.claimInput(scope));
		},
		/** @param {'keys'|'locomotion'} scope */
		releaseInput(scope) {
			claimedScopes.delete(scope);
			if (inputRuntimeRef) inputRuntimeRef.releaseInput(scope);
			else import('./inputRuntime').then((m) => m.releaseInput(scope));
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
			joints: () => import('./joints').then((m) => m.jointsSnapshot()),
			/** Is a simulation running anywhere in the session (ours or a peer's)?
			 * Gate driving/behaviour on this, not on isInitiator. */
			running: () =>
				physicsRef ? !!get(physicsRef.simulating) || !!get(physicsRef.remoteSimulating) : false,
			/** Replicated physics parameters — the shared setPhysicsFor write path
			 * (history entry + objectParameters + live collider rebuild).
			 * @param {string} uuid @param {any} patch */
			set: (uuid, patch) => physicsApi()?.setPhysicsFor(uuid, patch),
			/** Replicated joint (P-B): 'weld' | 'revolute', anchored in OBJECT-local
			 * space. @param {string} kind @param {string} a @param {string} b
			 * @param {string=} axis @param {any=} motor */
			createJoint: (kind, a, b, axis, motor) =>
				jointsRef?.createJoint(kind, a, b, axis ?? 'x', motor) ?? null
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
		/** Is Play mode active (the ▶ button / pointer lock)? Modules that only
		 * drive things in play gate on this. @returns {boolean} */
		isPlaying() {
			return get(isLocked) === true;
		},
		/** Connected peer ids (the replicated roster) — use it to free state a
		 * peer left behind. @returns {string[]} */
		peerIds() {
			return (/** @type {any[]} */ (get(userdata)) ?? []).map((entry) => entry[0]);
		},
		/**
		 * 21-E7.1 (DEVX #15's other half): the roster WITH NICKNAMES. `peerIds` answers who is
		 * here and nothing a player would recognise, which is what a leaderboard is blocked on -
		 * a table of peer ids is not a scoreboard.
		 *
		 * The name is the roster row's slot 1, replicated through the existing `userdata`
		 * message, so this is a READ of already-shared state and adds nothing to the wire. A
		 * peer who has not set one has an empty name; the id is offered as `label` so a caller
		 * never has to decide how to fall back.
		 * @returns {{id: string, name: string, label: string, me: boolean}[]}
		 */
		peerNames() {
			const myId = /** @type {any} */ (get(peers))?.peer?.id ?? '';
			return (/** @type {any[]} */ (get(userdata)) ?? [])
				.filter((entry) => !!entry?.[0])
				.map((entry) => {
					const id = String(entry[0]);
					const name = String(entry[1] ?? '');
					// a short id tail is far more use than the whole 36-character peer id
					return { id, name, label: name || 'peer ' + id.slice(0, 4), me: id === myId };
				});
		},
		/**
		 * DEVX #5: create objects in the SHARED scene, replicated exactly like a
		 * user typing the command. Returns the uuids that appeared, so you can
		 * position them (api.moveObject) or joint them together.
		 * @param {string} command e.g. '/create Box 1 1 1'
		 * @param {{at?: number[]}=} opts `at` places the object (replicated)
		 * @returns {Promise<string[]>}
		 */
		async create(command, opts) {
			const group = get(objectsGroup);
			const before = new Set((group?.children ?? []).map((/** @type {any} */ c) => c.uuid));
			if (opts?.at && addObjectsRef) addObjectsRef.spawnAtPoint(command, opts.at);
			else {
				const commands = await import('./commandsHandler.svelte');
				commands.sceneCommand(command);
			}
			return (get(objectsGroup)?.children ?? [])
				.filter((/** @type {any} */ c) => !before.has(c.uuid))
				.map((/** @type {any} */ c) => c.uuid);
		},
		/**
		 * DEVX #5: move/rotate/scale a shared object and tell every peer — the
		 * same `move` the editor sends. Omitted parts keep their current value.
		 * @param {string} uuid @param {{pos?: number[], rot?: number[], scale?: number[]}} to
		 */
		moveObject(uuid, to) {
			/** @type {any} */
			const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
			if (!object) return false;
			if (to?.pos) object.position.fromArray(to.pos);
			if (to?.rot) object.rotation.set(to.rot[0], to.rot[1], to.rot[2]);
			if (to?.scale) object.scale.fromArray(to.scale);
			object.updateMatrix();
			/** @type {any} */
			const peer = get(peers);
			peer?.send({
				type: 'move',
				uuid,
				pos: object.position.toArray(),
				rot: [object.rotation.x, object.rotation.y, object.rotation.z],
				scale: object.scale.toArray()
			});
			return true;
		},
		/** Fly the LOCAL editor camera somewhere (never replicated — the viewpoint
		 * is per-viewer). @param {number[]} position @param {number[]=} lookAt */
		flyTo(position, lookAt) {
			objectActionsRef?.flyTo(position, lookAt ?? position);
		},
		/** A spatial UI chime (the ping sounds). LOCAL — broadcast your own op if
		 * peers should hear it too. @param {string=} sound @param {number[]=} position */
		playSound(sound = 'ding', position = undefined) {
			pingAudioRef?.playPing(sound, position ?? null);
		},
		/** Park the editor camera behind an object and follow it (the car's chase
		 * cam) — LOCAL, no selection, no undo. @param {string} uuid */
		followCam(uuid) {
			return possessRef?.startFollowCam(uuid) ?? false;
		},
		stopFollowCam() {
			possessRef?.stopFollowCam();
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
		 * A1 (DEVX #9): pulse your module's own EVENT nodes — a level cleared, a goal
		 * scored, a wave spawned. REPLICATED like a click (the pulse rides the existing
		 * `nodetrigger` message from ONE peer's stamp), so call it on the peer where the
		 * event happened and NOT on all of them, or a Counter counts it once per peer.
		 *
		 * `match(data, id)` picks which instances fire; all of them when it is absent.
		 * Register the node type's output as `{vtype: 'event'}` so it can be wired to a
		 * Counter or an Object Selector.
		 *
		 * R3a: `opts.replicate === false` keeps the pulse in THIS peer's own trigger log —
		 * the per-player mechanism (a per-player collect fires locally; everything
		 * downstream — latch state, hide, counting — is then per-peer for free). Absent,
		 * the node's own `perPlayer` data flag decides, exactly as before.
		 * @param {string} type @param {(data: any, id: string) => boolean=} match
		 * @param {{replicate?: boolean}=} opts
		 */
		fireNodeTrigger(type, match, opts) {
			if (flowRuntimeRef) flowRuntimeRef.fireModuleTrigger(type, match, opts);
			else import('./flowRuntime').then((m) => m.fireModuleTrigger(type, match, opts));
		},
		/**
		 * R3a: where the VIEWER is — the active camera's world position as [x, y, z], or
		 * null before the scene exists. In play mode the camera IS the player (walk mode,
		 * fly mode and VR all move it), so this is the read a self-proximity trigger wants:
		 * each peer detects ITSELF near an object and fires its own pulse, no physics sim
		 * required. @returns {number[] | null}
		 */
		playerPosition() {
			const cam = /** @type {any} */ (get(globalCamera));
			if (!cam?.getWorldPosition) return null;
			return cam.getWorldPosition(new THREE.Vector3()).toArray();
		},
		/**
		 * R3a: select an object (the viewport-click path — selection is also the lock).
		 * The manager-toolbox row click. @param {string} uuid
		 */
		selectObject(uuid) {
			objectActionsRef?.selectObject?.(uuid);
		},
		/** R3a: the current selection SET's uuids — [] when nothing is selected. Reads the
		 * SET, never the sticky primary (`selectedUuid`), which keeps the last object after
		 * a deselect. @returns {string[]} */
		selectedUuids() {
			return [...(get(selectedObjects) ?? [])].filter(Boolean);
		},
		/**
		 * R3a: THE GAME SHELL, read-mostly. The round reads are what `perRound` content
		 * gates on; the variable pair is the shared scoreboard (the game singleton — writes
		 * replicate latest-wins, and an `add` computed on every peer from one replicated
		 * stamp is the standing shared-scope semantic). Per-player numbers live in
		 * `api.peerVars` instead.
		 */
		game: {
			/** The replicated round cutoff: null = shell unused, Infinity = menu/over, else
			 * the running round's start (epoch ms). @returns {number | null} */
			roundCutoff() {
				return roundCutoff();
			},
			/** Is a round underway (playing or paused)? @returns {boolean} */
			roundUnderway() {
				return roundUnderway();
			},
			/** Is THIS peer playing inside a running round? (`isPlaying() && roundUnderway()`
			 * — the gate recipe-driven effects act under.) @returns {boolean} */
			playActive() {
				return !!flowRuntimeRef?.gamePlayActive?.();
			},
			/** @param {string} name @param {number=} fallback @returns {number} */
			getVar(name, fallback = 0) {
				return gameVar(name, fallback);
			},
			/** Replicated latest-wins write to the shared game singleton.
			 * @param {string} name @param {number} value */
			setVar(name, value) {
				setGameVar(name, value);
			}
		},
		/**
		 * R3a: PEER-OWNED variables (21-G4). One writer per row BY CONSTRUCTION — this api
		 * only ever writes YOUR row (`setMine`), which is what makes per-player counting
		 * immune to the shared-scope add race. Rows replicate on the presence channel,
		 * late joiners converge, a row drops with its owner's disconnect.
		 */
		peerVars: {
			/** Write MY OWN row. @param {string} name @param {number} value */
			setMine(name, value) {
				setPeerVar(name, value);
			},
			/** My own number. @param {string} name @param {number=} fallback @returns {number} */
			mine(name, fallback = 0) {
				return myPeerVar(name, fallback);
			},
			/** Everyone's rows for one name, roster-resolved and deterministically ordered —
			 * `[{id, name, value, me, rank}]`, the leaderboard shape. @param {string} name
			 * @param {{order?: 'desc'|'asc'}=} opts */
			all(name, opts) {
				return leaderboardRows(name, opts);
			}
		},
		/**
		 * R3a: THE GRAPH, for modules whose node needs neighbours — a manager toolbox
		 * listing its instances, a count node reading its siblings, a recipe creating the
		 * node wired to an Object Selector. Reads are DETERMINISTIC because the graph is
		 * replicated; treat them exactly like replicated state (the value-node rule).
		 */
		flow: {
			/** Every node (optionally one type) as plain snapshots:
			 * `{id, type, graphId, data}` — graphId 'scene' or the owner object's uuid.
			 * @param {string=} type @returns {any[]} */
			nodes(type) {
				const out = [];
				for (const n of allNodes()) {
					if (type && n.type !== type) continue;
					out.push({ id: n.id, type: n.type, graphId: n.__graph ?? SCENE_GRAPH, data: { ...(n.data ?? {}) } });
				}
				return out;
			},
			/** Every edge, graph-tagged: `{id, source, target, sourceHandle, targetHandle,
			 * graphId}`. @returns {any[]} */
			edges() {
				const out = [];
				for (const [graphId, graph] of Object.entries(get(flowGraphs) ?? {})) {
					for (const e of graph.edges ?? [])
						out.push({
							id: e.id,
							source: e.source,
							target: e.target,
							sourceHandle: e.sourceHandle ?? null,
							targetHandle: e.targetHandle ?? null,
							graphId
						});
				}
				return out;
			},
			/** A node's current evaluated VALUE (what its output socket carries this tick) —
			 * how a module reads a core Latch's round-aware state without reimplementing it.
			 * Undefined for nodes that carry no value. @param {string} id */
			nodeValue(id) {
				return get(flowValues)[id];
			},
			/** A node's OWN round-aware trigger-log entry: `{stamp, age}` or null (never
			 * fired, or retired by `perRound` against the replicated round). The latch read
			 * a collectible-style module polls. @param {string} id */
			triggerStamp(id) {
				return flowRuntimeRef?.nodeTriggerStamp?.(id) ?? null;
			},
			/** Replicated node-data MERGE (the editor's own `nodedata` path — same message,
			 * same merge). The manager toolbox's inline param edit. @param {string} id
			 * @param {Record<string, any>} patch @returns {boolean} found */
			setNodeData(id, patch) {
				const found = findNodeAnyGraph((n) => n.id === id);
				if (!found) return false;
				sendNodeData(id, patch ?? {}, found.graphId);
				return true;
			},
			/**
			 * Create nodes (and edges) the way the editor does: replicated `nodecreate`/
			 * `edgecreate` per item plus ONE `flownodes` undo entry for the batch — so what a
			 * module builds can be undone in one step and taken apart afterwards, because it
			 * is an ordinary graph (the recipe rule).
			 *
			 * `nodes`: `[{type, x, y, data}]` — label defaults to the core spec's (or the
			 * type), data is spread over the spec defaults. `edges`: `[{from, to, handle?,
			 * fromHandle?}]` where from/to are INDICES into `nodes` or existing node ID
			 * strings; `handle` is the target handle. Edge ids take the editor's canonical
			 * handle-qualified shape — peer dedupe depends on it.
			 * @param {{graphId?: string, nodes?: any[], edges?: any[]}} spec
			 * @returns {string[]} the created node ids ([] until the runtime is primed)
			 */
			addNodes(spec) {
				if (!flowGraphsRef) return [];
				const graphId = spec?.graphId ?? SCENE_GRAPH;
				/** @type {any} */
				const peer = get(peers);
				const uuid = () =>
					typeof crypto !== 'undefined' && crypto.randomUUID
						? crypto.randomUUID()
						: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
								const r = (Math.random() * 16) | 0;
								return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
							});
				const created = (spec?.nodes ?? []).map((n) => {
					const nodeSpec = nodeCatalogRef?.findNodeSpec?.(n.type);
					return {
						id: uuid(),
						type: n.type,
						position: { x: Number(n.x) || 0, y: Number(n.y) || 0 },
						data: {
							label: nodeSpec?.label ?? n.data?.label ?? n.type,
							type: n.type,
							...(nodeSpec?.defaults ?? {}),
							...(n.data ?? {})
						},
						class: 'w-[150px]'
					};
				});
				const resolve = (/** @type {any} */ ref) =>
					typeof ref === 'number' ? created[ref]?.id : String(ref ?? '');
				const createdEdges = (spec?.edges ?? [])
					.map((e) => {
						const source = resolve(e.from);
						const target = resolve(e.to);
						if (!source || !target) return null;
						const sh = e.fromHandle ? '.' + e.fromHandle : '';
						const th = e.handle ? '.' + e.handle : '';
						return {
							id: 'e-' + source + sh + '-' + target + th,
							source,
							target,
							...(e.fromHandle ? { sourceHandle: e.fromHandle } : {}),
							...(e.handle ? { targetHandle: e.handle } : {})
						};
					})
					.filter(Boolean);
				// nodes before edges, the editor's own order
				for (const node of created) {
					createFlowNode(node, graphId);
					if (peer) peer.send({ type: 'nodecreate', node: serializeNode(node), graphId });
				}
				for (const edge of createdEdges) {
					createFlowEdge(edge, graphId);
					if (peer) peer.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId });
				}
				if (created.length || createdEdges.length)
					flowGraphsRef.recordFlowNodesEntry({
						op: 'create',
						graphId,
						nodes: created.map(serializeNode),
						edges: createdEdges.map(serializeEdge)
					});
				return created.map((n) => n.id);
			}
		},
		/**
		 * Possess an object: WASD/arrows or the VR left stick drive it (tank
		 * controls) with a follow camera; Esc releases. Possessing selects it
		 * (selection = lock), suspends its flow effects and records ONE undo
		 * entry on release. @param {string} uuid
		 * @param {{camera?: 'chase'|'orbit'|'none', speed?: number, turnSpeed?: number}=} opts
		 */
		possess(uuid, opts) {
			possessing = true;
			return possessRef?.possess(uuid, opts) ?? false;
		},
		releasePossess() {
			possessing = false;
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
		assetUrl: (path) => moduleAssets[moduleId]?.[path] ?? null,
		/**
		 * P12 seam: add a UV UNWRAP backend, which then appears in the UV editor's Unwrap menu
		 * beside the built-in projections.
		 *
		 * This is how a heavier unwrapper (xatlas and friends) can ship WITHOUT weighing down
		 * the core bundle: the module owns the library, core keeps the projections that always
		 * work. `run(faces, options)` is the same contract the built-ins implement, and it may
		 * be ASYNC — which is what makes a wasm backend possible. A module can carry the .wasm
		 * INSIDE its own zip and reach it through `api.assetUrl`, so it needs no network and
		 * trips no CSP.
		 * @param {string} key @param {string} label
		 * @param {(faces: any[], options: any) => any} run
		 */
		registerUnwrapBackend: (key, label, run) =>
			// dynamic, like the other late imports here: uvUnwrap stays out of the SDK's static
			// graph (the cycle guard)
			import('./uvUnwrap').then((m) =>
				m.registerUnwrapBackend(`mod-${moduleId}-${key}`, label, run)
			),

		/**
		 * SH6: supply a shader-graph COMPILE BACKEND. `compile(ir, ctx)` receives the same IR
		 * the built-ins get — `{uniforms, prelude, body, defines, albedo?, emissive?,
		 * roughness?, metalness?, normal?, opacity?, ao?, vertex?}` — plus `{object, scene,
		 * camera, renderer, baseMaterial}`, and returns a three Material (async allowed).
		 * That is how a module ships a different lighting model, a TSL path or a wasm
		 * compiler without core carrying any of it.
		 *
		 * A graph names its backend in its own document, so one authored against a module's
		 * backend keeps working for peers that have the module, and a peer without it falls
		 * back to the built-in with the reason surfaced per graph.
		 *
		 * RETURNS THE PROMISE, like registerUnwrapBackend — await it rather than sleeping on
		 * it (the documented uv-unwrap-module lesson).
		 * @param {string} key @param {string} label
		 * @param {(ir: any, ctx: any) => any} compile
		 * @returns {Promise<void>}
		 */
		registerShaderBackend: (key, label, compile) => {
			const full = `mod-${moduleId}-${key}`;
			// dynamic for the same cycle reason as every other late import here
			const job = import('./shaderBackends').then((m) => {
				const off = m.registerShaderBackend(full, label, compile);
				// same-module import promises resolve in .then order, so the disposer is
				// recorded even when teardown fires immediately after registration
				onDispose(() => off());
			});
			// a graph still naming this backend must not be left compiling against nothing:
			// once the registration is gone, re-compile those graphs so they fall back to the
			// built-in rather than silently keeping a stale material
			onDispose(() => import('./shaderGraph').then((m) => m.fallBackFromBackend(full, label)));
			return job;
		},

		/**
		 * #20 P6 (post plan P3): supply a whole POST EFFECT — an entry a user can add to
		 * the scene look, with its own params. `def` is the scenePost shape:
		 * `{label, group, isPass, params, make(params, ctx)}`, where `make` returns a
		 * postprocessing Effect (or a Pass with `isPass: true`).
		 *
		 * The kind is NAMESPACED `mod-<moduleId>-<kind>`, so two modules cannot collide and
		 * a document naming it stays readable when the module is gone: the post stack
		 * already PRESERVES-and-SKIPS an entry whose kind is unregistered, and registering
		 * pokes the stack so the chain rebuilds. That is deliberately the same story a peer
		 * who never had the module gets — the fallback belongs to the registry, not to the
		 * disable path.
		 *
		 * RETURNS THE PROMISE — await it rather than sleeping on it.
		 * @param {string} kind @param {any} def
		 * @returns {Promise<void>}
		 */
		registerPostEffect: (kind, def) => {
			const full = `mod-${moduleId}-${kind}`;
			// The disposer is recorded SYNCHRONOUSLY, and the late registration undoes
			// itself if teardown already ran. Recording it inside the `.then` instead
			// leaks the registration whenever a disable lands before the dynamic import
			// resolves — measured in post-backends: the kind was still in the registry
			// after `deactivateModule`, because the journal had already been replayed by
			// the time `onDispose` was handed the disposer.
			let off = /** @type {(() => void)|null} */ (null);
			let disposed = false;
			onDispose(() => {
				disposed = true;
				if (off) off();
			});
			return import('./scenePost').then((m) => {
				off = m.registerPostEffect(full, def);
				if (disposed) off();
			});
		},

		/**
		 * #20 P6: supply a post COMPILER — a backend turning a post shader description into
		 * an Effect. Separate from `registerShaderBackend` because the output is an Effect
		 * and not a Material (see postBackends.js for why that separation is load-bearing).
		 *
		 * An unknown key falls back to the built-in INSIDE the registry, so nothing here has
		 * to undo anything on teardown beyond removing itself.
		 * @param {string} key @param {string} label
		 * @param {(spec: any, ctx: any) => any} compile
		 * @returns {Promise<void>}
		 */
		registerPostBackend: (key, label, compile) => {
			const full = `mod-${moduleId}-${key}`;
			// same synchronous-disposer shape as registerPostEffect above — see the note
			// there for the race it closes
			let off = /** @type {(() => void)|null} */ (null);
			let disposed = false;
			onDispose(() => {
				disposed = true;
				if (off) off();
			});
			return import('./postBackends').then((m) => {
				off = m.registerPostBackend(full, label, compile);
				if (disposed) off();
			});
		},

		/**
		 * 21-E7.1: WRITE ROWS INTO A HUD LIST. The third door onto one store, beside the
		 * element's own authored rows and the HUD Rows node.
		 *
		 * `setHudRows` has existed since 21-A and lived in `flowRuntime`, which a module cannot
		 * reach — so the List kind shipped with its summary promising an API that did not exist.
		 * A leaderboard was the worked example and it was the one thing you could not build.
		 *
		 * CALL IT ON EVERY PEER from replicated state (your own `registerStateSync`, or a value
		 * every peer derives). Rows are never sent: like a module VALUE NODE, this writes local
		 * state that each peer is expected to compute identically, so calling it on one peer
		 * shows the rows to one person.
		 *
		 * The element's rows are cleared at teardown, so disabling the module puts the AUTHORED
		 * rows back rather than freezing the last thing you pushed.
		 */
		hud: {
			/** @param {string} elementId @param {any[]} rows */
			rows(elementId, rows) {
				const id = String(elementId ?? '').trim();
				if (!id) return;
				// primed ref, not a fresh import().then(): a module pushing rows from a frame task
				// would otherwise drop every push until the promise settled (DEVX #8)
				if (flowRuntimeRef) flowRuntimeRef.setHudRows(id, rows);
				else import('./flowRuntime').then((m) => m.setHudRows(id, rows));
				if (!hudRowsOwned.has(id)) {
					hudRowsOwned.add(id);
					onDispose(() =>
						flowRuntimeRef
							? flowRuntimeRef.clearHudRows(id)
							: import('./flowRuntime').then((m) => m.clearHudRows(id))
					);
				}
			},
			/** Drop the rows again, putting the element's authored ones back. @param {string} elementId */
			clearRows(elementId) {
				const id = String(elementId ?? '').trim();
				if (!id) return;
				if (flowRuntimeRef) flowRuntimeRef.clearHudRows(id);
				else import('./flowRuntime').then((m) => m.clearHudRows(id));
			},
			/**
			 * R3a: a line on the DEBUG element's expanded pill. `fn()` returns a string, or
			 * null/'' for "nothing to say right now"; it is sampled by the pill's own 500ms
			 * timer (never per frame) and a throw is swallowed. The collectibles counts line
			 * moved out of core through exactly this seam. @param {() => string | null} fn
			 */
			registerDebugLine(fn) {
				const off = registerModuleDebugLine(moduleId, fn);
				onDispose(off);
			},
			/**
			 * R3a: an entry in the HUD editor's ACTION catalog (the Actions section's picker).
			 * `entry` is the exact HudActionDef shape hudActions.js documents — {key, label,
			 * group, role: 'press'|'drives'|'value'|'writes', node, data?, handle?, via?,
			 * chain?, hint?}. The key is namespaced `mod-<moduleId>-<key>`. "Show collectibles
			 * left" moved out of core through this seam. @param {any} entry
			 * @returns {string} the namespaced key
			 */
			registerAction(entry) {
				const key = 'mod-' + moduleId + '-' + String(entry?.key ?? 'action');
				const off = registerModuleHudAction(moduleId, entry);
				onDispose(off);
				return key;
			}
		},

		/**
		 * 21-E7.4: SHIP YOUR OWN HUD ELEMENT KIND.
		 *
		 * `registerToolbox`'s contract, one layer in: you hand over a `(container, element,
		 * runtime) => cleanup` mount fn and core hands you a DOM node inside a real HUD element
		 * — so you inherit the layer's z-tier, the 9-grid anchoring, the document, replication,
		 * undo and all four save paths without writing any of it. `fields` are the properties
		 * pane's rows (the `hudKinds` schema: {key, kind, label, min, max, step, options,
		 * placeholder, hint}), `defaults` their starting values.
		 *
		 * Return `{update(element, runtime), destroy()}` instead of a bare cleanup and a runtime
		 * change calls `update` rather than rebuilding your DOM — which is what you want if you
		 * are drawing to a canvas.
		 *
		 * The kind is NAMESPACED `mod-<moduleId>-<kind>`, and the name is written into a
		 * replicated, saved document. A peer without the module reaches an unknown kind, which
		 * the HUD already PRESERVES verbatim and skips at render — so their layout survives and
		 * installing the module makes the element appear. Same story after a disable, which is
		 * the point: the fallback belongs to the format, not to the disable path.
		 * @param {string} kind @param {any} def
		 * @returns {string} the namespaced kind name
		 */
		registerHudElement(kind, def) {
			const full = registerModuleHudKind(moduleId, kind, {
				moduleName: def?.moduleName || moduleName,
				...(def ?? {})
			});
			onDispose(() => unregisterModuleHudKind(full));
			return full;
		}
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
			mod.register(makeApi(mod.id, mod.name || mod.id));
			loadedModules.push({ id: mod.id, name: mod.name, version: mod.version, description: mod.description });
			console.log('module loaded: ' + mod.id + ' v' + mod.version);
		} catch (error) {
			console.log('module ' + mod.id + ' failed to register', error);
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
			console.log('module ' + id + ' teardown step failed', error);
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
