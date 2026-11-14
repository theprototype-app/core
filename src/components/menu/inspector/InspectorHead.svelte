<script>
	// 38 R5 — the Inspector's sticky top. `#drawer-label` (the sticky block Section deep links
	// measure) and `#inspector-search` keep their ids for every caller and suite.
	//
	// 78-int PL14 (scene panel item 1, owner APPROVED 2026-11-08): ONE HEADER. The inner title row
	// (icon · title · kind badge · pin · close) is gone — the tab that hosts the panel owns the title
	// and its ✕ (the sidebar strip on a wider screen, the dock tab row on a phone). What it carried
	// moved:
	//   · the pin and the 42 I1 header lock are GONE (uir-polish E1/E2, owner 2026-11-11): this row is
	//     always sticky, and Properties keeps showing the last object after a deselect;
	//   · the object's name = the first Properties row (its Name field), the kind = a small badge at
	//     the end of the filter row (a selection only: "Mesh", "3 objects");
	// The filter placeholder says what it filters (Properties: the object's name alone, E2).
	import SearchField from '../../ui/SearchField.svelte';
	import Badge from '../../ui/Badge.svelte';
	import { inspectorFilter } from '../../../stores/appStore';

	/** @type {{badge?: string, filter?: boolean, placeholder?: string, panel?: 'scene'|'properties'|'', popped?: boolean}} */
	let { badge = '', filter = false, placeholder = 'Filter properties', panel = '', popped = false } = $props();

</script>

{#if filter || badge}
	<div id="drawer-label" class="tp-ui ins-head" data-sticky="true" data-panel={panel || null}>
		<div class="ins-filter">
			{#if filter}
				<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
				<div class="ins-filter-field">
					<SearchField
						id="inspector-search"
						size="sm"
						{placeholder}
						value={$inspectorFilter}
						oninput={(v) => inspectorFilter.set(v)}
						onkeydown={(/** @type {KeyboardEvent} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
					/>
				</div>
			{/if}
			{#if badge}<Badge tone="neutral" text={badge} data-inspector-badge />{/if}
		</div>
	</div>
{/if}

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
	.ins-filter {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 10px 14px;
	}
	.ins-filter-field {
		flex: 1 1 auto;
		min-width: 0;
	}
</style>
