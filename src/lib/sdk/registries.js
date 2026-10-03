// Module SDK — the registries the host app consumes, the click-mode rules, the per-module teardown journal.

import { globalScene, objectsGroup } from '../../stores/sceneStore';
import { log } from '../diagnostics';
import { clearAnnouncement } from '../gameAnnounce';
import { resetKit } from '../kit/runtime.js';
import { writable, get } from 'svelte/store';
import { effectsRef } from './refs.js';

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
/** 30b: a handler also gets `ctx = {source, mode}` (see runClickHandlers)
 * @type {((object: any, ctx?: {source: string, mode: string}) => boolean)[]} */
export const moduleClickHandlers = [];

/** 30 P1: the three places a viewport click can come from. */
export const CLICK_MODES = ['edit', 'interact', 'play'];
/** What an SDK handler hears when it names no modes: Interact and Play, NOT Edit —
 * the behaviour change the user asked for (a piano or a puzzle piece used to swallow
 * every EDITOR click, so it could never be selected). */
export const DEFAULT_CLICK_MODES = ['interact', 'play'];
/** handler -> the modes it runs in. A handler with NO entry runs everywhere: that is a
 * core handler pushed straight into the array (vrPatch's plug click — patching a cable
 * is authoring, so it must keep working in Edit), never an SDK one.
 * @type {WeakMap<Function, string[]>} */
export const clickHandlerModes = new WeakMap();

/** Normalise a `{modes}` option: known names only, the default when nothing usable is
 * left. @param {any} modes @returns {string[]} */
export function normalizeClickModes(modes) {
	const list = Array.isArray(modes) ? modes : typeof modes === 'string' ? [modes] : [];
	const known = [...new Set(list.filter((mode) => CLICK_MODES.includes(mode)))];
	return known.length ? known : [...DEFAULT_CLICK_MODES];
}

/** 30b (C3): handlers that asked NOT to be swept (`{sweep: false}`) — a knob you drag, a
 * dot you carry. They still hear the press itself; only the later entries of a held
 * trigger skip them. @type {WeakSet<Function>} */
export const noSweepHandlers = new WeakSet();

/** Does this handler run for a click in `mode`? A null mode is VR's trigger, which has
 * no editor mode of its own yet and keeps offering every handler, as it always has.
 * @param {Function} fn @param {string | null} mode */
export function clickHandlerRunsIn(fn, mode) {
	if (!mode) return true;
	const modes = clickHandlerModes.get(fn);
	return !modes || modes.includes(mode);
}

/**
 * Offer a clicked mesh to every handler that runs in `mode`, in registration order; the
 * first to return true consumes the click. ONE dispatch for the editor's pick, Interact
 * and Play's tap, so the three can never disagree about who hears what.
 *
 * 30b (C3): every handler also gets `ctx = {source, mode}` — `source` is 'click' (the
 * desktop / a VR release), 'trigger' (the VR press itself, fired on the press) or 'sweep'
 * (a later entry while the trigger is held). A 'sweep' skips handlers registered with
 * `{sweep: false}`. Additive: a one-argument handler is byte-unchanged.
 * @param {any} object @param {string | null} mode @param {{source?: string}} [ctx]
 * @returns {boolean}
 */
export function runClickHandlers(object, mode, ctx = {}) {
	const source = ctx?.source ?? 'click';
	const info = { source, mode: mode ?? 'vr' };
	for (const handler of [...moduleClickHandlers]) {
		if (!clickHandlerRunsIn(handler, mode)) continue;
		if (source === 'sweep' && noSweepHandlers.has(handler)) continue;
		try {
			if (handler(object, info)) return true;
		} catch (error) {
			log('warn', 'module', 'click handler failed', String(error));
		}
	}
	return false;
}

/** The modes a handler was registered with (tests / the debug view).
 * @param {Function} fn @returns {string[] | null} */
export function clickHandlerModesOf(fn) {
	return clickHandlerModes.get(fn) ?? null;
}
/** 23-B1: a viewport click that hit NOTHING. `moduleClickHandlers` is only ever handed a
 * MESH, so a gesture armed by a plug click had no way to hear "the user clicked the sky":
 * the wire stayed armed for the rest of the session and a picked-up cable stayed HIDDEN
 * with it. Nothing consumes — a miss is still a deselect.
 * @type {(() => void)[]} */
export const moduleClickMissHandlers = [];

/** Dispatch a viewport click that resolved to nothing selectable. Scene's editor pick and
 * play mode's tap both call it; it never consumes. */
export function fireClickMiss() {
	for (const handler of moduleClickMissHandlers) {
		try {
			handler();
		} catch (error) {
			log('warn', 'module', 'click-miss handler failed', String(error));
		}
	}
}
/** 23-C2: Explorer drops onto a module object - `fn(hit, item, target)`: `hit` is the exact
 * mesh under the drop, `item` `{id, name, kind, hash}`, `target` the resolved drop target;
 * return true to consume it (a sampler pad taking a sample). Same lifecycle as
 * moduleClickHandlers: registered by modules, cleared with them.
 * @type {((hit: any, item: {id: string, name: string, kind: string, hash: string}, target: any) => boolean)[]} */
export const moduleDropHandlers = [];
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
export const sceneClearHandlers = [];

/** Called by the clear-scene path (local and remote) */
export function runSceneClearHandlers() {
	// 30b: a cleared scene takes its game's bursts and banner with it
	effectsRef?.clearBursts?.();
	clearAnnouncement();
	// 34 R2: the next game starts with a fresh kit document (every peer clears; nothing is sent)
	resetKit();
	sceneClearHandlers.forEach((fn) => {
		try {
			fn();
		} catch (error) {
			log('warn', 'module', 'scene-clear handler failed', String(error));
		}
	});
}

/** @type {{id: string, name: string, version: string}[]} */
export const loadedModules = [];
/** @type {Record<string, ((data: any) => void)[]>} */
export const messageHandlers = {};
/** @type {Record<string, {getState: () => any, applyState: (state: any) => void}>} */
export const stateSyncs = {};

/** A2: per-module teardown journal — every api.register* records an undo thunk
 * here so deactivateModule() can genuinely dispose a module (the dev-mode live
 * reload tears down and re-registers with fresh code, no page reload).
 * @type {Record<string, (() => void)[]>} */
export const moduleDisposals = {};

/** remove one value from a plain registry array, in place
 * @param {any[]} arr @param {any} value */
export function arrayRemove(arr, value) {
	const index = arr.indexOf(value);
	if (index >= 0) arr.splice(index, 1);
}

/** A2: drop a module-owned viewport group at teardown. SCENE-ROOT only (golden
 * rule 5) — anything inside objectsGroup is replicated user content and stays.
 * @param {string} name */
export function removeSceneRootGroup(name) {
	const scene = get(globalScene);
	const target = scene?.getObjectByName(name);
	if (!target) return;
	const objects = get(objectsGroup);
	for (let node = target; node; node = node.parent) {
		if (objects && node === objects) return;
	}
	target.parent?.remove(target);
}

/** @type {Record<string, Record<string, string>>} moduleId -> {path: blobUrl} */
export const moduleAssets = {};
