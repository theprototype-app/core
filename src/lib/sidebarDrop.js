import { get } from 'svelte/store';
import { sidebarTabs, sidebarVisible } from './sidebars';
import { canDockFloating, bottomInset } from './bottomDock';
import { dockStripTarget, dockPaneAt, inBottomBand, overEmptyDock, showDockCaret } from './bottomDockDrop';

// 43 J4 — ONE DROP-TARGET MODEL for a panel on the move: a SIDEBAR TAB dragged out of its strip
// and a FLOATING WINDOW dragged by its header ask the same question here — where would this land —
// and get one of four answers, each painted as ONE highlight above every panel:
//
//   side   the other side's column: "Move to the left side" (empty side: the column it will open
//          as) or "Add as tab" (an open side: its whole column)
//   dock   the bottom dock: the tab strip (41 G7's caret, at an index) or the dock / the bottom
//          edge band: "Move to dock"
//   float  anywhere else in the viewport: "Float here" — a sidebar tab becomes a floating window
//          under the pointer (the user: "dragging tab cannot undock to floating window if drag to
//          viewport")
//   null   nothing happens on a drop (the tab's own column, or a panel with nowhere to go there)
//
// Before this, a sidebar tab knew one target — the other HALF of the screen — so a drop anywhere
// in the viewport's left half moved the panel to the left side, the bottom did nothing, and the
// highlight sat at --z-chrome + 2, UNDER an open column's tab strip (--z-dock - 1): over an open
// sidebar the drop looked silent. The highlight paints at --z-portal now (it takes no pointer).
//
// A leaf over the sidebar / dock stores and the dock-strip hit test; it decides and paints, and
// the CALLERS act (SidebarStrips moves a tab, docking.js docks a dragged window).

/** @typedef {'left'|'right'} Side */
/** @typedef {{kind: 'side', side: Side, tab: boolean} | {kind: 'dock', strip: ReturnType<typeof dockStripTarget>, pane?: ReturnType<typeof dockPaneAt>} | {kind: 'float', x: number, y: number, w: number, h: number}} DropTarget */

/** px from a screen edge that counts as reaching for that side (docking.js's reach) */
export const EDGE = 44;

/** a side's column on screen, from the sidebars' CSS bus @param {Side} side */
export function columnBox(side) {
	const root = getComputedStyle(document.documentElement);
	const w = parseFloat(root.getPropertyValue(`--sb-${side}-w`)) || 320;
	const x0 = side === 'left' ? parseFloat(root.getPropertyValue('--sb-left-x')) || 0 : window.innerWidth - w;
	const top = parseFloat(root.getPropertyValue(`--sb-${side}-top`)) || 0;
	return { x0, w, top };
}

/** does this side have an open column — a tab other than `except`, or (44 M7) an EMPTY column kept open
 * with its "+"? A hidden side (Ctrl+B) has no column on screen. @param {Side} side @param {string=} except */
export function sideOpen(side, except) {
	if (!get(sidebarVisible)[side]) return false;
	const tabs = get(sidebarTabs)[side];
	return !tabs.length || tabs.some((k) => k !== except);
}

/**
 * Which side's column is the pointer over? Over the column's box when the side is open, and the
 * edge band either way. `emptyBox` also counts the box an EMPTY side would open as (same width, from
 * the edge) — a sidebar TAB heading for the other side gets that generous reach (42 I3's half-screen
 * drag, kept inside a column's width); a bottom-dock tab or a floating window, whose likelier wish in
 * the viewport is to float, reaches an empty side at its edge only (docking.js's 44px rule).
 * @param {number} x @param {number} y @param {{emptyBox?: boolean, except?: string}} [opts] @returns {Side|null}
 */
export function sideAt(x, y, opts = {}) {
	for (const side of /** @type {Side[]} */ (['left', 'right'])) {
		const { x0, w, top } = columnBox(side);
		const onEdge = side === 'left' ? x < EDGE : x > window.innerWidth - EDGE;
		const box = opts.emptyBox || sideOpen(side, opts.except);
		if (onEdge || (box && x >= x0 && x <= x0 + w && y >= top)) return side;
	}
	return null;
}

/**
 * Where a SIDEBAR TAB dragged to (x, y) lands.
 * @param {{x: number, y: number, key: string, from: Side, canFloat: boolean, canDock: boolean, size?: {w: number, h: number}}} q
 * @returns {DropTarget|null}
 */
export function tabDropTarget({ x, y, key, from, canFloat, canDock, size }) {
	// the dock first: its strip and body sit under both columns' bottoms when the dock is wide
	if (canDock) {
		const strip = dockStripTarget(x, y);
		if (strip) return { kind: 'dock', strip };
		const dockTop = window.innerHeight - Math.max(EDGE, get(bottomInset) || 0);
		if (inBottomBand(y) || y >= dockTop) return { kind: 'dock', strip: null };
	}
	const side = sideAt(x, y, { emptyBox: true, except: key });
	if (side === from) return null; // its own column: it stays
	if (side) return { kind: 'side', side, tab: sideOpen(side, key) };
	if (!canFloat) return null;
	const w = size?.w ?? 360;
	const h = size?.h ?? 320;
	return { kind: 'float', x: Math.max(0, x - 120), y: Math.max(0, y - 12), w, h };
}

