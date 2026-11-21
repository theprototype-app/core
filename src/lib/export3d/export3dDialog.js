import { writable } from 'svelte/store';

// 102 M2: the open "Export for 3D print / AR" dialog, a LEAF so App renders it without pulling
// the writers, the USDZ exporter or fflate's zip into the boot chunk. null = closed.
// `uuids` null = the whole scene; `format` is the one picked from the menu (the dialog can switch).
/** @type {import('svelte/store').Writable<{format: 'stl'|'3mf'|'usdz', uuids: string[] | null, name: string} | null>} */
export const export3dDialog = writable(null);

/** open it @param {'stl'|'3mf'|'usdz'} format @param {string[] | null} uuids @param {string} [name] */
export function openExport3d(format, uuids, name) {
	export3dDialog.set({ format, uuids: uuids && uuids.length ? uuids : null, name: name || (uuids?.length ? 'selection' : 'scene') });
}
