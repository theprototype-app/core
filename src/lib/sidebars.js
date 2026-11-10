import { writable, readable, derived, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { inspectorClose, inspectorKind, connectDocked, connectBarHeight, setInspectorFocuser } from '../stores/appStore';
import { onLayoutRestore } from './uiLayoutsCore';
import { scaledPx, uiScale, cssPx } from './uiScale'; // 53 A1: the default + minimum width follow the UI scale
import { dockHeight, bottomInset } from './bottomDock'; // dock-fixes A: the free-space rule reads the dock's height
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
//                                 gives way to (an unpinned column stops above the dock)
//   --sb-free-left / -right       dock-fixes (owner 2026-11-08) — THE FREE VIEWPORT RECT: how far from
//                                 each edge the room between the OPEN columns starts, pinned or not
//                                 (the left one includes the menu inset). Every floating overlay —
//                                 the corner stacks (+, AI, mic, chat), the bottom toolbar's track, the
//                                 sim transport, a placed cluster — is laid out inside it, never over
//                                 a column ("never covered, never covering")
//   --sb-free-top-left / -right   the same for the TOP ROW (logo row: the top-right group, the
//                                 profile): only a column that reaches that row counts — a pinned one,
//                                 or the right one tucked under a docked Connect bar; an unpinned
//                                 column under a floating pill starts below the row
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

/**
 * dock-fixes A' (owner 2026-11-08, correction): the sides the FREE-SPACE RULE took off screen. Growing the bottom
 * dock is the point, so the dock is never clamped; instead an UNPINNED column whose room under its strip drops below
 * MIN_COLUMN_H collapses to its show button and comes back by itself when the room returns. Across the screen the
 * same: when both columns together would leave less than MIN_FREE_W of viewport (the unfolded phone), the side opened
 * EARLIER collapses and comes back when there is room again. Nothing here is persisted or touches a side's mode, tabs
 * or width — it is a mask over `sidebarWanted`.
 * @type {import('svelte/store').Writable<Record<Side, boolean>>}
 */
export const sidebarAutoHidden = writable({ left: false, right: false });

/** the tab in front on each side (null = the side is empty, or 44 M7: hidden) */
// dock-fixes A': an auto-hidden side draws NO member either (device lab UI-3 again: the right column's strip went,
// the Inspector stayed, full height over the top-right group) — the same path a hidden mode takes
export const sidebarShown = derived([sidebarTabs, mru, sidebarMode, sidebarAutoHidden], ([$tabs, $mru, $mode, $auto]) => {
	/** @type {Record<Side, string|null>} */
	const out = { left: null, right: null };
	for (const side of SIDES) {
		const tabs = $tabs[side];
		if (!tabs.length || $mode[side] === 'hidden' || $auto[side]) continue;
		out[side] = $mru[side].find((k) => tabs.includes(k)) ?? tabs[0];
	}
	return out;
});

/**
 * 44 M7 — is each side's column on screen: not hidden, and holding a tab or kept open empty.
 * @type {import('svelte/store').Readable<Record<Side, boolean>>}
 */
export const sidebarWanted = derived([sidebarTabs, sidebarMode], ([$tabs, $mode]) => ({
	left: $mode.left !== 'hidden' && ($tabs.left.length > 0 || $mode.left === 'open'),
	right: $mode.right !== 'hidden' && ($tabs.right.length > 0 || $mode.right === 'open')
}));

/**
 * 44 M7 — is each side's column on screen: not hidden, holding a tab or kept open empty, and (dock-fixes A') not
 * collapsed by the free-space rule.
 * @type {import('svelte/store').Readable<Record<Side, boolean>>}
 */
export const sidebarVisible = derived([sidebarWanted, sidebarAutoHidden], ([$w, $a]) => ({
	left: $w.left && !$a.left,
	right: $w.right && !$a.right
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
	// dock-fixes A': an explicit SHOW of a side the free-space rule collapsed wins — it becomes the newest side (the
	// other one gives way across the screen) and, when the dock left it no room, the dock gives the room back
	if (show && get(sidebarAutoHidden)[side]) {
		latestSide = side;
		makeRoomFor(side);
		autoHideTick();
	}
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

/**
 * dock-fixes (owner 2026-11-08) — the OPPOSITE of `keepSideOpen`, for a toolbar button / shortcut that
 * HIDES a panel ("click the AI assistant button again: … the sidebar does not collapse when it was the
 * only tab"). A button press is "put this away", not "empty this column for something else", so when
 * `key` is its side's last tab the column goes with it, even one the user once kept open empty (44 M7's
 * 'open' is dropped back to 'auto'). Its tabs, order and width are untouched.
 * @param {string} key
 */
export function collapseSideIfLast(key) {
	const m = get(members)[key];
	if (!m || !m.present) return;
	const tabs = get(sidebarTabs)[m.side];
	if (tabs.length === 1 && tabs[0] === key && get(sidebarMode)[m.side] === 'open') setMode(m.side, 'auto');
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
	// showhide-v8: the Inspector's two tabs share one element, so they move together
	if (isInspectorKey(key)) inspectorSide.set(side);
	else if (!dockMover?.(key, side)) return false;
	activateSidebarTab(key);
	return true;
}

// ---- the Inspector is a member -----------------------------------------------------------------

// ---- showhide-v8 (owner 2026-11-09, R2): Properties and Configure Scene are TWO TABS -----------------
//
// The owner's reversal: Object Properties and Configure Scene stay separate Inspector tabs that can BOTH be open at
// once, and selecting an object no longer swaps Properties in place of Configure Scene. They are two column members
// over ONE Inspector element (the phone dock's model, phoneDock.js `inspTabs`): `'inspector'` is the Properties tab
// (the selection, or a File), `'scene'` the Configure Scene tab. Both live on `inspectorSide` (one element cannot be
// drawn in two columns at once), `inspectorClose` / `inspectorKind` stay the app's truth — every caller keeps writing
// them — and this module keeps the tab set and the element in step:
//   - the Inspector OPENS with a kind  -> that kind's tab is open (and comes to the front, as a member arriving does)
//   - a tab comes to the FRONT          -> the element shows its kind
//   - the Inspector CLOSES              -> the tab that was showing closes; with the other tab still open, the
//                                          element reopens on it (a close is a tab's close, not the panel's)
// Off the wide posture (the phone shell) phoneDock owns the same two tabs; this half stands down there.

/** the Inspector's two column members: the Properties tab (selection / file) and the Configure Scene tab */
export const INSPECTOR_KEYS = ['inspector', 'scene'];
/** @param {string} key */
export const isInspectorKey = (key) => key === 'inspector' || key === 'scene';
/** @param {string} kind @returns {'inspector'|'scene'} */
export const tabOfKind = (kind) => (kind === 'scene' ? 'scene' : 'inspector');

/** which Inspector tabs are open in the wide posture (LOCAL, not persisted — the Inspector's open state is not) */
export const inspectorTabs = writable({ inspector: false, scene: false });

/** the Properties tab's label (a File shows in the same tab) */
export const inspectorTabTitle = derived(inspectorKind, ($k) => ($k === 'file' ? 'File' : 'Properties'));
/** the Inspector ELEMENT's name where it is one panel of its own (a pop-out window's tab and title): it names what it
 * shows, Configure Scene included — 78-fix-547: a popped Inspector switched to the scene kept saying "Properties" */
export const inspectorPanelTitle = derived(inspectorKind, ($k) => ($k === 'scene' ? 'Configure Scene' : $k === 'file' ? 'File' : 'Properties'));
/** the label of either Inspector tab @param {string} key @param {string} kind */
export function inspectorTabLabel(key, kind) {
	if (key === 'scene') return 'Configure Scene';
	return kind === 'file' ? 'File' : 'Properties';
}

/** the kind last shown in the Properties tab (a File stays a File when its tab comes back to the front) */
let propsKind = /** @type {'selection'|'file'} */ ('selection');
/** writes this module makes to the Inspector stores, so its own listener does not answer them */
let insOurs = 0;
/** @param {() => void} fn */
function insQuietly(fn) {
	insOurs++;
	try {
		fn();
	} finally {
		queueMicrotask(() => insOurs--);
	}
}
/** the pending "was that a close or a switch?" check (showSidebar closes + reopens across a 50 ms timer) */
let closeTimer = /** @type {any} */ (0);

/** the element shows `key`'s kind @param {'inspector'|'scene'} key */
function showInspectorKind(key) {
	const want = key === 'scene' ? 'scene' : propsKind;
	if (!get(inspectorClose) && get(inspectorKind) === want) return;
	insQuietly(() => {
		inspectorKind.set(/** @type {any} */ (want));
		inspectorClose.set(false);
	});
}

/**
 * Close ONE Inspector tab (its ×, Close in its menu, Close others). The other tab, when open, keeps the element.
 * @param {'inspector'|'scene'} key
 */
export function closeInspectorTab(key) {
	const tabs = get(inspectorTabs);
	if (!tabs[key]) return;
	const other = key === 'scene' ? 'inspector' : 'scene';
	const showing = !get(inspectorClose) && tabOfKind(get(inspectorKind)) === key;
	inspectorTabs.set({ ...tabs, [key]: false });
	if (!showing) return;
	if (tabs[other]) showInspectorKind(other);
	else insQuietly(() => inspectorClose.set(true));
}

/**
 * Open an Inspector tab WITHOUT bringing it to the front (a pinned Properties tab following the selection while
 * Configure Scene is in front: "selecting fills an open Properties tab, it does not replace another tab").
 * @param {'inspector'|'scene'} key
 */
export function addInspectorTabQuietly(key) {
	if (get(inspectorTabs)[key]) return;
	const side = get(inspectorSide);
	const front = get(sidebarShown)[side];
	inspectorTabs.update((t) => ({ ...t, [key]: true }));
	// a member arriving comes to the front (reportMember): put the front tab back where it was
	if (front && front !== key) activateSidebarTab(front);
}

/** the app opened / switched / closed the Inspector (wide posture only) @param {boolean} closed @param {string} kind */
function onInspector(closed, kind) {
	if (insOurs || !get(sidebarsWide)) return;
	clearTimeout(closeTimer);
	if (!closed) {
		const key = tabOfKind(kind);
		if (key === 'inspector') propsKind = kind === 'file' ? 'file' : 'selection';
		const tabs = get(inspectorTabs);
		if (!tabs[key]) inspectorTabs.set({ ...tabs, [key]: true });
		else activateSidebarTab(key); // an open of a covered tab brings it forward (the old one-member arrival)
		return;
	}
	// a close: wait out showSidebar's close-then-reopen (a switch), then close the tab that was showing
	const was = tabOfKind(kind);
	const other = was === 'scene' ? 'inspector' : 'scene';
	const settle = () => {
		if (!get(inspectorClose)) return;
		const tabs = get(inspectorTabs);
		if (tabs[other] && !get(panelAway).inspector) {
			inspectorTabs.set({ ...tabs, [was]: false });
			showInspectorKind(other);
		} else if (tabs.inspector || tabs.scene) inspectorTabs.set({ inspector: false, scene: false });
	};
	// 78-fix-547: with no other Inspector tab to fall back to, the column closes AT ONCE — waiting the 80 ms left an
	// empty column on screen for five frames and the top clusters and the profile jumped after it (controls-clusters
	// N3: they move with the column, never after it). A switch only waits when the other tab can take the element.
	const tabs = get(inspectorTabs);
	if (!(tabs[other] && !get(panelAway).inspector)) return settle();
	closeTimer = setTimeout(settle, 80);
}

let wired = false;
/** wire the Inspector's membership + the CSS bus (once, from the always-mounted editor chrome) */
export function startSidebars() {
	if (wired || typeof document === 'undefined') return;
	wired = true;
	// showhide-v8: seed the tab set from an Inspector already open at boot
	if (!get(inspectorClose)) inspectorTabs.set({ inspector: get(inspectorKind) !== 'scene', scene: get(inspectorKind) === 'scene' });
	derived([inspectorClose, inspectorKind], (x) => x).subscribe(([closed, kind]) => onInspector(closed, kind));
	// back from the phone posture (phoneDock owned the tabs there): the column's tabs follow the Inspector as it is now
	sidebarsWide.subscribe((wide) => {
		if (!wide) return;
		const closed = get(inspectorClose);
		const key = tabOfKind(get(inspectorKind));
		const tabs = get(inspectorTabs);
		if (closed && (tabs.inspector || tabs.scene)) inspectorTabs.set({ inspector: false, scene: false });
		else if (!closed && !tabs[key]) inspectorTabs.set({ ...tabs, [key]: true });
	});
	// 70 W2: an Inspector in a pop-out window is no column member (it keeps its side for coming back)
	derived([inspectorTabs, inspectorSide, panelAway], (x) => x).subscribe(([tabs, side, away]) => {
		reportMember('inspector', side, tabs.inspector && !away.inspector);
		reportMember('scene', side, tabs.scene && !away.inspector);
	});
	// a tab brought to the front shows its kind in the one element
	sidebarShown.subscribe((shown) => {
		const key = shown[get(inspectorSide)];
		if (key && isInspectorKey(key) && get(inspectorTabs)[/** @type {'inspector'|'scene'} */ (key)]) showInspectorKind(/** @type {any} */ (key));
	});
	// an explicit open of an Inspector that is already open (Configure Scene, double-click,
	// a deep link) brings its tab to the front of the column
	setInspectorFocuser(() => {
		const key = tabOfKind(get(inspectorKind));
		const covered = sidebarTabCovered(key);
		activateSidebarTab(key);
		return covered;
	});
	geometry.subscribe(publish);
	// dock-fixes A': the newest side wins across the screen; the free-space rule re-runs on every change of the wanted
	// sides, their widths / pins, the dock's height and the window size (geometry carries the last two families)
	/** @type {Record<Side, boolean>} */
	let wasWanted = { left: false, right: false };
	sidebarWanted.subscribe((w) => {
		for (const side of SIDES) if (w[side] && !wasWanted[side]) latestSide = side;
		wasWanted = w;
	});
	derived([sidebarWanted, sidebarFull, sidebarWidth, bottomInset, connectDocked, connectBarHeight, resizeTick, sidebarsWide, uiScale], (x) => x).subscribe(() =>
		requestAnimationFrame(autoHideTick)
	);
	window.addEventListener('resize', () => {
		resizeTick.update((n) => n + 1);
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

const resizeTick = writable(0);

// dock-fixes B (owner 2026-11-08, shot 5): the open main menu OVERLAYS the left column (it sits on --z-popover,
// above every sidebar) and never relayouts it. An unpinned column used to start past the open menu
// (dock-sidebar-inset), which shoved a left-docked Configure Scene sideways over the right column on the unfolded
// phone; a PINNED column keeps its edge and the logo + menu move inward beside it (--sb-dock-left), unchanged.
export const geometry = derived(
	// 53 A1: `uiScale` is a dependency only so the column's top re-derives with the scale
	[sidebarShown, sidebarFull, sidebarWidth, connectDocked, connectBarHeight, resizeTick, sidebarsWide, sidebarVisible, uiScale],
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
		const leftX = 0;
		return {
			left,
			right,
			wide: $wide,
			leftX,
			dockLeft: $wide && left.visible && left.full ? left.w : 0,
			dockRight: $wide && right.visible && right.full ? right.w : 0,
			// dock-fixes: the free viewport rect (see the bus above) — every OPEN column, pinned or not
			freeLeft: $wide && left.visible ? leftX + left.w : 0,
			freeRight: $wide && right.visible ? right.w : 0,
			freeTopLeft: $wide && left.visible && left.full ? left.w : 0,
			freeTopRight: $wide && right.visible && (right.full || !!$cDocked) ? right.w : 0
		};
	}
);

/** the least height an UNPINNED open column keeps under its tab strip (design px, scaled) */
export const MIN_COLUMN_H = 240;
/** the least viewport width both columns together leave free (design px, scaled) */
export const MIN_FREE_W = 300;

/** the side opened most recently (it wins when both do not fit) @type {Side} */
let latestSide = 'right';

/** room under an unpinned column's strip for the dock's current height, or Infinity for a pinned one @param {Side} side */
function columnRoom(side) {
	const g = get(geometry);
	if (g[side].full) return Infinity;
	const controls = cssPx(getComputedStyle(document.documentElement).getPropertyValue('--controls-inset')) || 0;
	return window.innerHeight - g[side].top - scaledPx(STRIP_H) - controls - (get(bottomInset) || 0);
}

/** dock-fixes A': the free-space rule (see `sidebarAutoHidden`) */
function autoHideTick() {
	if (typeof window === 'undefined') return;
	const want = get(sidebarWanted);
	const next = { left: false, right: false };
	if (get(sidebarsWide) && !document.documentElement.dataset.focus) {
		for (const side of SIDES) if (want[side] && columnRoom(side) < scaledPx(MIN_COLUMN_H)) next[side] = true;
		const w = get(sidebarWidth);
		if (want.left && want.right && !next.left && !next.right && window.innerWidth - w.left - w.right < scaledPx(MIN_FREE_W)) {
			next[latestSide === 'left' ? 'right' : 'left'] = true;
		}
	}
	const cur = get(sidebarAutoHidden);
	if (cur.left !== next.left || cur.right !== next.right) sidebarAutoHidden.set(next);
}

/** an explicit show of a column the dock left no room for: the dock shrinks just enough @param {Side} side */
function makeRoomFor(side) {
	const short = scaledPx(MIN_COLUMN_H) - columnRoom(side);
	if (short <= 0) return;
	const h = get(dockHeight);
	dockHeight.set(Math.max(scaledPx(160), Math.round(h - short)));
}

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
	root.setProperty('--sb-free-left', g.freeLeft + 'px');
	root.setProperty('--sb-free-right', g.freeRight + 'px');
	root.setProperty('--sb-free-top-left', g.freeTopLeft + 'px');
	root.setProperty('--sb-free-top-right', g.freeTopRight + 'px');
	// dock-fixes: the free width between the columns is a PHONE's (<= 600 px, ui.css's breakpoint for the corner
	// stacks): the stacks lift above the toolbar's row as they do on a narrow screen, so the bar gets the whole free
	// width to fold into instead of three clusters sharing one row (the unfolded N6 with both columns open)
	const freeW = typeof window !== 'undefined' ? window.innerWidth - g.freeLeft - g.freeRight : 1e4;
	document.documentElement.classList.toggle('sb-free-narrow', !!g.wide && !!(g.freeLeft || g.freeRight) && freeW <= 600);
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
		`height: calc(100vh - var(--sb-${side}-top, 64px) - var(--sb-strip-h, 30px) - var(--sb-${side}-bottom, 0px)); ` +
		// ui-audit-honor: the VISIBLE viewport where supported (a later declaration wins; 100vh is the fallback) —
		// on Android Chrome 100vh ignores the URL bar and the column ran off the bottom
		`height: calc(100dvh - var(--sb-${side}-top, 64px) - var(--sb-strip-h, 30px) - var(--sb-${side}-bottom, 0px));`
	);
}
