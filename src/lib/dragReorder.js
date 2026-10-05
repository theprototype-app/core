// 36-fb-code (F6/F8): DRAG TO REORDER a list of items — the code workspace's tab strip
// (horizontal) and its Open editors list (vertical) share it, so both orders move the same way.
//
// A POINTER gesture, not HTML5 drag-and-drop: the Explorer, the dock tabs and the viewport
// already speak DnD, and a tab's dragstart would look like a file to every drop target (the
// explorerView column-header ruling). A press that does not TRAVEL is a click and passes
// through untouched; one that travels reorders, and the click that ends it is swallowed.
// Touch keeps its native scrolling (a finger on the strip scrolls it).
//
// The container carries the action; items are found by `item` (a selector) and named by a
// data attribute (`idAttr`). While dragging, the item under the gap gets `data-drop="before"`
// (or the last one `"after"`) for the CSS to draw an insertion line, and the dragged item
// `data-dragging`. `onMove(id, toIndex)` gets the index in the list WITHOUT the dragged item
// (codeTabs.moveTab's contract).

/** how far a press must travel before it is a drag, in px */
const SLOP = 5;
/** the band at each end of a scrolling container that scrolls it while dragging */
const EDGE = 28;

/**
 * @typedef {{
 *   axis: 'x' | 'y',
 *   item: string,
 *   idAttr: string,
 *   onMove: (id: string, toIndex: number) => void,
 *   handleIgnore?: string
 * }} ReorderOptions
 */

/**
 * The slot a pointer at `pos` falls into, among the OTHER items' midpoints.
 * @param {number[]} mids midpoints along the axis, in list order @param {number} pos
 */
export function dropIndex(mids, pos) {
	let i = 0;
	while (i < mids.length && mids[i] < pos) i++;
	return i;
}

/** @param {HTMLElement} node @param {ReorderOptions} options */
export function dragReorder(node, options) {
	let opts = options;
	/** @type {null | {id: string, el: HTMLElement, x: number, y: number, moved: boolean, pointerId: number}} */
	let press = null;
	let index = -1;

	const others = () =>
		/** @type {HTMLElement[]} */ ([...node.querySelectorAll(opts.item)]).filter((el) => el !== press?.el);
	const clearMarks = () => {
		for (const el of node.querySelectorAll('[data-drop]')) el.removeAttribute('data-drop');
	};

	/** @param {PointerEvent} e */
	function down(e) {
		if (e.button !== 0 || e.pointerType === 'touch') return;
		const target = /** @type {HTMLElement} */ (e.target);
		if (opts.handleIgnore && target.closest(opts.handleIgnore)) return;
		const el = /** @type {HTMLElement | null} */ (target.closest(opts.item));
		if (!el || !node.contains(el)) return;
		const id = el.getAttribute(opts.idAttr);
		if (!id) return;
		press = { id, el, x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
		window.addEventListener('pointermove', move, true);
		window.addEventListener('pointerup', up, true);
		window.addEventListener('pointercancel', cancel, true);
	}

	/** @param {PointerEvent} e */
	function move(e) {
		if (!press || e.pointerId !== press.pointerId) return;
		const along = opts.axis === 'x' ? e.clientX - press.x : e.clientY - press.y;
		if (!press.moved) {
			if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP || Math.abs(along) < SLOP / 2) return;
			press.moved = true;
			press.el.setAttribute('data-dragging', 'true');
			node.setAttribute('data-reordering', 'true');
		}
		e.preventDefault();
		const pos = opts.axis === 'x' ? e.clientX : e.clientY;
		// scroll a scrolling container from its ends, so a tab can be carried past the visible ones
		const box = node.getBoundingClientRect();
		const lo = opts.axis === 'x' ? box.left : box.top;
		const hi = opts.axis === 'x' ? box.right : box.bottom;
		const step = pos < lo + EDGE ? -10 : pos > hi - EDGE ? 10 : 0;
		if (step) {
			if (opts.axis === 'x') node.scrollLeft += step;
			else node.scrollTop += step;
		}
		const rest = others();
		const mids = rest.map((el) => {
			const r = el.getBoundingClientRect();
			return opts.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
		});
		index = dropIndex(mids, pos);
		clearMarks();
		if (rest.length) {
			if (index < rest.length) rest[index].setAttribute('data-drop', 'before');
			else rest[rest.length - 1].setAttribute('data-drop', 'after');
		}
	}

	function finish() {
		window.removeEventListener('pointermove', move, true);
		window.removeEventListener('pointerup', up, true);
		window.removeEventListener('pointercancel', cancel, true);
		clearMarks();
		node.removeAttribute('data-reordering');
		press?.el.removeAttribute('data-dragging');
	}

	/** @param {PointerEvent} e */
	function up(e) {
		if (!press || e.pointerId !== press.pointerId) return;
		const done = press;
		finish();
		press = null;
		if (!done.moved) return;
		// the click this release produces is the end of a drag, not a press on the tab
		const swallow = (/** @type {MouseEvent} */ ev) => {
			ev.stopPropagation();
			ev.preventDefault();
		};
		window.addEventListener('click', swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener('click', swallow, true), 0);
		if (index >= 0) opts.onMove(done.id, index);
	}

	function cancel() {
		finish();
		press = null;
	}

	node.addEventListener('pointerdown', down);
	return {
		/** @param {ReorderOptions} next */
		update(next) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			finish();
		}
	};
}
