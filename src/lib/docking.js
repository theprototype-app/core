import { get } from 'svelte/store';
import { inspectorClose, closeMenu } from '../stores/appStore';
import { bottomDockWouldTake } from './bottomDockDrop';
import { safeStorage } from './safeStorage';

// Docking lite (phase 81L). Drag a window near the left/right screen edge to
// dock it as a full-height panel (--z-drawer tier); drag its header away to
// float it again. With the Inspector drawer open, a right-docked panel offsets
// inward as a second column.
// 21-H2: the Library drawer it also used to give way to no longer exists.
//
// 81.4 (v1.13) — EDGE SPLITS: an edge holds up to TWO windows, stacked. Dropping a
// second floating window onto a docked panel (or onto that edge) splits the column
// vertically; a draggable divider between them sets the share (persisted per side);
// undocking either member collapses the split back to one full-height panel. The
// quiz decision stands: splits are for DOCKED panels, tabbing (83) for floating ones
// — `headerTargetAt` already excludes docked windows, so the two never compete. A
// third window on a full edge is refused with the same wiggle as before.

const EDGE = 44; // px from a screen edge that counts as a dock drop
const TOP = 64; // below the topbar, like the drawers
const DRAWER_WIDTH = 320;
/** max windows stacked on one edge */
const MAX_PER_SIDE = 2;
/** half the divider's thickness, in px — each panel gives up this much */
const GAP = 3;
/** the smallest share either split panel may be dragged to */
const MIN_RATIO = 0.15;

/** @type {{left: string[], right: string[]}} */
let docked = { left: [], right: [] };
/** @type {Map<string, any>} */
const registry = new Map(); // key -> {node, prevRect, handle, divider}

/** @param {any} value a persisted side: a string (pre-81.4) or an array
 * @returns {string[]} */
function sideList(value) {
	if (Array.isArray(value)) return value.filter((k) => typeof k === 'string').slice(0, MAX_PER_SIDE);
	return typeof value === 'string' && value ? [value] : [];
}

try {
	const saved = JSON.parse(safeStorage.getItem('dockedWindows') ?? 'null');
	if (saved) docked = { left: sideList(saved.left), right: sideList(saved.right) };
} catch {}

function persist() {
	safeStorage.setItem('dockedWindows', JSON.stringify(docked));
}

/** @param {string} key */
function widthOf(key) {
	const value = parseInt(safeStorage.getItem('dockWidth:' + key) ?? '300');
	return Math.min(Math.max(Number.isNaN(value) ? 300 : value, 250), Math.round(window.innerWidth * 0.4));
}

/** the TOP panel's share of a split column @param {'left'|'right'} side */
function ratioOf(side) {
	const value = parseFloat(safeStorage.getItem('dockSplit:' + side) ?? '0.5');
	return Math.min(Math.max(Number.isNaN(value) ? 0.5 : value, MIN_RATIO), 1 - MIN_RATIO);
}

function drawerOpen() {
	return get(inspectorClose) === false;
}

// A LEFT-docked panel starts at x:0, but the app-sidebar floats above it (z-hud >
// z-drawer), covering the panel's topbar (dock/close) — worst on narrow screens
// where the panel is thin. When the menu is open, inset the panel past the sidebar
// so its buttons stay reachable (mirrors the right-side drawer offset).
function leftInset() {
	if (get(closeMenu) !== false) return 0; // menu closed = no sidebar
	const el = typeof document !== 'undefined' ? document.querySelector('.app-sidebar') : null;
	// fallback while the sidebar hasn't rendered yet (store fires before the DOM
	// updates); the deferred re-apply below refines it to the exact width
	return el ? Math.round(el.getBoundingClientRect().right) + 8 : 228;
}

/** @param {string} key @returns {'left'|'right'|null} */
function sideOf(key) {
	if (docked.left.includes(key)) return 'left';
	if (docked.right.includes(key)) return 'right';
	return null;
}
export { sideOf as dockSideOf };

/** the keys stacked on a side, top first @param {'left'|'right'} side */
export function dockedOn(side) {
	return [...docked[side]];
}

function applyAll() {
	for (const [key] of registry) apply(key);
}

/** re-lay out every member of one side @param {'left'|'right'} side */
function applySide(side) {
	for (const key of docked[side]) apply(key);
}

/** the usable column: from TOP to the bottom dock, as a CSS length */
const COLUMN = `(100vh - ${TOP}px - var(--bottom-inset, 0px))`;

