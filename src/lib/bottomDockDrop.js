import { isHeaderDrag } from './windowGrip';
import { get } from 'svelte/store';
import { armDockMode, activateDock, canDockFloating, dockSplitView } from './bottomDock';
import { groupOfKey, headerTargetAt } from './windowTabs';
import { dockAtStrip, dockIntoPane, canDockHere, moveToSidebar, canMoveToSidebar } from './dockMenu';
import { windowDropTarget, windowDropZoneId, showDropTarget } from './sidebarDrop';
import { placeFree, watchPlaceFree, placeFreeHint, showPlaceFreeChip } from './placeFree';
import { PHONE_QUERY } from './ui/phoneShell.js';
import { isForeign } from './windows/winEnv.js';

// W7 — DRAG A FLOATING PANEL INTO THE BOTTOM DOCK.
//
// The header's "⇩ Dock" button was the only way in; this is the gesture half, and it is
// the mirror of the tab strip's drag-a-tab-OUT.
//
// WHY THIS IS NOT IN docking.js, which already owns "drag a window near an edge and
// dock it". Two reasons, and the first is decisive: `use:dockable` is wired on exactly
// THREE windows (flow, explorer, objects) and only two of those are dock tabs — so
// teaching it a bottom edge would reach the Node editor and the Explorer and miss Flow
// Code, Animation, the UV editor and the HUD editor entirely. Wiring `dockable` onto
// those four to fix that would hand them LEFT/RIGHT edge docking as a side effect: a
// whole capability nobody asked for, with its own persisted `dockedWindows` entry and
// its in-memory-only `prevRect`. The second reason is that the two docks are different
// models — an edge dock re-poses the window node itself and remembers where it came
// from, while the bottom dock asks the PANEL to re-render as a tab through
// `armDockMode` and never touches the node. Sharing one module would mean one hit test
// wrapped around two unrelated bodies.
//
// What IS shared is the vocabulary: the same 44px reach, the same "highlight the target
// while you are over it", the same coarse-pointer stand-down.

const EDGE = 44; // mirrors docking.js — the reach of an edge drop

/**
 * THE BAND: a 44px strip along the bottom SCREEN EDGE — the same reach docking.js gives the
 * left/right edges. Whole-width, because the dock is `inset-x-0`.
 *
 * 41 G7: it used to be the open dock's WHOLE RECT, so a floating window could not be moved
 * over the dock at all without docking on release, and dropping there always appended. The
 * aimed target is the docked TAB STRIP now (`dockStripTarget`: a caret between the tabs, the
 * drop lands at that index); the edge band stays as the coarse "put it in the dock" reach and
 * is the only target while the dock is empty or minimized (there is no strip to aim at).
 * @param {number} y @returns {boolean}
 */
export function inBottomBand(y) {
	if (typeof window === 'undefined') return false;
	return y >= window.innerHeight - EDGE;
}

/**
 * Would the bottom dock actually TAKE a drop of `key` here? This is the question
 * docking.js must ask before standing its own edges down, and the `key` half is the
 * whole point of it: only a dockable panel can become a tab, so yielding the band
 * for anything else surrenders the bottom of BOTH side edges to a dock that was never
 * going to accept the window — the drop then does nothing at all (measured: without the key
 * test, 2 of 3 `docking` runs went red on a right-edge drop that lands low, green on
 * base). 42 I6: the object list CAN be a tab now (hosted, `canDockHere`), so its bottom
 * corners dock to the bottom like the Node editor's and the Explorer's.
 * @param {string} key @param {number} y @param {number=} x 41 G7: with x, the tab strip counts too
 */
export function bottomDockWouldTake(key, y, x) {
	if (!canDockHere(key)) return false;
	return inBottomBand(y) || (typeof x === 'number' && (!!dockStripTarget(x, y) || overEmptyDock(x, y)));
}

// ---- 41 G7: THE TAB STRIP AS A DROP TARGET ----------------------------------------------

/** how far above/below the 24px strip still counts as "on the strip" */
const STRIP_REACH = 14;

