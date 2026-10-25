// 77 K3 — TITLE PRESETS: where a title sits and how big, in a 1080-high frame (so a title is the
// same size on a phone, a 4K export and a thumbnail). Data only; the runtime lays them out with
// troika. An item may override `color`, `size` (a scale), `align` and `y` (px, up). A `titles`
// list in the packs repo can add more of the same shape (follow-up: QUESTIONS-77-cut-a fork 7).

/** @typedef {{id: string, name: string, anchor: 'center'|'bottom-left'|'top-right'|'bottom', size: number, subSize: number, align: 'left'|'center'|'right', bar: boolean, color: string, subColor: string}} TitlePreset */

/** @type {TitlePreset[]} */
export const TITLE_PRESETS = [
	{ id: 'title', name: 'Title', anchor: 'center', size: 112, subSize: 42, align: 'center', bar: false, color: '#ffffff', subColor: '#e5e7eb' },
	{ id: 'lower', name: 'Lower third', anchor: 'bottom-left', size: 52, subSize: 32, align: 'left', bar: true, color: '#ffffff', subColor: '#d1d5db' },
	{ id: 'caption', name: 'Caption line', anchor: 'bottom', size: 44, subSize: 32, align: 'center', bar: true, color: '#ffffff', subColor: '#e5e7eb' },
	{ id: 'corner', name: 'Corner tag', anchor: 'top-right', size: 34, subSize: 24, align: 'right', bar: true, color: '#ffffff', subColor: '#e5e7eb' },
	{ id: 'end', name: 'End card', anchor: 'center', size: 84, subSize: 40, align: 'center', bar: false, color: '#ffffff', subColor: '#9ca3af' }
];

/** @param {string} id */
export function titlePreset(id) {
	return TITLE_PRESETS.find((p) => p.id === id) ?? TITLE_PRESETS[0];
}

/**
 * Where a title's text block goes in a frame W wide and 1080 high (origin at the centre, y up):
 * the anchor point and troika's anchorX / anchorY for it.
 * @param {TitlePreset} p @param {number} W
 */
export function titleAnchor(p, W) {
	const H = 1080;
	const m = 72; // the title-safe margin
	if (p.anchor === 'bottom-left') return { x: -W / 2 + m * 1.4, y: -H / 2 + H * 0.2, ax: 'left', ay: 'bottom' };
	if (p.anchor === 'bottom') return { x: 0, y: -H / 2 + m * 1.3, ax: 'center', ay: 'bottom' };
	if (p.anchor === 'top-right') return { x: W / 2 - m, y: H / 2 - m, ax: 'right', ay: 'top' };
	return { x: 0, y: 0, ax: 'center', ay: 'middle' };
}
