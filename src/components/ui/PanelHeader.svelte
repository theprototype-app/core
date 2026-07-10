<script>
	// Shared panel header: [type badge] Title ........ [actions slot] [×]
	// onclose optional — omit it to hide the close button.
	let { title = '', badge = '', onclose = null, children } = $props();
</script>

<div class="ui-panel-header">
	{#if badge}
		<span class="ui-badge-type">{badge}</span>
	{/if}
	<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
	{@render children?.()}
	{#if onclose}
		<button class="ui-button-quiet" title="Close" onclick={onclose}>✕</button>
	{/if}
</div>
