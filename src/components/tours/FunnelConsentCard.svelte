<script>
	// 76 consent (owner sign-off S4, option D): the one question about usage counts, asked after a first
	// successful Play, once the person is back in the editor. Small and bottom-right: it takes no
	// focus and blocks nothing. It waits while a game runs, and on a narrow screen, where the quest's
	// card is a sheet in the same place, while a quest is open.
	import { funnelCardOpen, funnelAgree, funnelDecline } from '$lib/onboarding/funnel.js';
	import { activeTour } from '$lib/tours/index.js';
	import { isLocked } from '../../stores/sceneStore';

	let width = $state(typeof window === 'undefined' ? 0 : window.innerWidth);
	const shown = $derived($funnelCardOpen && !$isLocked && (width >= 900 || !$activeTour));
</script>

<svelte:window bind:innerWidth={width} />

{#if shown}
	<div id="funnel-consent" class="funnel-card" role="region" aria-label="Usage counts">
		<p class="funnel-text">Help us improve theprototype: count my first steps anonymously</p>
		<div class="funnel-actions">
			<button id="funnel-consent-agree" class="funnel-agree" onclick={funnelAgree}>Agree</button>
			<button id="funnel-consent-decline" class="funnel-decline" onclick={funnelDecline}>No thanks</button>
			<a class="funnel-more" href="/privacy" target="_blank" rel="noopener">Privacy</a>
		</div>
	</div>
{/if}

<style>
	.funnel-card {
		position: fixed;
		right: max(12px, env(safe-area-inset-right, 0px));
		bottom: calc(76px + env(safe-area-inset-bottom, 0px));
		z-index: calc(var(--z-onboarding) - 1);
		width: min(300px, calc(100vw - 24px));
		box-sizing: border-box;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: var(--surface-1);
		color: var(--text);
		box-shadow: var(--shadow-window);
	}
	.funnel-text {
		margin: 0 0 10px;
		font-size: 13px;
		line-height: 1.4;
	}
	.funnel-actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.funnel-agree {
		min-height: 36px;
		padding: 0 16px;
		border: 0;
		border-radius: 8px;
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}
	.funnel-decline {
		min-height: 36px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-2);
		font-size: 13px;
		text-decoration: underline;
		cursor: pointer;
	}
	.funnel-more {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 12px;
	}
	/* the wide layout's bottom-right button column stays clear */
	@media (min-width: 900px) {
		.funnel-card {
			right: 68px;
		}
	}
	@media (pointer: coarse) {
		.funnel-agree,
		.funnel-decline {
			min-height: 44px;
		}
	}
</style>
