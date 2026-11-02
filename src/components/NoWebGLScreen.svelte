<script>
	// 54i (fix-batch-3 c) — WHAT A BROWSER WITH NO WEBGL SEES. Before, three's renderer threw inside
	// the first mount and the page stayed blank. App.svelte renders this instead of the <Canvas>
	// when $lib/webglSupport's probe gets no WebGL 2 context: what happened, what to try, a help link.
	import { onMount } from 'svelte';
	import Button from './ui/Button.svelte';
	import { NO_WEBGL_DOCS } from '$lib/webglSupport.js';

	/** @type {HTMLElement | undefined} */
	let card = $state();
	const reload = () => location.reload();
	// the dialog takes focus, so a keyboard or screen reader lands on it first
	onMount(() => card?.focus());
</script>

<div class="no-gl" role="alertdialog" aria-modal="true" aria-labelledby="no-gl-title" aria-describedby="no-gl-desc" id="no-webgl-screen">
	<div class="tp-ui no-gl-card" tabindex="-1" bind:this={card}>
		<h2 id="no-gl-title">This browser can't show the 3D view</h2>
		<p id="no-gl-desc">
			theprototype.app draws its scenes with WebGL 2, and this browser did not give the page a WebGL
			context. This is usually a setting, not your device. Things to try:
		</p>
		<ul>
			<li>Turn on <strong>hardware acceleration</strong> (also called graphics acceleration) in your browser's settings, then restart the browser.</li>
			<li><strong>Update your browser</strong> and, on a computer, your graphics drivers.</li>
			<li><strong>Try another browser</strong> — a current Chrome, Edge, Firefox or Safari.</li>
		</ul>
		<div class="no-gl-actions">
			<Button variant="ghost" href={NO_WEBGL_DOCS} target="_blank" rel="noopener" iconRight="external-link">Help</Button>
			<Button variant="primary" onclick={reload}>Reload</Button>
		</div>
	</div>
</div>

<style>
	/* above every other tier: nothing else on screen can work without a 3D context */
	.no-gl {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-toast, 1200) + 20);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		box-sizing: border-box;
		overflow: auto;
		background: var(--bg-app);
	}
	.no-gl-card {
		max-width: 460px;
		width: 100%;
		padding: var(--space-5) var(--space-6);
		border-radius: 10px;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		outline: none;
	}
	.no-gl-card:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
	}
	h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-modal-title);
		font-weight: 600;
	}
	p,
	li {
		font-size: var(--fs-body);
		line-height: 1.5;
		color: var(--text-2);
	}
	p {
		margin: 0 0 var(--space-2);
	}
	ul {
		margin: 0 0 var(--space-4);
		padding-left: var(--space-5);
	}
	li + li {
		margin-top: var(--space-1);
	}
	strong {
		color: var(--text);
	}
	.no-gl-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
		flex-wrap: wrap;
	}
</style>