/** the docked tab strip on screen (only the visible docked panel's strip has a box) */
function visibleStripRow() {
	if (typeof document === 'undefined') return null;
	for (const row of document.querySelectorAll('.dt-row')) {
		const r = row.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return /** @type {HTMLElement} */ (row);
	}
	return null;
}

/**
 * The insertion point on the docked tab strip under (x, y), or null when the point is not
 * on the strip (or no docked panel is showing). `index` counts the present tabs to its left;
 * `before` is the tab the drop lands in front of (null = after the last one); `caretX` is
 * where the caret is drawn, in viewport px.
 * @param {number} x @param {number} y
 * @returns {{index: number, before: string|null, caretX: number, top: number, height: number}|null}
 */
export function dockStripTarget(x, y) {
	const row = visibleStripRow();
	if (!row) return null;
	const r = row.getBoundingClientRect();
	if (x < r.left || x > r.right || y < r.top - STRIP_REACH || y > r.bottom + STRIP_REACH) return null;
	const tabs = [...row.querySelectorAll('[data-dock-tab]')];
	const scroller = row.querySelector('.dt-scroll')?.getBoundingClientRect() ?? r;
	// 44 M5: the EMPTY dock's strip (only its "+") takes a drop too — the caret at its start
	if (!tabs.length) return { index: 0, before: null, caretX: Math.round(scroller.left + 2), top: r.top, height: r.height };
	// each tab with its own ✕ is one slot — the caret goes between slots, never inside one
	const slots = tabs.map((t) => (t.closest('.tp-dtab-group') ?? t).getBoundingClientRect());
	const keys = tabs.map((t) => /** @type {HTMLElement} */ (t).dataset.dockTab ?? '');
	const index = slots.filter((s) => x > s.left + s.width / 2).length;
	const raw = index < slots.length ? slots[index].left - 1 : slots[slots.length - 1].right + 1;
	const caretX = Math.min(Math.max(raw, scroller.left + 1), scroller.right - 1);
	return { index, before: keys[index] ?? null, caretX, top: r.top, height: r.height };
}

/**
 * 44 M5 — over the EMPTY dock's body ("Press + or drag a tab here")? The whole frame is a target
 * there, the way the edge band is: there is no strip of tabs to aim between.
 * @param {number} x @param {number} y
 */
