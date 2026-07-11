import { get } from 'svelte/store';
import { inspectorClose, libraryClose } from '../stores/appStore';

// Docking lite (phase 81L). Drag a window near the left/right screen edge to
// dock it as a full-height panel (--z-drawer tier); drag its header away to
// float it again. One window per edge (a second drop wiggles the occupant —
// SPLITS stay in pending/81). With the Inspector/Library drawer open, a
// right-docked panel offsets inward as a second column.

const EDGE = 44; // px from a screen edge that counts as a dock drop
const TOP = 64; // below the topbar, like the drawers
const DRAWER_WIDTH = 320;

/** @type {{left: string|null, right: string|null}} */
let docked = { left: null, right: null };
/** @type {Map<string, any>} */
const registry = new Map(); // key -> {node, prevRect, handle}

try {
	const saved = JSON.parse(localStorage.getItem('dockedWindows') ?? 'null');
	if (saved) docked = { left: saved.left ?? null, right: saved.right ?? null };
} catch {}

function persist() {
	localStorage.setItem('dockedWindows', JSON.stringify(docked));
}

/** @param {string} key */
function widthOf(key) {
	const value = parseInt(localStorage.getItem('dockWidth:' + key) ?? '300');
	return Math.min(Math.max(Number.isNaN(value) ? 300 : value, 250), Math.round(window.innerWidth * 0.4));
}

function drawerOpen() {
	return get(inspectorClose) === false || get(libraryClose) === false;
}

/** @param {string} key */
function sideOf(key) {
	if (docked.left === key) return 'left';
	if (docked.right === key) return 'right';
	return null;
}
export { sideOf as dockSideOf };

function applyAll() {
	for (const [key] of registry) apply(key);
}

/** @param {string} key */
function apply(key) {
	const entry = registry.get(key);
	if (!entry) return;
	const side = sideOf(key);
	const { node } = entry;
	if (!side) {
		delete node.dataset.docked;
		entry.handle?.remove();
		entry.handle = null;
		return;
	}
	const width = widthOf(key);
	node.dataset.docked = side;
	node.style.position = 'fixed';
	node.style.top = TOP + 'px';
	// edge-docked windows end above a docked Flow/Explorer (105)
	node.style.height = `calc(100vh - ${TOP}px - var(--bottom-inset, 0px))`;
	node.style.width = width + 'px';
	node.style.maxWidth = 'none';
	node.style.maxHeight = 'none';
	node.style.zIndex = '30'; // --z-drawer tier
	const offset = side === 'right' && drawerOpen() ? DRAWER_WIDTH : 0;
	node.style.left = side === 'left' ? '0px' : window.innerWidth - width - offset + 'px';
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
				localStorage.setItem('dockWidth:' + key, String(next));
				apply(key);
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
}

/** @param {string} key @param {'left'|'right'} side */
function dock(key, side) {
	const entry = registry.get(key);
	if (!entry) return false;
	if (docked[side] && docked[side] !== key) {
		// occupied — wiggle the occupant instead (splits live in pending/81)
		const occupant = registry.get(/** @type {string} */ (docked[side]))?.node;
		occupant?.animate(
			[{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }],
			{ duration: 220 }
		);
		return false;
	}
	if (sideOf(key)) docked[/** @type {'left'|'right'} */ (sideOf(key))] = null;
	entry.prevRect = {
		left: entry.node.style.left,
		top: entry.node.style.top,
		width: entry.node.style.width,
		height: entry.node.style.height,
		zIndex: entry.node.style.zIndex
	};
	docked[side] = key;
	persist();
	apply(key);
	return true;
}

/** @param {string} key @param {number=} x @param {number=} y */
export function undock(key, x, y) {
	const side = sideOf(key);
	if (!side) return;
	docked[side] = null;
	persist();
	const entry = registry.get(key);
	if (entry) {
		const { node, prevRect } = entry;
		delete node.dataset.docked;
		entry.handle?.remove();
		entry.handle = null;
		node.style.height = prevRect?.height || '';
		node.style.width = prevRect?.width || '';
		node.style.maxWidth = '';
		node.style.maxHeight = '';
		node.style.zIndex = prevRect?.zIndex || '40';
		node.style.left = (x != null ? Math.max(0, x - 120) : parseFloat(prevRect?.left) || 200) + 'px';
		node.style.top = (y != null ? Math.max(0, y - 12) : parseFloat(prevRect?.top) || 120) + 'px';
	}
}

/** @type {any} */ let zoneEl = null;
/** @param {'left'|'right'|null} side */
function showZone(side) {
	if (!side) {
		zoneEl?.remove();
		zoneEl = null;
		return;
	}
	if (!zoneEl) {
		zoneEl = document.createElement('div');
		zoneEl.id = 'dock-zone';
		zoneEl.style.cssText = `position:fixed;top:${TOP}px;bottom:0;width:80px;z-index:29;pointer-events:none;background:rgb(37 99 235 / .25);border:2px dashed rgb(96 165 250 / .8);`;
		document.body.appendChild(zoneEl);
	}
	zoneEl.style.left = side === 'left' ? '0' : 'auto';
	zoneEl.style.right = side === 'right' ? '0' : 'auto';
}

let subscribed = false;

/**
 * svelte action: makes a floating window dockable to the screen edges.
 * @param {any} node @param {{key: string}} options
 */
export function dockable(node, { key }) {
	registry.set(key, { node, prevRect: null, handle: null });
	if (!subscribed) {
		subscribed = true;
		// right-docked panels give way to the Inspector/Library drawer
		inspectorClose.subscribe(() => applyAll());
		libraryClose.subscribe(() => applyAll());
		window.addEventListener('resize', applyAll);
	}
	if (sideOf(key)) apply(key); // restore a persisted dock

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
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		showZone(e.clientX < EDGE ? 'left' : e.clientX > window.innerWidth - EDGE ? 'right' : null);
	};
	/** @param {any} e */
	const up = (e) => {
		if (!dragging) return;
		dragging = false;
		showZone(null);
		if (e.clientX < EDGE) dock(key, 'left');
		else if (e.clientX > window.innerWidth - EDGE) dock(key, 'right');
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
		}
	};
}
