<script>
	// 92 (GC8) — A JOIN CARD OVER THE GAME. The ordinary card cannot be clicked while the pointer is
	// locked, so in Play a small card says who is waiting and how to answer without leaving the game
	// (Esc / the pad's Start opens the menu's Join requests page). Non-blocking (pointer-events only on
	// its own button), never pauses anyone. A LAZY chunk, mounted only while a card waits in Play.
	import Icon from '../ui/Icon.svelte';
	import { pendingApprovals } from '../../stores/appStore';
	import { openShellMenu, showShellPage } from '$lib/gameShell';
	import { shortPeer } from '$lib/admitNotice';

	const cards = $derived(/** @type {any[]} */ ($pendingApprovals));
	const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

	function answer() {
		if (openShellMenu('main')) showShellPage('joins');
	}
</script>

{#if cards.length}
	<div id="play-join-card" class="pj-card" role="status" aria-live="polite">
		<Icon name="user-plus" size={16} aria-hidden="true" />
		<span class="pj-text">
			{cards.length === 1 ? shortPeer(cards[0].peerId) + ' wants to join' : cards.length + ' people want to join'}
		</span>
		<button type="button" class="pj-btn" onclick={answer}>{coarse ? 'Answer' : 'Esc to answer'}</button>
	</div>
{/if}

<style>
	.pj-card {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 56px);
		left: 50%;
		transform: translateX(-50%);
		z-index: calc(var(--z-hud) + 2);
		display: inline-flex;
		align-items: center;
		gap: 10px;
		max-width: calc(100vw - 32px);
		padding: 8px 10px 8px 14px;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		color: var(--text);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-window);
		font-size: 14px;
		font-weight: 600;
		pointer-events: none;
	}
	.pj-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pj-btn {
		pointer-events: auto;
		padding: 4px 12px;
		border-radius: 9999px;
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: 13px;
	}
	.pj-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
