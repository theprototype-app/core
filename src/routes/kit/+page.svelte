<script>
	// 38 R3 — /kit: the redesign's primitives in every state, in dark, light and a custom
	// theme (SPEC §2: "a dev-only /kit route"). DEV-ONLY: `npm run dev`, or a build with
	// VITE_UI_KIT=1 (the preview-ui-kit Pages deploy). Anywhere else the constant below is
	// false at build time, the dynamic import is dropped and no kit code ships — the route
	// only says it is not available.
	import '../../app.css';

	const KIT = import.meta.env.DEV || import.meta.env.VITE_UI_KIT === '1';
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
	<p class="kit-off">The UI kit is only available in development builds. <a href="/">Open the app</a></p>
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
