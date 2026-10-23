<script>
	// 57 — the character tools' lazy HOST: App mounts this one tiny component; each dialog's code
	// (and the retarget / VRM / rig code behind it) loads only when its store opens it.
	import { applyClipRequest } from '$lib/characterUi.js';
</script>

{#if $applyClipRequest}
	{#await import('./ApplyClipDialog.svelte') then m}
		<m.default />
	{/await}
{/if}
