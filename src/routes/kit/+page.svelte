<script>
	// 38 R3 — /kit: the redesign's primitives in every state, in dark, light and a custom
	// theme. SPEC §2 made it dev-only; NOTES-38 #17 (user) publishes it as the reference module
	// authors build their UIs from (docs: ui-kit page). The kit is a lazy chunk loaded only
	// here, so the app itself ships nothing extra. A build with VITE_UI_KIT=0 drops it again
	// (the dynamic import is dead code then) and the route only says it is not available.
	import '../../app.css';

	const KIT = import.meta.env.DEV || import.meta.env.VITE_UI_KIT !== '0';
	const load = KIT ? import('../../components/ui/kit/KitPage.svelte') : null;
</script>

<svelte:head>
	<title>UI kit · theprototype.app</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if load}
	{#await load then mod}
		<mod.default />
	{/await}
{:else}
	<p class="kit-off">The UI kit is not part of this build. <a href="/">Open the app</a></p>
{/if}

<style>
	.kit-off {
		margin: 48px auto;
		max-width: 40ch;
		color: var(--text-muted);
		font-family: var(--font-ui);
		text-align: center;
	}
	.kit-off a {
		color: var(--accent-text);
	}
</style>
