// showhide-v8 §6 — THE WINDOWS ▸ SWITCHES (owner 2026-11-09 10:35): Snap to edges, Lock layout, Remember layout per
// scene. Three LOCAL prefs (a fact about this screen, like the dock order: nothing replicates, saves into a scene or
// undoes) plus the pure arithmetic the consumers share, so it is testable with no DOM. A LEAF: svelte/store +
// safeStorage only — dragWindow, panelPlaces and dockMenu all read it, and none of them may be reached from here.
//
// All three default OFF: each changes what a drag does, and a default that moves a window you did not ask to move
// is the bug report the switch exists to prevent.
import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';

/** @param {string} key */
function boolPref(key) {
	const store = writable(safeStorage.getItem(key) === 'true');
	store.subscribe((v) => {
		if (v) safeStorage.setItem(key, 'true');
		else safeStorage.removeItem(key);
	});
	return store;
}

/** a dragged window lands flush on a viewport edge it comes within SNAP_DISTANCE of */
export const snapToEdges = boolPref('windows:snapToEdges');
/** no window moves, resizes, undocks or tears off by hand (opening, closing and the menus still work) */
export const layoutLocked = boolPref('windows:layoutLocked');
/** each named scene keeps the window layout it was left with, and gets it back when it opens */
export const layoutPerScene = boolPref('windows:layoutPerScene');

export const SNAP_DISTANCE = 16;

/**
 * Where a window at (left, top) of size w x h comes to rest with Snap to edges on: each axis independently pulled
 * flush to the nearer viewport edge when within `dist`. Left beats right (and top beats bottom) when a window is
 * as wide as the screen, so it can never be pulled off its left/top edge, where the header is.
 * @param {number} left @param {number} top @param {number} w @param {number} h
 * @param {number} vw @param {number} vh @param {number} [dist]
 * @returns {{left: number, top: number}}
 */
export function snapRectToEdges(left, top, w, h, vw, vh, dist = SNAP_DISTANCE) {
	let x = left;
	let y = top;
	if (Math.abs(vw - (left + w)) <= dist) x = vw - w;
	if (Math.abs(left) <= dist) x = 0;
	if (Math.abs(vh - (top + h)) <= dist) y = vh - h;
	if (Math.abs(top) <= dist) y = 0;
	return { left: x, top: y };
}

/** how many scenes keep a layout (each record carries every window's stored geometry, a few KB) */
export const MAX_SCENE_LAYOUTS = 12;
const SCENE_LAYOUTS_KEY = 'windows:sceneLayouts';

/**
 * The per-scene layout map, most recent first: `[{scene, layout}]`. Pure: returns the new list.
 * @param {{scene: string, layout: any}[]} list @param {string} scene @param {any} layout
 */
export function upsertSceneLayout(list, scene, layout) {
	const rest = (list ?? []).filter((r) => r && r.scene !== scene);
	return [{ scene, layout }, ...rest].slice(0, MAX_SCENE_LAYOUTS);
}

/** @param {{scene: string, layout: any}[]} list @param {string} scene */
export function sceneLayoutOf(list, scene) {
	return (list ?? []).find((r) => r && r.scene === scene)?.layout ?? null;
}

/** @returns {{scene: string, layout: any}[]} */
export function readSceneLayouts() {
	try {
		const raw = JSON.parse(safeStorage.getItem(SCENE_LAYOUTS_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((r) => r && typeof r.scene === 'string') : [];
	} catch {
		return [];
	}
}

/** @param {{scene: string, layout: any}[]} list */
export function writeSceneLayouts(list) {
	try {
		safeStorage.setItem(SCENE_LAYOUTS_KEY, JSON.stringify(list));
	} catch {
		// a full storage keeps the previous map; the switch degrades to "not remembered"
	}
}
