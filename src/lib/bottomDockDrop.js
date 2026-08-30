import { get } from 'svelte/store';
import { bottomInset, armDockMode, activateDock, DOCK_FAMILY } from './bottomDock';
import { groupOfKey, headerTargetAt } from './windowTabs';

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
 * THE BAND: the open dock's own rect when a panel is showing, and a 44px strip along
 * the bottom edge when the dock is empty or minimized (`bottomInset` reads 0 for both).
 * Whole-width, because the dock is `inset-x-0`.
 * @param {number} y @returns {boolean}
 */
export function inBottomBand(y) {
	if (typeof window === 'undefined') return false;
	return y >= window.innerHeight - Math.max(get(bottomInset), EDGE);
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
 * @param {string} key @param {number} y
 */
export function bottomDockWouldTake(key, y) {
	return DOCK_FAMILY.includes(key) && inBottomBand(y);
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
			'position:fixed;left:0;right:0;bottom:0;z-index:29;pointer-events:none;background:rgb(37 99 235 / .25);border:2px dashed rgb(96 165 250 / .8);';
		document.body.appendChild(zoneEl);
	}
	zoneEl.style.height = Math.max(get(bottomInset), EDGE) + 'px';
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
	let armed = false;
	/** @param {any} e */
	const down = (e) => {
		if (!e.target.closest('.move-handle') || e.button !== 0) return;
		if (node.dataset?.docked) return; // edge-docked: docking.js's own drag undocks it first
		if (groupOfKey(key)) return; // a tab group drags as one; docking one member is ambiguous
		dragging = true;
		armed = false;
	};
	/** PRECEDENCE, and it is the whole design: a header-merge target WINS, because it is
	 * the smaller and more specific target — a window header you are pointing at is a
	 * deliberate aim, while the band is a whole strip of screen. docking.js's left/right
	 * edges LOSE to the band, which it enforces on its own side by asking `inBottomBand`,
	 * so the bottom-left corner docks to the bottom rather than to both at once.
	 * @param {any} e @returns {boolean} */
	const wants = (e) => inBottomBand(e.clientY) && !headerTargetAt(e.clientX, e.clientY, key);
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		armed = wants(e);
		showZone(armed);
	};
	const up = () => {
		if (!dragging) return;
		const take = armed;
		dragging = false;
		armed = false;
		showZone(false);
		if (!take) return;
		armDockMode(key, true);
		activateDock(key);
	};
	const cancel = () => {
		dragging = false;
		armed = false;
		showZone(false);
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
