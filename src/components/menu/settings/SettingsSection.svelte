<script lang="ts">
	// 36 B14 — one Settings section (a CATEGORY page). A drop-in for flowbite's AccordionItem
	// (Settings.svelte imports it UNDER THAT NAME, so every `<AccordionItem bind:open={…}>{#snippet
	// header()}…{/snippet}` block, including ones other lanes add, keeps working unchanged) that
	// registers itself with the sidebar (`$lib/settingsNav`). As before the body is mounted only while
	// `open`, and the header SNIPPET is rendered once, by the sidebar (it is the section's name there,
	// and any id / data-tour it carries stays unique); the title here is its text.
	//
	// 37-settings (R21): the page. A title + one-line description (desktop; on a phone the nav bar
	// carries the title), the breadcrumb + back while a SUB-PAGE is open ("VR › Remap buttons"),
	// and on a phone the quiet "Reset <Category> to defaults" + "Changes save automatically" at the
	// end of the page (the desktop has them in the window's footer). While searching the title is a
	// PATH button ("Interface ›") that jumps to the page, and every card label is prefixed with it.
	import { getContext, onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import { NAV_CONTEXT, sectionKeyOf } from '$lib/settingsNav';
	import { categoryMeta } from '$lib/settings/categories.js';
	import { canResetCategory, askResetCategory } from '$lib/settings/resetCategory.js';
	import Icon from '../../ui/Icon.svelte';
	import Button from '../../ui/Button.svelte';

	let {
		open = $bindable(false),
		header,
		children
	}: { open?: boolean; header?: Snippet; children?: Snippet } = $props();

	const nav: any = getContext(NAV_CONTEXT);
	let page: HTMLElement | null = $state(null);
	/** the header's text, read off the sidebar row once it renders */
	let label = $state('');
	const entry = {
		get header() {
			return header;
		},
		get label() {
			return label;
		},
		set label(v: string) {
			label = v;
		},
		isOpen: () => open,
		setOpen: (v: boolean) => (open = v),
		el: () => page
	};
	const off = nav?.register(entry);
	onDestroy(() => off?.());

	const key = $derived(sectionKeyOf(label));
	const meta = $derived(categoryMeta(key));
	const sub = nav?.sub;
	const searching = nav?.searching;
	const active = nav?.active;
	const isActive = $derived($active === entry);
	const subpage = $derived(isActive && !$searching ? $sub : null);
	/** a CSS string literal for the search-mode path prefix on the card labels */
	const pathCss = $derived(`'${label.replace(/['\\]/g, '')} › '`);
</script>

{#if open}
	<div class="ss-page" data-section={key} bind:this={page} style:--ss-path={pathCss}>
		<header class="ss-head">
			{#if $searching}
				<h2 class="ss-title ss-path">
					<button type="button" class="ss-path-btn" title={'Go to ' + label} onclick={() => nav?.jumpTo?.(key)}>{label} ›</button>
				</h2>
			{:else if subpage}
				<nav class="ss-crumb" aria-label="Breadcrumb">
					<button type="button" class="ss-back" aria-label={'Back to ' + label} onclick={() => nav.closeSub()}>
						<Icon name="chevron-left" size={16} strokeWidth={1.75} />
					</button>
					<button type="button" class="ss-crumb-parent" onclick={() => nav.closeSub()}>{label}</button>
					<span class="ss-crumb-sep" aria-hidden="true">›</span>
					<h2 class="ss-title" aria-current="page">{subpage.label}</h2>
				</nav>
			{:else}
				<h2 class="ss-title">{label}</h2>
				{#if meta.description}<p class="ss-desc">{meta.description}</p>{/if}
			{/if}
		</header>
		<div class="ss-body">{@render children?.()}</div>
		{#if !$searching && !subpage && canResetCategory(key)}
			<div class="ss-end">
				<Button variant="warn-text" size="sm" id={'settings-reset-' + key + '-end'} onclick={() => askResetCategory(key, label)}>Reset {label} to defaults</Button>
				<span class="ss-note">Changes save automatically</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	.ss-page {
		max-width: 660px;
		padding-bottom: 8px;
	}
	.ss-head {
		margin: 0 0 18px;
	}
	.ss-title {
		margin: 0;
		font-size: var(--fs-page-title);
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.25;
		color: var(--text);
		scroll-margin-top: 8px;
	}
	.ss-desc {
		margin: 6px 0 0;
		font-size: var(--fs-body);
		color: var(--text-muted);
	}
	.ss-body {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}
	/* the breadcrumb: ‹  Controls › Gamepad */
	.ss-crumb {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.ss-crumb .ss-title {
		font-size: var(--fs-modal-title);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ss-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		margin-left: -6px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.ss-back:hover,
	.ss-crumb-parent:hover {
		background: var(--surface-hover);
	}
	.ss-crumb-parent {
		padding: 2px 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		font-size: var(--fs-modal-title);
		color: var(--text-muted);
		cursor: pointer;
	}
	.ss-crumb-sep {
		color: var(--text-faint);
		font-size: var(--fs-modal-title);
	}
	/* searching: the page title is a small PATH (it jumps to the page), the card labels carry it */
	.ss-path {
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
	}
	.ss-path-btn {
		padding: 2px 4px;
		margin-left: -4px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: var(--accent-text);
		cursor: pointer;
	}
	.ss-path-btn:hover {
		background: var(--surface-hover);
	}
	/* the phone's end-of-page reset (the desktop has it in the footer) */
	.ss-end {
		display: none;
	}
	@media (max-width: 639.98px) {
		.ss-page {
			max-width: none;
		}
		/* the nav bar is the title on a phone — don't repeat it */
		.ss-head:not(:has(.ss-path)) {
			display: none;
		}
		.ss-end {
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			gap: 6px;
			margin-top: 26px;
		}
		.ss-note {
			font-size: var(--fs-desc);
			color: var(--text-faint);
		}
	}
</style>
