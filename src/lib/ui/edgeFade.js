// dock-fixes (device lab, folded N6 "Ava" + PC-4 Objects chips "St…"): a strip that scrolls with its scrollbar hidden
// reads as a CUT word at its edge. The edge that has more to scroll FADES — the scroll cue. The fade itself is
// `[data-fade]` in styles/ui.utilities.css, so any horizontal scroller opts in with `use:edgeFade`.

/** @param {HTMLElement} node */
export function edgeFade(node) {
	const update = () => {
		const more = node.scrollWidth - node.clientWidth;
		const start = more > 1 && node.scrollLeft > 1;
		const end = more > 1 && node.scrollLeft < more - 1;
		node.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
	};
	const ro = new ResizeObserver(update);
	ro.observe(node);
	// a chip appearing or hiding changes scrollWidth without resizing the strip itself
	const mo = new MutationObserver(update);
	mo.observe(node, { childList: true, subtree: true });
	node.addEventListener('scroll', update, { passive: true });
	update();
	return {
		destroy() {
			ro.disconnect();
			mo.disconnect();
			node.removeEventListener('scroll', update);
		}
	};
}
