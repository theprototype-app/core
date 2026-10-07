<script>
	// 38 NOTES-38 #39 — ONE strip for every toolbar or tab row that can run out of width:
	// it scrolls sideways (a touch drag, a trackpad swipe, a mouse wheel) and FADES the edge
	// that still hides something, so nothing is ever unreachable and the cut-off is visible.
	// While the row fits, it is a plain flex row: no fade, no scroll, nothing changes — which is
	// what keeps desktop layouts byte-for-byte where they were.
	//
	// The fade is a mask on the scroller, decided per side from the scroll position
	// (`data-fade="start|end|both"`), so a strip scrolled to its end does not fade the last
	// tool. Keep anything that must stay visible (a pinned "+", a close button) OUTSIDE the
	// strip — the shell tab strips do exactly that (NOTES-38 #29).
	//
	// Focus: a keyboard step onto a hidden child scrolls it into view (the browser does this for
	// a focusable child of a scroller); `reveal` additionally brings the element matching a
	// selector into view when it changes (a selected tab, an armed tool).
	import { onMount } from 'svelte';

	/** @type {{gap?: string, label?: string, role?: string, reveal?: string, fade?: number, class?: string, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		gap = 'var(--space-1)',
		label = '',
		role = undefined,
		reveal = '',
		fade = 24,
		class: cls = '',
		children = undefined,
		...rest
	} = $props();

	/** @type {HTMLDivElement | undefined} */
	let el = $state();
	let fadeSide = $state('');

	function measure() {
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		if (max <= 1) {
			fadeSide = '';
			return;
		}
		// RTL scrollLeft runs negative; the strip only ever needs "is there more this way"
		const x = Math.abs(el.scrollLeft);
		const start = x > 1;
		const end = x < max - 1;
		fadeSide = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
	}

	/** a vertical wheel over a strip that overflows scrolls it sideways — a mouse has no
	 *  other way to reach the end. Left alone when the strip fits, or the gesture is
	 *  already horizontal (a trackpad), or it is a zoom (ctrl). @param {WheelEvent} e */
	function onWheel(e) {
		if (!el || e.ctrlKey || el.scrollWidth - el.clientWidth <= 1) return;
		if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
		const before = el.scrollLeft;
		el.scrollLeft += e.deltaY;
		if (el.scrollLeft !== before) e.preventDefault();
	}

	/** bring the `reveal` match into view (centred is wrong for a toolbar: `nearest`) */
	function revealNow() {
		if (!el || !reveal) return;
		const target = /** @type {HTMLElement | null} */ (el.querySelector(reveal));
		if (!target) return;
		const a = target.offsetLeft;
		const b = a + target.offsetWidth;
		if (a < el.scrollLeft) el.scrollLeft = a - fade;
		else if (b > el.scrollLeft + el.clientWidth) el.scrollLeft = b - el.clientWidth + fade;
	}

	onMount(() => {
		if (!el) return;
		measure();
		const ro = new ResizeObserver(() => measure());
		ro.observe(el);
		// the CONTENT changing width (a tool appearing, a label growing) does not resize the
		// scroller itself — watch the children too
		const mo = new MutationObserver(() => {
			for (const c of el?.children ?? []) ro.observe(c);
			measure();
			revealNow();
		});
		for (const c of el.children) ro.observe(c);
		mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'class'] });
		// a DIRECT wheel listener: it must be able to preventDefault (passive: false)
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			ro.disconnect();
			mo.disconnect();
			el?.removeEventListener('wheel', onWheel);
		};
	});
</script>

<div
	bind:this={el}
	class="tp-ui scroll-strip {cls}"
	data-fade={fadeSide || undefined}
	style:--strip-gap={gap}
	style:--strip-fade="{fade}px"
	{role}
	aria-label={label || undefined}
	onscroll={measure}
	{...rest}
>
	{@render children?.()}
</div>

<style>
	.scroll-strip {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: var(--strip-gap);
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		/* a touch drag pans the strip sideways; a vertical drag still reaches the page/sheet */
		touch-action: pan-x pan-y;
		scrollbar-width: none;
		-webkit-overflow-scrolling: touch;
	}
	.scroll-strip::-webkit-scrollbar {
		display: none;
	}
	/* every item keeps its own width: a strip scrolls, it never squeezes or wraps a label */
	.scroll-strip > :global(*) {
		flex-shrink: 0;
	}
	.scroll-strip :global(button),
	.scroll-strip :global(label) {
		white-space: nowrap;
	}
	.scroll-strip[data-fade='end'] {
		mask-image: linear-gradient(to right, black calc(100% - var(--strip-fade)), transparent);
	}
	.scroll-strip[data-fade='start'] {
		mask-image: linear-gradient(to left, black calc(100% - var(--strip-fade)), transparent);
	}
	.scroll-strip[data-fade='both'] {
		mask-image: linear-gradient(
			to right,
			transparent,
			black var(--strip-fade),
			black calc(100% - var(--strip-fade)),
			transparent
		);
	}
</style>
