import { get } from 'svelte/store';
import { isHeaderDrag } from './windowGrip';
import { setSideDockable } from './bottomDockDrop';
import { safeStorage } from './safeStorage';
import { onLayoutRestore } from './uiLayoutsCore';
import { reportMember, sidebarShown, setDockMover, activateSidebarTab } from './sidebars';
import { canDockFloating, armDockMode, dockOccupants, forgetDockTab, HOSTED_DOCK_TABS } from './bottomDock';
import { hostedDocked, setHostedDocked } from './dockHost';
import { registerSideMover } from './dockMenu';
import { groupOfKey, removeFromGroup } from './windowTabs';
import { phoneShell } from './ui/phoneShell.js';
import { isForeign } from './windows/winEnv.js';

// Docking lite (phase 81L). Drag a window near the left/right screen edge to dock it as a
// full-height panel (--z-chrome tier); drag its header away to float it again.
// 21-H2: the Library drawer it also used to give way to no longer exists.
//
// 42 I3 — ONE SIDEBAR PER SIDE ($lib/sidebars). An edge is ONE column and every window docked
// to it is a TAB of that column, beside the Inspector when it docks to the same side: only the
// tab in front renders (`data-sidebar-hidden` on the others), the column's tab header + resize
// grip are SidebarStrips.svelte's, and the column's geometry is the `--sb-*` CSS bus. This
// RETIRES two older shapes, both of which put two things on screen where the user asked for
// one: 81.4's vertical SPLIT (a second window on an edge stacked under the first, with a
// divider) and the right-docked window that slid inward as a SECOND COLUMN while the
// Inspector was open. Dropping a window on an occupied edge (or on the column itself) now adds
// a tab; a stored 81.4 pair restores as two tabs, and its old `dockSplit:<side>` share is
// simply no longer read.
//
// 43 J4 — ANY DOCKABLE WINDOW CAN BE A SIDEBAR TAB. `use:dockable` used to be wired on three
// windows (Objects, the Node editor, the Explorer); every window that can be a bottom-dock tab
// (FLOAT_DOCKABLE: the nine editors with a docked layout and the five hosted windows) is
// side-dockable now through ONE seam — `bottomDockable` (bottomDockDrop.js) also runs this action
// (`setSideDockable` below), so no window component had to change. A window moves between the two
// docks through `dockToSide` (out of the bottom dock first) and the sidebar tab's "Move to the
// bottom dock" (undock here, then the bottom dock's own arm). The drag feedback is the one drop
// model's ($lib/sidebarDrop), painted above every panel.
//
// 44 M2/M3 — ONE GESTURE. A floating window dragged to a side used to be decided HERE (an edge/column
// hit test of its own) while the same gesture's bottom-dock half was decided in bottomDockDrop.js, each
// painting its own highlight. Both now ask the one drop model (`windowDropTarget`) in ONE place —
// `bottomDockable`, which every dockable window wears — and a side drop lands through `dockToSide`
// (dockMenu's side mover). What stays here: the registry, a persisted side, and dragging a side-docked
// window back OUT by its header. And the touch stance moved from "a coarse pointer" to "a phone": the
// unfolded N6 is a touch screen with room for a column (the user: "floating window should be possible to
// add to a sidebar and move to dock for unfolded phone"). On a fold a side-docked window lets go of its
// column without forgetting it — the phone has no sidebars — and takes it back on the unfold.

/** @type {{left: string[], right: string[]}} */
let docked = { left: [], right: [] };
/** @type {Map<string, any>} */
const registry = new Map(); // key -> {node, prevRect, present, observer}

/** @param {any} value a persisted side: a string (pre-81.4) or an array
 * @returns {string[]} */
function sideList(value) {
	if (Array.isArray(value)) return value.filter((k) => typeof k === 'string');
	return typeof value === 'string' && value ? [value] : [];
}

try {
	const saved = JSON.parse(safeStorage.getItem('dockedWindows') ?? 'null');
	if (saved) docked = { left: sideList(saved.left), right: sideList(saved.right) };
} catch {}

function persist() {
	safeStorage.setItem('dockedWindows', JSON.stringify(docked));
}

/** @param {string} key @returns {'left'|'right'|null} */
function sideOf(key) {
	if (docked.left.includes(key)) return 'left';
	if (docked.right.includes(key)) return 'right';
	return null;
}
export { sideOf as dockSideOf };

/** the keys docked to a side, in docking order @param {'left'|'right'} side */
export function dockedOn(side) {
	return [...docked[side]];
}

function applyAll() {
	for (const [key] of registry) apply(key);
}

/** a docked window is a TAB only while it is open (the object list stays mounted and hides
 *  itself with a class when closed) @param {any} node */
const isPresent = (node) => !!node?.isConnected && !node.classList.contains('hidden');

