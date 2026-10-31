import { writable, get } from 'svelte/store';
import { isHeaderDrag } from './windowGrip';
import { PHONE_QUERY } from './ui/phoneShell.js';
import { DOCK_TITLES } from './bottomDock';
import { dockTab, canDockHere, moveToSidebar } from './dockMenu';
import { canSideHere } from './bottomDockDrop';
import { groupOfKey, groupCandidates, keyOfNode, mergeWindows, ungroupTab, closeMember, titleOf, nodeOf } from './windowTabs';
import { raiseWindowNode } from './windowFocus';
import { sizeResetOf } from './windowSize';
import { popOutItems } from './windows/panelPlaces.js';

// 44 M3 — A FLOATING WINDOW'S MENU (the user, preview-1-34: "right click or holding header of window or
// tab should give an option to dock/undock or put to left or right sidebar, if any other options are good
// to have, add them … but i do not want to change its header, should look the same as now").
//
// Decision: right-click / long press on a floating window's HEADER, or on a window group's TAB, opens one
// menu — Dock to bottom, Move to left sidebar, Move to right sidebar, Float (undock), Group with…, Bring to
// front, Reset size, Close. The header gains no button: the menu is a GESTURE on the header it already has.
// A row that cannot act on this window stays, disabled, with the reason in its tooltip (the dock tab and
// sidebar tab menus' rule — W5/43 J4).
//
// A press on a header CONTROL keeps its own menu (the search field's clipboard menu, 43-clipboard): only a
// press that would drag the window (windowGrip `isHeaderDrag`) opens this one, and only when nothing under
// it claimed the event first (`defaultPrevented`). Docked windows have their own tab menus (dockMenu,
// sidebarMenu); a phone's floating windows are bottom sheets.

/** @typedef {{x: number, y: number, node: HTMLElement, key: string|null, grouped: boolean}} WindowMenuState */
/** @type {import('svelte/store').Writable<WindowMenuState|null>} */
export const windowMenu = writable(null);

const LONG_PRESS_MS = 500;
const SLOP = 8;

const onPhone = () => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;

/** the floating window a header press belongs to, or null @param {any} target */
function windowOfHeader(target) {
	if (!target || typeof target.closest !== 'function' || !isHeaderDrag(target)) return null;
	const node = /** @type {HTMLElement|null} */ (target.closest('[data-body-drag]'));
	if (!node || node.dataset.docked || node.closest('[data-pd-host]')) return null;
	return node;
}

/** the dock / tab key a window node answers to (null: a window with no dock or tab identity) @param {HTMLElement} node */
export function windowKeyOf(node) {
	return node.dataset.windowKey || keyOfNode(node) || null;
}

/**
 * Open the menu for a window (a header press) or a group tab (TabStrips).
 * @param {HTMLElement} node @param {number} x @param {number} y @param {string|null=} key
 */
export function openWindowMenu(node, x, y, key) {
	const k = key ?? windowKeyOf(node);
	windowMenu.set({ x, y, node, key: k, grouped: !!(k && groupOfKey(k)) });
}

/** what the window is called in the rows' tooltips @param {WindowMenuState} m */
function titleFor(m) {
	if (m.key) {
		const t = titleOf(m.key);
		if (t && t !== m.key) return t;
		if (DOCK_TITLES[m.key]) return DOCK_TITLES[m.key];
	}
	return m.node.querySelector('.wc-title')?.textContent?.trim() || 'this window';
}

/** close a window the way its own ✕ does @param {WindowMenuState} m */
function closeWindow(m) {
	if (m.key && nodeOf(m.key)) {
		closeMember(m.key);
		return;
	}
	const x = /** @type {HTMLElement|null} */ (m.node.querySelector('.move-handle .wc-close, .move-handle [aria-label^="Close"]'));
	x?.click();
}

/** can this window be closed from its menu? @param {WindowMenuState} m */
function canClose(m) {
	if (m.key && nodeOf(m.key)) return true;
	return !!m.node.querySelector('.move-handle .wc-close, .move-handle [aria-label^="Close"]');
}

/**
 * The menu's rows, in the decision's order.
 * @param {WindowMenuState} m
 * @returns {any[]}
 */
