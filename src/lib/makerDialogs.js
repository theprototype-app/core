import { writable } from 'svelte/store';

// 102 M1/M2: the open Simplify and Export-for-print/AR dialogs. ONE LEAF so App can render them
// without pulling the simplifier, the writers, fflate's zip or three's USDZExporter into the boot
// chunk (each dialog and its module load when it opens). null = closed.

/** Simplify: the object, its name and live triangle count; `bake` = a primitive baked first */
/** @type {import('svelte/store').Writable<{uuid: string, name: string, triangles: number, bake?: boolean} | null>} */
export const simplifyDialog = writable(null);

/** Export: the format picked from the menu (the dialog can switch); `uuids` null = whole scene */
/** @type {import('svelte/store').Writable<{format: 'stl'|'3mf'|'usdz', uuids: string[] | null, name: string} | null>} */
export const export3dDialog = writable(null);

/** @param {'stl'|'3mf'|'usdz'} format @param {string[] | null} uuids @param {string} [name] */
export function openExport3d(format, uuids, name) {
	export3dDialog.set({ format, uuids: uuids && uuids.length ? uuids : null, name: name || (uuids?.length ? 'selection' : 'scene') });
}
