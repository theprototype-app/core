<script lang="ts">
	// 36 B14 — one Settings section. A drop-in for flowbite's AccordionItem (Settings.svelte imports
	// it UNDER THAT NAME, so every `<AccordionItem bind:open={…}>{#snippet header()}…{/snippet}` block,
	// including ones other lanes add, keeps working unchanged) that registers itself with the
	// sidebar (`$lib/settingsNav`). Same DOM contract as before, which the I4 search filter and a
	// dozen suites read: an `<h2>` holding the header, then the body as its NEXT SIBLING; and, as
	// before, the body is mounted only while `open`. The header SNIPPET is rendered once, by the
	// sidebar (it is the section's name there, and any id / data-tour it carries stays unique);
	// the title here is its text, so a closed section leaves no element behind.
	import { getContext, onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import { NAV_CONTEXT } from '$lib/settingsNav';

	let {
		open = $bindable(false),
		header,
		children
	}: { open?: boolean; header?: Snippet; children?: Snippet } = $props();

	const nav: any = getContext(NAV_CONTEXT);
	let title: HTMLElement | null = $state(null);
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
		el: () => title
	};
	const off = nav?.register(entry);
	onDestroy(() => off?.());
</script>

{#if open}
	<h2 class="ss-title" bind:this={title}>{label}</h2>
	<div class="ss-body">{@render children?.()}</div>
{/if}

<style>
	.ss-title {
		margin: 0 0 8px;
		padding-top: 2px;
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--text, rgb(229 231 235));
		scroll-margin-top: 8px;
	}
	.ss-body {
		margin-bottom: 18px;
	}
</style>
