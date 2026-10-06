<script>
	// Labelled group. PFX-C follow-up: COLLAPSIBLE by default (chevron header,
	// state persisted per label) and aware of the Inspector property SEARCH —
	// while $inspectorFilter is non-empty every section force-renders its
	// content (so hidden rows are searchable), matches the query against its
	// rendered TEXT, and hides itself when nothing matches.
	//
	// 38 R3 (SPEC §2 Section): two redesign variants beside the legacy look (the DEFAULT —
	// every existing caller renders byte-identical until its lane opts in):
	//   variant="card"   Settings: uppercase header + optional scope badge + ONE card whose
	//                    rows are split by 1px dividers. Never collapses, and is NOT wired to
	//                    the Inspector's filter or deep links (a Settings card named "Grid"
	//                    must not answer — and clear — the Inspector's "Grid" request).
	//   variant="panel"  Inspector / panels: collapsible uppercase header with a chevron and
	//                    an optional badge; same filter + deep-link + persisted collapse as legacy.
	import { inspectorFilter, inspectorScrollTo } from '../../stores/appStore';
	import Icon from './Icon.svelte';
	import Badge from './Badge.svelte';

	/**
	 * P6: `aliases` are OLD deep-link names this section still answers to. A section's
	 * label is user-visible copy and its deep-link name is an identifier written down in
	 * menus, other components and suites — the 21-G1 rule is that the word may change and
	 * the identifier may not, so a rename lists what it used to be called instead of
	 * hunting every caller (and silently missing one).
	 * @type {{label?: string, aliases?: string[], collapsible?: boolean, open?: boolean, variant?: 'legacy'|'card'|'panel', badge?: string, children?: any}}
	 */
	let {
		label = '',
		aliases = [],
		collapsible = true,
		open = $bindable(true),
		variant = 'legacy',
		badge = '',
		children = null
	} = $props();
	const isCard = $derived(variant === 'card');

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
		const q = isCard ? '' : $inspectorFilter.trim().toLowerCase();
		if (!q) {
			match = true;
			return;
		}
		// the rendered text IS the search index — labels, values, hints all count
		match = (label + ' ' + (root?.textContent ?? '')).toLowerCase().includes(q);
	});

	const filtering = $derived(!isCard && $inspectorFilter.trim().length > 0);
	const showContent = $derived(filtering ? true : !collapsible || (open && !collapsed));

	// 16-Q2: a menu deep link ("More snapping settings…") names a section — expand it
	// even if the user had collapsed it, scroll it into view, then clear the request
	// so it fires exactly once.
	$effect(() => {
		const request = $inspectorScrollTo;
		// a request is either "Grid" or "Camera:Saved views" (section:sub-anchor)
		const [wanted, anchor] = String(request ?? '').split(':');
		if (isCard || !request || (wanted !== label && !aliases.includes(wanted))) return;
		collapsed = false;
		try {
			LS?.setItem('inspector:sec:' + label, 'open');
		} catch {}
		const node = root;
		// 16-Q6: measure → scroll → re-measure → correct. The old single-shot version
		// could fire before the just-expanded content had laid out, and a `smooth`
		// scroll could be cancelled by that very reflow — so the label sometimes ended
		// up under the sticky header (or nowhere). The scroller is found by real
		// SCROLLABILITY, not class names.
		const findScroller = () => {
			let el = node?.parentElement;
			while (el) {
				const overflow = getComputedStyle(el).overflowY;
				if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
				el = el.parentElement;
			}
			return null;
		};
		/** the label to land on: a named sub-heading, else the section itself */
		const findTarget = () => (anchor ? node?.querySelector(`[data-anchor="${anchor}"]`) : null) ?? node;

		let attempts = 0;
		const settle = () => {
			const scroller = findScroller();
			const target = findTarget();
			if (!scroller || !target) {
				// the section (or its anchor) may still be rendering after expanding
				if (attempts++ < 12) requestAnimationFrame(settle);
				else target?.scrollIntoView({ block: 'start' });
				return;
			}
			// the sticky title + property filter sit ON TOP of the scroll area
			const sticky = scroller.querySelector('#drawer-label');
			const pad = (sticky?.getBoundingClientRect().height ?? 0) + 8;
			const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad;
			if (Math.abs(delta) > 2) {
				// instant, not smooth: a reflow mid-animation used to cancel it
				scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
			}
			// verify once more next frame — expanding a section changes heights under us
			if (attempts++ < 6) requestAnimationFrame(settle);
		};
		requestAnimationFrame(settle);
		inspectorScrollTo.set(null);
	});
</script>

{#if variant === 'card'}
	<section class="tp-ui sec-card-wrap" bind:this={root}>
		<div class="sec-card-head">
			<h3 class="sec-title" data-section-label>{label}</h3>
			{#if badge}<Badge tone="scope" text={badge} />{/if}
		</div>
		<div class="sec-card">
			{@render children?.()}
		</div>
	</section>
{:else if variant === 'panel'}
	<section class="tp-ui sec-panel" class:hidden={filtering && !match} bind:this={root}>
		{#if collapsible && !filtering}
			<button type="button" class="sec-panel-head" aria-expanded={showContent} onclick={toggle}>
				<span class="sec-chev" class:sec-chev-open={showContent} aria-hidden="true"><Icon name="chevron-right" size={16} strokeWidth={1.75} /></span>
				<span class="sec-title ui-section-label">{label}</span>
				{#if badge}<Badge tone="scope" text={badge} />{/if}
			</button>
		{:else}
			<div class="sec-panel-head sec-static">
				<span class="sec-title ui-section-label">{label}</span>
				{#if badge}<Badge tone="scope" text={badge} />{/if}
			</div>
		{/if}
		{#if showContent}
			<div class="sec-panel-body">
				{@render children?.()}
			</div>
		{/if}
	</section>
{:else}
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
{/if}

<style>
	/* ---- variant="card" (Settings) ---- */
	.sec-card-wrap {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.sec-card-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0 2px;
	}
	/* a panel title also wears `ui-section-label` — the HOOK the Inspector's deep links,
	   the behaviour lock and the suites read section names through (its utility look is
	   overridden here: these scoped rules are unlayered, so they win) */
	.sec-title {
		margin: 0;
		padding: 0;
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.sec-card {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		overflow: hidden;
	}
	/* 1px dividers between the card's rows, whatever they are (SettingRow, NavRow …) */
	.sec-card > :global(* + *) {
		border-top: 1px solid var(--border);
	}
	@media (max-width: 639.98px) {
		.sec-card {
			border-radius: var(--radius-window);
		}
	}

	/* ---- variant="panel" (Inspector / panels) ---- */
	.sec-panel {
		display: flex;
		flex-direction: column;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border);
	}
	/* the filter's `hidden` (a Tailwind utility, LAYERED) loses to this file's unlayered
	   `display: flex` — say it here, or a filtered-out panel section never hides */
	.sec-panel.hidden {
		display: none;
	}
	.sec-panel-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		height: var(--row-h);
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.sec-panel-head:hover .sec-title {
		color: var(--text-2);
	}
	.sec-static {
		cursor: default;
	}
	.sec-chev {
		display: inline-flex;
		transition: transform 0.15s ease;
	}
	.sec-chev-open {
		transform: rotate(90deg);
	}
	.sec-panel-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	@media (prefers-reduced-motion: reduce) {
		.sec-chev {
			transition: none;
		}
	}
</style>
