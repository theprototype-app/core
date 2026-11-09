// 38 NOTES-38 #39 — any toolbar or tab strip that can overflow scrolls sideways: a touch swipe
// (native overflow-x), the mouse wheel (vertical wheel → horizontal scroll, only while the strip
// actually overflows), and a fade on the edge that has more behind it, so nothing is unreachable
// and the user can SEE there is more. `use:stripScroll` on the scrolling element (overflow-x:
// auto; pair it with `tp-noscrollbar` — the strip shows no bar, NOTES-38 #1).
// The fade classes (`strip-fade-l` / `strip-fade-r`) are styled in styles/windows.css.
//
// panel-gestures item 7 (owner, N6): "on docked panels a vertical drag moves the tabs up / down like
// a menu" — `overflow-x: auto` computes overflow-y to auto too, so a row a pixel taller than its box
// scrolled VERTICALLY under a finger. Every strip is one row: overflow-y hidden, touch-action pan-x
// (a sideways swipe is the browser's own scroll; up / down on a strip does nothing), and the
// sideways overscroll stays in the strip instead of swiping the page back.

/** @param {HTMLElement} node */
export function stripScroll(node) {
	if (typeof window === 'undefined') return {};
	node.style.setProperty('overflow-y', 'hidden');
	node.style.setProperty('touch-action', 'pan-x');
	node.style.setProperty('overscroll-behavior-x', 'contain');
	const edges = () => {
		const more = node.scrollWidth - node.clientWidth;
		node.classList.toggle('strip-fade-l', more > 1 && node.scrollLeft > 1);
		node.classList.toggle('strip-fade-r', more > 1 && node.scrollLeft < more - 1);
	};
	/** @param {WheelEvent} e */
	const wheel = (e) => {
		if (node.scrollWidth <= node.clientWidth + 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
		node.scrollLeft += e.deltaY;
		e.preventDefault();
	};
	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(edges) : null;
	ro?.observe(node);
	const mo = new MutationObserver(edges);
	mo.observe(node, { childList: true, subtree: true });
	node.addEventListener('scroll', edges, { passive: true });
	node.addEventListener('wheel', wheel, { passive: false });
	edges();
	return {
		destroy() {
			ro?.disconnect();
			mo.disconnect();
			node.removeEventListener('scroll', edges);
			node.removeEventListener('wheel', wheel);
			node.classList.remove('strip-fade-l', 'strip-fade-r');
		}
	};
}