/** @param {string} key */
function apply(key) {
	const entry = registry.get(key);
	if (!entry) return;
	const side = phoneNow ? null : sideOf(key);
	const { node } = entry;
	entry.present = isPresent(node);
	reportMember(key, side, entry.present);
	if (!side) {
		// a fold: the column it filled is gone — float where it floated before (its side is kept)
		if (node.dataset.docked && sideOf(key)) releaseNode(entry);
		delete node.dataset.docked;
		delete node.dataset.sidebarHidden;
		return;
	}
	node.dataset.docked = side;
	node.style.position = 'fixed';
	node.style.maxWidth = 'none';
	node.style.maxHeight = 'none';
	// the column's geometry is the sidebars' CSS bus: one place decides where the column is
	node.style.left = side === 'left' ? 'var(--sb-left-x, 0px)' : 'auto';
	node.style.right = side === 'right' ? '0px' : 'auto';
	node.style.top = `calc(var(--sb-${side}-top, 64px) + var(--sb-strip-h, 30px))`;
	node.style.width = `var(--sb-${side}-w, 320px)`;
	node.style.height = `calc(100vh - var(--sb-${side}-top, 64px) - var(--sb-strip-h, 30px) - var(--sb-${side}-bottom, 0px))`;
	node.style.zIndex = '30'; // z-ok: = --z-chrome; restored + compared as a number by docking/TabStrips
	// only the tab in front renders
	if (get_shown()[side] === key) delete node.dataset.sidebarHidden;
	else node.dataset.sidebarHidden = '';
}

/** the phone posture right now (no sidebars there) — declared above every subscriber that reads it */
let phoneNow = false;
/** @type {Record<'left'|'right', string|null>} */
let shownNow = { left: null, right: null };
const get_shown = () => shownNow;
sidebarShown.subscribe((v) => {
	shownNow = v;
	applyAll();
});
phoneShell.subscribe((v) => {
	if (v === phoneNow) return;
	phoneNow = v;
	applyAll();
});

/** remember where a window floated before it joins a column @param {any} entry */
function rememberFloat(entry) {
	entry.prevRect = {
		left: entry.node.style.left,
		top: entry.node.style.top,
		width: entry.node.style.width,
		height: entry.node.style.height,
		zIndex: entry.node.style.zIndex
	};
}

/** dock a window to a side, as that column's front tab @param {string} key @param {'left'|'right'} side */
function dock(key, side) {
	const entry = registry.get(key);
	if (!entry) return false;
	const from = sideOf(key);
	if (from === side) {
		activateSidebarTab(key);
		return true;
	}
	if (from) docked[from] = docked[from].filter((k) => k !== key);
	else rememberFloat(entry);
	if (!from && groupOfKey(key)) removeFromGroup(key); // a tab group member leaves it for the column
	docked[side] = [...docked[side].filter((k) => k !== key), key];
	persist();
	apply(key);
	activateSidebarTab(key);
	return true;
}

// the sidebar tab drag moves a docked window to the other side
setDockMover((key, side) => (sideOf(key) ? dock(key, side) : false));

/** is this window a bottom-dock tab right now (docked AND open there)? @param {string} key */
function inBottomDock(key) {
	if (HOSTED_DOCK_TABS.includes(key)) return !!get(hostedDocked)[key];
	return !!get(dockOccupants)[key]?.present;
}

/**
 * 43 J4 — put a window in a side's column, from wherever it is: floating (a plain dock), already on
 * a side (a move), or a BOTTOM-DOCK tab — which leaves the bottom dock first. A hosted window
 * (Objects, Statistics, …) keeps one element, so it docks the moment it leaves the bottom frame; an
 * editor re-renders its floating layout when it leaves the bottom dock (`armDockMode`), and that
 * window docks itself here as it mounts, because its side is written down FIRST (`apply` on mount).
 * @param {string} key @param {'left'|'right'} side @returns {boolean}
 */
export function dockToSide(key, side) {
	if (!canDockFloating(key) || phoneNow) return false;
	if (inBottomDock(key)) {
		if (HOSTED_DOCK_TABS.includes(key)) setHostedDocked(key, false);
		else {
			for (const s of /** @type {const} */ (['left', 'right'])) docked[s] = docked[s].filter((k) => k !== key);
			docked[side] = [...docked[side], key];
			persist();
			forgetDockTab(key);
			armDockMode(key, false);
			return true;
		}
	}
	if (registry.has(key)) return dock(key, side);
	// not mounted (closed): remembered for when it opens
	for (const s of /** @type {const} */ (['left', 'right'])) docked[s] = docked[s].filter((k) => k !== key);
	docked[side] = [...docked[side], key];
	persist();
	return true;
}
registerSideMover(dockToSide);

/**
 * 43 J4 — the size a side-docked window will float at (where it floated before it joined the
 * column), for the "Float here" highlight. null = not docked / never floated.
 * @param {string} key @returns {{w: number, h: number}|null}
 */
