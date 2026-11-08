// dock-fixes (device lab, folded N6 "Ava" + PC-4 Objects chips "St…"): a strip that scrolls with its scrollbar hidden
// reads as a CUT word at its edge. The edge that has more to scroll FADES — the scroll cue. The fade itself is
// `[data-fade]` in styles/ui.utilities.css, so any horizontal scroller opts in with `use:edgeFade`.

// 98-int (device lab UI-6, the main menu at 1280: "Tour the interface" below the screen, no scroll hint): `'y'` fades
// a VERTICAL scroller's top / bottom edge the same way (`[data-fade-y]`).
/** @param {HTMLElement} node @param {'x' | 'y' | 'off'} [axis] ('off': no cue — the phone sheet's grip sits at its top) */
export function edgeFade(node, axis = 'x') {
	const update = () => {
		if (axis === 'off') {
			delete node.dataset.fade;
			delete node.dataset.fadeY;
			return;
		}
		const y = axis === 'y';
		const more = y ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
		const at = y ? node.scrollTop : node.scrollLeft;
		const start = more > 1 && at > 1;
		const end = more > 1 && at < more - 1;
		node.dataset[y ? 'fadeY' : 'fade'] = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
	};
	const ro = new ResizeObserver(update);
	ro.observe(node);
	// a chip appearing or hiding changes scrollWidth without resizing the strip itself
	const mo = new MutationObserver(update);
	mo.observe(node, { childList: true, subtree: true });
	node.addEventListener('scroll', update, { passive: true });
	update();
	return {
		/** @param {'x' | 'y' | 'off'} [next] */
		update(next = 'x') {
			axis = next;
			delete node.dataset.fade;
			delete node.dataset.fadeY;
			update();
		},
		destroy() {
			ro.disconnect();
			mo.disconnect();
			node.removeEventListener('scroll', update);
		}
	};
}
