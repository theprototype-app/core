// 53 A3 — FULL KEYBOARD NAVIGATION: the shared pieces (a leaf: it imports only the keyScope leaf — shortcuts.js sits in
// history's import family and reads `isViewportTarget`).
//
//   - THE VIEWPORT is a focus target only when the keyboard asks for it (the skip link, Ctrl+F6):
//     `focusViewport()` lends `#viewport` a tabindex of -1 for as long as it holds focus. A mouse
//     press on the canvas still leaves focus on <body>, exactly as before — every "is the
//     viewport focused" probe in the app reads body.
//   - `isViewportTarget(el)` = a key press that belongs to the 3D view (body, the canvas, the
//     viewport wrapper). Only there is Tab the Edit Mesh shortcut; on a control it moves focus.
//   - `roving(node, {item, axis})` — ONE tab stop per toolbar: the last-focused item carries
//     tabindex 0, every other -1; arrows / Home / End move between items in VISUAL order.
//   - `trapTab(node, e)` — keep Tab inside a dialog/sheet (wraps at both ends).
//   - `rememberFocus()` — where focus was before a menu/dialog opened; the returned function puts
//     it back (when focus is still inside the closing surface, or fell to <body>).

// 54i: keyScope is a zero-import leaf too, so the "is this a field you type into" rule stays ONE rule
import { isTypingField } from './keyScope.js';

/** Elements a keyboard user can land on, in DOM order. */
export const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Is `el` on screen and reachable? @param {any} el */
export function isShown(el) {
	if (!el || !el.isConnected) return false;
	if (el.closest?.('[inert], [hidden]')) return false;
	try {
		if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
		const cs = getComputedStyle(el);
		return cs.visibility !== 'hidden' && cs.display !== 'none';
	} catch {
		return true;
	}
}

/** The focusable elements inside `root`, in DOM order (hidden ones skipped).
 * @param {ParentNode} root @returns {HTMLElement[]} */
export function focusablesIn(root) {
	return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]).filter(isShown);
}

/** Does a key press on `el` belong to the 3D view? @param {any} el */
export function isViewportTarget(el) {
	// no element (window / document — a synthetic dispatch) reads as the view, as before
	if (!el || typeof document === 'undefined' || typeof el.closest !== 'function') return true;
	if (el === document.body || el === document.documentElement) return true;
	if (el.id === 'viewport') return true;
	return el.tagName === 'CANVAS' && !!el.closest?.('#viewport');
}

/** <body> holds focus after a press on the canvas, after a blur — and after Tab ran past the last
 *  control in the document. Only the last is a keyboard user moving on, so it alone must not
 *  read as "in the 3D view": a Tab pressed ON a control that put focus on no other control. */
let tabbedPast = false;
let claimTracking = false;
/** Start telling them apart (shortcuts.startShortcuts). */
export function trackViewClaim() {
	if (claimTracking || typeof window === 'undefined') return;
	claimTracking = true;
	window.addEventListener(
		'keydown',
		(e) => {
			const t = /** @type {any} */ (e.target);
			if (e.key === 'Tab' && t && typeof t.closest === 'function' && t !== document.body && t.id !== 'viewport') tabbedPast = true;
		},
		true
	);
	window.addEventListener(
		'focusin',
		(e) => {
			if (e.target !== document.body) tabbedPast = false;
		},
		true
	);
	window.addEventListener('pointerdown', () => (tabbedPast = false), true);
}

/** A field the keyboard just LEFT (Enter / Escape in a number field blur it, the locked
 *  behaviour): focus is on <body>, but the browser still continues Tab from that field, so the next
 *  Tab is navigation, not Edit Mesh — the keyboard user keeps their place in the panel. */
export function leftByKeyboard() {
	tabbedPast = true;
}

/**
 * Is a Tab on `el` the Edit Mesh shortcut? Only on the 3D view — the focused viewport or its
 * canvas, or <body> — and not on a <body> that Tab itself just wrapped to past the last control,
 * or a keyboard user with something selected would be stuck there entering and leaving Edit Mesh.
 * @param {any} el
 */
export function tabEditsMesh(el) {
	if (!isViewportTarget(el)) return false;
	if (!el || typeof el.closest !== 'function') return true; // a synthetic window dispatch
	if (el === document.body || el === document.documentElement) return !tabbedPast;
	return true;
}

