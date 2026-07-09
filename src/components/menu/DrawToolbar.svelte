<script>
	import { drawMode, drawColor, drawSize, toggleDrawMode } from '$lib/drawMode';

	function onKeydown(event) {
		if (event.key === 'Escape' && $drawMode) toggleDrawMode();
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if $drawMode}
	<div
		id="draw-toolbar"
		class="fixed left-1/2 top-20 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-gray-800 px-4 py-2 text-sm text-white shadow-xl"
	>
		<span class="font-semibold">✏️ Drawing</span>
		<input
			type="color"
			title="Stroke color"
			value={$drawColor}
			on:input={(e) => drawColor.set(e.currentTarget.value)}
		/>
		<label class="flex items-center gap-1">
			<span class="text-xs text-gray-300">size</span>
			<input
				type="range"
				class="w-24 accent-[#ff4000]"
				min="0.01"
				max="0.15"
				step="0.01"
				value={$drawSize}
				on:input={(e) => drawSize.set(+e.currentTarget.value)}
			/>
		</label>
		<button class="rounded-full bg-[#ff4000] px-3 py-0.5" on:click={toggleDrawMode}>Done</button>
	</div>
{/if}
