<script>
	// 38 R5 — the Inspector's sticky top: WindowChrome `panel` (icon · title · kind badge ·
	// pin · close) and, below it, the property filter in the one SearchField style. Chrome
	// only: pin/close/filter are the Inspector's own stores, unchanged (SPEC §0) — `#drawer-label`
	// (the sticky block Section deep links measure), `#inspector-pin` and `#inspector-search`
	// keep their ids for every caller and suite.
	import WindowChrome from '../../ui/WindowChrome.svelte';
	import SearchField from '../../ui/SearchField.svelte';
	import Badge from '../../ui/Badge.svelte';
	import { inspectorFilter } from '../../../stores/appStore';

	/** @type {{title?: string, badge?: string, icon?: string, pinned?: boolean, onpin?: (() => void) | null, onclose?: (() => void) | null, filter?: boolean}} */
	let { title = '', badge = '', icon = '', pinned = false, onpin = null, onclose = null, filter = false } = $props();
</script>

<div id="drawer-label" class="tp-ui ins-head">
	<WindowChrome
		size="panel"
		{title}
		{icon}
		body={false}
		{pinned}
		{onpin}
		pinId="inspector-pin"
		pinTitle={pinned
			? 'Unpin — properties then open on double-click or via the context menu'
			: 'Pin — keep this panel open and follow the selection'}
		pinLabel={pinned ? 'Unpin the properties panel' : 'Pin the properties panel'}
		{onclose}
		closeLabel="Close the properties panel"
		style="border: 0; border-radius: 0; background: transparent; overflow: visible"
	>
		{#snippet actions()}
			{#if badge}<Badge tone="neutral" text={badge} data-inspector-badge />{/if}
		{/snippet}
	</WindowChrome>
	{#if filter}
		<div class="ins-filter">
			<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
			<SearchField
				id="inspector-search"
				size="sm"
				placeholder="Filter properties"
				value={$inspectorFilter}
				oninput={(v) => inspectorFilter.set(v)}
				onkeydown={(/** @type {KeyboardEvent} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
			/>
		</div>
	{/if}
</div>

<style>
	/* sticky over the Inspector's scroller, full bleed across its 14px side padding */
	.ins-head {
		position: sticky;
		top: 0;
		z-index: 10;
		margin: 0 -14px;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
	}
	.ins-head :global(.wc-head) {
		border-bottom: 0;
	}
	.ins-filter {
		padding: 0 14px 10px;
	}
</style>