/** Give the keyboard to the 3D view (the skip link's target). @returns {boolean} */
export function focusViewport() {
	if (typeof document === 'undefined') return false;
	const el = document.getElementById('viewport');
	if (!el) return false;
	if (!el.hasAttribute('tabindex')) {
		el.setAttribute('tabindex', '-1');
		// lent, not kept: a mouse press on the canvas must keep focusing <body>
		el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
	}
	el.focus({ preventScroll: true });
	return document.activeElement === el;
}

/** the last few elements that held focus, newest last, with WHEN — so a surface opened from a
 *  menu row that is gone by the time it closes can hand focus back to the menu's own button
 *  @type {{el: HTMLElement, at: number}[]} */
const trail = [];
let tracking = false;
export function trackFocus() {
	if (tracking || typeof document === 'undefined') return;
	tracking = true;
	document.addEventListener(
		'focusin',
		(e) => {
			const t = e.target;
			if (!(t instanceof HTMLElement) || t === document.body) return;
			const i = trail.findIndex((r) => r.el === t);
			if (i >= 0) trail.splice(i, 1);
			trail.push({ el: t, at: Date.now() });
			// distinct elements: long enough to outlast a walk down the whole main menu
			if (trail.length > 64) trail.shift();
		},
		true
	);
}

/**
 * Where focus was; the returned function restores it, but only when focus is still inside
 * `within` (the surface that is closing) or fell to <body> — a user who already moved on keeps
 * their place. When the element that had focus is gone (a menu row that opened a dialog and
 * closed its menu with it), the newest earlier one still on screen takes it.
 * @param {() => (Element | null | undefined)} [within]
 */
export function rememberFocus(within) {
	trackFocus();
	let prev = typeof document === 'undefined' ? null : /** @type {HTMLElement | null} */ (document.activeElement);
	// focus on <body> because the opener just VANISHED (the row unmounted with its menu in the
	// same click) is not the user being on the viewport — take the opener from the trail.
	// 54i: never a field you type into — an opener is a button or a row; a vanished INPUT is the
	// filter of a menu that just closed (Shift+A, Enter, Space at once), and adopting it sent focus
	// back down the trail into an old node's number field, so the next M typed "m" instead of muting
	const newest = trail[trail.length - 1];
	if ((!prev || prev === document.body) && newest && !newest.el.isConnected && !isTypingField(newest.el) && Date.now() - newest.at < 3000) prev = newest.el;
	const earlier = trail.map((r) => r.el).reverse();
	return () => {
		const now = document.activeElement;
		const box = within?.();
		const lost = !now || now === document.body || !now.isConnected || (box && box.contains(now)) || (box && !box.isConnected);
		if (!lost) return;
		// nothing to go back to when focus was on <body> (a right-click on the canvas): stay there
		if (!prev || prev === document.body) return;
		const usable = (/** @type {HTMLElement | null} */ el) => !!el && el !== document.body && el.isConnected && !(box && box.contains(el)) && isShown(el);
		// the fallback hands focus to a control, never into a text field the person did not press now
		const target = usable(prev) ? prev : earlier.find((el) => usable(el) && !isTypingField(el));
		try {
			// the viewport takes focus only on loan (focusViewport) — lend it again
			if (target?.id === 'viewport') focusViewport();
			else target?.focus({ preventScroll: true });
		} catch {
			/* a node that cannot take focus any more keeps nothing */
		}
	};
}

/**
 * Keep Tab inside `node`: Tab on the last focusable goes to the first, Shift+Tab on the first
 * to the last, and a Tab from outside the box lands inside it. Returns true when it handled it.
 * @param {HTMLElement} node @param {KeyboardEvent} e
 */
export function trapTab(node, e) {
	if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return false;
	const list = focusablesIn(node);
	if (!list.length) {
		e.preventDefault();
		return true;
	}
	const first = list[0];
	const last = list[list.length - 1];
	const active = document.activeElement;
	const inside = !!active && node.contains(active);
	if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
		e.preventDefault();
		(e.shiftKey ? last : first).focus();
		return true;
	}
	return false;
}

