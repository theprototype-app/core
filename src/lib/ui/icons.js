// 38 R10 — the icon standard behind ui/Icon.svelte (SPEC §7).
//
// UI icons come in TWO sizes: 16 (rows, buttons, menus, tool headers) and 20 (panel headers,
// toolbars, empty states). Bigger glyphs are not UI icons but placeholder ART (an Explorer
// tile with no thumbnail, a file preview's folder, the Play/VR buttons' face) and get a
// display scale of their own. Any other number snaps to the nearest step, so a stray
// size={13} can never come back as a third UI size. One stroke for all of them: 1.75 on
// lucide's 24-unit grid (the custom domain set is drawn on the same grid, see
// cloud docs/design/redesign/icons-brief.md). Pure, imports nothing: tests/unit/icons.test.js.

/** the two UI icon sizes, px */
export const ICON_SIZES = [16, 20];
/** placeholder art / big play buttons only, px */
export const ICON_DISPLAY_SIZES = [24, 32, 48];
/** stroke-width on the 24-unit grid, every size */
export const ICON_STROKE = 1.75;

/**
 * The standard size for a requested one: ≤17 → 16, ≤22 → 20, ≤27 → 24, ≤39 → 32, else 48.
 * A missing or non-numeric size is 16.
 * @param {unknown} size
 * @returns {number}
 */
export function iconSize(size) {
	const n = Number(size);
	if (!Number.isFinite(n) || n <= 17) return 16;
	if (n <= 22) return 20;
	if (n <= 27) return 24;
	if (n <= 39) return 32;
	return 48;
}

/**
 * lucide's kebab-case name for a component name: `Trash2` → `trash-2`, `Grid3x3` → `grid-3x3`,
 * `Move3d` → `move-3d`, `AlignStartVertical` → `align-start-vertical`.
 * @param {string} pascal
 * @returns {string}
 */
export function lucideName(pascal) {
	return pascal
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.replace(/(?<!\d)([A-Za-z])(\d)/g, '$1-$2')
		.toLowerCase();
}
