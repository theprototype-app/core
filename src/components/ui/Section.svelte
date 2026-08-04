<script>
	// Labelled group. PFX-C follow-up: COLLAPSIBLE by default (chevron header,
	// state persisted per label) and aware of the Inspector property SEARCH —
	// while $inspectorFilter is non-empty every section force-renders its
	// content (so hidden rows are searchable), matches the query against its
	// rendered TEXT, and hides itself when nothing matches.
	import { inspectorFilter, inspectorScrollTo } from '../../stores/appStore';

	/** @type {{label?: string, collapsible?: boolean, open?: boolean, children?: any}} */
	let { label = '', collapsible = true, open = $bindable(true), children = null } = $props();

	const LS = typeof localStorage !== 'undefined' ? localStorage : null;
	// persisted collapse, keyed by the section label (static per instance — a
	// deliberate one-time read)
	// svelte-ignore state_referenced_locally
	let collapsed = $state(LS?.getItem('inspector:sec:' + label) === 'closed');
	function toggle() {
		collapsed = !collapsed;
		try {
			LS?.setItem('inspector:sec:' + label, collapsed ? 'closed' : 'open');
		} catch {}
	}

	/** @type {any} */ let root = $state(null);
	let match = $state(true);
	$effect(() => {
		const q = $inspectorFilter.trim().toLowerCase();
		if (!q) {
			match = true;
			return;
		}
		// the rendered text IS the search index — labels, values, hints all count
		match = (label + ' ' + (root?.textContent ?? '')).toLowerCase().includes(q);
	});

	const filtering = $derived($inspectorFilter.trim().length > 0);
	const showContent = $derived(filtering ? true : !collapsible || (open && !collapsed));

	// 16-Q2: a menu deep link ("More snapping settings…") names a section — expand it
	// even if the user had collapsed it, scroll it into view, then clear the request
	// so it fires exactly once.
	$effect(() => {
		const request = $inspectorScrollTo;
		// a request is either "Grid" or "Camera:Saved views" (section:sub-anchor)
		const [wanted, anchor] = String(request ?? '').split(':');
		if (!request || wanted !== label) return;
		collapsed = false;
		try {
			LS?.setItem('inspector:sec:' + label, 'open');
		} catch {}
		const node = root;
		requestAnimationFrame(() => {
			// 16-Q5: scroll the CONTAINER, offset by the sticky header (title + property
			// filter) — plain scrollIntoView tucked the section label underneath it, so
			// you landed on the section's first row with no idea where you were.
			const target = (anchor ? node?.querySelector(`[data-anchor="${anchor}"]`) : null) ?? node;
			const scroller = node?.closest('.overflow-y-auto, .overflow-auto') ?? null;
			const sticky = scroller?.querySelector('#drawer-label');
			const pad = (sticky?.getBoundingClientRect().height ?? 0) + 10;
			if (scroller && target) {
				const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
				scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - pad), behavior: 'smooth' });
			} else {
				target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
			}
		});
		inspectorScrollTo.set(null);
	});
</script>

<div class="border-b border-gray-700/40 pb-2" class:hidden={filtering && !match} bind:this={root}>
	{#if collapsible && !filtering}
		<button
			class="ui-section-label flex w-full items-center justify-between hover:text-gray-200"
			onclick={toggle}
		>
			<span>{label}</span>
			<span class="text-gray-500">{showContent ? '−' : '+'}</span>
		</button>
	{:else}
		<p class="ui-section-label">{label}</p>
	{/if}
	{#if showContent}
		<div class="flex flex-col gap-1 px-1">
			{@render children?.()}
		</div>
	{/if}
</div>
