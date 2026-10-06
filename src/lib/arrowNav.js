// 36-fb-code (S12): ARROW-KEY NAVIGATION through a list of focusable rows — the code workspace's
// Open editors list, Project tree, tab strip and right-sidebar lists share it. ↑/↓ (or ←/→ for a
// horizontal strip) move focus to the next/previous row, Home/End to the ends; focus wraps
// nowhere (the list's ends are its ends, the ARIA practice). Rows are found by `item`; one with
// `aria-disabled` or `hidden` is skipped. The rows keep their own Enter/Space (they are buttons).
// `onMove(el)` hears where focus went (a roving-tabindex owner records it). `onKey(e)` sees every
// key FIRST, on a direct listener (svelte delegates `onkeydown`, and panel chrome that stops
// propagation on the way up would swallow a delegated one) — preventDefault there to take it.

/**
 * The row focus should move to.
 * @param {number} count @param {number} current -1 = none focused @param {'next' | 'prev' | 'first' | 'last'} step
 */
export function nextIndex(count, current, step) {
	if (count <= 0) return -1;
	if (step === 'first') return 0;
	if (step === 'last') return count - 1;
	if (current < 0) return step === 'next' ? 0 : count - 1;
	return step === 'next' ? Math.min(count - 1, current + 1) : Math.max(0, current - 1);
}

/**
 * @param {HTMLElement} node
 * @param {{ item: string, axis?: 'y' | 'x', onMove?: (el: HTMLElement) => void, onKey?: (e: KeyboardEvent) => void }} options
 */
export function arrowNav(node, options) {
	let opts = options;
	/** @param {KeyboardEvent} e */
	function down(e) {
		opts.onKey?.(e);
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		const axis = opts.axis ?? 'y';
		/** @type {Record<string, 'next' | 'prev' | 'first' | 'last'>} */
		const map = axis === 'y' ? { ArrowDown: 'next', ArrowUp: 'prev', Home: 'first', End: 'last' } : { ArrowRight: 'next', ArrowLeft: 'prev', Home: 'first', End: 'last' };
		const step = map[e.key];
		if (!step) return;
		const target = /** @type {HTMLElement} */ (e.target);
		// a text field keeps its own Home/End and arrows
		if (target.closest('input, textarea, [contenteditable="true"]')) return;
		const rows = /** @type {HTMLElement[]} */ ([...node.querySelectorAll(opts.item)]).filter((el) => !el.hidden && el.getAttribute('aria-disabled') !== 'true');
		const current = rows.findIndex((el) => el === target || el.contains(target));
		const i = nextIndex(rows.length, current, step);
		if (i < 0) return;
		e.preventDefault();
		e.stopPropagation();
		rows[i].focus();
		rows[i].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
		opts.onMove?.(rows[i]);
	}
	node.addEventListener('keydown', down);
	return {
		/** @param {typeof options} next */
		update(next) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('keydown', down);
		}
	};
}
