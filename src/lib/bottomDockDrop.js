import { isHeaderDrag } from './windowGrip';
import { armDockMode, activateDock, DOCK_FAMILY } from './bottomDock';
import { groupOfKey, headerTargetAt } from './windowTabs';
import { dockAtStrip } from './dockMenu';

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
 * whole point of it: only a DOCK_FAMILY panel can become a tab, so yielding the band
 * for anything else surrenders the bottom of BOTH side edges to a dock that was never
 * going to accept the window — the drop then does nothing at all. The object list is
 * exactly that case; it edge-docks and can never be a tab (measured: without the key
 * test, 2 of 3 `docking` runs went red on a right-edge drop that lands low, green on
 * base).
 * @param {string} key @param {number} y @param {number=} x 41 G7: with x, the tab strip counts too
 */
export function bottomDockWouldTake(key, y, x) {
	if (!DOCK_FAMILY.includes(key)) return false;
	return inBottomBand(y) || (typeof x === 'number' && !!dockStripTarget(x, y));
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
	if (!tabs.length) return null;
	const scroller = row.querySelector('.dt-scroll')?.getBoundingClientRect() ?? r;
	// each tab with its own ✕ is one slot — the caret goes between slots, never inside one
	const slots = tabs.map((t) => (t.closest('.tp-dtab-group') ?? t).getBoundingClientRect());
	const keys = tabs.map((t) => /** @type {HTMLElement} */ (t).dataset.dockTab ?? '');
	const index = slots.filter((s) => x > s.left + s.width / 2).length;
	const raw = index < slots.length ? slots[index].left - 1 : slots[slots.length - 1].right + 1;
	const caretX = Math.min(Math.max(raw, scroller.left + 1), scroller.right - 1);
	return { index, before: keys[index] ?? null, caretX, top: r.top, height: r.height };
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

/** @type {any} */ let zoneEl = null;
/** @param {boolean} on */
function showZone(on) {
	if (!on) {
		zoneEl?.remove();
		zoneEl = null;
		return;
	}
	if (!zoneEl) {
		zoneEl = document.createElement('div');
		zoneEl.id = 'bottom-dock-zone';
		zoneEl.style.cssText =
			'position:fixed;left:0;right:0;bottom:0;z-index:calc(var(--z-chrome) - 1);pointer-events:none;background:rgb(37 99 235 / .25);border:2px dashed rgb(96 165 250 / .8);';
		document.body.appendChild(zoneEl);
	}
	zoneEl.style.height = EDGE + 'px';
}

// touch: the same stance docking.js takes. A band drag has no hover feedback to read
// and fights touch scrolling, and on a coarse pointer a DOCK_FAMILY panel is forced
// docked anyway unless the user opted into `mobileUndockAllowed` — so the window this
// would act on usually does not exist. The header's "⇩ Dock" button stays the touch path.
const isCoarse = () =>
	typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

/**
 * svelte action: dragging this floating window's header into the bottom band docks it.
 * @param {any} node @param {{key: string}} options `key` is the DOCK key, which is ALSO
 *   windowTabs' key — this note used to record that Flow Code was 'flowcode' here and
 *   'flowCode' there, and that divergence was not a quirk but a defect: both
 *   `groupOfKey` and `headerTargetAt` below are handed this key, so under the old
 *   spelling the group guard never fired and the hit test never excluded FlowCode's own
 *   header — which, since a header drag keeps the pointer on that very header, meant
 *   `wants()` was false on every move and Flow Code could not be docked by drag at all.
 */
export function bottomDockable(node, { key }) {
	if (isCoarse() || !DOCK_FAMILY.includes(key)) return { destroy() {} };

	let dragging = false;
	// THE VERDICT IS TAKEN ON THE LAST MOVE, NEVER RE-DERIVED AT THE DROP. Three modules
	// listen for the same `pointerup` on `window`, and windowTabs registers first — so by
	// the time this handler runs, a merge has already hidden the very window the header
	// test was going to find, and re-asking would answer "no header here" and dock on top
	// of a merge that just happened (measured: the pair merged AND the dragged window
	// docked, dissolving the group again). Deciding from the last move also makes the drop
	// agree with the feedback the user was looking at, which is the honest contract.
	/** @type {null | {strip: ReturnType<typeof dockStripTarget>} | {band: true}} */
	let armed = null;
	/** @param {any} e */
	const down = (e) => {
		if (!isHeaderDrag(e.target) || e.button !== 0) return; // 36 F4: not on a header control
		if (node.dataset?.docked) return; // edge-docked: docking.js's own drag undocks it first
		if (groupOfKey(key)) return; // a tab group drags as one (TabStrips docks a group)
		dragging = true;
		armed = null;
	};
	/** PRECEDENCE, and it is the whole design: a header-merge target WINS, because it is
	 * the smaller and more specific target — a window header you are pointing at is a
	 * deliberate aim. Then the docked TAB STRIP (41 G7: the caret, at an index), then the
	 * bottom edge band. docking.js's left/right edges LOSE to both, which it enforces on its
	 * own side by asking `bottomDockWouldTake`, so the bottom-left corner docks to the bottom
	 * rather than to both at once.
	 * @param {any} e */
	const verdict = (e) => {
		if (headerTargetAt(e.clientX, e.clientY, key)) return null;
		const strip = dockStripTarget(e.clientX, e.clientY);
		if (strip) return { strip };
		return inBottomBand(e.clientY) ? /** @type {{band: true}} */ ({ band: true }) : null;
	};
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		armed = verdict(e);
		const strip = armed && 'strip' in armed ? armed.strip : null;
		showDockCaret(strip);
		ghostWindows([node], !!strip);
		showZone(!!armed && 'band' in armed);
	};
	const up = () => {
		if (!dragging) return;
		const take = armed;
		dragging = false;
		armed = null;
		showZone(false);
		clearStripFeedback();
		if (!take) return;
		if ('strip' in take && take.strip) {
			dockAtStrip([key], take.strip.before);
			return;
		}
		armDockMode(key, true);
		activateDock(key);
	};
	const cancel = () => {
		dragging = false;
		armed = null;
		showZone(false);
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
			if (dragging) cancel();
		}
	};
}
