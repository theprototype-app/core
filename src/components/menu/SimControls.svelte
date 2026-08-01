<script>
	import { Pause, Play, RotateCcw, Square } from '@lucide/svelte';
	// P-A: compact physics transport (own component so it can use onclick without
	// mixing with Controls.svelte's on: style — MobileAddButton precedent).
	// ▶ always; ⏸/⏹/↺ appear while simulating. Sits above the chat toggle.
	import {
		simulating,
		simPaused,
		remoteSimulating,
		toggleSimulation,
		pauseSimulation,
		resetSimulation
	} from '$lib/physics';
	import { nameOf } from '$lib/lockControl';
	import { showSimControls } from '../../stores/appStore.js';

	const btn =
		'flex h-9 w-9 items-center justify-center rounded-full bg-gray-700 text-white shadow-lg transition-colors hover:bg-gray-600';
</script>

{#if $showSimControls}
<div id="sim-controls" class="fixed bottom-[112px] right-4 z-30 flex flex-col gap-1.5">
	{#if $simulating}
		<button id="sim-reset" class={btn} aria-label="Reset simulation" title="Reset — restore the initial layout" onclick={() => resetSimulation()}>
			<RotateCcw size={16} class="text-xs" aria-hidden="true" />
		</button>
		<button id="sim-pause" class={btn} aria-label={$simPaused ? 'Resume simulation' : 'Pause simulation'} title={$simPaused ? 'Resume' : 'Pause'} onclick={() => pauseSimulation()}>
			{#if $simPaused}<Play size={16} aria-hidden="true" />{:else}<Pause size={16} aria-hidden="true" />{/if}
		</button>
		<button id="sim-stop" class={btn + ' bg-red-700 hover:bg-red-600'} aria-label="Stop simulation" title="Stop — Ctrl+Z restores the layout" onclick={() => toggleSimulation()}>
			<Square size={16} class="text-xs" aria-hidden="true" />
		</button>
	{:else}
		<button
			id="sim-play"
			class={btn}
			disabled={!!$remoteSimulating}
			aria-label="Simulate physics"
			title={$remoteSimulating
				? nameOf($remoteSimulating) + ' is simulating'
				: 'Simulate physics (P) — dynamic objects fall and collide'}
			onclick={() => toggleSimulation()}
		>
			<Play size={16} class="text-xs" aria-hidden="true" />
		</button>
	{/if}
</div>
{/if}
