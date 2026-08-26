// Click-to-front for floating windows (phase 82). Every registered window
// gets a z-index inside the --z-window band (40..44, still under the hud at
// 45); pointerdown moves it to the top of the stack.
import { writable } from 'svelte/store';

/** @type {any[]} */
const order = [];
/** @type {Map<string, any>} key -> node, for programmatic raise (e.g. a toolbar button) */
const byKey = new Map();
/** bumps whenever the z-order changes, so followers (tab strips) can re-read z */
export const focusTick = writable(0);

/**
 * The band is five slots wide (40..44) and must stay under the hud at 45, so with six or
 * more windows open SOMETHING has to share.
 *
 * R22 ROUND 26 — WHICH END SHARES IS THE WHOLE QUESTION. `Math.min(index, 4)` clamped the
 * TOP: every window from the fifth-most-recent onwards got 44, so the ones you had just
 * been using were exactly the ones that could no longer be ordered against each other. A
 * tie is then broken by DOM order, and a tab strip - rendered from Menu.svelte, after the
 * windows - wins every one of them, which is a strip drawing through a window in front of
 * it.
 *
 * Counting from the TOP instead keeps the five most recent windows strictly ordered and
 * lets the DEEP ones share 40, where a tie is invisible: they are all behind everything
 * that matters. Same five slots, spent on the end you can see.
 *
 * (This does not make ties impossible - CSS z-index is an integer, and six windows cannot
 * have six distinct values in five slots. It makes them impossible where they are
 * noticeable, which is the most the band allows.)
 */
function apply() {
	const top = order.length - 1;
	order.forEach((node, index) => {
		node.style.zIndex = String(40 + Math.max(0, 4 - (top - index)));
	});
	focusTick.update((n) => n + 1);
}

/** @param {any} node */
function raiseNode(node) {
	const index = order.indexOf(node);
	if (index >= 0 && index < order.length - 1) {
		order.splice(index, 1);
		order.push(node);
		apply();
	}
}

/**
 * svelte action: use:focusStack on a floating window's root. Pass an optional key
 * (use:focusStack={'objects'}) to allow raising it programmatically by key.
 * @param {any} node @param {string=} key
 */
export function focusStack(node, key) {
	order.push(node);
	if (key) byKey.set(key, node);
	apply();
	const raise = () => raiseNode(node);
	// capture phase: runs before inner handlers, dragging included
	node.addEventListener('pointerdown', raise, true);
	return {
		destroy() {
			node.removeEventListener('pointerdown', raise, true);
			const index = order.indexOf(node);
			if (index >= 0) order.splice(index, 1);
			if (key) byKey.delete(key);
			apply();
		}
	};
}

/** Raise a keyed window to the front (e.g. when its toolbar button is clicked). @param {string} key */
export function raiseWindow(key) {
	const node = byKey.get(key);
	if (node) raiseNode(node);
	return !!node;
}

/** Raise a window to the front by its node (e.g. a tab group's active member). @param {any} node */
export function raiseWindowNode(node) {
	if (node) raiseNode(node);
}

/** Is the keyed window already at the front of the stack? @param {string} key */
export function isTopWindow(key) {
	const node = byKey.get(key);
	return !!node && order.length > 0 && order[order.length - 1] === node;
}
