<script>
	// 38 NOTES-38 #39 — the kit COMPONENT for a toolbar or tab row that can run out of width.
	// The behaviour is ONE implementation, `$lib/ui/stripScroll.js` (shared with the dock tabs,
	// floating tab groups and the phone selection strip): it scrolls sideways (a touch drag, a
	// trackpad swipe, a vertical mouse wheel while it overflows) and fades the edge that still
	// hides something (`strip-fade-l` / `strip-fade-r`, styled in styles/windows.css). This
	// component adds the LAYOUT an editor toolbar needs on top of it: a no-wrap flex row whose
	// items keep their own width (a strip scrolls, it never squeezes or wraps a label), no bar
	// (`tp-noscrollbar`). While the row fits it is a plain flex row: no fade, no scroll — which
	// is what keeps desktop layouts where they were.
	//
	// Keep anything that must stay visible (a pinned "+", a close button, REC) OUTSIDE the strip.
	//
	// `reveal` (a selector) brings the matching element into view whenever the content changes
	// (an armed tool, a selected tab); a keyboard step onto a hidden child already scrolls it in.
	import { onMount } from 'svelte';
	import { stripScroll } from '$lib/ui/stripScroll.js';

	/** @type {{gap?: string, label?: string, role?: string, reveal?: string, class?: string, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		gap = 'var(--space-1)',
		label = '',
		role = undefined,
		reveal = '',
		class: cls = '',
		children = undefined,
		...rest
	} = $props();

	/** @type {HTMLDivElement | undefined} */
	let el = $state();

	/** bring the `reveal` match into view (`nearest`, never centred — it is a toolbar) */
	function revealNow() {
		if (!el || !reveal) return;
		const target = /** @type {HTMLElement | null} */ (el.querySelector(reveal));
		if (!target) return;
		const a = target.offsetLeft;
		const b = a + target.offsetWidth;
		if (a < el.scrollLeft) el.scrollLeft = a - 24;
		else if (b > el.scrollLeft + el.clientWidth) el.scrollLeft = b - el.clientWidth + 24;
	}

	onMount(() => {
		if (!el) return;
		const node = el;
		// stripScroll re-measures on its own resize, a child added/removed and a scroll; an item
		// that only CHANGES WIDTH (a readout's text, a label swapping) resizes neither, so the
		// children are watched too and nudge it through the scroll event it already listens to
		const nudge = () => node.dispatchEvent(new Event('scroll'));
		const ro = new ResizeObserver(nudge);
		// 40 F5: a child REMOVED while it is watched is the "ResizeObserver loop completed with
		// undelivered notifications" error: the Explorer's header measured narrow inside a resize
		// pass and unmounted its storage chip, and a detached node's 0x0 notification cannot be
		// delivered in that pass. The MutationObserver below runs at the same microtask checkpoint
		// as the removal, so un-watching there happens before the next gather.
		/** @type {Set<Element>} */
		const watched = new Set();
		const watch = () => {
			for (const c of watched) {
				if (c.parentNode !== node) {
					ro.unobserve(c);
					watched.delete(c);
				}
			}
			for (const c of node.children) {
				if (watched.has(c)) continue;
				watched.add(c);
				ro.observe(c);
			}
		};
		watch();
		const mo = new MutationObserver(() => {
			watch();
			revealNow();
		});
		mo.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
		revealNow();
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
	});
</script>

<div
	bind:this={el}
	class="tp-ui tp-noscrollbar scroll-strip {cls}"
	style:--strip-gap={gap}
	{role}
	aria-label={label || undefined}
	use:stripScroll
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
		/* a touch drag pans the strip sideways; a vertical drag still reaches the page / sheet */
		touch-action: pan-x pan-y;
	}
	/* every item keeps its own width: a strip scrolls, it never squeezes or wraps a label */
	.scroll-strip > :global(*) {
		flex-shrink: 0;
	}
	.scroll-strip :global(button),
	.scroll-strip :global(label) {
		white-space: nowrap;
	}
</style>
