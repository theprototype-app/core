// 38 NOTES-38 #1 — "no native scrollbars anywhere; the app's minimal scrollbar". ONE action for
// every scroller in the redesign: `<div use:minimalScroll>` hides the platform scrollbar on that
// element and draws a thin overlay thumb instead — invisible at rest, shown while the element
// scrolls or the pointer is over it, gone ~0.9 s after. The thumb is draggable; the wheel, the
// keyboard, touch and `scrollTop` writes scroll exactly as before (the element is still the
// native scroller — only its bar is replaced), so nothing that scrolls changes behaviour.
//
// Self-contained on purpose (no shared stylesheet edit): the one global rule it needs — hide the
// native bar on `.tp-scroll` — is injected once into <head>. The thumb paints from tokens
// (--text-faint), so every theme and a custom .theme.json restyle it. Vertical only (every
// redesigned scroller is a column); a horizontal native bar is left alone.

const STYLE_ID = 'tp-minimal-scroll-style';
const CSS = `
.tp-scroll{scrollbar-width:none;-ms-overflow-style:none}
.tp-scroll::-webkit-scrollbar{display:none;width:0;height:0}
.tp-scroll-thumb{position:absolute;right:2px;top:0;width:6px;border-radius:999px;
background:color-mix(in srgb,var(--text-faint) 55%,transparent);opacity:0;
transition:opacity .2s ease,width .12s ease;z-index:5;touch-action:none;cursor:default}
.tp-scroll-thumb[data-on]{opacity:1}
.tp-scroll-thumb:hover,.tp-scroll-thumb[data-drag]{width:8px;background:color-mix(in srgb,var(--text-faint) 80%,transparent)}
@media (prefers-reduced-motion:reduce){.tp-scroll-thumb{transition:none}}
`;

function ensureStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

/** Pure geometry, exported for the unit test: where the thumb sits for a scroll state.
 * @param {{scrollTop: number, scrollHeight: number, clientHeight: number}} s
 * @param {number} [min] smallest thumb, px
 * @param {number} [topInset] px of the viewport a sticky header covers (uir-polish E6): the track starts below it
 * @returns {{visible: boolean, top: number, height: number}} `top` is in CONTENT coordinates
 *   (the thumb is a child of the scroller, so it scrolls with the content and is offset back) */
export function thumbGeometry(s, min = 24, topInset = 0) {
	const { scrollTop, scrollHeight, clientHeight } = s;
	const range = scrollHeight - clientHeight;
	if (!(range > 1) || clientHeight <= 0) return { visible: false, top: 0, height: 0 };
	const inset = 2;
	const top0 = Math.max(0, Math.min(topInset, clientHeight - inset * 2 - min));
	const track = clientHeight - inset * 2 - top0;
	const height = Math.max(min, Math.min(track, (clientHeight / scrollHeight) * track));
	const t = Math.min(1, Math.max(0, scrollTop / range));
	return { visible: true, top: scrollTop + top0 + inset + t * (track - height), height };
}

/**
 * @param {HTMLElement} node the scrolling element
 * @param {{hideAfter?: number, stickyTop?: string} | undefined} [opts] `stickyTop` = a selector for a sticky
 *   header INSIDE the scroller (uir-polish E6): the thumb runs below it instead of sliding under it
 */
