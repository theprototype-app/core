// NOTES-38 #19 — UI density: one token switch (styles/tokens.css "DENSITY"). Comfortable is
// the design; Compact tightens rows/controls to 32px on desktop (phones keep 44px targets).
// The setting row (Settings ▸ Interface, device-scoped) belongs to 37-settings: it stores the
// value and calls applyDensity; nothing here persists anything.

export const DENSITIES = [
	{ value: 'comfortable', label: 'Comfortable' },
	{ value: 'compact', label: 'Compact' }
];
export const DEFAULT_DENSITY = 'comfortable';

/** @param {string | null | undefined} value @param {HTMLElement} [root] */
export function applyDensity(value, root = document.documentElement) {
	if (value === 'compact') root.dataset.density = 'compact';
	else delete root.dataset.density;
}
