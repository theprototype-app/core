<script lang="ts">
	// RW/B4: the changelog as a floating window (ui-panel + dragWindow). Opened by the logo-menu
	// row, the update toast, or Settings ▸ About. Opening it marks the version seen.
	// 41 G3b: it lives on --z-onboarding, ABOVE the modals and every top/bottom button (logo,
	// undo/redo, multi-select, notifications, profile, Connect, the Controls bar) at every width —
	// so no focusStack: that would rank it back into the --z-window band under the chrome.
	import { whatsNewOpen, closeWhatsNew, CHANGELOG } from '$lib/whatsNew';
	import { changelogReleases, changelogBlocks } from '$lib/changelog.js';
	import { whatsNewCloud } from '$lib/cloudHooks';
	import { dragWindow } from '$lib/dragWindow';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	let winEl: any = $state(null);

	$effect(() => {
		if ($whatsNewOpen) setTimeout(() => winEl?.focus(), 0); // so Esc closes it
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeWhatsNew();
		}
	}

	// the changelog as releases (one foldable section each) — $lib/changelog.js, shared with
	// Settings ▸ About ▸ What's new (37-settings)
	const { intro, releases } = changelogReleases(CHANGELOG);
	type Block = (typeof intro)[number];

	// 37-fx: the cloud plugin's own section (null without a plugin), same escaped subset;
	// its h1/h2 headings step down to h3 so they read as part of ONE folded section
	const cloudBlocks = $derived(
		$whatsNewCloud
			? changelogBlocks($whatsNewCloud.markdown).map((b) => (b.kind === 'h1' || b.kind === 'h2' ? { ...b, kind: 'h3' } : b))
			: []
	);
</script>

{#if $whatsNewOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="whats-new-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		use:dragWindow={{ key: 'whatsNewWin', defaultRect: { left: 220, top: 90 }, resizable: true, minW: 320, minH: 240 }}
		style="z-index: var(--z-onboarding); width: min(620px, 94vw); height: min(620px, 80vh)"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>✨ What's new</span>
			<span class="flex-1"></span>
			<button id="whats-new-close" class="ui-button-quiet" title="Close" onclick={closeWhatsNew}>✕</button>
		</div>
		<div class="wn-body min-h-0 flex-1 overflow-y-auto px-4 py-3" use:minimalScroll>
			{#snippet body(list: Block[])}
				{#each list as block}
					{#if block.kind === 'h3'}
						<h3>{@html block.html}</h3>
					{:else if block.kind === 'h4'}
						<h4>{@html block.html}</h4>
					{:else if block.kind === 'ul'}
						<ul>
							{#each block.items ?? [] as item}
								<li>{@html item}</li>
							{/each}
						</ul>
					{:else}
						<p>{@html block.html}</p>
					{/if}
				{/each}
			{/snippet}
			{@render body(intro)}
			{#if $whatsNewCloud && cloudBlocks.length}
				<details id="whats-new-cloud" class="wn-release wn-cloud" open>
					<summary><h2>{$whatsNewCloud.title}</h2></summary>
					{@render body(cloudBlocks)}
				</details>
			{/if}
			<!-- newest release open, the history folded away behind its heading -->
			{#each releases as release, index (release.title)}
				<details class="wn-release" open={index === 0}>
					<summary><h2>{@html release.title}</h2></summary>
					{@render body(release.body)}
				</details>
			{/each}
		</div>
	</div>
{/if}

<style>
	/* 15-B7: on a narrow screen the changelog reads as a FULL-SCREEN sheet (the
	   .tp-modal-frame treatment Settings/Sessions get), filling below the Connect
	   bar. !important beats the inline left/top/width/height dragWindow writes;
	   the resize grabber is pointless at this size, so it hides. */
	@media (max-width: 640px) {
		#whats-new-window {
			left: 0 !important;
			top: var(--connect-bottom, 0px) !important;
			width: 100vw !important;
			height: calc(100dvh - var(--connect-bottom, 0px)) !important;
			border-radius: 0;
		}
	}
	@media (max-width: 640px) {
		#whats-new-window :global(.dw-resize) {
			display: none;
		}
	}
	.wn-body {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-2);
	}
	.wn-body h2 {
		display: inline;
		font-size: 15.5px;
		font-weight: 700;
		color: var(--text);
	}
	/* one foldable section per release: the heading IS the toggle */
	.wn-release > summary {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 20px 0 8px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		list-style: none;
	}
	.wn-release:first-of-type > summary {
		margin-top: 0;
	}
	.wn-release > summary::-webkit-details-marker {
		display: none;
	}
	/* the chevron is ours, so it can rotate with the open state */
	.wn-release > summary::before {
		content: '';
		flex: 0 0 auto;
		width: 0;
		height: 0;
		border-left: 5px solid currentColor;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		color: var(--text-faint);
		transition: transform 120ms ease;
	}
	.wn-release[open] > summary::before {
		transform: rotate(90deg);
	}
	.wn-release > summary:hover {
		color: var(--text);
	}
	.wn-body h3 {
		font-size: 13.5px;
		font-weight: 650;
		color: var(--text);
		margin: 16px 0 6px;
	}
	.wn-body h4 {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text-2);
		margin: 12px 0 4px;
	}
	.wn-body p {
		margin: 7px 0;
	}
	.wn-body ul {
		margin: 6px 0 10px;
		padding-left: 18px;
		list-style: disc;
	}
	.wn-body li {
		margin: 4px 0;
	}
	.wn-body :global(strong) {
		color: var(--text);
		font-weight: 620;
	}
	.wn-body :global(code) {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: var(--surface-inset);
		color: var(--text);
	}
	.wn-body :global(a) {
		color: var(--accent-text);
		text-decoration: underline;
	}
	.wn-body :global(a:hover) {
		color: var(--accent-text);
		filter: brightness(1.15);
	}
</style>