/**
 * 44 M3 — where a FLOATING WINDOW dragged by its header (or its body, M1) lands. The tab model above with a
 * window's own reach: the dock's tab strip (41 G7's caret) or the bottom edge band, then a side's open
 * column or its edge band (docking.js's 44px rule — in the viewport a window's likelier wish is to stay
 * where it is dropped, so an EMPTY side is reached at its edge only), else null: it stays floating there.
 * The dock BODY is not a target (41 G7: a window must be able to pass over the dock). A header-merge
 * target, which beats all of these, is the caller's to ask first (windowTabs.headerTargetAt). Used by an
 * ungrouped window (bottomDockDrop's `bottomDockable`, every dockable window) and by a dragged window
 * GROUP or torn-out group tab (TabStrips), so the two can no longer disagree.
 * @param {{x: number, y: number, key: string, canDock: boolean, canSide: boolean}} q
 * @returns {DropTarget|null}
 */
export function windowDropTarget({ x, y, key, canDock, canSide }) {
	if (canDock) {
		const strip = dockStripTarget(x, y);
		if (strip) return { kind: 'dock', strip };
		// 48 F5: over a PANE of the split on screen, the window goes INTO that pane (an unsplit dock's body stays
		// a place a window can pass over, 41 G7)
		const pane = dockPaneAt(x, y);
		if (pane) return { kind: 'dock', strip: null, pane };
		// 44 M5: the EMPTY dock's body takes a drop like the edge band
		if (inBottomBand(y) || overEmptyDock(x, y)) return { kind: 'dock', strip: null };
	}
	if (canSide) {
		const side = sideAt(x, y, { except: key });
		if (side) return { kind: 'side', side, tab: sideOpen(side, key) };
	}
	return null;
}

/** the element id a window drag paints its target under — the ids suites have long addressed
 * (`dock-zone` for a side, `bottom-dock-zone` for the bottom band) @param {DropTarget|null} t */
export function windowDropZoneId(t) {
	return t?.kind === 'side' ? 'dock-zone' : 'bottom-dock-zone';
}

/** can this panel be a floating window? (the Inspector cannot: its homes are the sidebars) @param {string} key */
export function canFloatPanel(key) {
	return key !== 'inspector' && canDockFloating(key);
}

// ---- the one highlight ------------------------------------------------------------------------

/** @type {HTMLElement|null} */ let zoneEl = null;

/**
 * Paint a target (or clear with null). `id` keeps each caller's long-standing element id
 * (`sidebar-drop-zone` for a tab drag, `dock-zone` for a window drag), which suites address.
 * 45 N7: `hint` is a second, quieter line under the label (a floating window's target says how to
 * place it without docking).
 * @param {DropTarget|null} target @param {{id?: string, label?: string, hint?: string}} [opts]
 */
export function showDropTarget(target, opts = {}) {
	if (typeof document === 'undefined') return;
	const id = opts.id ?? 'sidebar-drop-zone';
	showDockCaret(target && target.kind === 'dock' ? target.strip : null);
	if (!target || (target.kind === 'dock' && target.strip)) {
		// the strip's caret is that target's highlight
		zoneEl?.remove();
		zoneEl = null;
		return;
	}
	if (zoneEl && zoneEl.id !== id) {
		zoneEl.remove();
		zoneEl = null;
	}
	if (!zoneEl) {
		zoneEl = document.createElement('div');
		zoneEl.id = id;
		zoneEl.className = 'sb-drop-zone';
		zoneEl.setAttribute('aria-hidden', 'true');
		document.body.appendChild(zoneEl);
	}
	const z = zoneEl;
	z.dataset.dropTarget = target.kind;
	const s = z.style;
	s.left = s.right = s.top = s.bottom = s.width = s.height = '';
	if (target.kind === 'side') {
		const { side, tab } = target;
		z.dataset.side = side;
		z.dataset.tab = tab ? 'true' : 'false';
		s.top = `var(--sb-${side}-top, 64px)`;
		s.bottom = `var(--sb-${side}-bottom, 0px)`;
		s.width = `var(--sb-${side}-w, 320px)`;
		if (side === 'left') s.left = 'var(--sb-left-x, 0px)';
		else s.right = '0px';
		label(z, opts.label ?? (tab ? 'Add as tab' : `Move to the ${side} side`), opts.hint);
		return;
	}
	delete z.dataset.side;
	delete z.dataset.tab;
	if (target.kind === 'dock' && target.pane) {
		// 48 F5: the pane the window would show in
		const r = target.pane.rect;
		s.left = r.x + 'px';
		s.top = r.y + 'px';
		s.width = r.w + 'px';
		s.height = r.h + 'px';
		label(z, opts.label ?? 'Show in this pane', opts.hint);
		return;
	}
	if (target.kind === 'dock') {
		s.left = 'var(--sb-dock-left, 0px)';
		s.right = 'var(--sb-dock-right, 0px)';
		s.bottom = '0px';
		s.height = Math.max(EDGE, get(bottomInset) || 0) + 'px';
		label(z, opts.label ?? 'Move to dock', opts.hint);
		return;
	}
	const w = Math.min(target.w, window.innerWidth - target.x);
	const h = Math.min(target.h, window.innerHeight - target.y);
	s.left = target.x + 'px';
	s.top = target.y + 'px';
	s.width = Math.max(120, w) + 'px';
	s.height = Math.max(80, h) + 'px';
	label(z, opts.label ?? 'Float here', opts.hint);
}

/** the zone's words: its label, and (45 N7) an optional hint line under it
 * @param {HTMLElement} z @param {string} text @param {string} [hint] */
function label(z, text, hint) {
	z.textContent = '';
	const a = document.createElement('span');
	a.className = 'sb-drop-label';
	a.textContent = text;
	z.appendChild(a);
	if (!hint) return;
	const b = document.createElement('span');
	b.className = 'sb-drop-hint';
	b.textContent = hint;
	z.appendChild(b);
}
