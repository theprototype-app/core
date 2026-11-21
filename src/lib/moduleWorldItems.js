// 61-nav — two small registries a module fills and core's menus read (a LEAF: svelte/store only).
//
//   view toggles    rows in the viewport menu's View submenu (a module overlay: the navmesh, the NPC
//                   debug view). LOCAL: each row reads and writes the module's own per-device state
//                   through `get` / `set`; core only lists them and re-renders when `bump()` is called.
//   object actions  rows in the object menu (right-click / the Selected submenu): "Make this an
//                   enemy…". `open(uuid)` is the person's door (a sheet), `apply(uuid, spec)` the same
//                   recipe with no UI, which the agent tools call (game_setup {npc}).
//
// Both are torn down with the module (sdk/gameWorld.js journals the undo).

import { writable } from 'svelte/store';

/**
 * @typedef {{key: string, moduleId: string, id: string, label: string, tooltip?: string,
 *   get: () => boolean, set: (on: boolean) => void}} ViewToggle
 * @typedef {{key: string, moduleId: string, id: string, label: string, icon?: string, tooltip?: string,
 *   when?: (uuid: string) => boolean, open: (uuid: string) => void,
 *   apply?: (uuid: string, spec: any) => any}} ObjectAction
 */

/** @type {import('svelte/store').Writable<ViewToggle[]>} */
export const moduleViewToggles = writable([]);
/** @type {import('svelte/store').Writable<ObjectAction[]>} */
export const moduleObjectActions = writable([]);

/** a toggle's state changed outside the menu (the module's own toolbox): re-render the rows */
export function bumpViewToggles() {
	moduleViewToggles.update((list) => [...list]);
}

/** @param {ViewToggle} entry @returns {() => void} */
export function addViewToggle(entry) {
	moduleViewToggles.update((list) => [...list.filter((t) => t.key !== entry.key), entry]);
	return () => moduleViewToggles.update((list) => list.filter((t) => t !== entry));
}

/** @param {ObjectAction} entry @returns {() => void} */
export function addObjectAction(entry) {
	moduleObjectActions.update((list) => [...list.filter((a) => a.key !== entry.key), entry]);
	return () => moduleObjectActions.update((list) => list.filter((a) => a !== entry));
}

/** the action a module registered under `moduleId:id`, or null @param {ObjectAction[]} list @param {string} key */
export function objectActionByKey(list, key) {
	return list.find((a) => a.key === key) ?? null;
}
