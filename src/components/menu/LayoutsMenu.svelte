<script>
	// 37 R14 — the Layouts popover the burger menu opens: the saved layouts + "save the
	// current layout", without going through Settings. Closes on Escape / an outside press.
	import { X } from '@lucide/svelte';
	import WorkspaceLayouts from './WorkspaceLayouts.svelte';
	import { layoutsMenuOpen } from '$lib/uiLayouts';

	/** @type {HTMLElement|null} */
	let panel = $state(null);

	/** @param {PointerEvent} e */
	function outside(e) {
		if (!$layoutsMenuOpen || !panel) return;
		if (panel.contains(/** @type {Node} */ (e.target))) return;
		if (/** @type {HTMLElement} */ (e.target)?.closest?.('#open-layouts')) return;
		layoutsMenuOpen.set(false);
	}
</script>

<svelte:window
	onpointerdown={outside}
	onkeydown={(e) => {
		if ($layoutsMenuOpen && e.key === 'Escape') layoutsMenuOpen.set(false);
	}}
/>

{#if $layoutsMenuOpen}
	<div id="layouts-menu" class="layouts-menu ui-panel" role="region" aria-label="Workspace layouts" bind:this={panel}>
		<div class="lm-head">
			<span class="lm-title">Workspace layouts</span>
			<button class="lm-close" title="Close" aria-label="Close" onclick={() => layoutsMenuOpen.set(false)}><X size={14} aria-hidden="true" /></button>
		</div>
		<WorkspaceLayouts idPrefix="layouts-menu" />
	</div>
{/if}

<style>
	.layouts-menu {
		position: fixed;
		top: 64px;
		left: 16px;
		width: min(300px, calc(100vw - 32px));
		padding: 10px;
		z-index: var(--z-modal);
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		border: 1px solid var(--border, #374151);
	}
	.lm-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.lm-title {
		font-size: 0.85rem;
		font-weight: 600;
	}
	.lm-close {
		display: inline-flex;
		padding: 3px;
		color: var(--muted, #9ca3af);
		background: transparent;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
	}
	.lm-close:hover {
		color: var(--text, #e5e7eb);
	}
</style>
