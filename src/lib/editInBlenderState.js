import { writable } from 'svelte/store';

// 59 T2 — the "Edit in Blender" card's state and the facts it shows. A LEAF (svelte/store only):
// App mounts the card, and the export machinery (editInBlender.js) must stay out of the boot graph.

/** the docs page the card links (T6, written by 59-int from this lane's docs fragment) */
export const EDIT_IN_BLENDER_DOCS = 'https://docs.theprototype.app/edit-in-blender/';

/** Blender's glTF export settings for a clean round trip — the card and the docs list these */
export const BLENDER_EXPORT_SETTINGS = [
	{ where: 'Format', what: 'glTF Binary (.glb)' },
	{ where: 'Include', what: 'Custom Properties — keeps the link to this object' },
	{ where: 'Transform', what: '+Y Up' },
	{ where: 'Data ▸ Mesh', what: 'Apply Modifiers' },
	{ where: 'Animation', what: 'on, for a rigged model (its clips go along)' }
];

/** the open card, or null @type {import('svelte/store').Writable<{uuid: string, name: string, fileName: string, format: string, stamped: boolean} | null>} */
export const editInBlenderCard = writable(null);
