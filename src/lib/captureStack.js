// 78 F5 — THE VIEWPORT CAPTURE STACK: one owner for "the next click in the 3D view is mine".
//
// Five tools take viewport clicks for themselves — spline placing (Draw ▸ Spline), waypoint
// placing (Path patrol), Measure, freehand Draw and the flatten pick — and each used to hold
// that capture privately: its own Esc listener, its own toast, its own idea of when it ended.
// Two of them armed at once both answered Esc, both ate clicks in Scene's fixed order, and one
// of them could stay armed with nothing on screen saying so (the class of bug behind the
// fix-batch-2 patrol trap). Now a tool PUSHES an entry while it captures and POPS it when it
// ends; the TOP entry owns the clicks (`captureOwns`), Esc pops the TOP only (one listener,
// ahead of the tools' own), and ONE banner (CaptureBanner.svelte) says what is armed.
//
// A LEAF: svelte/store only. The tools are bridged in captureModes.js, which subscribes to their
// stores, so no tool module imports this one.

import { writable, derived, get } from 'svelte/store';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   hint?: string,
 *   icon?: string,
 *   escape: () => void,
 *   done?: () => void,
 *   keyOk?: (event: KeyboardEvent) => boolean
 * }} Capture
 *   `escape` = what Esc does (may step back inside the tool and keep it armed); `done` = the
 *   banner's finish button (default: `escape`); `keyOk` = does this key event belong to the tool
 *   (a tool that answers keys only while the 3D view holds the keyboard says no elsewhere, and
 *   the event passes on untouched)
 */

/** @type {import('svelte/store').Writable<Capture[]>} bottom first, the top entry last */
export const captureStack = writable([]);

/** the entry that owns viewport clicks right now, or null */
export const topCapture = derived(captureStack, (stack) => stack[stack.length - 1] ?? null);

/** Push (or re-push to the top) a capture. @param {Capture} entry */
export function pushCapture(entry) {
	captureStack.update((stack) => [...stack.filter((c) => c.id !== entry.id), entry]);
}

/** Change an entry in place (its label follows the tool) — never reorders. @param {string} id @param {Partial<Capture>} patch */
export function updateCapture(id, patch) {
	captureStack.update((stack) => stack.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

/** Remove an entry (its tool ended by itself). @param {string} id */
export function popCapture(id) {
	if (get(captureStack).some((c) => c.id === id)) captureStack.update((stack) => stack.filter((c) => c.id !== id));
}

/** Is `id` armed at all? @param {string} id */
export function captureArmed(id) {
	return get(captureStack).some((c) => c.id === id);
}

/**
 * May the tool `id` take this viewport click? Yes when it is the top entry — and also when it is
 * not on the stack at all (a tool nobody bridged keeps its old behaviour). An armed tool BELOW the
 * top waits its turn.
 * @param {string} id
 */
export function captureOwns(id) {
	const stack = get(captureStack);
	if (!stack.length) return true;
	return stack[stack.length - 1].id === id || !stack.some((c) => c.id === id);
}

/** a field you type in owns its own Esc @param {any} el */
function isTyping(el) {
	if (!el || typeof el !== 'object') return false;
	const tag = String(el.tagName ?? '');
	if (tag === 'TEXTAREA' || el.isContentEditable) return true;
	if (tag !== 'INPUT') return false;
	const type = String(el.type ?? 'text');
	return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(type);
}

/**
 * Esc pops the TOP capture (its `escape`, which may step back inside the tool first). Returns true
 * when it was used — the caller then stops the event so no tool below also answers it.
 * @param {KeyboardEvent} event
 */
export function escapeTopCapture(event) {
	if (event.key !== 'Escape' || event.repeat) return false;
	const top = get(topCapture);
	if (!top) return false;
	if (isTyping(event.target)) return false;
	if (top.keyOk && !top.keyOk(event)) return false;
	top.escape();
	return true;
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (!escapeTopCapture(event)) return;
	event.preventDefault();
	event.stopImmediatePropagation();
}

let installed = false;
/**
 * Install the one Esc listener — at app start, so on the window it runs AHEAD of every tool's own
 * capture listener (a tool adds its listener when it is armed, i.e. later). Idempotent.
 * @returns {() => void} uninstall
 */
export function installCaptureKeys() {
	if (installed || typeof window === 'undefined') return () => {};
	installed = true;
	window.addEventListener('keydown', onKeydown, true);
	return () => {
		installed = false;
		window.removeEventListener('keydown', onKeydown, true);
	};
}
