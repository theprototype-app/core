// Floating-window svelte action (phase 68): drag by any `.move-handle` child,
// stay inside the viewport, persist the position per `key` in localStorage.
// Windows sit on the --z-window tier; the caller sets size and z-index.

import { clampWinSize, clampResize } from './windowSize';

// 169: live reset registry — every draggable window (this action + the object
// list's own dragMe) registers a reset fn so Settings can rescue windows stuck
// off-screen without a reload.
/** @type {Set<() => void>} */
const resetters = new Set();

/** Register a live reset callback; returns an unregister fn. @param {() => void} fn */
export function registerWindowReset(fn) {
	resetters.add(fn);
	return () => resetters.delete(fn);
}

/** Clear every persisted floating-window position + re-lay live windows (169). */
export function resetWindowLayout() {
	if (typeof localStorage !== 'undefined') {
		for (const key of Object.keys(localStorage))
			if (key.startsWith('win:')) localStorage.removeItem(key);
		['objectListRect', 'explorerWinW', 'explorerWinH', 'explorerHeight', 'explorerTreeW', 'uvWinW', 'uvWinH'].forEach((k) =>
			localStorage.removeItem(k)
		);
	}
	resetters.forEach((fn) => {
		try {
			fn();
		} catch {}
	});
}

/**
 * @param {any} node
 * @param {{key: string, defaultRect?: {left?: number, top?: number, right?: number, bottom?: number},
 *   resizable?: boolean, axis?: 'x'|'xy', minW?: number, minH?: number,
 *   inert?: (() => boolean) | null}} options
 *   `resizable` (15-B7) adds a bottom-right grabber and persists {w,h} in the
 *   SAME `win:<key>` record — opt-in, so windows that own their sizing (Flow,
 *   Explorer, the object list) are untouched.
 *   `axis: 'x'` (M0 toolbox) makes the grip WIDTH-only: height stays `auto` so
 *   the window hugs its content while the grid inside reflows to the width —
 *   the Photoshop tool-palette idiom. Only `w` is persisted; the cursor becomes
 *   ew-resize. Default 'xy' keeps every existing consumer byte-identical.
 *   `inert: () => boolean` (18-C3) suspends the action while the consumer is
 *   rendering as something else — the toolbox becomes a full-width bottom SHEET
 *   on a phone, and a sheet pinned to left:0 would otherwise be clamped and
 *   SAVED as position 0, losing the desktop placement on the way back.
 */
