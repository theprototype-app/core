// Module SDK — creatable primitives, viewport clicks/drops, frame tasks, scene-root groups, scene clear, scope.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { editorMode } from '../../stores/sceneStore';
import { customGeometryBuilders } from '../customGeometries';
import { noteModuleGroup, forgetModuleGroup } from '../moduleContent';
import { ownerInScope } from '../sceneScope';
import { get } from 'svelte/store';
import {
	modulePrimitiveGroups,
	moduleClickHandlers,
	clickHandlerModes,
	normalizeClickModes,
	noSweepHandlers,
	moduleDropHandlers,
	moduleFrameTasks,
	moduleInteractiveGroups,
	systemGroupNames,
	registerSystemGroup,
	sceneClearHandlers,
	arrayRemove,
	removeSceneRootGroup
} from './registries.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkScene(ctx) {
	const { moduleId, moduleName, onDispose } = ctx;
	return {
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
		 *
		 * 30 P1: `{modes}` says WHERE it runs — any of 'edit' | 'interact' | 'play'.
		 * Absent means ['interact', 'play']: a handler that is part of the GAME (a key,
		 * a pad, a puzzle piece) no longer eats the editor's select click. A handler
		 * that is an editor TOOL (a toolbox pick) passes {modes: ['edit']}, or all three.
		 * In Edit an 'edit' handler still runs BEFORE the selection, so it can consume.
		 *
		 * 30b: `fn(object, ctx)` — `ctx.source` is 'click', 'trigger' (the VR press) or
		 * 'sweep' (VR, Interact/Play: the trigger HELD and the controller tip or laser
		 * passing into this mesh — each entry clicks once, re-armed when it leaves). Pass
		 * `{sweep: false}` for a control that must not be swept (a knob you drag, a dot you
		 * carry); it still hears the press.
		 * @param {(object: any, ctx?: {source: string, mode: string}) => boolean} fn
		 * @param {{modes?: string[], sweep?: boolean}} [options]
		 */
		registerClickHandler(fn, options = {}) {
			clickHandlerModes.set(fn, normalizeClickModes(options?.modes));
			if (options?.sweep === false) noSweepHandlers.add(fn);
			moduleClickHandlers.push(fn);
			onDispose(() => arrayRemove(moduleClickHandlers, fn));
		},
		/**
		 * 23-C2: an Explorer item dropped ON a scene object - audio and text items, the ones
		 * core has no placement for. `fn(hit, item, target)` gets the exact mesh under the
		 * drop, the item `{id, name, kind, hash}` (feed `hash` to `api.audio.sample`) and the
		 * resolved target; return true to consume the drop.
		 * @param {(hit: any, item: {id: string, name: string, kind: string, hash: string}, target: any) => boolean} fn
		 */
		registerDropHandler(fn) {
			moduleDropHandlers.push(fn);
			onDispose(() => arrayRemove(moduleDropHandlers, fn));
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
			noteModuleGroup(name, { id: moduleId, name: moduleName }, 'interactive'); // 30 P3
			onDispose(() => {
				arrayRemove(moduleInteractiveGroups, name);
				arrayRemove(systemGroupNames, name);
				forgetModuleGroup(name, 'interactive');
				removeSceneRootGroup(name); // module-owned viewport content goes with the module
			});
		},
		/** List a scene-root group under the object list's System filter @param {string} name */
		registerSystemGroup(name) {
			registerSystemGroup(name);
			noteModuleGroup(name, { id: moduleId, name: moduleName }, 'system'); // 30 P3
			onDispose(() => {
				arrayRemove(systemGroupNames, name);
				forgetModuleGroup(name, 'system');
				removeSceneRootGroup(name);
			});
		},
		/**
		 * 30 P3: list a scene-root group in the object list's "Module content" section under
		 * a label a person can read (the group's own name is usually an id). Groups passed to
		 * registerInteractiveGroup / registerSystemGroup are listed anyway; this names them,
		 * or lists one that is neither. Read-only there: a click selects a PROXY and frames
		 * it, and the Inspector points at your module's toolbox and nodes.
		 * @param {string} name the scene-root group's object name
		 * @param {{label?: string, icon?: string}} [options]
		 */
		registerListedGroup(name, options = {}) {
			noteModuleGroup(name, { id: moduleId, name: moduleName }, 'listed', options ?? {});
			onDispose(() => forgetModuleGroup(name, 'listed'));
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
		 * 33 (L4): does the scene on screen still count this module? False once a scene switch
		 * LEFT IT BEHIND — the person kept it loaded, but the scene now open does not use it
		 * (Waves kept while Towers is open). Core already keeps such a module's levels, help,
		 * settings rows, Restart, music and spawn out of the new game; what core cannot stop is
		 * the module's OWN drawing and listening (a gun in the hand), so a game module stands
		 * down while this reads false. True for a module no switch has left behind (a fresh
		 * install in a blank scene is in scope). LOCAL, read-only. @returns {boolean}
		 */
		inScene() {
			return ownerInScope(moduleId);
		},
		/**
		 * 30 integrate (modules DEVX #35): the editor's click mode on THIS screen —
		 * 'edit' | 'interact'. LOCAL and read-only; `isPlaying()` says whether Play is on
		 * top of it. A module whose own pointer listeners run outside core's click routing
		 * (untangle's drag) stands down while this reads 'edit' and nothing is playing, so an
		 * Edit click selects its content like any object.
		 * @returns {'edit' | 'interact'}
		 */
		editorMode() {
			return get(editorMode) === 'interact' ? 'interact' : 'edit';
		}
	};
}
