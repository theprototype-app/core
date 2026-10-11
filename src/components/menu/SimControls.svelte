<script>
	import Icon from '../ui/Icon.svelte';
	// P-A: compact physics transport (own component so it can use onclick without
	// mixing with Controls.svelte's on: style — MobileAddButton precedent).
	// ▶ always; ⏸/⏹/↺ appear while simulating. Sits above the chat toggle.
	import {
		simulating,
		simPaused,
		remoteSimulating,
		toggleSimulation,
		pauseSimulation,
	} from '$lib/physics';
	import { nameOf } from '$lib/lockControl';
	import { showSimControls } from '../../stores/appStore.js';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { resetWholeSimulation } from '$lib/sim/simOnLoad.js';
	// 36-fb-water S9: a SIMULATION scene (Start simulation on load) always shows the transport,
	// and Reset puts the whole simulation back (bodies, fluid tanks, drops) and plays it again

	// 38 R8: the corner-button look (styles/hud.css) at a 44 px touch size
	const btn = 'tp-ui hud-fab';
</script>

{#if $showSimControls || $scenePhysicsState_.simOnLoad === true}
<div id="sim-controls" class="fixed bottom-[112px] right-4 z-(--z-chrome) flex flex-col gap-2">
	{#if $simulating}
		<button id="sim-reset" class={btn} aria-label="Reset simulation" title="Reset — back to how it opened (bodies, fluid tanks, drops), and play again" onclick={() => resetWholeSimulation()}>
			<Icon name="rotate-ccw" size={16} aria-hidden="true" />
		</button>
		<button id="sim-pause" class={btn} aria-label={$simPaused ? 'Resume simulation' : 'Pause simulation'} title={$simPaused ? 'Resume' : 'Pause'} onclick={() => pauseSimulation()}>
			{#if $simPaused}<Icon name="play" size={16} aria-hidden="true" />{:else}<Icon name="pause" size={16} aria-hidden="true" />{/if}
		</button>
		<button id="sim-stop" class={btn + ' hud-fab-warn'} aria-label="Stop simulation" title="Stop — Ctrl+Z restores the layout" onclick={() => toggleSimulation()}>
			<Icon name="square" size={16} aria-hidden="true" />
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
			<Icon name="play" size={16} aria-hidden="true" />
		</button>
	{/if}
</div>
{/if}