/** @param {string} key */
function apply(key) {
	const entry = registry.get(key);
	if (!entry) return;
	const side = sideOf(key);
	const { node } = entry;
	if (!side) {
		delete node.dataset.docked;
		delete node.dataset.dockSlot;
		entry.handle?.remove();
		entry.handle = null;
		entry.divider?.remove();
		entry.divider = null;
		return;
	}
	// the column's width belongs to the SIDE: every member reads the top one's
	// (the handle below writes all of them, so either panel's handle resizes the column)
	const width = widthOf(docked[side][0] ?? key);
	const stack = docked[side];
	const slot = stack.indexOf(key); // 0 = top (or the only one), 1 = bottom
	const split = stack.length > 1;
	const r = ratioOf(side);
	node.dataset.docked = side;
	node.style.position = 'fixed';
	node.style.maxWidth = 'none';
	node.style.maxHeight = 'none';
	node.style.width = width + 'px';
	node.style.zIndex = '30'; // --z-drawer tier
	if (!split) {
		delete node.dataset.dockSlot;
		node.style.top = TOP + 'px';
		// edge-docked windows end above a docked Flow/Explorer (105)
		node.style.height = `calc(100vh - ${TOP}px - var(--bottom-inset, 0px))`;
	} else if (slot === 0) {
		node.dataset.dockSlot = 'top';
		node.style.top = TOP + 'px';
		node.style.height = `calc(${COLUMN} * ${r} - ${GAP}px)`;
	} else {
		node.dataset.dockSlot = 'bottom';
		node.style.top = `calc(${TOP}px + ${COLUMN} * ${r} + ${GAP}px)`;
		node.style.height = `calc(${COLUMN} * ${1 - r} - ${GAP}px)`;
	}
	const offset = side === 'right' && drawerOpen() ? DRAWER_WIDTH : 0;
	node.style.left = side === 'left' ? leftInset() + 'px' : window.innerWidth - width - offset + 'px';
	node.style.right = 'auto';
	// inner-edge resize handle
	if (!entry.handle) {
		const handle = document.createElement('div');
		handle.className = 'dock-resize resize-cue';
		handle.style.cssText =
			'position:absolute;top:0;bottom:0;width:6px;cursor:ew-resize;touch-action:none;z-index:5;';
		handle.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startWidth = node.offsetWidth;
			const currentSide = sideOf(key);
			const move = (/** @type {any} */ ev) => {
				const delta = currentSide === 'left' ? ev.clientX - startX : startX - ev.clientX;
				const next = Math.min(Math.max(250, startWidth + delta), Math.round(window.innerWidth * 0.4));
				// the column is one width: write it for every member of the side
				for (const k of currentSide ? docked[currentSide] : [key])
					safeStorage.setItem('dockWidth:' + k, String(next));
				if (currentSide) applySide(currentSide);
				else apply(key);
			};
			const up = () => {
				handle.removeEventListener('pointermove', move);
				handle.removeEventListener('pointerup', up);
			};
			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', up);
		});
		node.appendChild(handle);
		entry.handle = handle;
	}
	entry.handle.style.left = side === 'left' ? 'auto' : '-3px';
	entry.handle.style.right = side === 'left' ? '-3px' : 'auto';
	// 81.4: the split DIVIDER hangs off the TOP panel's bottom edge
	if (split && slot === 0) {
		if (!entry.divider) {
			const divider = document.createElement('div');
			divider.className = 'dock-split-divider resize-cue';
			// INSIDE the panel, hugging its bottom edge: every docked window is
			// `overflow-hidden`, so a handle hung past the edge is clipped away and
			// takes no pointer events at all (the width handle only works because half
			// of its 6px sits inside). 7px is the same hot zone the width grip uses.
			divider.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize;touch-action:none;z-index:5;';
			divider.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				divider.setPointerCapture(e.pointerId);
				const currentSide = sideOf(key);
				if (!currentSide) return;
				const inset =
					parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset')) || 0;
				const column = Math.max(1, window.innerHeight - TOP - inset);
				const move = (/** @type {any} */ ev) => {
					const next = Math.min(Math.max((ev.clientY - TOP) / column, MIN_RATIO), 1 - MIN_RATIO);
					safeStorage.setItem('dockSplit:' + currentSide, String(Math.round(next * 1000) / 1000));
					applySide(currentSide);
				};
				const up = () => {
					divider.removeEventListener('pointermove', move);
					divider.removeEventListener('pointerup', up);
				};
				divider.addEventListener('pointermove', move);
				divider.addEventListener('pointerup', up);
			});
			node.appendChild(divider);
			entry.divider = divider;
		}
	} else if (entry.divider) {
		entry.divider.remove();
		entry.divider = null;
	}
}

