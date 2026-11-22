// 80a K1: a panel showing an object another peer holds is READ-ONLY, live. Not a disabled
// <fieldset>: that would also disable the section headers, and a read-only panel you cannot open a
// section of is not one you can read. Instead every edit gesture is stopped at the panel (capture
// phase, before any control's own handler) except on a section header or anything marked
// `data-held-ok` (the banner's Request control), and the controls say they are disabled
// (`aria-disabled`, dimmed by `[data-held-ro]`). Values keep updating: nothing is unmounted.
//
// The receiving-side gate (lockGate) is the backstop; this is what stops the edit being made at all.

/** where a press still works while held */
const ALLOWED = '.sec-panel-head, [data-held-ok], [data-held-ok] *';
/** the controls that get `aria-disabled` */
const CONTROLS = 'input, select, textarea, button, [role="slider"], [role="spinbutton"], [role="combobox"], [contenteditable="true"]';
/** events that edit; `wheel` is stopped from reaching a control but still scrolls the panel */
const EDIT_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'beforeinput', 'input', 'change', 'paste', 'drop', 'dragstart', 'contextmenu'];
/** keys that only move focus or dismiss, which a reader still needs */
const NAV_KEYS = new Set(['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'F6']);

/**
 * @param {HTMLElement} node
 * @param {boolean | {held: boolean, pan?: string}} arg held, or `{held, pan}` where `pan` is a selector
 *   whose pointer presses and wheel still work (the flow editor's pane: looking around is reading)
 */
export function heldReadOnly(node, arg) {
	let on = false;
	/** @type {string} */
	let pan = typeof arg === 'object' && arg?.pan ? arg.pan : '';
	const PAN_EVENTS = new Set(['pointerdown', 'mousedown', 'touchstart']);
	/** @type {MutationObserver | null} */
	let observer = null;
	/** @type {Set<Element>} controls we marked, so letting go restores only ours */
	const marked = new Set();

	/** @param {Event} e */
	const allowed = (e) => {
		const t = /** @type {any} */ (e.target);
		return !!(t && typeof t.closest === 'function' && t.closest(ALLOWED));
	};
	/** @param {Event} e */
	const stop = (e) => {
		if (allowed(e)) return;
		const t = /** @type {any} */ (e.target);
		// a press on the bare pane pans; one on a card or a socket would edit it
		if (pan && PAN_EVENTS.has(e.type) && t?.closest?.(pan) && !t.closest('.svelte-flow__node, .svelte-flow__handle')) return;
		e.preventDefault();
		e.stopImmediatePropagation();
	};
	/** @param {KeyboardEvent} e */
	const key = (e) => {
		if (NAV_KEYS.has(e.key) || allowed(e)) return;
		// Enter / Space on a section header is allowed above; anything else would edit a value
		e.preventDefault();
		e.stopImmediatePropagation();
	};
	/** @param {WheelEvent} e */
	const wheel = (e) => {
		if (allowed(e)) return;
		const t = /** @type {any} */ (e.target);
		// only stop it from reaching a control (a drag row, a focused number); the panel still scrolls
		if (t?.closest?.(CONTROLS + ', [data-drag-row], .drag-row')) e.stopImmediatePropagation();
	};

	const mark = () => {
		for (const el of node.querySelectorAll(CONTROLS)) {
			if (el.closest(ALLOWED) || el.getAttribute('aria-disabled') === 'true') continue;
			el.setAttribute('aria-disabled', 'true');
			marked.add(el);
		}
	};

	/** @param {boolean} next */
	const set = (next) => {
		if (next === on) return;
		on = next;
		if (on) {
			node.setAttribute('data-held-ro', '');
			for (const t of EDIT_EVENTS) node.addEventListener(t, stop, true);
			node.addEventListener('keydown', key, true);
			node.addEventListener('wheel', wheel, { capture: true, passive: true });
			mark();
			observer = new MutationObserver(mark);
			observer.observe(node, { childList: true, subtree: true });
			// a focused field would keep a half-typed value: put it down
			const active = /** @type {any} */ (document.activeElement);
			if (active && node.contains(active) && !active.closest(ALLOWED)) active.blur?.();
		} else {
			node.removeAttribute('data-held-ro');
			for (const t of EDIT_EVENTS) node.removeEventListener(t, stop, true);
			node.removeEventListener('keydown', key, true);
			node.removeEventListener('wheel', wheel, { capture: true });
			observer?.disconnect();
			observer = null;
			for (const el of marked) el.removeAttribute('aria-disabled');
			marked.clear();
		}
	};
	/** @param {any} a */
	const heldOf = (a) => (typeof a === 'object' && a !== null ? !!a.held : !!a);
	set(heldOf(arg));
	return {
		/** @param {boolean | {held: boolean, pan?: string}} next */
		update(next) {
			pan = typeof next === 'object' && next?.pan ? next.pan : '';
			set(heldOf(next));
		},
		destroy() {
			set(false);
		}
	};
}
