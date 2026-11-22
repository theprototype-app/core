import { INTERACTIVE_CHROME } from './windowGrip';
import { PHONE_QUERY } from './ui/phoneShell.js';

// 44 M1 — DRAG AN UNGROUPED FLOATING WINDOW BY ITS BODY (the user, preview-1-34: "ungrouped floating
// windows should be possible to move by dragging any place using touch or mouse by click and drag, if
// just click i can activate button or filter (object list as example)").
//
// The decision (macOS / Figma panels): a press-and-move past a 6 px slop — or, on touch, after a 150 ms
// hold — on any NON-interactive part of the window moves it; a plain click / tap still reaches buttons,
// inputs and list rows; text inputs, sliders, scrollable lists and canvases never start a window drag.
//
// HOW: the press waits here until it travels; then it is handed to the window's HEADER — a pointerdown
// re-dispatched on its `.move-handle` at the point the press started. Every module that moves a window
// (dragWindow / the Objects list's own drag, windowTabs' header merge, the bottom dock, the sidebars)
// already listens for exactly that press, so a body drag IS a header drag from there on: the same
// clamps, the same merge / dock / sidebar targets, the same right-click guard (windowGrip) — one gesture,
// not a second copy of five. The real press is never prevented, so focus, selection and the click of a
// press that does NOT travel are the browser's own.
//
// Only an UNGROUPED floating window: a tab-group member drags by its strip (TabStrips), a docked one by
// its tab, and on a phone a floating window is a bottom sheet with a grip of its own.

/** px a press travels before it is a drag (TabStrips' and the dock strip's SLOP) */
export const BODY_SLOP = 6;
/** a touch held this long is a drag at the first move (the slop is waived) */
export const TOUCH_HOLD_MS = 150;

/** what never starts a window drag: the header's controls, plus the body's own gestures */
const NEVER =
	INTERACTIVE_CHROME +
	', .move-handle, .tab-strip, canvas, video, audio, iframe, img, .svelte-flow, .cm-editor, [draggable="true"], [role="treeitem"], [role="row"], [role="gridcell"], [role="listbox"], [role="textbox"], [role="separator"], [role="scrollbar"], .dw-resize, .resize-handle, .resize-cue, [data-window-grip]';
/** a cursor that says the element drags / selects / resizes on its own */
const OWN_CURSOR = /^(text|vertical-text|grab|grabbing|crosshair|cell|copy|alias|move|all-scroll|[nsew]{1,2}-resize|nwse-resize|nesw-resize|col-resize|row-resize)$/;

/** @param {Element} el */
function scrolls(el) {
	const cs = getComputedStyle(el);
	const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
	const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
	return x || y;
}

/**
 * Does a press on `target` (inside the floating window `node`) start a body drag once it travels?
 * @param {any} target @param {HTMLElement} node
 */
export function isBodyDragStart(target, node) {
	if (!target || typeof target.closest !== 'function' || !node.contains(target)) return false;
	if (target.closest(NEVER)) return false;
	// a scrollable list, a cursor that promises its own drag — on the way up to the window
	for (let el = target; el && el !== node.parentElement; el = el.parentElement) {
		if (el.nodeType !== 1) continue;
		if (scrolls(el)) return false;
		try {
			if (OWN_CURSOR.test(getComputedStyle(el).cursor)) return false;
		} catch {}
		if (el === node) break;
	}
	return true;
}

/** can this window be dragged by its body right now? @param {HTMLElement} node */
function floatingAlone(node) {
	if (node.dataset.tabMember || node.dataset.docked) return false; // its group / its column places it
	if (node.closest('[data-pd-host]')) return false; // hosted in the dock: it moves by its tab
	if (typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches) return false; // a sheet
	return true;
}

/** the header a body drag is handed to (a visible one) @param {HTMLElement} node */
function headerOf(node) {
	const handle = /** @type {HTMLElement|null} */ (node.querySelector('.move-handle'));
	return handle && handle.getClientRects().length > 0 ? handle : null;
}

/** @type {Set<HTMLElement>} */
const moving = new Set();
/** each wired window's live "may it move by its body right now?" @type {WeakMap<HTMLElement, () => boolean>} */
const liveWindows = new WeakMap();

/**
 * hitslop-fix: would a press-and-move at `el` drag a floating window by its body right now? The touch tap areas
 * ($lib/ui/hitSlop) must not cover such a point, or a window loses the free body it moves by.
 * @param {Element} el
 */
