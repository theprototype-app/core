// 36 U8: the default themed set for touch action buttons — one 24-unit stroke glyph per
// built-in action, drawn in `currentColor` so a theme token (or a per-button tint) colours
// it. Plain markup strings rather than lucide components because the layout editor and the
// settings previews render them by NAME from data, and a module may name one for its own
// action (`icon: 'fire'`). Imports nothing.

const svg = (/** @type {string} */ body) =>
	'<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	body +
	'</svg>';

/** @type {Record<string, string>} */
export const TOUCH_ICONS = {
	// an arrow springing off a ground line
	jump: svg('<path d="M12 17V5"/><path d="M7 10l5-5 5 5"/><path d="M5 20h14"/>'),
	// a crosshair
	fire: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
	// a pointing hand reduced to a tap ripple
	interact: svg('<circle cx="12" cy="12" r="3"/><path d="M12 4a8 8 0 0 1 8 8"/><path d="M4 12a8 8 0 0 1 8-8"/><path d="M12 20a8 8 0 0 1-8-8"/>'),
	// a chevron pressing down onto a line
	crouch: svg('<path d="M7 8l5 5 5-5"/><path d="M5 18h14"/>'),
	// double chevrons forward
	sprint: svg('<path d="M5 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/>'),
	// a circular arrow
	reload: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
	// a hand closing
	grab: svg('<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.2-2.3L4 14a1.5 1.5 0 0 1 2.4-1.8L8 14"/>'),
	up: svg('<path d="M6 15l6-6 6 6"/>'),
	down: svg('<path d="M6 9l6 6 6-6"/>'),
	// the stick's own glyph, for lists that name every control
	stick: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>')
};

/** The glyph for an icon name, or '' (the button then draws its label). @param {string} name */
export function touchIconSvg(name) {
	return TOUCH_ICONS[name] ?? '';
}
