// Search-popover UX (phase 84): move the box with the RIGHT mouse button
// (anywhere except the text field) and a custom copy/paste/clear context menu
// on the field itself.

/**
 * Right-button drag moves the popover. Pass onMove when the host re-renders
 * its position from state (the callback updates that state instead).
 * @param {any} node
 * @param {{exclude?: string, onMove?: (dx: number, dy: number) => void}=} options
 */
export function rightDragMove(node, options = {}) {
	const { exclude = 'input', onMove } = options;
	let dragging = false;
	/** @param {any} e */
	const down = (e) => {
		if (e.button !== 2 || e.target.closest(exclude)) return;
		dragging = true;
		node.setPointerCapture?.(e.pointerId);
		e.preventDefault();
	};
	/** @param {any} e */
	const move = (e) => {
		if (!dragging) return;
		if (onMove) {
			onMove(e.movementX, e.movementY);
			return;
		}
		// Keep the box FULLY on-screen: clamping only the left/top edges let a drag
		// push it off the right/bottom (which also grows the document — see the
		// off-the-right-edge gotcha in CLAUDE.md).
		const rect = node.getBoundingClientRect();
		const margin = 8;
		const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
		const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
		node.style.left = Math.max(margin, Math.min(rect.left + e.movementX, maxLeft)) + 'px';
		node.style.top = Math.max(margin, Math.min(rect.top + e.movementY, maxTop)) + 'px';
	};
	/** @param {any} e */
	const up = (e) => {
		if (!dragging) return;
		dragging = false;
		node.releasePointerCapture?.(e.pointerId);
	};
	/** @param {any} e */
	const ctx = (e) => {
		if (!e.target.closest(exclude)) e.preventDefault(); // no browser menu on the box
	};
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('contextmenu', ctx);
	return {
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('contextmenu', ctx);
		}
	};
}

/**
 * Custom Copy · Paste · Clear menu on right-clicking a search input.
 * Paste needs clipboard-read permission — on denial the entry removes itself.
 * @param {any} input
 */
export function inputContextMenu(input) {
	/** @type {any} */
	let menu = null;
	const closeMenu = () => {
		menu?.remove();
		menu = null;
		window.removeEventListener('pointerdown', outside, true);
	};
	/** @param {any} e */
	const outside = (e) => {
		if (menu && !menu.contains(e.target)) closeMenu();
	};
	/** @param {any} e */
	const onCtx = (e) => {
		e.preventDefault();
		e.stopPropagation();
		closeMenu();
		menu = document.createElement('div');
		menu.id = 'input-context-menu';
		menu.className =
			'fixed z-1001 flex overflow-hidden rounded-lg border border-gray-600 bg-gray-800 text-xs text-gray-200 shadow-xl';
		menu.style.left = e.clientX + 'px';
		menu.style.top = e.clientY + 'px';
		/** @param {string} label @param {() => any} fn */
		const mk = (label, fn) => {
			const button = document.createElement('button');
			button.textContent = label;
			button.className = 'px-2.5 py-1 hover:bg-gray-600';
			button.addEventListener('click', async () => {
				await fn();
				closeMenu();
			});
			menu.appendChild(button);
			return button;
		};
		mk('Copy', async () => {
			const selection = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
			try {
				await navigator.clipboard.writeText(selection || input.value);
			} catch {}
		});
		const paste = mk('Paste', async () => {
			try {
				const text = await navigator.clipboard.readText();
				const start = input.selectionStart ?? input.value.length;
				const end = input.selectionEnd ?? start;
				input.value = input.value.slice(0, start) + text + input.value.slice(end);
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.focus();
			} catch {
				paste.remove(); // clipboard-read denied — no permission nagging
			}
		});
		mk('Clear', () => {
			input.value = '';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.focus();
		});
		document.body.appendChild(menu);
		setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
	};
	input.addEventListener('contextmenu', onCtx);
	return {
		destroy() {
			input.removeEventListener('contextmenu', onCtx);
			closeMenu();
		}
	};
}
