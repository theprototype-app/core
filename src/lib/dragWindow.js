// Floating-window svelte action (phase 68): drag by any `.move-handle` child,
// stay inside the viewport, persist the position per `key` in localStorage.
// Windows sit on the --z-window tier; the caller sets size and z-index.

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
		['objectListRect', 'explorerWinW', 'explorerWinH', 'explorerHeight', 'explorerTreeW'].forEach((k) =>
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
 * @param {{key: string, defaultRect?: {left?: number, top?: number, right?: number, bottom?: number}}} options
 */
export function dragWindow(node, { key, defaultRect = {} }) {
	/** @type {any} */
	let rect = null;
	try {
		rect = JSON.parse(localStorage.getItem('win:' + key) ?? 'null');
	} catch {
		rect = null;
	}
	rect = rect ?? { ...defaultRect };

	node.style.position = 'fixed';

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

	function apply() {
		if (typeof rect.left !== 'number' || typeof rect.top !== 'number') return;
		node.style.left = rect.left + 'px';
		node.style.top = rect.top + 'px';
	}

	function save() {
		localStorage.setItem('win:' + key, JSON.stringify({ left: rect.left, top: rect.top }));
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

	return {
		destroy() {
			unregisterReset();
			io?.disconnect();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
		}
	};
}