export function windowMenuItems(m) {
	const { key, grouped } = m;
	const title = titleFor(m);
	const dock = !!key && canDockHere(key);
	const side = !!key && canSideHere(key);
	const others = key ? groupCandidates(key) : [];
	const reset = grouped ? null : sizeResetOf(m.node);
	const group = key ? groupOfKey(key) : null;
	const front = group ? nodeOf(group.active) : m.node;
	return [
		{
			label: 'Dock to bottom',
			icon: 'panel-bottom',
			tooltip: dock ? `Make ${title} a tab of the bottom dock` : `${title} has no place in the bottom dock`,
			disabled: !dock,
			action: () => key && dockTab(key)
		},
		...(/** @type {const} */ (['left', 'right'])).map((s) => ({
			label: `Move to ${s} sidebar`,
			icon: s === 'left' ? 'panel-left' : 'panel-right',
			tooltip: side ? `Dock ${title} in the ${s} sidebar, as one of its tabs` : `${title} cannot be a sidebar tab here`,
			disabled: !side,
			action: () => key && moveToSidebar(key, s)
		})),
		{
			label: 'Float (undock)',
			icon: 'app-window',
			tooltip: grouped ? `Take ${title} out of its group, as a window of its own` : `${title} is already a floating window`,
			disabled: !grouped,
			action: () => key && ungroupTab(key)
		},
		// 70 W2: into a browser window of its own (desktop only — the rows are absent elsewhere)
		...(key ? popOutItems(key) : []),
		{
			label: 'Group with…',
			icon: 'group',
			tooltip: others.length ? `Join ${title} to another window as one of its tabs` : 'No other floating window is open',
			disabled: !others.length,
			// no candidates: a plain disabled row (ContextMenu drops a submenu row with no children)
			...(others.length && {
				children: others.map((o) => ({
					label: o.title,
					tooltip: `Group ${title} with ${o.title}`,
					action: () => key && mergeWindows(o.key, key)
				}))
			})
		},
		{
			label: 'Bring to front',
			icon: 'layers',
			tooltip: `Raise ${title} above the other windows`,
			action: () => front && raiseWindowNode(front)
		},
		{
			label: 'Reset size',
			icon: 'shrink',
			tooltip: reset ? `Back to ${title}'s default size (its place is kept)` : grouped ? 'A group shares one size across its tabs' : `${title} sizes itself`,
			disabled: !reset,
			action: () => reset?.()
		},
		{
			label: 'Close',
			icon: 'x',
			tooltip: `Close ${title}`,
			disabled: !canClose(m),
			action: () => closeWindow(m)
		}
	];
}

let installed = false;
/** the window-level listeners (WindowMenu.svelte installs them once) */
export function installWindowMenu() {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	/** a long press opened the menu for this node a moment ago — Android's own long-press
	 * `contextmenu` must not open it a second time @type {{node: any, at: number}|null} */
	let lastLong = null;
	window.addEventListener('contextmenu', (/** @type {MouseEvent} */ e) => {
		if (e.defaultPrevented || onPhone()) return;
		const node = windowOfHeader(e.target);
		if (!node) return;
		e.preventDefault();
		if (lastLong && lastLong.node === node && performance.now() - lastLong.at < 1200) return;
		openWindowMenu(node, e.clientX, e.clientY);
	});
	// touch: a STILL press on the header (the timer is the promise — Android's own long-press
	// `contextmenu` is not guaranteed once the window drag has taken the pointer)
	/** @type {null | {id: number, x: number, y: number, node: HTMLElement, timer: any}} */
	let press = null;
	const clear = () => {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
	};
	window.addEventListener(
		'pointerdown',
		(/** @type {PointerEvent} */ e) => {
			if (e.pointerType === 'mouse' || e.button !== 0 || onPhone()) return;
			const node = windowOfHeader(e.target);
			if (!node) return;
			clear();
			const p = { id: e.pointerId, x: e.clientX, y: e.clientY, node, timer: /** @type {any} */ (null) };
			p.timer = setTimeout(() => {
				if (press !== p) return;
				press = null;
				lastLong = { node, at: performance.now() };
				openWindowMenu(node, p.x, p.y);
			}, LONG_PRESS_MS);
			press = p;
		},
		true
	);
	window.addEventListener(
		'pointermove',
		(/** @type {PointerEvent} */ e) => {
			if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) clear();
		},
		true
	);
	window.addEventListener('pointerup', (/** @type {PointerEvent} */ e) => press && e.pointerId === press.id && clear(), true);
	window.addEventListener('pointercancel', (/** @type {PointerEvent} */ e) => press && e.pointerId === press.id && clear(), true);
}

/** is the menu open? (tests) */
export function windowMenuOpen() {
	return !!get(windowMenu);
}