/** wiggle a panel that refused a drop @param {string} occupantKey */
function wiggle(occupantKey) {
	const occupant = registry.get(occupantKey)?.node;
	occupant?.animate(
		[{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }],
		{ duration: 220 }
	);
}

/**
 * @param {string} key @param {'left'|'right'} side
 * @param {'top'|'bottom'=} slot where to land when the side already holds a window
 *   (81.4): default bottom
 */
function dock(key, side, slot = 'bottom') {
	const entry = registry.get(key);
	if (!entry) return false;
	const stack = docked[side].filter((k) => k !== key);
	if (stack.length >= MAX_PER_SIDE) {
		wiggle(stack[stack.length - 1]);
		return false;
	}
	const from = sideOf(key);
	if (from) docked[from] = docked[from].filter((k) => k !== key);
	if (!from || from !== side || entry.prevRect == null)
		entry.prevRect = {
			left: entry.node.style.left,
			top: entry.node.style.top,
			width: entry.node.style.width,
			height: entry.node.style.height,
			zIndex: entry.node.style.zIndex
		};
	docked[side] = slot === 'top' ? [key, ...stack] : [...stack, key];
	persist();
	if (from && from !== side) applySide(from);
	applySide(side);
	return true;
}

/** @param {string} key @param {number=} x @param {number=} y */
export function undock(key, x, y) {
	const side = sideOf(key);
	if (!side) return;
	docked[side] = docked[side].filter((k) => k !== key);
	persist();
	const entry = registry.get(key);
	if (entry) {
		const { node, prevRect } = entry;
		delete node.dataset.docked;
		delete node.dataset.dockSlot;
		entry.handle?.remove();
		entry.handle = null;
		entry.divider?.remove();
		entry.divider = null;
		node.style.height = prevRect?.height || '';
		node.style.width = prevRect?.width || '';
		node.style.maxWidth = '';
		node.style.maxHeight = '';
		node.style.zIndex = prevRect?.zIndex || '40';
		node.style.left = (x != null ? Math.max(0, x - 120) : parseFloat(prevRect?.left) || 200) + 'px';
		node.style.top = (y != null ? Math.max(0, y - 12) : parseFloat(prevRect?.top) || 120) + 'px';
	}
	// 81.4: the member left behind takes the whole column again
	applySide(side);
}

/** @type {any} */ let zoneEl = null;
/**
 * @param {{side: 'left'|'right', split?: {node: any, slot: 'top'|'bottom'}} | null} target
 *   `split` = the docked panel the drop would share, and which half the new window takes
 */
function showZone(target) {
	if (!target) {
		zoneEl?.remove();
		zoneEl = null;
		return;
	}
	if (!zoneEl) {
		zoneEl = document.createElement('div');
		zoneEl.id = 'dock-zone';
		zoneEl.style.cssText = `position:fixed;z-index:29;pointer-events:none;background:rgb(37 99 235 / .25);border:2px dashed rgb(96 165 250 / .8);`;
		document.body.appendChild(zoneEl);
	}
	const { side, split } = target;
	if (split) {
		// the half of the occupant the new window would take, with a label — the 83
		// merge-target affordance, one drop kind over
		const r = split.node.getBoundingClientRect();
		zoneEl.dataset.split = split.slot;
		zoneEl.style.top = (split.slot === 'top' ? r.top : r.top + r.height / 2) + 'px';
		zoneEl.style.height = r.height / 2 + 'px';
		zoneEl.style.bottom = 'auto';
		zoneEl.style.left = r.left + 'px';
		zoneEl.style.right = 'auto';
		zoneEl.style.width = r.width + 'px';
		zoneEl.textContent = '⊟ Split panel';
		zoneEl.style.cssText +=
			'display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:600;';
	} else {
		delete zoneEl.dataset.split;
		zoneEl.textContent = '';
		zoneEl.style.top = TOP + 'px';
		zoneEl.style.bottom = '0';
		zoneEl.style.height = 'auto';
		zoneEl.style.width = '80px';
		zoneEl.style.left = side === 'left' ? '0' : 'auto';
		zoneEl.style.right = side === 'right' ? '0' : 'auto';
	}
}

let subscribed = false;

