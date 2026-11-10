<script>
	// 78-int PL14 — the phone's header lock (42 I1 sticky panel header) in the sheet-grip row. The
	// wider screen keeps it in the sidebar strip (SidebarStrips, 43 J6); the id is the same, and only
	// one of the two is ever on screen (the grip row is hidden above 640 px).
	import Icon from '../../ui/Icon.svelte';
	import { stickyPanelHeads, toggleStickyHead } from '$lib/panelHeaderPrefs';

	/** @type {{panel: 'scene' | 'properties'}} */
	let { panel } = $props();
	const sticky = $derived($stickyPanelHeads[panel] !== false);
	const panelName = $derived(panel === 'scene' ? 'Configure Scene' : 'Properties');
</script>

<button
	type="button"
	id="inspector-sticky-head"
	class="ins-lock-btn"
	aria-pressed={sticky}
	aria-label={sticky ? `Let the ${panelName} header scroll away` : `Keep the ${panelName} header on top`}
	title={sticky
		? 'Header stays on top — tap to let it scroll away with the properties'
		: 'Header scrolls away — tap to keep it on top while you scroll'}
	onclick={() => toggleStickyHead(panel)}
>
	<Icon name={sticky ? 'lock' : 'lock-open'} size={16} aria-hidden="true" />
</button>

<style>
	.ins-lock-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 24px;
		border-radius: 6px;
		color: var(--text-muted);
		background: transparent;
		touch-action: manipulation;
	}
	.ins-lock-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
</style>
