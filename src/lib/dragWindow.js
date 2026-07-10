// Floating-window svelte action (phase 68): drag by any `.move-handle` child,
// stay inside the viewport, persist the position per `key` in localStorage.
// Windows sit on the --z-window tier; the caller sets size and z-index.

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

	function clamp() {
		const w = node.offsetWidth || 0;
		const h = node.offsetHeight || 0;
		rect.left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - w));
		rect.top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - h));
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
		clamp();
		apply();
		return true;
	}
	if (!resolveDefaults()) {
		const observer = new ResizeObserver(() => {
			if (resolveDefaults()) observer.disconnect();
		});
		observer.observe(node);
	} else {
		clamp();
		apply();
	}

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
		clamp();
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
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
		}
	};
}
