<script>
	// Labelled group with an optional collapse. Content renders on the token grid.
	let { label = '', collapsible = false, open = $bindable(true), children } = $props();
</script>

<div class="border-b border-gray-700/40 pb-2">
	{#if collapsible}
		<button
			class="ui-section-label flex w-full items-center justify-between hover:text-gray-200"
			onclick={() => (open = !open)}
		>
			{label}
			<span>{open ? '−' : '+'}</span>
		</button>
	{:else}
		<p class="ui-section-label">{label}</p>
	{/if}
	{#if !collapsible || open}
		<div class="flex flex-col gap-1 px-1">
			{@render children?.()}
		</div>
	{/if}
</div>
