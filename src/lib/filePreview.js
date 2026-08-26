// R22 ROUND 11 — THE PREVIEW WINDOW STOPS BEING AN IMAGE VIEWER.
//
// Four reported things live here, and the reason they share a module is that they are all
// facts about ONE window: how you walk between files without going back to the grid, what
// the window may show while you do, and how far out of the way it can get.
//
//   "add to image preview window left right buttons to open files in same folder"
//   "image preview also should show 3d object preview and audio preview ... when left/right"
//   "enter folder, backspace to return up"
//   "add to image preview header a button 'passthrough'" -> a COG opening OPACITY and
//   PASSTHROUGH, so the window can sit over the viewport as a modelling reference.
//
// A LEAF: svelte/store plus arithmetic, importing nothing of ours. `stepPreview` is a
// comparator-shaped function — the kind that is cheap to get subtly wrong and cheap to
// pin without a browser — and the two prefs are LOCAL facts about this screen, so they
// belong beside it rather than in a scene.
//
// THE SIBLING LIST IS PUBLISHED, NOT DERIVED HERE. Which files are "in the same folder,
// in the order you can see" is a question only the Explorer can answer: it owns the
// filters, the search box, the two view modes and the sort. So the Explorer publishes
// `previewSiblings` and the window reads it — the `noteMarkers` shape, one domain over.
// Deriving it a second time here would be a copy of that logic guaranteed to drift.

import { writable } from 'svelte/store';

/**
 * What the preview window can actually SHOW. A `.txt` opens in the code editor and a
 * `.tpscene` opens a world, so neither belongs in a walk through pictures — stepping onto
 * one would either do nothing or replace the scene, and both are worse than skipping it.
 */
export const PREVIEW_KINDS = ['image', 'audio', 'object', 'prefab'];

/**
 * Which face the window draws for a row. Returns null for anything it cannot show, which
 * is also what excludes that row from the walk.
 * @param {any} entry a grid entry `{kind: 'folder', folder}` or `{kind: 'item', item}`
 * @returns {'folder'|'image'|'audio'|'object'|null}
 */
export function previewFaceOf(entry) {
	if (!entry) return null;
	if (entry.kind === 'folder') return 'folder';
	const item = entry.item ?? entry;
	// a PACK or SCENE card is a view of something the library does not hold, so there are
	// no bytes to preview; a remote row's bytes are not here YET, which is the same answer
	// for a different reason (the card says so, and opening it pulls)
	if (item?.packEntry || item?.sceneEntry || item?.remoteItem || item?.deletedEntry) return null;
	if (item?.kind === 'image') return 'image';
	if (item?.kind === 'audio') return 'audio';
	if (item?.kind === 'object' || item?.kind === 'prefab') return 'object';
	return null;
}

/** The entries the arrows walk: every folder, plus every item with a face. PURE.
 * @param {any[]} entries @returns {any[]} */
export function previewWalk(entries) {
	return (entries ?? []).filter((e) => previewFaceOf(e) !== null);
}

/** A grid entry's stable id — the same key the Explorer's cards carry.
 * @param {any} entry @returns {string} */
export function previewIdOf(entry) {
	if (!entry) return '';
	return String(entry.kind === 'folder' ? entry.folder?.id : entry.item?.id) || '';
}

/**
 * Step from `id` by `delta` through the walkable entries. CLAMPS rather than wrapping: an
 * arrow that silently returns you to the first file is indistinguishable from one that did
 * nothing, and a disabled button at the end says where you are.
 *
 * An id the list no longer holds (the file was deleted, or a filter hid it while the
 * window was open) starts the walk from the beginning rather than answering nothing —
 * being lost is not a reason to strand the arrows.
 *
 * @param {any[]} entries @param {string} id @param {number} delta
 * @returns {any|null} the entry to show, or null when there is nowhere to go
 */
export function stepPreview(entries, id, delta) {
	const walk = previewWalk(entries);
	if (!walk.length) return null;
	const at = walk.findIndex((e) => previewIdOf(e) === id);
	if (at < 0) return walk[delta >= 0 ? 0 : walk.length - 1];
	const next = at + (delta >= 0 ? 1 : -1);
	if (next < 0 || next >= walk.length) return null;
	return walk[next];
}

/** Where `id` sits in the walk, 1-based, for the "3 / 9" readout. 0 when it is not in it.
 * @param {any[]} entries @param {string} id @returns {{at: number, of: number}} */
export function previewPosition(entries, id) {
	const walk = previewWalk(entries);
	return { at: walk.findIndex((e) => previewIdOf(e) === id) + 1, of: walk.length };
}

/**
 * The entries of the folder the Explorer is showing, in the order it is showing them.
 * Published by the Explorer; see the header for why it is not derived here.
 * @type {import('svelte/store').Writable<{folderId: any, parentId: any, entries: any[]}>}
 */
export const previewSiblings = writable({ folderId: null, parentId: null, entries: [] });

const PASS_KEY = 'preview:passthrough';
const OPACITY_KEY = 'preview:opacity';

/** @param {string} key @param {number} fallback */
function loadNumber(key, fallback) {
	if (typeof localStorage === 'undefined') return fallback;
	const raw = Number(localStorage.getItem(key));
	return Number.isFinite(raw) && raw > 0 ? clampPreviewOpacity(raw) : fallback;
}

/**
 * Opacity below this and the window is a ghost you cannot find again.
 *
 * `Number(v) || 1` would have been wrong in the one place it matters: a slider dragged to
 * ZERO is falsy, so it would read as "no value" and snap the window back to FULL strength
 * — the opposite of what the hand did. Only a value that is not a number falls back.
 * @param {number} v
 */
export function clampPreviewOpacity(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return 1;
	return Math.max(0.15, Math.min(1, n));
}

/**
 * CLICK-THROUGH. The window's CONTENT stops taking pointer events, so the viewport under
 * it does — which is the whole point: a reference image you can orbit the model behind.
 * The HEADER deliberately stays live, or there would be no way to move the window, step
 * to the next file or switch this back off.
 *
 * Its own setting, separate from the opacity, because they answer different questions:
 * "can I still work under it" and "how loud is it". Wanting one without the other is the
 * normal case in both directions — a faint reference you still want to zoom, or a
 * full-strength overlay you must be able to click past.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const previewPassthrough = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem(PASS_KEY) === 'true'
);
previewPassthrough.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(PASS_KEY, String(v));
	} catch {}
});

/** How strongly the CONTENT is drawn. LOCAL, like every other fact about this screen.
 * @type {import('svelte/store').Writable<number>} */
export const previewOpacity = writable(loadNumber(OPACITY_KEY, 1));
previewOpacity.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(OPACITY_KEY, String(v));
	} catch {}
});

/**
 * mm:ss for a transport readout. Seconds only — a preview of an eight-minute track is
 * still eight minutes, and hours have no place in a strip this size.
 * @param {number} seconds @returns {string}
 */
export function formatClock(seconds) {
	const s = Math.max(0, Math.floor(Number(seconds) || 0));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
