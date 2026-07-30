<script>
	import { Dices } from '@lucide/svelte';
	import { panelOpen, panelStats, generateAndBroadcast, clearAndBroadcast } from './module.js';

	let seed = 1337;
	let roomCount = 24;
	let loopChance = 0.15;

	function dice() {
		seed = Math.floor(Math.random() * 1_000_000); // seed choice is local; the SEED replicates
	}

	function generate() {
		generateAndBroadcast(+seed >>> 0, { roomCount: +roomCount, loopChance: +loopChance });
	}
</script>

{#if $panelOpen}
	<div
		id="dungeon-panel"
		class="fixed right-2 top-20 z-40 flex w-72 flex-col gap-2 rounded-lg bg-gray-800 p-3 text-sm text-white shadow-xl"
	>
		<div class="flex items-center justify-between">
			<span class="font-semibold">Dungeon generator</span>
			<button class="rounded bg-gray-600 px-2" on:click={() => panelOpen.set(false)}>✕</button>
		</div>

		<label class="flex items-center gap-2">
			Seed
			<input id="dungeon-seed" class="w-28 rounded bg-gray-700 px-2 py-0.5" type="number" bind:value={seed} />
			<button class="rounded bg-gray-600 px-2" title="Random seed" on:click={dice}><Dices size={16} aria-hidden="true" /></button>
		</label>

		<label class="flex flex-col">
			<span class="flex justify-between"><span>Rooms</span><span>{roomCount}</span></span>
			<input class="accent-[#ff4000]" type="range" min="6" max="60" step="1" bind:value={roomCount} />
		</label>

		<label class="flex flex-col">
			<span class="flex justify-between"><span>Extra loops</span><span>{loopChance}</span></span>
			<input class="accent-[#ff4000]" type="range" min="0" max="0.5" step="0.05" bind:value={loopChance} />
		</label>

		<div class="flex gap-2">
			<button id="dungeon-generate" class="flex-1 rounded bg-[#ff4000] px-2 py-1" on:click={generate}>
				Generate
			</button>
			<button class="rounded bg-gray-600 px-2 py-1" on:click={clearAndBroadcast}>Clear</button>
		</div>

		{#if $panelStats}
			<p class="text-xs text-gray-300">
				{$panelStats.rooms} rooms, {$panelStats.loops} loops, {$panelStats.ms} ms —
				checksum {$panelStats.checksum}
			</p>
			<p class="text-xs text-gray-400">
				Peers regenerate from the seed — same checksum means the exact same dungeon.
				Walk it in play mode (no collision yet).
			</p>
		{/if}
	</div>
{/if}
