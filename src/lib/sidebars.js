import { writable, readable, derived, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { inspectorClose, inspectorKind, closeMenu, connectDocked, connectBarHeight, setInspectorFocuser } from '../stores/appStore';
import { onLayoutRestore } from './uiLayoutsCore';
import { scaledPx, uiScale } from './uiScale'; // 53 A1: the default + minimum width follow the UI scale
import { panelAway } from './windows/panelPlaces.js'; // 70 W2: a popped Inspector leaves its column

// 42 I2/I3 — ONE SIDEBAR PER SCREEN SIDE (user decision 2026-10-14, roadmap 42).
//
// A side of the screen holds one column. Every panel docked to that side is a TAB of it: the
// Inspector (Configure Scene / Properties / File — one panel whose kind swaps) and every
// edge-docked window (Objects, Node editor, Explorer — docking.js). Only the active tab renders;
// opening a panel onto an occupied side brings its tab to the front instead of adding a second
// column (the old "right-docked window offsets inward when the Inspector opens") or a vertical
// split (81.4). Dragging a tab to the other half of the screen moves the panel to that side.
//
// The column is the SIDE's: one width (`sidebarWidth:<side>`), one Full-height pin
// (`sidebar:full:<side>`). Pinned, the column runs from the top edge to the bottom edge; that
// side's corner buttons slide inward by the column width and the bottom dock gets narrower by
// it — never under it.
//
// THE CONTRACT WITH THE PANELS is a set of CSS custom properties on :root, published here, so
// the owners place themselves without importing each other (docking.js styles its nodes with
// them, Inspector.svelte its drawer, SidebarStrips.svelte the tab header and the resize grip,
// and the chrome that has to make way reads the `--sb-dock-*` pair):
//   --sb-strip-h                  the tab header's height
//   --sb-<side>-w                 the column width
//   --sb-<side>-top / -bottom     the column's top / bottom (the header sits at top)
//   --sb-left-x                   the left column's x (the menu insets an UNPINNED left column)
//   --sb-dock-left / -right       a PINNED, shown column's width, else 0px: what the bottom dock
//                                 and the corner chrome give way to
//
// A leaf: svelte/store + the app stores. Members REPORT themselves (`reportMember`); nothing
// here reaches into a component.

/** @typedef {'left'|'right'} Side */
/** @type {Side[]} */
export const SIDES = ['left', 'right'];
/** the tab header's height, px */
export const STRIP_H = 30;
/** the column's top below the corner chrome (the old drawer's top-16) */
const TOP_PX = 64; // 53 A1: design px — the live top is scaledPx(TOP_PX), the chrome row grows with the UI scale
export const MIN_W = 250;
const DEFAULT_W = 320;
/** 53 (A1): the default column width at the current UI scale (a 150 % device opens a 480 px column) */
export const defaultSidebarWidth = () => scaledPx(DEFAULT_W);

const ls = typeof localStorage !== 'undefined';

/** @param {any} v @returns {Side} */
const asSide = (v) => (v === 'left' ? 'left' : 'right');

/** clamp a column width to the window (the old dock rule: 250 .. 40 % of the window) @param {number} w */
export function clampWidth(w) {
	const min = scaledPx(MIN_W);
	const max = typeof window !== 'undefined' ? Math.max(min, Math.round(window.innerWidth * 0.4)) : 1200;
	return Math.min(Math.max(Number.isFinite(w) ? Math.round(w) : defaultSidebarWidth(), min), max);
}

/** @param {Side} side */
function readWidth(side) {
	if (!ls) return defaultSidebarWidth();
	let v = parseInt(safeStorage.getItem('sidebarWidth:' + side) ?? '');
	if (Number.isNaN(v)) {
		// migrate: the column used to take the width of its first docked window
		try {
			const docked = JSON.parse(safeStorage.getItem('dockedWindows') ?? 'null');
			const first = Array.isArray(docked?.[side]) ? docked[side][0] : null;
			const old = first ? parseInt(safeStorage.getItem('dockWidth:' + first) ?? '') : NaN;
			v = Number.isNaN(old) ? defaultSidebarWidth() : old;
		} catch {
			v = defaultSidebarWidth();
		}
	}
	return clampWidth(v);
}

/** which side the Inspector docks to (LOCAL, persisted) */
export const inspectorSide = writable(/** @type {Side} */ (ls ? asSide(safeStorage.getItem('sidebar:inspectorSide')) : 'right'));
inspectorSide.subscribe((v) => ls && safeStorage.setItem('sidebar:inspectorSide', v));

/** the Full-height pin, per side (LOCAL, persisted) */
export const sidebarFull = writable({
	left: ls && safeStorage.getItem('sidebar:full:left') === 'true',
	right: ls && safeStorage.getItem('sidebar:full:right') === 'true'
});
sidebarFull.subscribe((v) => {
	if (!ls) return;
	safeStorage.setItem('sidebar:full:left', String(!!v.left));
	safeStorage.setItem('sidebar:full:right', String(!!v.right));
});
/** @param {Side} side @param {boolean=} on */
export function toggleSidebarFull(side, on) {
	sidebarFull.update((v) => ({ ...v, [side]: on ?? !v[side] }));
}

/**
 * 44 M7 — WHETHER A SIDE'S COLUMN IS ON SCREEN, per side (LOCAL, persisted — VS Code keeps its
 * sidebars' visibility the same way):
 *   'auto'    on screen while it has a tab (what the columns always did)
 *   'open'    on screen EVEN EMPTY — its strip with only "+" and "Press + or drag a tab here"
 *             (the user: "when all tabs are dragged to somewhere else or closed it should keep panel
 *             opened empty"). A side becomes 'open' when the user empties it (its last tab closed,
 *             moved or floated — `keepSideOpen`) or opens it with its shortcut.
 *   'hidden'  collapsed by its shortcut (Ctrl+B left, Ctrl+Alt+B right): every tab stays OPEN and
 *             mounted, only the column is off screen; a panel arriving on a hidden side (opened,
 *             docked there, brought forward) shows the side again. Not persisted (see below).
 * @typedef {'auto'|'open'|'hidden'} SideMode
 */
/** @param {Side} side @returns {SideMode} */
function readMode(side) {
	const v = ls ? safeStorage.getItem('sidebar:mode:' + side) : null;
	return v === 'open' ? 'open' : 'auto';
}
export const sidebarMode = writable(/** @type {Record<Side, SideMode>} */ ({ left: readMode('left'), right: readMode('right') }));
sidebarMode.subscribe((v) => {
	if (!ls) return;
	// 'hidden' is NOT remembered (the dock's `dockMinimized` rule): a column off screen leaves no trace,
	// so a reload brings it back rather than handing somebody a sidebar with no visible way to it
	for (const side of /** @type {Side[]} */ (['left', 'right'])) safeStorage.setItem('sidebar:mode:' + side, v[side] === 'open' ? 'open' : 'auto');
});
/** @param {Side} side @param {SideMode} mode */
function setMode(side, mode) {
	sidebarMode.update((v) => (v[side] === mode ? v : { ...v, [side]: mode }));
}

/**
 * 43 K1 — the side whose column is being RESIZED right now (its grip held), else null. PUBLIC (with
 * the rest of this module's stores — 43-controls and 43-focus read them): while it is set, <html>
 * carries `sb-resizing` and nothing that follows the column edge animates (windows.css), so the logo,
 * the profile corner and the dock land on the edge in the same frame as the column.
 * @type {import('svelte/store').Writable<Side|null>}
 */
export const sidebarResizing = writable(/** @type {Side|null} */ (null));
if (typeof document !== 'undefined')
	sidebarResizing.subscribe((v) => document.documentElement.classList.toggle('sb-resizing', !!v));

/** the column width, per side (LOCAL, persisted) */
export const sidebarWidth = writable({ left: readWidth('left'), right: readWidth('right') });
/** @param {Side} side @param {number} w @param {boolean=} persist */
export function setSidebarWidth(side, w, persist = true) {
	const next = clampWidth(w);
	sidebarWidth.update((v) => ({ ...v, [side]: next }));
	if (persist && ls) safeStorage.setItem('sidebarWidth:' + side, String(next));
}

// ---- membership --------------------------------------------------------------------------------

/** key -> {side, present}; `present` = open on screen (a docked-but-closed window is not a tab)
 * @type {import('svelte/store').Writable<Record<string, {side: Side, present: boolean}>>} */
const members = writable({});

/** per side, the tab order (first arrival first; persisted so a reload keeps it) */
const order = { left: readOrder('left'), right: readOrder('right') };
/** @param {Side} side @returns {string[]} */
function readOrder(side) {
	try {
		const v = JSON.parse((ls && safeStorage.getItem('sidebar:order:' + side)) || '[]');
		return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
	} catch {
		return [];
	}
}
/** @param {Side} side */
function saveOrder(side) {
	if (ls) safeStorage.setItem('sidebar:order:' + side, JSON.stringify(order[side]));
}

/** per side, the most-recently-activated keys first (what is in front, and what comes back
 *  when the front tab closes) */
const mru = writable(/** @type {Record<Side, string[]>} */ ({
	left: ls && safeStorage.getItem('sidebar:active:left') ? [String(safeStorage.getItem('sidebar:active:left'))] : [],
	right: ls && safeStorage.getItem('sidebar:active:right') ? [String(safeStorage.getItem('sidebar:active:right'))] : []
}));

/**
 * A panel tells the sidebars where it is. Arriving present on a side (opened, or docked there)
 * brings its tab to the front — "opening a panel on an occupied side focuses its tab".
 * @param {string} key @param {Side|null} side null = not docked to any side @param {boolean} present
 */
export function reportMember(key, side, present) {
	const before = get(members)[key];
	if (!side) {
		if (!before) return;
		members.update((m) => {
			const next = { ...m };
			delete next[key];
			return next;
		});
		return;
	}
	if (before && before.side === side && before.present === present) return;
	// the tab order is the order panels ARRIVE on screen (a docked-but-closed one has not)
	if (present && !order[side].includes(key)) {
		order[side] = [...order[side], key];
		const other = side === 'left' ? 'right' : 'left';
		order[other] = order[other].filter((k) => k !== key);
		saveOrder(side);
		saveOrder(other);
	}
	members.update((m) => ({ ...m, [key]: { side, present } }));
	if (present && (!before || !before.present || before.side !== side)) activateSidebarTab(key);
}

/** the tabs of each side, in order (present members only) */
export const sidebarTabs = derived(members, ($m) => {
	/** @type {Record<Side, string[]>} */
	const out = { left: [], right: [] };
	for (const side of SIDES) {
		const here = Object.keys($m).filter((k) => $m[k].side === side && $m[k].present);
		out[side] = here.sort((a, b) => rank(side, a) - rank(side, b));
	}
	return out;
});
/** @param {Side} side @param {string} key */
function rank(side, key) {
	const i = order[side].indexOf(key);
	return i < 0 ? 1e6 : i;
}

/** the tab in front on each side (null = the side is empty, or 44 M7: hidden) */
export const sidebarShown = derived([sidebarTabs, mru, sidebarMode], ([$tabs, $mru, $mode]) => {
	/** @type {Record<Side, string|null>} */
	const out = { left: null, right: null };
	for (const side of SIDES) {
		const tabs = $tabs[side];
		if (!tabs.length || $mode[side] === 'hidden') continue;
		out[side] = $mru[side].find((k) => tabs.includes(k)) ?? tabs[0];
	}
	return out;
});

/**
 * 44 M7 — is each side's column on screen: not hidden, and holding a tab or kept open empty.
 * @type {import('svelte/store').Readable<Record<Side, boolean>>}
 */
export const sidebarVisible = derived([sidebarTabs, sidebarMode], ([$tabs, $mode]) => ({
	left: $mode.left !== 'hidden' && ($tabs.left.length > 0 || $mode.left === 'open'),
	right: $mode.right !== 'hidden' && ($tabs.right.length > 0 || $mode.right === 'open')
}));

/** 44 M7: is this side an open column with NO tab (the "+" and the helper line)? @param {Side} side */
export function sidebarEmptyOpen(side) {
	return get(sidebarVisible)[side] && !get(sidebarTabs)[side].length;
}

/**
 * 44 M7 — the sidebar shortcut (Ctrl+B left, Ctrl+Alt+B right): on screen -> hidden (every tab stays
 * open, the column goes); off screen -> open (its tabs come back, or an empty column with "+").
 * @param {Side} side @param {boolean=} on force shown (true) / hidden (false)
 */
export function toggleSidebar(side, on) {
	const show = on ?? !get(sidebarVisible)[side];
	setMode(side, show ? (get(sidebarTabs)[side].length ? 'auto' : 'open') : 'hidden');
}

/**
 * 44 M7 — the USER is about to take `key` out of its side (its × / Close, a drag or a menu move to
 * another side, the dock or a floating window): when it is the side's LAST tab, the column stays
 * open, empty, with its "+". Programmatic closes (a deselect closing Properties) never call this, so
 * a column that only ever held the Inspector still goes away with it as before.
 * @param {string} key
 */
export function keepSideOpen(key) {
	const m = get(members)[key];
	if (!m || !m.present) return;
	const tabs = get(sidebarTabs)[m.side];
	if (tabs.length === 1 && tabs[0] === key && get(sidebarMode)[m.side] !== 'hidden') setMode(m.side, 'open');
}

/** bring a panel's tab to the front of its side @param {string} key */
export function activateSidebarTab(key) {
	const m = get(members)[key];
	if (!m) return;
	// 44 M7: bringing a tab forward shows a hidden side
	if (get(sidebarMode)[m.side] === 'hidden') setMode(m.side, 'auto');
	mru.update((v) => ({ ...v, [m.side]: [key, ...v[m.side].filter((k) => k !== key)].slice(0, 12) }));
	if (ls) safeStorage.setItem('sidebar:active:' + m.side, key);
}

/** the side a panel is docked to (null = none) @param {string} key @returns {Side|null} */
export function sidebarSideOf(key) {
	return get(members)[key]?.side ?? null;
}
/** is this panel docked and open, but covered by another tab of its side? @param {string} key */
export function sidebarTabCovered(key) {
	const m = get(members)[key];
	if (!m || !m.present) return false;
	return get(sidebarShown)[m.side] !== key;
}

// ---- moving a panel to the other side ---------------------------------------------------------

/** docking.js registers how it moves one of its windows between sides
 * @type {((key: string, side: Side) => boolean) | null} */
let dockMover = null;
/** @param {((key: string, side: Side) => boolean) | null} fn */
export function setDockMover(fn) {
	dockMover = fn;
}
/** move a panel to a side (the tab drag's drop) @param {string} key @param {Side} side */
export function moveSidebarTab(key, side) {
	if (get(members)[key]?.side !== side) keepSideOpen(key);
	if (key === 'inspector') inspectorSide.set(side);
	else if (!dockMover?.(key, side)) return false;
	activateSidebarTab(key);
	return true;
}

// ---- the Inspector is a member -----------------------------------------------------------------

/** the Inspector's tab label */
export const inspectorTabTitle = derived(inspectorKind, ($k) => ($k === 'scene' ? 'Configure Scene' : $k === 'file' ? 'File' : 'Properties'));

let wired = false;
/** wire the Inspector's membership + the CSS bus (once, from the always-mounted editor chrome) */
export function startSidebars() {
	if (wired || typeof document === 'undefined') return;
	wired = true;
	// 70 W2: an Inspector in a pop-out window is no column member (it keeps its side for coming back)
	derived([inspectorClose, inspectorSide, panelAway], (x) => x).subscribe(([closed, side, away]) => reportMember('inspector', side, !closed && !away.inspector));
	// an explicit open of an Inspector that is already open (Configure Scene, double-click,
	// a deep link) brings its tab to the front of the column
	setInspectorFocuser(() => {
		const covered = sidebarTabCovered('inspector');
		activateSidebarTab('inspector');
		return covered;
	});
	geometry.subscribe(publish);
	// the left inset is measured from the menu's DOM, which mounts after the store fires
	closeMenu.subscribe(() => requestAnimationFrame(() => leftInsetTick.update((n) => n + 1)));
	window.addEventListener('resize', () => {
		leftInsetTick.update((n) => n + 1);
		sidebarWidth.update((v) => ({ left: clampWidth(v.left), right: clampWidth(v.right) }));
	});
}

// a named layout rewrote the stored widths / pins / sides: adopt them
onLayoutRestore(() => {
	sidebarWidth.set({ left: readWidth('left'), right: readWidth('right') });
	sidebarFull.set({
		left: safeStorage.getItem('sidebar:full:left') === 'true',
		right: safeStorage.getItem('sidebar:full:right') === 'true'
	});
	inspectorSide.set(asSide(safeStorage.getItem('sidebar:inspectorSide')));
	sidebarMode.set({ left: readMode('left'), right: readMode('right') });
	for (const side of SIDES) order[side] = readOrder(side);
	mru.update((v) => {
		const next = { ...v };
		for (const side of SIDES) {
			const front = safeStorage.getItem('sidebar:active:' + side);
			if (front) next[side] = [front, ...v[side].filter((k) => k !== front)];
		}
		return next;
	});
});

// ---- geometry: the CSS bus ---------------------------------------------------------------------

/** the sidebars exist above the phone width (at <= 640 px the Inspector is a bottom sheet and the
 *  phone shell's dock holds the panels) */
export const sidebarsWide = readable(true, (set) => {
	if (typeof window === 'undefined' || !window.matchMedia) return;
	const mq = window.matchMedia('(min-width: 641px)');
	set(mq.matches);
	const on = () => set(mq.matches);
	mq.addEventListener('change', on);
	return () => mq.removeEventListener('change', on);
});

const leftInsetTick = writable(0);

// An UNPINNED left column starts past the open main menu (the menu used to cover the docked
// panel's header — dock-sidebar-inset); a PINNED one keeps its edge and the logo + menu move
// inward instead, so the menu opens beside the column, above every sidebar.
function measureLeftInset() {
	if (typeof document === 'undefined' || get(closeMenu) !== false) return 0;
	const el = document.querySelector('.app-sidebar');
	return el ? Math.round(el.getBoundingClientRect().right) + 8 : 228;
}

export const geometry = derived(
	// 53 A1: `uiScale` is a dependency only so the column's top re-derives with the scale
	[sidebarShown, sidebarFull, sidebarWidth, connectDocked, connectBarHeight, leftInsetTick, sidebarsWide, sidebarVisible, uiScale],
	([$shown, $full, $w, $cDocked, $cBar, _tick, $wide, $visible]) => {
		const TOP = scaledPx(TOP_PX);
		/** @param {Side} side */
		const col = (side) => {
			const full = !!$full[side];
			// 44-int: under a docked Connect bar an OPEN left column starts below the logo's row (the logo drops to
			// cBar + 8, a 44 px tile), as it does under a floating pill (TOP) — right under the bar, its tab strip
			// (above the chrome while Connect docks) covered the logo, and the menu could not be opened. 44 M14
			// pins the bar by default on the unfolded phone, which made that the everyday case. The right column
			// keeps tucking under the bar (it covers the top-right chrome there by design, ui.css).
			const top = full ? ($cDocked ? $cBar : 0) : $cDocked ? $cBar + (side === 'left' ? TOP - 4 : 4) : TOP;
			const bottom = full ? '0px' : 'calc(var(--bottom-inset, 0px) + var(--controls-inset, 0px))';
			return { shown: $shown[side], visible: $visible[side], full, top, bottom, w: $w[side] };
		};
		const left = col('left');
		const right = col('right');
		return {
			left,
			right,
			wide: $wide,
			leftX: left.full || !$wide ? 0 : measureLeftInset(),
			dockLeft: $wide && left.visible && left.full ? left.w : 0,
			dockRight: $wide && right.visible && right.full ? right.w : 0
		};
	}
);

/** @param {any} g */
function publish(g) {
	const root = document.documentElement.style;
	root.setProperty('--sb-strip-h', scaledPx(STRIP_H) + 'px'); // 53 A1: the strip's CSS is scaled too
	for (const side of SIDES) {
		root.setProperty(`--sb-${side}-w`, g[side].w + 'px');
		root.setProperty(`--sb-${side}-top`, g[side].top + 'px');
		root.setProperty(`--sb-${side}-bottom`, g[side].bottom);
	}
	root.setProperty('--sb-left-x', g.leftX + 'px');
	root.setProperty('--sb-dock-left', g.dockLeft + 'px');
	root.setProperty('--sb-dock-right', g.dockRight + 'px');
	document.documentElement.classList.toggle('sb-full-left', !!g.dockLeft);
	document.documentElement.classList.toggle('sb-full-right', !!g.dockRight);
}

/**
 * The inline placement of a column MEMBER (below the tab header). One string for every member,
 * so the Inspector and a docked window cannot disagree about where the column is.
 * @param {Side} side @returns {string}
 */
export function memberPlacement(side) {
	const x = side === 'left' ? 'left: var(--sb-left-x, 0px); right: auto;' : 'left: auto; right: 0px;';
	return (
		`position: fixed; ${x} top: calc(var(--sb-${side}-top, 64px) + var(--sb-strip-h, 30px)); ` +
		`bottom: var(--sb-${side}-bottom, 0px); width: var(--sb-${side}-w, 320px); ` +
		`height: calc(100vh - var(--sb-${side}-top, 64px) - var(--sb-strip-h, 30px) - var(--sb-${side}-bottom, 0px));`
	);
}
