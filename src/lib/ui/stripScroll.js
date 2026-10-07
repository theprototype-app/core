// 38 NOTES-38 #39 — any toolbar or tab strip that can overflow scrolls sideways: a touch swipe
// (native overflow-x), the mouse wheel (vertical wheel → horizontal scroll, only while the strip
// actually overflows), and a fade on the edge that has more behind it, so nothing is unreachable
// and the user can SEE there is more. `use:stripScroll` on the scrolling element (overflow-x:
// auto; pair it with `tp-noscrollbar` — the strip shows no bar, NOTES-38 #1).
// The fade classes (`strip-fade-l` / `strip-fade-r`) are styled in styles/windows.css.

/** @param {HTMLElement} node */
export function stripScroll(node) {
	if (typeof window === 'undefined') return {};
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
