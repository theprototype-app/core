<script lang="ts">
	// RW/B4: the changelog as a floating window (same chrome as the other floating
	// windows — ui-panel + dragWindow + focusStack). Opened by the logo-menu row, the
	// update toast, or Settings ▸ About. Opening it marks the version seen.
	import { whatsNewOpen, closeWhatsNew, CHANGELOG } from '$lib/whatsNew';
	import { changelogReleases } from '$lib/changelog.js';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';

	let winEl: any = $state(null);

	$effect(() => {
		if ($whatsNewOpen) setTimeout(() => winEl?.focus(), 0); // so Esc closes it
	});

	// NARROW ONLY: at full screen this window owns the display, so the logo must not
	// float on top of the text. The logo lives at --z-menu (1300) — above any sane
	// window tier — so instead of chasing it upward (which would also put the sheet
	// over the toast tier, hiding connection requests) we drop the LOGO under the
	// sheet for exactly as long as it is open. A root class keeps that reversible and
	// keeps the rule in this component, next to the layout it belongs to.
	let narrow = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(max-width: 640px)'); // the repo's sheet breakpoint
		const sync = () => (narrow = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});
	$effect(() => {
		const sheet = $whatsNewOpen && narrow;
		document.documentElement.classList.toggle('wn-sheet', sheet);
		return () => document.documentElement.classList.remove('wn-sheet');
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
</script>

{#if $whatsNewOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="whats-new-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-hidden"
		use:dragWindow={{ key: 'whatsNewWin', defaultRect: { left: 220, top: 90 }, resizable: true, minW: 320, minH: 240 }}
		use:focusStack
		style="z-index: var(--z-window); width: min(620px, 94vw); height: min(620px, 80vh)"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>✨ What's new</span>
			<span class="flex-1"></span>
			<button id="whats-new-close" class="ui-button-quiet" title="Close" onclick={closeWhatsNew}>✕</button>
		</div>
		<div class="wn-body min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
			/* a full-screen sheet has to cover the top-right chrome (peers 997,
			   notifications/notes 998, profile avatar 999) — at the floating-window
			   tier it was READABLE but with those buttons floating on top of it.
			   !important beats the inline z-index dragWindow writes. */
			z-index: 1000 !important;
		}
	}
	/* ...and the logo (.burger, at --z-menu = 1300) steps UNDER the sheet for as long
	   as it is open — see the `wn-sheet` effect. Narrow only: on a wide screen this is
	   an ordinary floating window and the logo rightly stays on top. Specificity
	   (0,2,1) beats menu.css's plain `.burger`, so no !important. */
	:global(:root.wn-sheet .burger) {
		z-index: 999;
	}
	@media (max-width: 640px) {
		#whats-new-window :global(.dw-resize) {
			display: none;
		}
	}
	.wn-body {
		font-size: 13px;
		line-height: 1.6;
		color: #d1d5db;
	}
	.wn-body h2 {
		display: inline;
		font-size: 15.5px;
		font-weight: 700;
		color: #f3f4f6;
	}
	/* one foldable section per release: the heading IS the toggle */
	.wn-release > summary {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 20px 0 8px;
		padding-bottom: 6px;
		border-bottom: 1px solid rgb(255 255 255 / 0.09);
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
		color: #9ca3af;
		transition: transform 120ms ease;
	}
	.wn-release[open] > summary::before {
		transform: rotate(90deg);
	}
	.wn-release > summary:hover {
		color: #fff;
	}
	.wn-body h3 {
		font-size: 13.5px;
		font-weight: 650;
		color: #e5e7eb;
		margin: 16px 0 6px;
	}
	.wn-body h4 {
		font-size: 12.5px;
		font-weight: 600;
		color: #cbd5e1;
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
		color: #f3f4f6;
		font-weight: 620;
	}
	.wn-body :global(code) {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: rgb(255 255 255 / 0.08);
		color: #e5e7eb;
	}
	.wn-body :global(a) {
		color: #93c5fd;
		text-decoration: underline;
	}
	.wn-body :global(a:hover) {
		color: #bfdbfe;
	}
</style>