/**
 * ROVING TABINDEX over the items of a toolbar (the ARIA toolbar pattern): one tab stop, arrows
 * between the items. Items are re-read on every key and every DOM change (toolbars re-render
 * their cells), so the one tabbable item always exists.
 * @param {HTMLElement} node
 * @param {{ item: string, axis?: 'x' | 'y' | 'both', wrap?: boolean }} options
 */
export function roving(node, options) {
	let opts = options;
	/** the item that keeps tabindex 0 (the last one focused) @type {HTMLElement | null} */
	let current = null;

	// in VISUAL order, not document order: a group placed with CSS `order` (the top-right cluster)
	// or a right-to-left page must step to the neighbour the eye sees
	const items = () => {
		const list = /** @type {HTMLElement[]} */ ([...node.querySelectorAll(opts.item)]).filter((el) => isShown(el) && el.getAttribute('aria-disabled') !== 'true' && !(/** @type {any} */ (el).disabled));
		const at = new Map(list.map((el) => [el, el.getBoundingClientRect()]));
		const axis = opts.axis ?? 'x';
		return list.sort((a, b) => {
			const ra = /** @type {DOMRect} */ (at.get(a));
			const rb = /** @type {DOMRect} */ (at.get(b));
			if (axis === 'x') return ra.left - rb.left;
			if (axis === 'y') return ra.top - rb.top;
			// a grid / stack: rows top to bottom (half a row of slack), then left to right
			return Math.abs(ra.top - rb.top) > Math.min(ra.height, rb.height) / 2 ? ra.top - rb.top : ra.left - rb.left;
		});
	};

	function apply() {
		const list = items();
		if (!list.length) return;
		if (!current || !list.includes(current)) current = list[0];
		for (const el of list) {
			const want = el === current ? '0' : '-1';
			if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want);
		}
	}

	/** @param {FocusEvent} e */
	function focusin(e) {
		const el = /** @type {HTMLElement} */ (e.target);
		const list = items();
		const hit = list.find((it) => it === el || it.contains(el));
		if (hit && hit !== current) {
			current = hit;
			apply();
		}
	}

	/** @param {KeyboardEvent} e */
	function keydown(e) {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		const target = /** @type {HTMLElement} */ (e.target);
		if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
		const axis = opts.axis ?? 'x';
		const nextKeys = axis === 'x' ? ['ArrowRight'] : axis === 'y' ? ['ArrowDown'] : ['ArrowRight', 'ArrowDown'];
		const prevKeys = axis === 'x' ? ['ArrowLeft'] : axis === 'y' ? ['ArrowUp'] : ['ArrowLeft', 'ArrowUp'];
		const list = items();
		const at = list.findIndex((it) => it === target || it.contains(target));
		if (at < 0) return;
		let i = -1;
		if (nextKeys.includes(e.key)) i = at + 1;
		else if (prevKeys.includes(e.key)) i = at - 1;
		else if (e.key === 'Home') i = 0;
		else if (e.key === 'End') i = list.length - 1;
		else return;
		if (opts.wrap) i = (i + list.length) % list.length;
		else i = Math.max(0, Math.min(list.length - 1, i));
		// ours either way: the window's arrow keys fly the camera and Home is the start view
		e.preventDefault();
		e.stopPropagation();
		current = list[i];
		apply();
		current.focus();
	}

	const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => apply());
	mo?.observe(node, { childList: true, subtree: true });
	node.addEventListener('focusin', focusin);
	node.addEventListener('keydown', keydown);
	apply();
	return {
		/** @param {typeof options} next */
		update(next) {
			opts = next;
			apply();
		},
		destroy() {
			mo?.disconnect();
			node.removeEventListener('focusin', focusin);
			node.removeEventListener('keydown', keydown);
		}
	};
}

/**
 * Enter / Space press a `role="button"` element that is not a real <button> (the toolbar's
 * `<p>` cells — suites and panel toggles select them by tag, so they stay paragraphs). The press
 * is a real click, so every existing click handler runs unchanged. A held key does not repeat.
 * @param {HTMLElement} node
 */
export function pressOnKey(node) {
	/** @param {KeyboardEvent} e */
	function down(e) {
		if (e.target !== node || e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		e.stopPropagation();
		if (!e.repeat) node.click();
	}
	node.addEventListener('keydown', down);
	return {
		destroy() {
			node.removeEventListener('keydown', down);
		}
	};
}