export function floatSizeOf(key) {
	const r = registry.get(key)?.prevRect;
	const w = parseFloat(r?.width);
	const h = parseFloat(r?.height);
	return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** @param {string} key @param {number=} x @param {number=} y */
export function undock(key, x, y) {
	const side = sideOf(key);
	if (!side) return;
	docked[side] = docked[side].filter((k) => k !== key);
	persist();
	const entry = registry.get(key);
	if (entry) {
		releaseNode(entry, x, y);
		reportMember(key, null, false);
	}
}

/** Hand a node that is no longer docked its floating geometry back.
 * @param {any} entry @param {number=} x @param {number=} y */
function releaseNode(entry, x, y) {
	const { node, prevRect } = entry;
	delete node.dataset.docked;
	delete node.dataset.sidebarHidden;
	delete node.dataset.dockSlot;
	node.style.height = prevRect?.height || '';
	node.style.width = prevRect?.width || '';
	node.style.maxWidth = '';
	node.style.maxHeight = '';
	node.style.right = '';
	node.style.zIndex = prevRect?.zIndex || '40'; // z-ok: = --z-window, read back as a number
	node.style.left = (x != null ? Math.max(0, x - 120) : parseFloat(prevRect?.left) || 200) + 'px';
	node.style.top = (y != null ? Math.max(0, y - 12) : parseFloat(prevRect?.top) || 120) + 'px';
}

// 37 R14: a named workspace layout rewrote `dockedWindows` — adopt the stored sides. A live
// window that leaves the column gets its floating geometry back (its own dragWindow re-read then
// places it); one that joins a column remembers where it floated, as a drag-dock does.
// Registered at module load, so it runs BEFORE the windows' own re-reads.
onLayoutRestore(() => {
	/** @type {{left: string[], right: string[]}} */
	let next = { left: [], right: [] };
	try {
		const saved = JSON.parse(safeStorage.getItem('dockedWindows') ?? 'null');
		if (saved) next = { left: sideList(saved.left), right: sideList(saved.right) };
	} catch {}
	const was = docked;
	docked = next;
	for (const [key, entry] of registry) {
		const before = was.left.includes(key) || was.right.includes(key);
		const now = !!sideOf(key);
		if (before && !now) {
			releaseNode(entry);
			reportMember(key, null, false);
		} else if (!before && now) rememberFloat(entry);
	}
	applyAll();
});

/**
 * svelte action: makes a floating window dockable to the screen edges.
 * @param {any} node @param {{key: string}} options
 */
export function dockable(node, { key }) {
	// 70 W2: a panel in a pop-out window ($lib/windows/panelHost) is laid out by its window, not here
	if (isForeign(node)) return { destroy() {} };
	// 43 J4: a window may be wired twice (its own `use:dockable` + bottomDockable's seam) — once is enough
	if (registry.get(key)?.node === node) return { destroy() {} };
	/** @type {any} */
	const entry = { node, prevRect: null, present: false, observer: null };
	registry.set(key, entry);
	if (sideOf(key)) rememberFloat(entry);
	apply(key); // restore a persisted dock (as a tab of its side)
	// open / closed is a class on an always-mounted window (the object list): a tab comes and goes
	// with it, and coming back brings it to the front (reportMember)
	entry.observer = new MutationObserver(() => {
		if (isPresent(node) !== entry.present) apply(key);
	});
	entry.observer.observe(node, { attributes: true, attributeFilter: ['class'] });

	/** @param {any} e */
	const down = (e) => {
		if (!isHeaderDrag(e.target) || e.button !== 0) return; // 36 F4: not on a header control
		if (!node.dataset.docked) return; // floating: bottomDockable owns the drop (44 M3)
		// docked: dragging the header away undocks and hands back to the window's own drag
		// behavior on the NEXT gesture
		e.stopImmediatePropagation();
		const startX = e.clientX;
		const startY = e.clientY;
		const moveOut = (/** @type {any} */ ev) => {
			if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 40) {
				undock(key, ev.clientX, ev.clientY);
				cleanup();
			}
		};
		const cleanup = () => {
			window.removeEventListener('pointermove', moveOut);
			window.removeEventListener('pointerup', cleanup);
			window.removeEventListener('pointercancel', cleanup);
		};
		window.addEventListener('pointermove', moveOut);
		window.addEventListener('pointerup', cleanup);
		window.addEventListener('pointercancel', cleanup);
	};
	node.addEventListener('pointerdown', down, true); // capture: beats dragWindow while docked

	return {
		destroy() {
			node.removeEventListener('pointerdown', down, true);
			entry.observer?.disconnect();
			// a member that unmounts is no longer a tab (its persisted side survives for its return) —
			// unless a fresh instance of the same window has already taken its key
			if (registry.get(key) !== entry) return;
			registry.delete(key);
			if (sideOf(key)) reportMember(key, sideOf(key), false);
		}
	};
}

// 43 J4: every bottom-dockable window is side-dockable (bottomDockDrop's seam)
setSideDockable(dockable);
