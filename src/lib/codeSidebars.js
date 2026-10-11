// 36-fb-code (F6/F7): the code workspace's two SIDEBARS, as LOCAL prefs. A LEAF (svelte/store +
// safeStorage): the workspace chrome, its keyboard and the e2e all read the same stores.
//
//   left   Open editors (the tabs, drag to reorder) over a draggable separator over Project
//          (every source the scene has, as a searchable tree). Collapsible; remembers its
//          width and where the separator sits.
//   right  ONE panel at a time — Outline, Problems, Bound nodes, Find in files. Collapsible;
//          remembers its width and which panel was showing.
// Nothing here replicates or saves with a scene: how wide a sidebar is, is a fact about this
// screen (the explorerView rule).

import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { readPanelOpen, writePanelOpen } from './ui/handheldPanels.js';

/** @param {string} key @param {number} fallback @param {number} min @param {number} max */
function readNumber(key, fallback, min, max) {
	const v = Number(safeStorage.getItem(key));
	return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, v)) : fallback;
}
/** a store that writes itself back on every change @template T @param {string} key @param {T} initial @returns {import('svelte/store').Writable<T>} */
function persisted(key, initial) {
	const store = writable(initial);
	store.subscribe((v) => safeStorage.setItem(key, String(v)));
	return store;
}

/** 41 G18: a sidebar's open state — HIDDEN on a phone until the user opens it (ui/handheldPanels) @param {string} key @param {boolean} desktopDefault */
function panelPref(key, desktopDefault) {
	const store = writable(readPanelOpen(key, desktopDefault));
	store.subscribe((v) => writePanelOpen(key, v));
	return store;
}

export const LEFT_MIN = 140;
export const LEFT_MAX = 480;
export const RIGHT_MIN = 160;
export const RIGHT_MAX = 520;
/** the right sidebar's panels, in tab order */
export const RIGHT_PANELS = /** @type {const} */ (['outline', 'problems', 'bound', 'find']);

/** the left sidebar is shown (Ctrl+B) */
export const codeLeftOpen = panelPref('code:leftOpen', true);
/** its width in px */
export const codeLeftWidth = persisted('code:leftWidth', readNumber('code:leftWidth', 210, LEFT_MIN, LEFT_MAX));
/** the Open editors share of the left sidebar's height, 0.1..0.9 (the separator) */
export const codeLeftSplit = persisted('code:leftSplit', readNumber('code:leftSplit', 0.34, 0.1, 0.9));
/** the right sidebar is shown (Ctrl+Alt+B) */
export const codeRightOpen = panelPref('code:rightOpen', true);
/** its width in px */
export const codeRightWidth = persisted('code:rightWidth', readNumber('code:rightWidth', 230, RIGHT_MIN, RIGHT_MAX));
const storedPanel = safeStorage.getItem('code:rightPanel');
/** which panel the right sidebar shows @type {import('svelte/store').Writable<typeof RIGHT_PANELS[number]>} */
export const codeRightPanel = persisted('code:rightPanel', /** @type {any} */ (RIGHT_PANELS.includes(/** @type {any} */ (storedPanel)) ? storedPanel : 'outline'));
/** bumped by Ctrl+Shift+F: the Find box takes focus (a write-once poke, the codeWorkspaceRaise shape) */
export const codeFindFocus = writable(0);

/** Ctrl+B @param {boolean} [force] */
export function toggleLeftSidebar(force) {
	codeLeftOpen.set(force ?? !get(codeLeftOpen));
}
/** Ctrl+Alt+B @param {boolean} [force] */
export function toggleRightSidebar(force) {
	codeRightOpen.set(force ?? !get(codeRightOpen));
}
/** show one right-sidebar panel (opening the sidebar) @param {typeof RIGHT_PANELS[number]} panel */
export function showRightPanel(panel) {
	codeRightPanel.set(panel);
	codeRightOpen.set(true);
}
/** Ctrl+Shift+F: the Find panel, its box focused */
export function focusFind() {
	showRightPanel('find');
	codeFindFocus.update((n) => n + 1);
}

/** clamp a dragged width @param {'left' | 'right'} side @param {number} px */
export function clampSidebarWidth(side, px) {
	return side === 'left' ? Math.min(LEFT_MAX, Math.max(LEFT_MIN, Math.round(px))) : Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(px)));
}

/**
 * The workspace's own keyboard, as a pure decision so the chrome and a test agree:
 * Ctrl+B left sidebar · Ctrl+Alt+B right sidebar · Ctrl+Shift+F find in files ·
 * Ctrl+P quick-open a project script · Ctrl+Shift+O go to a symbol of the current file
 * (36-fb-code S7). Returns what to do, or null.
 * @param {{key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
 * @returns {'left' | 'right' | 'find' | 'quickOpen' | 'symbols' | null}
 */
export function sidebarKey(e) {
	if (!(e.ctrlKey || e.metaKey)) return null;
	const byCode = { KeyB: 'b', KeyF: 'f', KeyP: 'p', KeyO: 'o' };
	const k = String(byCode[/** @type {keyof typeof byCode} */ (e.code ?? '')] ?? e.key).toLowerCase();
	if (k === 'b' && !e.shiftKey) return e.altKey ? 'right' : 'left';
	if (e.altKey) return null;
	if (k === 'f' && e.shiftKey) return 'find';
	if (k === 'p' && !e.shiftKey) return 'quickOpen';
	if (k === 'o' && e.shiftKey) return 'symbols';
	return null;
}
