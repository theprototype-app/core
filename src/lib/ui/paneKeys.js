// uir-polish B5 (owner 2026-11-11): Ctrl+B / Ctrl+Alt+B toggle the side panes of a DOCKED window when that window has
// the focus OR the mouse is over it; anywhere else they keep toggling the app's own sidebars.
//
// Every PaneHandle registers itself here (its edge and its press), so the keys reach every window that draws the
// one pane-handle pattern (Explorer, Timeline, Profiler, Node editor, Shader, Animation, UV, HUD, Code) without a
// handler per window. A LEAF: no store, no app import, the registry and the pointer position only.

/** what counts as a docked window's frame: a bottom-dock pane, or a window hosted in the dock */
export const DOCKED_FRAME = '.tp-dock-panel, [data-pd-host]';

/** @typedef {{ el: () => HTMLElement | null, edge: 'left' | 'right', press: () => void }} PaneEntry */
/** @type {Set<PaneEntry>} */
const entries = new Set();

/** @param {PaneEntry} entry @returns {() => void} unregister */
export function registerPaneHandle(entry) {
	entries.add(entry);
	return () => entries.delete(entry);
}

let px = -1;
let py = -1;
if (typeof window !== 'undefined')
	window.addEventListener(
		'pointermove',
		(e) => {
			px = e.clientX;
			py = e.clientY;
		},
		{ capture: true, passive: true }
	);

/** @param {Element | null | undefined} el */
const frameOf = (el) => /** @type {HTMLElement | null} */ (el?.closest?.(DOCKED_FRAME) ?? null);

/** the docked window the keys act on: the one holding the focus, else the one under the mouse, else null */
export function paneKeyTarget() {
	if (typeof document === 'undefined') return null;
	const focused = frameOf(document.activeElement);
	if (focused) return focused;
	if (px < 0) return null;
	return frameOf(document.elementFromPoint(px, py));
}

/**
 * Toggle the pane on `edge` of the targeted docked window.
 * @param {'left' | 'right'} edge
 * @returns {boolean} true = a docked window took the key (the app's sidebar is left alone)
 */
export function togglePaneOfTarget(edge) {
	const frame = paneKeyTarget();
	if (!frame) return false;
	for (const entry of entries) {
		const el = entry.el();
		if (!el || entry.edge !== edge || !frame.contains(el) || !el.isConnected) continue;
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) continue; // a hidden half of the window (the other face of a split)
		entry.press();
		return true;
	}
	return false;
}