// touch / limited-width devices: edge side-docking is disabled — there isn't the
// horizontal room for a full-height side panel, and it fights touch scrolling.
const isCoarse = () =>
	typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

/**
 * svelte action: makes a floating window dockable to the screen edges.
 * @param {any} node @param {{key: string}} options
 */
export function dockable(node, { key }) {
	registry.set(key, { node, prevRect: null, handle: null, divider: null });
	// On mobile, register only (so destroy() still cleans up) but wire NO edge-drag
	// handlers and restore NO persisted side-dock — the window stays a normal floating
	// window. The persisted desktop preference is left untouched.
	if (isCoarse()) {
		return {
			destroy() {
				registry.delete(key);
			}
		};
	}
	if (!subscribed) {
		subscribed = true;
		// right-docked panels give way to the Inspector drawer
		inspectorClose.subscribe(() => applyAll());
		// left dock insets past the sidebar — re-apply next frame too, since the
		// sidebar mounts AFTER the store fires (so it can be measured)
		closeMenu.subscribe(() => {
			applyAll();
			requestAnimationFrame(applyAll);
		});
		window.addEventListener('resize', applyAll);
	}
	const restored = sideOf(key);
	if (restored) applySide(restored); // restore a persisted dock (and re-share a split)

	let dragging = false;
	/** @param {any} e */
	const down = (e) => {
		if (!e.target.closest('.move-handle') || e.button !== 0) return;
		if (sideOf(key)) {
			// docked: dragging the header away undocks and hands back to the
			// window's own drag behavior on the NEXT gesture
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
			};
			window.addEventListener('pointermove', moveOut);
			window.addEventListener('pointerup', cleanup);
			return;
		}
		dragging = true;
	};
	// W7 PRECEDENCE: the bottom-dock band beats an edge. The bottom-left corner is in
	// both reaches at once, and a DOCK_FAMILY window dropped there means "put it in the
	// dock" — the model the user was aiming at — not "make it a full-height side panel
	// that happens to start below the dock". Asking here rather than there keeps the
	// decision on the side that has to yield.
	/** @param {any} e @returns {'left'|'right'|null} */
	const edgeAt = (e) => {
		// ...but only where the dock would really take THIS window. Yielding the band
		// unconditionally hands the bottom of both side edges to a dock that cannot
		// accept a non-DOCK_FAMILY panel, so the drop does nothing at all.
		if (bottomDockWouldTake(key, e.clientY)) return null;
		return e.clientX < EDGE ? 'left' : e.clientX > window.innerWidth - EDGE ? 'right' : null;
	};
	/** 81.4: the docked panel under the pointer (on a side with room), and which half
	 * @param {any} e @returns {{side: 'left'|'right', node: any, slot: 'top'|'bottom'} | null} */
	const splitAt = (e) => {
		if (bottomDockWouldTake(key, e.clientY)) return null;
		for (const side of /** @type {const} */ (['left', 'right'])) {
			const stack = docked[side].filter((k) => k !== key);
			if (stack.length !== 1) continue;
			const other = registry.get(stack[0])?.node;
			if (!other?.isConnected) continue;
			const r = other.getBoundingClientRect();
			if (r.width === 0) continue;
			const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
			const onEdge = edgeAt(e) === side;
			if (!inside && !onEdge) continue;
			return { side, node: other, slot: inside && e.clientY < r.top + r.height / 2 ? 'top' : 'bottom' };
		}
		return null;
	};
	/** @param {any} e @returns {{side: 'left'|'right', split?: {node: any, slot: 'top'|'bottom'}} | null} */
	const targetAt = (e) => {
		const split = splitAt(e);
		if (split) return { side: split.side, split: { node: split.node, slot: split.slot } };
		const side = edgeAt(e);
		return side ? { side } : null;
	};
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		showZone(targetAt(e));
	};
	/** @param {any} e */
	const up = (e) => {
		if (!dragging) return;
		dragging = false;
		showZone(null);
		const target = targetAt(e);
		if (target) dock(key, target.side, target.split?.slot ?? 'bottom');
	};
	node.addEventListener('pointerdown', down, true); // capture: beats dragWindow while docked
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);

	return {
		destroy() {
			node.removeEventListener('pointerdown', down, true);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			registry.delete(key);
			// a member that unmounts leaves its partner the column (the persisted
			// pair survives for its return, since the layout is re-derived on apply)
			const side = sideOf(key);
			if (side) applySide(side);
		}
	};
}
