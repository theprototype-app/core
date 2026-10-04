// 36 U6 — NO ACCIDENTAL TEXT SELECTION IN THE CHROME. A drag that strays across a menu, a toolbar
// or a panel label used to paint a blue selection over the editor (and a second press on that
// selection starts a native text DRAG, which eats the gesture — the HUD artboard gotcha, app-wide).
//
// Text is selectable only where it is content: inputs, textareas, CodeMirror, the chat and AI
// transcripts, What's new, the transfer log, setting descriptions, and anything marked
// `.tp-selectable` (ui.css lists them). The local setting "Allow text selection everywhere"
// (Settings > Interface) puts selection back on every surface.
//
// The VIEWPORT and the NODE EDITOR never start a selection, whatever the setting: a press there
// is a camera/gizmo/marquee/pan gesture, so a stray selection is cleared on the press and
// `selectstart` is refused until the button is released.
//
// LOCAL (this device), persisted through safeStorage; never replicated or saved.
import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'allowTextSelection';

/** the setting: true = selection everywhere (the pre-36 behaviour) */
export const allowTextSelection = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem(KEY) === 'true'
);

let seen = false;
allowTextSelection.subscribe((on) => {
	if (typeof document !== 'undefined') document.documentElement.classList.toggle('allow-text-select', !!on);
	if (!seen) {
		seen = true;
		return;
	}
	safeStorage.setItem(KEY, on ? 'true' : 'false');
});

/** a press on the 3D viewport or the node editor's pane (not on a field inside one)
 * @param {EventTarget | null} target */
export function isGestureSurface(target) {
	const el = /** @type {Element | null} */ (target instanceof Element ? target : null);
	if (!el) return false;
	if (el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], .cm-editor')) return false;
	return !!el.closest('canvas, .svelte-flow__pane, .svelte-flow__node, .svelte-flow__edge, .svelte-flow__renderer');
}

let gesture = false;
function onDown(/** @type {PointerEvent} */ e) {
	if (!isGestureSurface(e.target)) return;
	gesture = true;
	const sel = typeof window !== 'undefined' ? window.getSelection() : null;
	if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
}
function onUp() {
	gesture = false;
}
function onSelectStart(/** @type {Event} */ e) {
	if (gesture) e.preventDefault();
}

if (typeof window !== 'undefined') {
	window.addEventListener('pointerdown', onDown, true);
	window.addEventListener('pointerup', onUp, true);
	window.addEventListener('pointercancel', onUp, true);
	document.addEventListener('selectstart', onSelectStart, true);
}

/** suites: is a viewport/node-editor gesture holding selection off right now */
export function textSelectionDebug() {
	return { gesture, allow: document.documentElement.classList.contains('allow-text-select') };
}