export function isBodyDragGround(el) {
	const node = /** @type {HTMLElement | null} */ (el.closest('[data-body-drag]'));
	return !!node && !!liveWindows.get(node)?.() && isBodyDragStart(el, node);
}
/** Is a body drag moving a window right now? (tests, and the debug hook) */
export function bodyDragActive() {
	return moving.size > 0;
}

/**
 * svelte action (dragWindow and the Objects list wire it): an ungrouped floating window moves by a
 * press-and-drag anywhere on its body that is not a control.
 * @param {HTMLElement} node @param {{enabled?: () => boolean}} [options] `enabled` — false while the
 *   window renders as something that must not move (dragWindow's `inert`: the toolbox as a sheet)
 */
export function bodyDrag(node, { enabled } = {}) {
	/** @type {null | {id: number, x: number, y: number, type: string, held: boolean, timer: any}} */
	let press = null;
	let dragging = false;

	const on = () => {
		try {
			return (enabled?.() ?? true) && floatingAlone(node);
		} catch {
			return false;
		}
	};
	/** @param {PointerEvent} e */
	const down = (e) => {
		// a child that took the press for itself (a slider, a field, a sheet grip) said so
		if (e.button !== 0 || e.defaultPrevented || press || dragging || !e.isTrusted) return;
		if (!on() || !isBodyDragStart(e.target, node)) return;
		press = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, held: false, timer: null };
		if (e.pointerType !== 'mouse') {
			const p = press;
			p.timer = setTimeout(() => (p.held = true), TOUCH_HOLD_MS);
		}
		window.addEventListener('pointermove', move, true);
		window.addEventListener('pointerup', end, true);
		window.addEventListener('pointercancel', end, true);
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		if (!press || e.pointerId !== press.id) return;
		if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= (press.held ? 1 : BODY_SLOP)) return;
		const handle = headerOf(node);
		const p = press;
		release();
		if (!handle || !on()) return;
		// the press becomes a header press where it started: the window keeps the grab point under the
		// pointer, and this very move (still on its way to the window's listeners) catches it up
		dragging = true;
		moving.add(node);
		node.dataset.bodyDragging = ''; // the moving flag; `data-body-drag` (below) marks the window as ever-draggable
		window.getSelection?.()?.removeAllRanges();
		document.documentElement.classList.add('tp-body-dragging');
		window.addEventListener('pointerup', finish, true);
		window.addEventListener('pointercancel', finish, true);
		handle.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				composed: true,
				pointerId: p.id,
				pointerType: p.type,
				isPrimary: true,
				button: 0,
				buttons: 1,
				clientX: p.x,
				clientY: p.y,
				screenX: p.x + (e.screenX - e.clientX),
				screenY: p.y + (e.screenY - e.clientY)
			})
		);
	};
	/** a press that never travelled: the browser's click is the whole story @param {PointerEvent} e */
	const end = (e) => {
		if (press && e.pointerId === press.id) release();
	};
	const release = () => {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
		window.removeEventListener('pointermove', move, true);
		window.removeEventListener('pointerup', end, true);
		window.removeEventListener('pointercancel', end, true);
	};
	/** the drag is over: the click it would end in belongs to no row or button (the window moved) */
	const finish = () => {
		window.removeEventListener('pointerup', finish, true);
		window.removeEventListener('pointercancel', finish, true);
		dragging = false;
		moving.delete(node);
		delete node.dataset.bodyDragging;
		if (!moving.size) document.documentElement.classList.remove('tp-body-dragging');
		const swallow = (/** @type {Event} */ ev) => {
			ev.preventDefault();
			ev.stopPropagation();
		};
		window.addEventListener('click', swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener('click', swallow, true), 0);
	};
	// touch: the body is not a scroller (isBodyDragStart), so its moves are the window's — without this
	// the browser may claim the finger as a pan and cancel the pointer mid-drag
	/** @param {TouchEvent} e */
	const touchMove = (e) => {
		if ((press || dragging) && e.cancelable) e.preventDefault();
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('touchmove', touchMove, { passive: false });
	// touch-action is decided at touchstart, before any of the above can speak: the window claims the
	// finger itself (windows.css, wider than a phone), and a list inside it still scrolls — touch-action is
	// cut off at the nearest scroll container
	node.setAttribute('data-body-drag', '');
	liveWindows.set(node, on);
	return {
		destroy() {
			release();
			if (dragging) finish();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('touchmove', touchMove);
			node.removeAttribute('data-body-drag');
			liveWindows.delete(node);
		}
	};
}
