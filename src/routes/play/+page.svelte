<script>
	// 94 SP1 — the play-only entry: /play?s=<id> (a community scene) or /play?scene=<url>.
	// Its own route node, so the editor (src/routes/+page.svelte → App.svelte) never enters its boot.
	import PlayApp from '../../PlayApp.svelte';
</script>

<svelte:head>
	<title>Play · theprototype.app</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="play-root">
	<PlayApp />
</div>

<style>
	:global(body, html) {
		margin: 0;
		overflow: hidden;
	}
	.play-root {
		position: absolute;
		height: 100%;
		width: 100%;
	}
</style>