export function overEmptyDock(x, y) {
	if (typeof document === 'undefined') return false;
	const frame = document.querySelector('#phone-dock[data-dock-empty]');
	if (!frame) return false;
	const r = frame.getBoundingClientRect();
	return r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * 48 F5 — the PANE of the split on screen under (x, y): a floating window (or a tab pulled out of the strip) dropped
 * there shows IN it. `pair` names the pair by its left member; `rect` is the pane's box (the highlight).
 * @param {number} x @param {number} y
 * @returns {{pair: string, pane: 'a'|'b', rect: {x: number, y: number, w: number, h: number}}|null}
 */
export function dockPaneAt(x, y) {
	if (typeof document === 'undefined') return null;
	const split = get(dockSplitView);
	if (!split) return null;
	const SEL = '[data-dock-pane], [data-pd-host-pane]';
	const hit = document.elementsFromPoint(x, y).find((n) => n.closest?.(SEL));
	const host = /** @type {HTMLElement|undefined} */ (hit?.closest?.(SEL));
	const pane = host?.getAttribute('data-dock-pane') || host?.getAttribute('data-pd-host-pane');
	if (!host || (pane !== 'a' && pane !== 'b')) return null;
	const r = host.getBoundingClientRect();
	return { pair: split.a, pane, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

/** @type {HTMLElement|null} */ let caretEl = null;
/** @type {HTMLElement|null} */ let markedRow = null;
/**
 * Draw (or remove) the insertion caret on the strip, and mark the strip as the target.
 * @param {{caretX: number, top: number, height: number}|null} hit
 */
export function showDockCaret(hit) {
	if (!hit) {
		caretEl?.remove();
		caretEl = null;
		markedRow?.classList.remove('dock-drop-target');
		markedRow = null;
		return;
	}
	if (!caretEl) {
		caretEl = document.createElement('div');
		caretEl.id = 'dock-strip-caret';
		caretEl.className = 'dock-strip-caret';
		caretEl.setAttribute('aria-hidden', 'true');
		document.body.appendChild(caretEl);
	}
	caretEl.style.left = Math.round(hit.caretX - 1) + 'px';
	caretEl.style.top = Math.round(hit.top - 3) + 'px';
	caretEl.style.height = Math.round(hit.height + 6) + 'px';
	const row = visibleStripRow();
	if (row !== markedRow) {
		markedRow?.classList.remove('dock-drop-target');
		markedRow = row;
		markedRow?.classList.add('dock-drop-target');
	}
}

/** @type {Set<HTMLElement>} */ const ghosts = new Set();
/**
 * 41 G7: the dragged window turns see-through while it hovers the strip, so the caret and
 * the tabs under it stay readable.
 * @param {(HTMLElement|null|undefined)[]} nodes @param {boolean} on
 */
export function ghostWindows(nodes, on) {
	if (!on) {
		for (const n of ghosts) n.classList.remove('dock-drag-ghost');
		ghosts.clear();
		return;
	}
	for (const n of nodes) {
		if (!n || ghosts.has(n)) continue;
		n.classList.add('dock-drag-ghost');
		ghosts.add(n);
	}
}

/** end every piece of strip feedback (a drop, a cancel, a drag leaving the strip) */
export function clearStripFeedback() {
	showDockCaret(null);
	ghostWindows([], false);
}

// touch: since 44 M2 a touch screen wider than a phone (the unfolded N6) gets every target a mouse
// does — the window claims its own touch gesture (windows.css `[data-body-drag]`), so a drag no longer
// fights a pan. A PHONE keeps the old stance: its floating windows are bottom sheets and the dock hosts
// its own content tabs. Asked per gesture, since a window outlives a fold.
const onPhone = () => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;

/**
 * svelte action: a floating window dragged by its header (or its body, 44 M1) docks where it is
 * dropped — the bottom dock's tab strip or bottom band, or (43 J4/44 M3) a sidebar column — through
 * the ONE drop model ($lib/sidebarDrop `windowDropTarget`), painted by its one highlight.
 * @param {any} node @param {{key: string}} options `key` is the DOCK key, which is ALSO
 *   windowTabs' key — this note used to record that Flow Code was 'flowcode' here and
 *   'flowCode' there, and that divergence was not a quirk but a defect: both
 *   `groupOfKey` and `headerTargetAt` below are handed this key, so under the old
 *   spelling the group guard never fired and the hit test never excluded FlowCode's own
 *   header — which, since a header drag keeps the pointer on that very header, meant
 *   `wants()` was false on every move and Flow Code could not be docked by drag at all.
 */
export function bottomDockable(node, { key }) {
	// 70 W2: a panel in a pop-out window ($lib/windows/panelHost) is laid out by its window, not here
	if (isForeign(node)) return { destroy() {} };
	// 43 J4: every window that can be a bottom-dock tab can be a SIDEBAR tab too — docking.js's edge
	// action rides along (its registry, a persisted side, and dragging a side-docked window back out)
	const side = canDockFloating(key) ? (sideDockable?.(node, { key }) ?? null) : null;
	node.dataset.windowKey = key; // 44 M3: the header menu acts on this window by its dock key
	if (!canDockFloating(key)) return { destroy: () => side?.destroy() };

	let dragging = false;
	// THE VERDICT IS TAKEN ON THE LAST MOVE, NEVER RE-DERIVED AT THE DROP. Three modules
	// listen for the same `pointerup` on `window`, and windowTabs registers first — so by
	// the time this handler runs, a merge has already hidden the very window the header
	// test was going to find, and re-asking would answer "no header here" and dock on top
	// of a merge that just happened (measured: the pair merged AND the dragged window
	// docked, dissolving the group again). Deciding from the last move also makes the drop
	// agree with the feedback the user was looking at, which is the honest contract.
	/** @type {import('./sidebarDrop').DropTarget|null} */
	let armed = null;
	let ghosted = false;
	/** 45 N7: what the window WOULD dock into at the last move (Ctrl held or not), and where */
	/** @type {import('./sidebarDrop').DropTarget|null} */
	let would = null;
	let at = { x: 0, y: 0 };
	/** @type {(() => void) | null} */
	let unwatch = null;
	/** 45 N7: the key pressed or released with the pointer still flips the target at once */
	const onFree = () => {
		if (!dragging) return;
		armed = placeFree() ? null : would;
		paint(armed);
	};
	/** @param {any} e */
	const down = (e) => {
		if (!isHeaderDrag(e.target) || e.button !== 0) return; // 36 F4: not on a header control
		if (node.dataset?.docked) return; // side-docked: docking.js's own drag undocks it first
		if (groupOfKey(key)) return; // a tab group drags as one (TabStrips)
		if (onPhone()) return;
		dragging = true;
		armed = null;
		would = null;
		unwatch?.();
		unwatch = watchPlaceFree(onFree);
	};
	/** PRECEDENCE: a header-merge target WINS, because it is the smaller and more specific
	 * target — a window header you are pointing at is a deliberate aim. Then the one drop model:
	 * the docked tab strip (41 G7's caret, at an index), the bottom edge band, a sidebar.
	 * @param {any} e */
	const verdict = (e) => {
		at = { x: e.clientX, y: e.clientY };
		would = headerTargetAt(e.clientX, e.clientY, key)
			? null
			: windowDropTarget({ x: e.clientX, y: e.clientY, key, canDock: canDockHere(key), canSide: canSideHere(key) });
		// 45 N7: Ctrl (Cmd) held = every target stands down — the window is placed where it is dropped
		return placeFree(e) ? null : would;
	};
	/** @param {import('./sidebarDrop').DropTarget|null} t */
	const paint = (t) => {
		showDropTarget(t, { id: windowDropZoneId(t), hint: placeFreeHint() });
		showPlaceFreeChip(dragging && !t && would && placeFree() ? at : null);
		// the window goes see-through over a strip, a column or (48 F5) a pane, so the target under it reads (41 G7)
		const ghost = !!t && (t.kind === 'side' || (t.kind === 'dock' && (!!t.strip || !!t.pane)));
		if (ghost || ghosted) ghostWindows([node], ghost);
		ghosted = ghost;
	};
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		armed = verdict(e);
		paint(armed);
	};
	const up = () => {
		if (!dragging) return;
		const take = armed;
		dragging = false;
		armed = null;
		unwatch?.();
		unwatch = null;
		paint(null);
		clearStripFeedback();
		if (!take) return;
		if (take.kind === 'side') {
			moveToSidebar(key, take.side);
			return;
		}
		if (take.kind !== 'dock') return;
		if (take.pane) {
			dockIntoPane(key, take.pane);
			return;
		}
		if (take.strip) {
			dockAtStrip([key], take.strip.before);
			return;
		}
		armDockMode(key, true);
		activateDock(key);
	};
	const cancel = () => {
		if (!dragging) return;
		dragging = false;
		armed = null;
		unwatch?.();
		unwatch = null;
		paint(null);
		clearStripFeedback();
	};
	node.addEventListener('pointerdown', down);
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
	window.addEventListener('pointercancel', cancel);

	return {
		destroy() {
			node.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			cancel();
			side?.destroy();
		}
	};
}

/** can this window join a sidebar column here? (any dockable window, wider than a phone — docking.js
 * registers the mover) @param {string} key */
export function canSideHere(key) {
	return canDockFloating(key) && !onPhone() && canMoveToSidebar();
}

/**
 * 43 J4 — docking.js's edge-dock action, registered here at its module load (it imports this
 * module, so the seam runs this way round): `bottomDockable` wires it on every window it wires.
 * @type {((node: any, opts: {key: string}) => {destroy(): void}) | null}
 */
let sideDockable = null;
/** @param {((node: any, opts: {key: string}) => {destroy(): void}) | null} fn */
export function setSideDockable(fn) {
	sideDockable = fn;
}
