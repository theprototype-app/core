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
 *
 * R22 ROUND 14 (user): "passthrough and opacity is per window setting and should be
 * disabled when new window opened with 100%". BOTH LEFT THIS FILE — they are neither
 * stores nor persisted any more, they are `$state` on the window component, reset every
 * time a window takes a new target.
 *
 * THE REASON THEY ARE THE TWO THAT MOVED, while auto-rotate and the stats stayed: these
 * two describe HOW THIS WINDOW SITS OVER THE SCENE, which is a fact about one window's
 * job at one moment — a faded, click-through reference pinned beside the model you are
 * building. Remembering that is actively wrong: the next thing you open is usually
 * opened to be LOOKED at, and a preview that arrives at 15% and swallows no clicks reads
 * as broken, with the control that explains it hidden behind a cog. The other two are
 * preferences about how you like previews to behave, which is exactly what a pref is.
 *
 * A pref you would not want restored is not a pref. It is this window's state.
 */

/**
 * R22 round 12 (user): "add in cog (allow multiple windows) - so when clicking on another
 * file in explorer it opens new window rather replacing current one".
 *
 * OFF by default, which is today's behaviour: one window that re-points. On, a second
 * open ADDS a window — the file manager's "open in new window", and the reason somebody
 * wants it is comparing two files side by side, which one re-pointing window cannot do.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const previewMultiWindow = writable(readFlag('preview:multiWindow', false));
previewMultiWindow.subscribe((v) => saveFlag('preview:multiWindow', v));

/**
 * R22 round 12 (user): "keep tris/verts/meshes statistics, also add it into cog as
 * option". ON by default — it was always shown beside the old pop-out, so hiding it by
 * default would be taking something away in the name of adding a switch.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const previewShowStats = writable(readFlag('preview:showStats', true));
previewShowStats.subscribe((v) => saveFlag('preview:showStats', v));

/**
 * R22 round 12 (user): "add into cog menu option auto-rotate (enabled by default) for
 * objects, so when disabled I can rotate object as I want and it will stop at a place
 * where I will stop rotating".
 *
 * The STOPPING half needs no code: `ModelPreview`'s drag is pointer-CAPTURED, applies
 * `movementX` directly and has no inertia, so it already rests exactly where the pointer
 * released — the spin was the only thing carrying it on. And the prop is read inside the
 * rAF loop rather than in the effect body, so toggling it takes effect on the next frame
 * WITHOUT re-running the effect (which would tear the WebGL context down and rebuild it —
 * the documented 21-H2 hazard in that file).
 * @type {import('svelte/store').Writable<boolean>}
 */
export const previewAutoRotate = writable(readFlag('preview:autoRotate', true));
previewAutoRotate.subscribe((v) => saveFlag('preview:autoRotate', v));

/** @param {string} key @param {boolean} fallback */
function readFlag(key, fallback) {
	if (typeof localStorage === 'undefined') return fallback;
	const raw = localStorage.getItem(key);
	return raw === null ? fallback : raw === 'true';
}
/** @param {string} key @param {boolean} value */
function saveFlag(key, value) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, String(value));
	} catch {}
}

/**
 * mm:ss for a transport readout. Seconds only — a preview of an eight-minute track is
 * still eight minutes, and hours have no place in a strip this size.
 * @param {number} seconds @returns {string}
 */
export function formatClock(seconds) {
	const s = Math.max(0, Math.floor(Number(seconds) || 0));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
