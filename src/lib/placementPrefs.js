import { writable, get } from 'svelte/store';
import * as safeStorage from './safeStorage';
import { coarsePointer } from './inputDevice';

// 39 P3 — Settings ▸ Scene ▸ Performance ▸ "Placement preview": how complex the ghost of an item
// being dragged into the scene may be. LOCAL (a fact about this device), persisted through
// safeStorage, read by placeGhost before it builds anything:
//   'full'    the real model whenever it is already decoded in memory
//   'budget'  the real model only when it is decoded AND under the triangle budget (default)
//   'box'     always the bounding box
// The triangle budget defaults to 50k on a desktop and 15k on a phone or a headset, where one
// translucent copy of a dense model would cost the frame the drag is supposed to keep smooth.

/** @typedef {'full' | 'budget' | 'box'} PreviewMode */

export const PREVIEW_MODES = /** @type {const} */ (['full', 'budget', 'box']);
export const DESKTOP_TRI_BUDGET = 50000;
export const LIGHT_TRI_BUDGET = 15000;

/** is this a phone or a headset (the lighter default budget)? */
export function lightDevice() {
	if (typeof navigator !== 'undefined' && /OculusBrowser|Quest|Pico/i.test(navigator.userAgent || '')) return true;
	return coarsePointer();
}

/** the default triangle budget for THIS device */
export function defaultTriBudget() {
	return lightDevice() ? LIGHT_TRI_BUDGET : DESKTOP_TRI_BUDGET;
}

/** @param {any} v @returns {PreviewMode} */
export function normalizePreviewMode(v) {
	return v === 'full' || v === 'box' || v === 'budget' ? v : 'budget';
}

/** @param {any} v @returns {number} */
export function normalizeTriBudget(v) {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && n >= 0 ? Math.min(n, 5_000_000) : defaultTriBudget();
}

/**
 * @template T @param {string} key @param {T} fallback @param {(raw: any) => T} normalize
 * @returns {import('svelte/store').Writable<T>}
 */
function persisted(key, fallback, normalize) {
	/** @type {T} */
	let initial = fallback;
	try {
		const raw = safeStorage.getItem(key);
		if (raw !== null) initial = normalize(JSON.parse(raw));
	} catch {
		initial = fallback;
	}
	const store = writable(initial);
	let first = true;
	store.subscribe((value) => {
		if (first) {
			first = false;
			return;
		}
		safeStorage.setItem(key, JSON.stringify(normalize(value)));
	});
	return store;
}

export const placementPreview = persisted('placement:preview', /** @type {PreviewMode} */ ('budget'), normalizePreviewMode);
/** null in storage = "the device default", so a phone and a desktop sharing a profile each get theirs */
export const placementTriBudget = persisted('placement:triBudget', defaultTriBudget(), normalizeTriBudget);
export const placementShowDims = persisted('placement:showDims', true, (v) => v !== false);

/**
 * May the ghost be the real model? (the P2 tier rule, pure so the suites can read it)
 * @param {{decoded: boolean, tris: number | null}} item @param {PreviewMode} mode @param {number} budget
 * @returns {'model' | 'box'}
 */
export function ghostTier(item, mode, budget) {
	if (!item.decoded || mode === 'box') return 'box';
	if (mode === 'full') return 'model';
	return item.tris != null && item.tris <= budget ? 'model' : 'box';
}

/** the live tier rule against the stores @param {{decoded: boolean, tris: number | null}} item */
export function currentGhostTier(item) {
	return ghostTier(item, get(placementPreview), get(placementTriBudget));
}
