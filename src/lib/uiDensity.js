// NOTES-38 #19 — the Density SETTING (Settings ▸ Interface): Comfortable (the default, the
// redesign as drawn) or Compact (32 px rows on desktop; phones keep 44 px targets). The token
// switch is the kit's ($lib/ui/density.js — `applyDensity` sets / removes data-density="compact"
// on <html>); this module is the half the kit leaves to Settings: the device-scoped value, read
// at boot and applied on every change. LOCAL (this device), like Theme. A LEAF.
import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { DENSITIES, DEFAULT_DENSITY, applyDensity } from './ui/density.js';

export { DENSITIES, DEFAULT_DENSITY };
export const DENSITY_KEY = 'ui:density';

/** @param {unknown} v @returns {string} */
export function normalizeDensity(v) {
	return DENSITIES.some((d) => d.value === v) ? /** @type {string} */ (v) : DEFAULT_DENSITY;
}

/** 'comfortable' | 'compact' */
export const uiDensity = writable(normalizeDensity(safeStorage.getItem(DENSITY_KEY)));

uiDensity.subscribe((d) => {
	const value = normalizeDensity(d);
	if (typeof document !== 'undefined') applyDensity(value);
	// the default is an ABSENT key, so a fresh device and a reset read the same
	if (value === DEFAULT_DENSITY) safeStorage.removeItem(DENSITY_KEY);
	else safeStorage.setItem(DENSITY_KEY, value);
});