export function dragWindow(node, { key, defaultRect = {}, resizable = false, axis = 'xy', minW = 260, minH = 180, inert = null }) {
	/** @type {any} */
	let rect = null;
	try {
		rect = JSON.parse(localStorage.getItem('win:' + key) ?? 'null');
	} catch {
		rect = null;
	}
	rect = rect ?? { ...defaultRect };

	node.style.position = 'fixed';

	/** 18-C3: is the consumer currently rendering as something this action must
	 * not touch (a bottom sheet)? A predicate, so it tracks without an update(). */
	function suspended() {
		try {
			return !!inert?.();
		} catch {
			return false;
		}
	}

	// min px of the window kept on-screen while DRAGGING — you can shove a window mostly
	// off the left/right/bottom (to get it out of the way) but a grabbable strip always
	// stays, and its top (the drag header) never goes above the top edge, so it's never
	// lost. `reveal`/init clamp it FULLY back on-screen.
	const KEEP = 52;

	/** @param {boolean} full  true = keep the whole window on-screen; false = allow partial off */
	function clamp(full) {
		const w = node.offsetWidth || 0;
		const h = node.offsetHeight || 0;
		const keepX = full ? w : Math.min(KEEP, w);
		const keepY = full ? h : Math.min(KEEP, h);
		rect.left = Math.min(Math.max(keepX - w, rect.left), Math.max(keepX - w, window.innerWidth - keepX));
		// keep the window from sliding BEHIND the Connect bar/pill (which sits above the
		// window tier) — only when they actually overlap horizontally (the centred pill on
		// a wide screen; the full-width bar on a narrow one)
		let minTop = 0;
		const cp = typeof document !== 'undefined' ? document.querySelector('.connect-pill') : null;
		if (cp) {
			const r = cp.getBoundingClientRect();
			if (rect.left < r.right && rect.left + w > r.left) minTop = Math.max(minTop, Math.round(r.bottom) + 4);
		}
		// top never above minTop (the drag header stays reachable); may slide off the bottom
		rect.top = Math.min(Math.max(minTop, rect.top), Math.max(minTop, window.innerHeight - keepY));
	}

	/** clamp a persisted size into the current viewport (B7).
	 * 18-B: the viewport cap WINS over `minW`/`minH` — the old `Math.max(minW, …)`
	 * put the minimum last, so on a viewport narrower than the minimum the window
	 * came out wider than the screen, which is the state that strands the grip. */
	function clampSize() {
		const fit = clampWinSize(rect.w ?? 0, rect.h ?? 0, { minW, minH, margin: 16 });
		if (typeof rect.w === 'number') rect.w = fit.w;
		if (typeof rect.h === 'number') rect.h = fit.h;
	}

	function apply() {
		if (suspended()) return;
		if (resizable) {
			clampSize();
			if (typeof rect.w === 'number') node.style.width = rect.w + 'px';
			if (axis !== 'x' && typeof rect.h === 'number') node.style.height = rect.h + 'px';
		}
		if (typeof rect.left !== 'number' || typeof rect.top !== 'number') return;
		node.style.left = rect.left + 'px';
		node.style.top = rect.top + 'px';
		// 18-B: publish the offset so a window whose HEIGHT is content-driven (the
		// toolbox: axis 'x', height auto) can cap itself against the space actually
		// below it. A plain `max-height: 100vh` ignores the offset, which is how a
		// toolbox pinned under the Connect bar still hung its grip off the bottom.
		node.style.setProperty('--dw-top', rect.top + 'px');
	}

	function save() {
		if (suspended()) return;
		/** @type {any} */
		const payload = { left: rect.left, top: rect.top };
		if (resizable && typeof rect.w === 'number') {
			payload.w = rect.w;
			if (axis !== 'x') payload.h = rect.h;
		}
		localStorage.setItem('win:' + key, JSON.stringify(payload));
	}

	// right/bottom-anchored defaults need the rendered size — resolve on the
	// first frame the window is actually visible (it may mount display:none)
	function resolveDefaults() {
		if (typeof rect.left === 'number' && typeof rect.top === 'number') return true;
		if (!node.offsetWidth) return false;
		rect.left =
			typeof rect.right === 'number' ? window.innerWidth - node.offsetWidth - rect.right : rect.left ?? 60;
		rect.top =
			typeof rect.bottom === 'number' ? window.innerHeight - node.offsetHeight - rect.bottom : rect.top ?? 60;
		delete rect.right;
		delete rect.bottom;
		clamp(true);
		apply();
		return true;
	}
	if (!resolveDefaults()) {
		const observer = new ResizeObserver(() => {
			if (resolveDefaults()) observer.disconnect();
		});
		observer.observe(node);
	} else {
		clamp(true);
		apply();
	}

	// 18-B: a window that GROWS must be pulled back on-screen. The consumers that
	// own their own sizing (Explorer, UV, Animation, Flow) apply their height after
	// this action has already clamped the position, so the initial clamp measured a
	// window that was still small — the result was a correctly-sized window whose
	// bottom-right grip sat below the viewport, i.e. unreachable, which is the very
	// state this batch exists to prevent. Watching the node's box catches it
	// whatever sets the size, and re-clamping is a no-op when it already fits.
	let lastBox = '';
	const sizeWatch =
		typeof ResizeObserver !== 'undefined'
			? new ResizeObserver(() => {
					if (typeof rect.left !== 'number' || dragging) return;
					const box = node.offsetWidth + 'x' + node.offsetHeight;
					if (box === lastBox) return;
					lastBox = box;
					const before = rect.left + ',' + rect.top;
					clamp(true);
					if (before !== rect.left + ',' + rect.top) apply();
				})
			: null;
	sizeWatch?.observe(node);

	// Reveal: when the window goes from hidden back to visible ("called again"), snap it
	// FULLY on-screen so a window that was shoved partly off doesn't reappear off-screen.
	let wasVisible = false;
	const io =
		typeof IntersectionObserver !== 'undefined'
			? new IntersectionObserver((entries) => {
					const vis = entries.some((e) => e.isIntersecting);
					if (vis && !wasVisible && typeof rect.left === 'number') {
						clamp(true);
						apply();
						save();
					}
					wasVisible = vis;
				})
			: null;
	io?.observe(node);

	// 169: reset this window to its default spot (Settings rescue)
	function resetToDefault() {
		try {
			localStorage.removeItem('win:' + key);
		} catch {}
		rect = { ...defaultRect };
		if (resizable) {
			// drop a persisted size too — back to the CSS default
			node.style.removeProperty('width');
			node.style.removeProperty('height');
		}
		if (typeof rect.left === 'number' && typeof rect.top === 'number') {
			clamp(true);
			apply();
		} else {
			resolveDefaults();
		}
	}
	const unregisterReset = registerWindowReset(resetToDefault);

	let dragging = false;

	/** @param {any} e */
	function down(e) {
		if (suspended()) return;
		if (!e.target.closest('.move-handle')) return;
		if (e.target.closest('button, input, select, textarea')) return; // header controls stay clickable
		dragging = true;
		node.setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}

	/** @param {any} e */
	function move(e) {
		if (!dragging) return;
		rect.left = (typeof rect.left === 'number' ? rect.left : node.offsetLeft) + e.movementX;
		rect.top = (typeof rect.top === 'number' ? rect.top : node.offsetTop) + e.movementY;
		clamp(false); // allow partial off-screen while dragging
		apply();
	}

	/** @param {any} e */
	function up(e) {
		if (!dragging) return;
		dragging = false;
		node.releasePointerCapture?.(e.pointerId);
		save();
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);

	// --- B7: opt-in resize grabber (bottom-right), Flow's corner-resize feel ---
	/** @type {any} */
	let grabber = null;
	if (resizable && typeof document !== 'undefined') {
		grabber = document.createElement('div');
		grabber.className = 'dw-resize';
		grabber.title = 'Drag to resize · double-click to reset size';
		// built in JS (no markup change needed in every consumer); the diagonal
		// hint is drawn with a gradient so it needs no icon import
		grabber.style.cssText =
			'position:absolute;right:0;bottom:0;width:16px;height:16px;' +
			'cursor:' + (axis === 'x' ? 'ew-resize' : 'se-resize') + ';' +
			'touch-action:none;z-index:2;background:linear-gradient(135deg,transparent 45%,' +
			'rgb(255 255 255 / 0.35) 45%,rgb(255 255 255 / 0.35) 55%,transparent 55%);';
		node.appendChild(grabber);

		let sizing = false;
		/** @param {any} e */
		const gdown = (e) => {
			sizing = true;
			// take the CURRENT rendered size as the baseline (the window may still be
			// on its CSS default size, with nothing persisted yet)
			rect.w = node.offsetWidth;
			if (axis !== 'x') rect.h = node.offsetHeight;
			grabber.setPointerCapture?.(e.pointerId);
			e.preventDefault();
			e.stopPropagation(); // never start a drag from the corner
		};
		/** @param {any} e */
		const gmove = (e) => {
			if (!sizing) return;
			// 18-B: the corner stops at the viewport edge (the OS window rule), so the
			// grip can never be dragged out of reach — the whole reason a window used
			// to become unshrinkable.
			const wanted = {
				w: (rect.w ?? node.offsetWidth) + e.movementX,
				h: (rect.h ?? node.offsetHeight) + e.movementY
			};
			const fit = clampResize(wanted.w, wanted.h, rect.left ?? node.offsetLeft, rect.top ?? node.offsetTop, {
				minW,
				minH,
				margin: 16
			});
			rect.w = fit.w;
			if (axis !== 'x') rect.h = fit.h;
			apply();
		};
		/** @param {any} e */
		const gup = (e) => {
			if (!sizing) return;
			sizing = false;
			grabber.releasePointerCapture?.(e.pointerId);
			clamp(false);
			apply();
			save();
		};
		grabber.addEventListener('pointerdown', gdown);
		grabber.addEventListener('pointermove', gmove);
		grabber.addEventListener('pointerup', gup);
		// 18-B: the escape hatch for a size that is already wrong — double-click the
		// grip to go back to the CSS default. Size only: the window stays where the
		// user put it (resetToDefault, the Settings rescue, moves it as well).
		grabber.addEventListener('dblclick', (/** @type {any} */ e) => {
			e.preventDefault();
			e.stopPropagation();
			resetSize();
		});
	}

	/** Drop the persisted size, keeping the position (18-B). */
	function resetSize() {
		delete rect.w;
		delete rect.h;
		node.style.removeProperty('width');
		node.style.removeProperty('height');
		clamp(true);
		apply();
		save();
	}

	// a shrinking viewport must not strand a window at a size that no longer fits
	const onWindowResize = () => {
		if (!resizable) return;
		clampSize();
		apply();
	};
	window.addEventListener('resize', onWindowResize);

	return {
		destroy() {
			unregisterReset();
			io?.disconnect();
			sizeWatch?.disconnect();
			window.removeEventListener('resize', onWindowResize);
			grabber?.remove();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
		}
	};
}
