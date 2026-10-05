// 36 F3/F4: WHAT A PRESS ON A WINDOW'S CHROME MEANS — one leaf every window-drag module reads
// (dragWindow, windowTabs' header merge, the bottom-dock band, docking.js' edge dock).
//
// F4 (user, 2026-10-05: "undocked code window: tabs cannot be clicked"). A floating window drags
// by its `.move-handle` header, and the code workspace draws its TABS inside that header. Each of
// the four modules decided "is this a header drag?" for itself, dragWindow by exempting only
// `button, input, select, textarea`: a tab is a `div role="tab"`, so a press on it took POINTER
// CAPTURE on the window — and a captured pointer's `click` lands on the window, never on the tab.
// The rule is now one predicate: a press is a header drag only when it is not on an interactive
// child (a tab, a link, an ARIA button/checkbox/switch/slider/option, an editable field, a label,
// or anything that opts out with `data-no-window-drag`).
//
// F3 ("right-click while dragging a floating window opens the browser menu"). Every window drag
// is a left-button gesture on chrome: a move handle, a resize grip, a tab strip. While one is in
// progress, a right press must not open the browser's menu. One window-level CAPTURE listener
// does it for every window at once:
//   · the gesture starts on a left press on chrome — `.move-handle`, a window tab strip, or
//     anything whose cursor says resize (the corner grips, the dock's top edge, split
//     dividers); it ends on pointerup/pointercancel/blur;
//   · only the browser's DEFAULT is prevented: an app handler still sees the event;
//   · Chromium on Linux/macOS fires `contextmenu` on the right PRESS (mid-drag); Windows fires it
//     on the right RELEASE, which can come after the left button is already up — so a right press
//     that STARTED during a drag swallows its own contextmenu whenever it arrives.
// A contextmenu outside a drag is untouched, the browser's and the app's alike.

/** The children of a window header that are controls, not grips. */
export const INTERACTIVE_CHROME =
	'button, input, select, textarea, a[href], label, [role="tab"], [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="slider"], [role="option"], [role="menuitem"], [contenteditable=""], [contenteditable="true"], [data-no-window-drag]';

/**
 * Does a press on `target` drag its window by the header? (on `.move-handle`, not on a control in it)
 * @param {any} target
 */
export function isHeaderDrag(target) {
	if (!target || typeof target.closest !== 'function') return false;
	if (!target.closest('.move-handle')) return false;
	return !target.closest(INTERACTIVE_CHROME);
}

/** a cursor that names a resize gesture (a corner grip, the dock's top edge, a split divider) */
const GRIP_CURSOR = /^([nsew]{1,2}-resize|nwse-resize|nesw-resize|col-resize|row-resize)$/;

/**
 * Does a left press on `target` start a window drag? Header drags (incl. a tab strip's own
 * `cursor: move`), window tabs being torn out, and every resize grip.
 * @param {any} target
 */
export function isWindowGrip(target) {
	if (!target || typeof target.closest !== 'function') return false;
	if (isHeaderDrag(target)) return true;
	// a tab of a window tab-group drags out to detach (TabStrips)
	if (target.closest('.tab-strip')) return true;
	if (target.closest('.dw-resize, .resize-cue, .resize-handle, [data-window-grip]')) return true;
	if (typeof getComputedStyle !== 'function' || target.nodeType !== 1) return false;
	// the grips the classes above miss draw themselves with a resize cursor (never the 3D
	// canvas or a graph: their drags are the editor's)
	if (target.closest('.svelte-flow, canvas')) return false;
	try {
		return GRIP_CURSOR.test(getComputedStyle(target).cursor);
	} catch {
		return false;
	}
}

let dragging = false;
let swallowNext = false;
let started = false;

/** Is a window drag in progress? (tests, and the debug hook) */
export function windowDragActive() {
	return dragging;
}

/** Install the right-click guard once (every dragWindow calls this; idempotent). */
export function startWindowDragGuard() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener(
		'pointerdown',
		(/** @type {PointerEvent} */ e) => {
			if (e.button !== 0) return;
			swallowNext = false;
			dragging = isWindowGrip(e.target);
		},
		true
	);
	// a chorded press (right while left is held) fires no pointerdown — only mousedown
	window.addEventListener(
		'mousedown',
		(/** @type {MouseEvent} */ e) => {
			if (e.button === 2 && dragging) swallowNext = true;
		},
		true
	);
	const end = () => {
		dragging = false;
	};
	window.addEventListener('pointerup', end, true);
	window.addEventListener('pointercancel', end, true);
	window.addEventListener('blur', end);
	window.addEventListener(
		'contextmenu',
		(/** @type {MouseEvent} */ e) => {
			if (!dragging && !swallowNext) return;
			swallowNext = false;
			e.preventDefault();
		},
		true
	);
}
