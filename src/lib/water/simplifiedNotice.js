// 36-fb-water F27: "the quality level simplified the water / fluid on this device" — a LEAF
// (svelte/store only). waterRuntime sets `water` while a visible volume draws the Quest tier
// BECAUSE OF QUALITY (not a headset, not the user's own "Low" pick); fluidRuntime sets `fluid`
// while a tank draws the points tier for the same reason. AutoQualityNotice (40 F12) names it
// as "water quality" / "fluid quality", once per session, never in Play and never in a headset.
import { writable, get } from 'svelte/store';

/** @type {import('svelte/store').Writable<{water: boolean, fluid: boolean}>} */
export const simplifiedWater = writable({ water: false, fluid: false });

/** @param {'water'|'fluid'} key @param {boolean} on */
export function noteSimplified(key, on) {
	const cur = get(simplifiedWater);
	if (cur[key] !== on) simplifiedWater.set({ ...cur, [key]: on });
}
