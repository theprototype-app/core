// 70 W2 — MULTI-WINDOW HYGIENE. A pop-out window ($lib/windows/panelHost) is a same-origin popup:
// it shares this JS realm's MODULES (every store, the Yjs document, the flow runtime) but NOT its
// globals — the popup has its own `window`, `document`, `HTMLElement`, `KeyboardEvent`,
// `requestAnimationFrame` and `ResizeObserver` (VS Code's auxiliary windows hit exactly this; see
// cloud/plans/core/pending/multiwindow-research.md). Code that may run inside a popped panel asks
// THESE helpers for the window it lives in instead of the bare globals:
//   getWin(node) / getDoc(node)   the window / document a node renders into
//   isElement(x, 'HTMLElement')   `instanceof` that holds across realms
//   isForeign(node)               true for a node in another window than the main one
//   winRaf(node, fn)              that window's rAF (the main one's freezes while main is hidden)
//   observe(node, 'ResizeObserver', cb)  an observer built from the node's own realm
//   lastFocusedWindow             the window the user last focused (commands go there)
// ContextMenu, ContextMenuItems and dragReorder already used `ownerDocument.defaultView`; this is
// that pattern in one place.
import { writable } from 'svelte/store';

/** the main window (null outside a browser) */
export const mainWin = typeof window !== 'undefined' ? window : null;

/** @param {any} node @returns {Window} the window `node` lives in (the main one when unknown) */
export function getWin(node) {
	const doc = node?.ownerDocument ?? (node?.nodeType === 9 ? node : null);
	return /** @type {Window} */ (doc?.defaultView ?? node?.defaultView ?? (node?.window === node ? node : null) ?? mainWin);
}

/** @param {any} node @returns {Document} the document `node` lives in */
export function getDoc(node) {
	return node?.ownerDocument ?? (node?.nodeType === 9 ? node : null) ?? getWin(node)?.document ?? document;
}

/** does this node render in ANOTHER window than the main one (a pop-out)? @param {any} node */
export function isForeign(node) {
	if (!node || !mainWin) return false;
	const doc = node.ownerDocument ?? (node.nodeType === 9 ? node : null);
	return !!doc && doc !== mainWin.document;
}

/**
 * `x instanceof <Class>` that also holds for an object from another window's realm (a popup's
 * `HTMLInputElement` is not the main realm's).
 * @param {any} x @param {string} cls a global constructor name ('HTMLElement', 'KeyboardEvent', …)
 */
export function isElement(x, cls = 'HTMLElement') {
	if (!x || typeof x !== 'object') return false;
	/** @type {any} */
	const own = mainWin;
	if (own?.[cls] && x instanceof own[cls]) return true;
	/** @type {any} */
	const w = x.ownerDocument?.defaultView ?? x.view ?? x.target?.ownerDocument?.defaultView ?? null;
	return !!(w && w !== own && w[cls] && x instanceof w[cls]);
}

/** is this element one that takes typed text (an input, a textarea, contenteditable)? @param {any} el */
export function isTypingTarget(el) {
	if (!isElement(el, 'Element')) return false;
	const tag = el.tagName;
	if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
	if (tag === 'INPUT') return !/^(button|checkbox|radio|range|color|submit|reset|file|image)$/i.test(el.type || '');
	return !!el.isContentEditable;
}

/** request a frame from the window `node` lives in @param {any} node @param {FrameRequestCallback} fn */
export function winRaf(node, fn) {
	const w = getWin(node);
	return { id: w.requestAnimationFrame(fn), win: w };
}
/** @param {{id: number, win: Window}|null|undefined} handle */
export function cancelWinRaf(handle) {
	if (handle) handle.win.cancelAnimationFrame(handle.id);
}

/**
 * Observe `node` with an observer built from ITS realm (a main-realm ResizeObserver on popup nodes
 * is not reliable). Returns the disconnect.
 * @param {Element} node @param {'ResizeObserver'|'IntersectionObserver'|'MutationObserver'} kind
 * @param {(entries: any[], obs: any) => void} cb @param {any=} options
 */
export function observe(node, kind, cb, options) {
	/** @type {any} */
	const w = getWin(node);
	const Ctor = w[kind] ?? /** @type {any} */ (mainWin)?.[kind];
	if (!Ctor) return () => {};
	const obs = new Ctor(cb, kind === 'IntersectionObserver' ? options : undefined);
	obs.observe(node, kind === 'IntersectionObserver' ? undefined : options);
	return () => obs.disconnect();
}

/**
 * The window the user last focused — the main one, or a pop-out. A command that has no node of
 * its own (the command palette, a toast) opens where the user is looking.
 */
export const lastFocusedWindow = writable(/** @type {Window|null} */ (mainWin));

/** follow focus on a window (the main one is wired at load; panelHost wires each popup) @param {Window} w */
export function trackFocus(w) {
	const on = () => lastFocusedWindow.set(w);
	w.addEventListener('focus', on);
	return () => w.removeEventListener('focus', on);
}
if (mainWin) trackFocus(mainWin);
