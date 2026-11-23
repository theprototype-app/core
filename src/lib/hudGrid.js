// 103 H15 — THE HUD GRID, read from CSS. styles/hud.css owns the numbers (`--hud-inset`, `--hud-tile`, `--hud-gap`);
// the few scripts that place or measure standing controls (TouchTools' row-or-column, the top-right group's stack
// decision, the toolbar's band) read them here instead of keeping their own copies, so the grid cannot drift between
// CSS and script again. A LEAF (uiScale's cssPx only). Fallbacks are the desktop values.
import { cssPx } from './uiScale';

/** @returns {{inset: number, tile: number, gap: number}} the grid in px, as the browser computes it now */
export function hudGrid() {
	if (typeof document === 'undefined') return { inset: 12, tile: 44, gap: 6 };
	const cs = getComputedStyle(document.documentElement);
	const read = (/** @type {string} */ name, /** @type {number} */ fallback) => {
		const v = cssPx(cs.getPropertyValue(name));
		return Number.isFinite(v) ? v : fallback;
	};
	return { inset: read('--hud-inset', 12), tile: read('--hud-tile', 44), gap: read('--hud-gap', 6) };
}
