<script>
	// 38 R5 — the Inspector's sticky top. `#drawer-label` (the sticky block Section deep links
	// measure) and `#inspector-search` keep their ids for every caller and suite.
	//
	// 78-int PL14 (scene panel item 1, owner APPROVED 2026-11-08): ONE HEADER. The inner title row
	// (icon · title · kind badge · pin · close) is gone — the tab that hosts the panel owns the title
	// and its ✕ (the sidebar strip on a wider screen, the dock tab row on a phone). What it carried
	// moved:
	//   · pin ("Follow the selection", id `#inspector-pin`) = a sidebar STRIP button (SidebarStrips);
	//     on the phone the first item of the tab's long-press menu ($lib/dockMenu dockTabItems);
	//   · the 42 I1 header lock = the strip (43 J6, unchanged) / the phone's sheet-grip row
	//     (InspectorLock in SheetGrip's `end`);
	//   · the object's name = the first Properties row (its Name field), the kind = a small badge at
	//     the end of the filter row (a selection only: "Mesh", "3 objects");
	//   · a pop-out window (70 W2) has no strip: its pin sits at the end of the filter row.
	// The filter placeholder says what it filters.
	import SearchField from '../../ui/SearchField.svelte';
	import Badge from '../../ui/Badge.svelte';
	import InspectorPin from './InspectorPin.svelte';
	import { inspectorFilter } from '../../../stores/appStore';
	import { stickyPanelHeads } from '$lib/panelHeaderPrefs';

	/** @type {{badge?: string, filter?: boolean, placeholder?: string, panel?: 'scene'|'properties'|'', popped?: boolean}} */
	let { badge = '', filter = false, placeholder = 'Filter properties', panel = '', popped = false } = $props();

	/** 42 I1: does this panel's header stick (the default) or scroll away with the content */
	const sticky = $derived(!panel || $stickyPanelHeads[panel] !== false);
</script>

{#if filter || badge}
	<div id="drawer-label" class="tp-ui ins-head" class:ins-head-flow={!sticky} data-sticky={sticky ? 'true' : 'false'}>
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
			{#if popped && panel}<InspectorPin />{/if}
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
	/* 42 I1: unstuck — the header is the first thing in the scroller and scrolls away with it */
	.ins-head-flow {
		position: relative;
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
