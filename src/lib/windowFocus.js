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

function apply() {
	order.forEach((node, index) => {
		node.style.zIndex = String(40 + Math.min(index, 4));
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

/**
 * Is a node currently on screen? The same test windowTabs' merge hit-test uses
 * (`targetAt`): these windows are `position: fixed`, so `offsetParent` is null
 * even when they are perfectly visible — the offsetParent clause only rules out
 * NON-fixed ones. A closed window is hidden either by an inline `display:none`
 * (a tab group left it behind) or by a `hidden` CLASS, which shows up as a
 * computed `display:none` and a zero-width rect.
 * @param {any} node
 */
function isVisible(node) {
	if (!node?.isConnected) return false;
	if (node.style.display === 'none') return false;
	const style = getComputedStyle(node);
	if (style.display === 'none') return false;
	if (node.offsetParent === null && style.position !== 'fixed') return false;
	return node.getBoundingClientRect().width > 0;
}

/**
 * Is the keyed window the top-most VISIBLE one? `isTopWindow` cannot answer this:
 * a closed window usually stays MOUNTED (a `hidden` class / display:none) and
 * windowFocus only drops a node when its action is destroyed, so a window closed
 * while it was on top sits at the top of `order` for ever — after which the
 * top-most window that is actually on screen never reads as top.
 * @param {string} key
 */
export function isTopVisibleWindow(key) {
	const node = byKey.get(key);
	if (!node) return false;
	for (let index = order.length - 1; index >= 0; index--) {
		if (!isVisible(order[index])) continue;
		return order[index] === node;
	}
	return false;
}