export function minimalScroll(node, opts) {
	if (typeof window === 'undefined') return {};
	ensureStyle();
	let hideAfter = opts?.hideAfter ?? 900;
	let stickyTop = opts?.stickyTop ?? '';
	/** how much of the scroller's viewport the sticky header covers (0 without one) */
	function topInset() {
		if (!stickyTop) return 0;
		const head = /** @type {HTMLElement | null} */ (node.querySelector(stickyTop));
		if (!head || !head.offsetParent) return 0;
		const r = head.getBoundingClientRect();
		const n = node.getBoundingClientRect();
		return Math.max(0, Math.round(r.bottom - n.top - node.clientTop));
	}
	let inset0 = 0;
	node.classList.add('tp-scroll');
	if (getComputedStyle(node).position === 'static') node.style.position = 'relative';

	const thumb = document.createElement('div');
	thumb.className = 'tp-scroll-thumb';
	thumb.setAttribute('aria-hidden', 'true');
	node.appendChild(thumb);

	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	let hover = false;
	let geo = { visible: false, top: 0, height: 0 };

	function place() {
		// 41b H10: the thumb is a CHILD of the scroller, so while it is laid out it is part of the
		// scrollable overflow. A list that shrank under a scrolled view (Modules: Browse scrolled
		// down, then Core) kept its old height through the thumb, and every scroll event moved
		// the thumb up by its inset — the view drained 2 px a frame for seconds, items out of
		// sight above. Measure with the thumb out of layout: the offset clamps at once.
		thumb.style.display = 'none';
		inset0 = topInset();
		geo = thumbGeometry(node, 24, inset0);
		thumb.style.display = geo.visible ? '' : 'none';
		if (!geo.visible) return;
		thumb.style.height = geo.height + 'px';
		thumb.style.transform = `translateY(${geo.top}px)`;
	}
	function show() {
		place();
		if (!geo.visible) return;
		thumb.setAttribute('data-on', '');
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (!hover && !thumb.hasAttribute('data-drag')) thumb.removeAttribute('data-on');
		}, hideAfter);
	}

	const onScroll = () => show();
	const onEnter = () => {
		hover = true;
		show();
	};
	const onLeave = () => {
		hover = false;
		show();
	};

	/** dragging the thumb maps pointer travel onto scrollTop */
	let dragY = 0;
	let dragTop = 0;
	/** @param {PointerEvent} e */
	function onDown(e) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		dragY = e.clientY;
		dragTop = node.scrollTop;
		thumb.setAttribute('data-drag', '');
		thumb.setPointerCapture?.(e.pointerId);
	}
	/** @param {PointerEvent} e */
	function onMove(e) {
		if (!thumb.hasAttribute('data-drag')) return;
		const track = node.clientHeight - 4 - inset0 - geo.height;
		const range = node.scrollHeight - node.clientHeight;
		if (track > 0) node.scrollTop = dragTop + ((e.clientY - dragY) / track) * range;
	}
	/** @param {PointerEvent} e */
	function onUp(e) {
		if (!thumb.hasAttribute('data-drag')) return;
		thumb.removeAttribute('data-drag');
		thumb.releasePointerCapture?.(e.pointerId);
		show();
	}

	node.addEventListener('scroll', onScroll, { passive: true });
	node.addEventListener('pointerenter', onEnter);
	node.addEventListener('pointerleave', onLeave);
	thumb.addEventListener('pointerdown', onDown);
	thumb.addEventListener('pointermove', onMove);
	thumb.addEventListener('pointerup', onUp);
	thumb.addEventListener('pointercancel', onUp);
	// content or box size changes move the thumb (a list that grows, a window resize)
	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
	ro?.observe(node);
	const mo = new MutationObserver(() => {
		// keep the thumb the LAST child so a {#each} appending rows never lands after it in a
		// layout that cares, and re-measure
		if (node.lastElementChild !== thumb) node.appendChild(thumb);
		place();
	});
	mo.observe(node, { childList: true, subtree: true });
	place();

	return {
		/** @param {{hideAfter?: number, stickyTop?: string} | undefined} next */
		update(next) {
			hideAfter = next?.hideAfter ?? 900;
			stickyTop = next?.stickyTop ?? '';
			place();
		},
		destroy() {
			if (timer) clearTimeout(timer);
			ro?.disconnect();
			mo.disconnect();
			node.removeEventListener('scroll', onScroll);
			node.removeEventListener('pointerenter', onEnter);
			node.removeEventListener('pointerleave', onLeave);
			thumb.remove();
			node.classList.remove('tp-scroll');
		}
	};
}
