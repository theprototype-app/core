<script>
	// 95 SM1/SM2 — the moment buffer's host: loads the buffer on the FIRST Play (so neither it nor
	// its capture worker is in the boot graph) and mounts the Share a moment preview while it is open.
	// Mounted by App and PlayApp; renders nothing of its own.
	import { isLocked } from '../../stores/sceneStore';
	import { momentOpen } from '$lib/moment/momentStores.js';

	let loading = false;
	$effect(() => {
		if ($isLocked !== true || loading) return;
		loading = true;
		import('$lib/moment/momentBuffer.js')
			.then((m) => m.startMomentBuffer())
			.catch(() => (loading = false)); // a chunk that failed to load is tried again next Play
	});
</script>

{#if $momentOpen}
	{#await import('./MomentDialog.svelte') then m}<m.default />{/await}
{/if}
