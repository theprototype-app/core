// A5 — module TOOLBOXES: `api.registerToolbox` over the shared ToolboxWindow shell.
//
// `makeApi()` had no DOM/panel seam at all, so a module's controls could only live
// behind `registerMenu` — two clicks deep inside the Modules MODAL, which then has to
// be closed before the module's own overlay is usable. Every module that wanted real
// controls hand-rolled a fixed overlay at a z-index it does not own (dungeon-realms'
// `#dr-gui` at 900, dungeon's `#dungeon-panel` at 40, inside the --z-window band).
//
// A module writes plain DOM through a `(el) => cleanup` mount fn (the cloudMount
// contract) and gets dragWindow persistence, focusStack z-banding, the <=640px bottom
// sheet and the whole `.tbx-*` CSS contract for nothing.
//
// STORE-ONLY (svelte/store and nothing else): moduleSDK imports this, and moduleSDK is
// reachable from flowRuntime, so any edge from here into the app would risk the TDZ
// cycle family around history.js.
//
// `openToolboxes` is the piece that did not exist anywhere: MeshEditPopup and
// SculptToolbar are rendered by a consumer's own `{#if}` over state their session
// stores already own (`faceEditObject`, `sculptMode`). A module toolbox has no session,
// so open/closed has to live somewhere — here. Those two are deliberately NOT reworked
// onto this store: it would be a second source of truth for state that belongs to an
// edit session, whose Done/Esc owns the lifecycle.

import { writable, get } from 'svelte/store';

/**
 * @typedef {{
 *   moduleId: string, id: string, title: string, key?: string,
 *   width?: number, minW?: number,
 *   defaultRect?: {left?: number, top?: number, right?: number, bottom?: number},
 *   mount: (el: HTMLElement) => (() => void) | void,
 *   onOpen?: () => void, onClose?: () => void,
 *   playMode?: boolean, shortcut?: string, sidebar?: boolean
 * }} ModuleToolbox
 */

/** every registered toolbox, in registration order
 * @type {import('svelte/store').Writable<ModuleToolbox[]>} */
export const moduleToolboxes = writable([]);

/** ids of the toolboxes currently OPEN. LOCAL — a toolbox is this viewer's window,
 * never scene data, so nothing here replicates or is saved with the scene.
 * @type {import('svelte/store').Writable<string[]>} */
export const openToolboxes = writable([]);

/** Register a toolbox. Returns the resolved id (namespaced `mod-<moduleId>-<id>`), so
 * the caller can open/close it without re-deriving the name.
 * @param {ModuleToolbox} box @returns {string} */
export function registerModuleToolbox(box) {
	const full = {
		...box,
		// namespaced the way registerShaderBackend / registerNodeDefs namespace theirs, so
		// two modules may both ship a toolbox called 'settings'
		id: 'mod-' + box.moduleId + '-' + box.id,
		key: 'modtbx-' + box.moduleId + '-' + (box.key ?? box.id)
	};
	moduleToolboxes.update((list) => [...list.filter((b) => b.id !== full.id), full]);
	return full.id;
}

/** Drop a toolbox and force it CLOSED — a disabled or reloading module must not leave
 * a window on screen with a dead mount fn behind it. @param {string} id */
export function unregisterModuleToolbox(id) {
	closeModuleToolbox(id);
	moduleToolboxes.update((list) => list.filter((b) => b.id !== id));
}

/** @param {string} id */
export function toolboxById(id) {
	return get(moduleToolboxes).find((b) => b.id === id) ?? null;
}

/** @param {string} id */
export function isToolboxOpen(id) {
	return get(openToolboxes).includes(id);
}

/** @param {string} id */
export function openModuleToolbox(id) {
	const box = toolboxById(id);
	if (!box || isToolboxOpen(id)) return false;
	openToolboxes.update((list) => [...list, id]);
	try {
		box.onOpen?.();
	} catch (e) {
		console.log('toolbox onOpen failed', e);
	}
	return true;
}

/** @param {string} id */
export function closeModuleToolbox(id) {
	if (!isToolboxOpen(id)) return false;
	openToolboxes.update((list) => list.filter((x) => x !== id));
	try {
		toolboxById(id)?.onClose?.();
	} catch (e) {
		console.log('toolbox onClose failed', e);
	}
	return true;
}

/** @param {string} id */
export function toggleModuleToolbox(id) {
	return isToolboxOpen(id) ? (closeModuleToolbox(id), false) : openModuleToolbox(id);
}

/** Close every toolbox one module owns (teardown). @param {string} moduleId */
export function unregisterModuleToolboxes(moduleId) {
	get(moduleToolboxes)
		.filter((b) => b.moduleId === moduleId)
		.forEach((b) => unregisterModuleToolbox(b.id));
}

/**
 * THE ONE BUILDER for "which module toolboxes can I open", shared by the sidebar's
 * Modules section and the viewport menu — the `buildObjectMenuItems` precedent, so the
 * two hosts cannot drift. Rows are plain data; each host renders them its own way.
 *
 * `surface` is which host is asking. A toolbox with `sidebar: false` is left out of the
 * SIDEBAR's list and keeps its viewport-menu row — for a module whose window belongs to
 * a workflow rather than to the app's permanent chrome, and which would rather be found
 * where the work is (a right-click in the viewport, or its own button in the Modules
 * manager) than add a row to the burger menu forever. ABSENT means listed, so every
 * shipped module and both hosts are byte-identical to before this parameter existed;
 * filtering here rather than in the sidebar's markup is what keeps this the ONE builder.
 * @param {ModuleToolbox[]} list @param {string[]} open @param {'sidebar'|'menu'} [surface]
 * @returns {{id: string, label: string, checked: boolean, shortcut: string|null, action: () => void}[]}
 */
export function buildToolboxItems(list, open, surface) {
	return (list ?? [])
		.filter((box) => surface !== 'sidebar' || box.sidebar !== false)
		.map((box) => ({
			id: box.id,
			label: box.title,
			checked: (open ?? []).includes(box.id),
			shortcut: box.shortcut ?? null,
			action: () => toggleModuleToolbox(box.id)
		}));
}
