<script>
	// 92 (GC8) — THE JOIN REQUESTS PAGE of the pause menu: every pending card, answerable by mouse,
	// keyboard (the menu's arrow ring) or a gamepad, without leaving Play. A LAZY chunk. Admitting never
	// pauses anybody; the menu's own pause is "alone only" and lifts when the newcomer starts playing.
	import Icon from '../ui/Icon.svelte';
	import { pendingApprovals } from '../../stores/appStore';
	import { sessionHost, roomIsFull, HARD_PEER_CAP } from '$lib/connectionState';
	import { peers } from '../../stores/appStore';
	import { admitFromPlay, declineFromPlay } from '$lib/playJoins';
	import { gameMenus } from '$lib/gameMenus';
	import { setGameMenus } from '$lib/gameMenusPlan.js';
	import { shortPeer } from '$lib/admitNotice';

	const cards = $derived($sessionHost === null ? /** @type {any[]} */ ($pendingApprovals) : []);
	const full = $derived(roomIsFull(/** @type {any} */ ($peers)));
</script>

<div class="jr-list" id="game-join-requests">
	{#each cards as card (card.peerId)}
		<div class="jr-card" data-join-card={card.peerId}>
			<Icon name={card.kind === 'agent' ? 'bot' : 'user-plus'} size={20} aria-hidden="true" />
			<span class="jr-text">
				<span class="jr-who">{card.kind === 'agent' ? 'AI agent' : 'Someone'} <span class="jr-id">{shortPeer(card.peerId)}</span> wants to join</span>
				{#if card.label}<span class="jr-label">{card.label}</span>{/if}
			</span>
			<button
				type="button"
				class="jr-yes"
				data-shell-focus=""
				data-join-admit={card.peerId}
				disabled={full}
				title={full ? 'This session is full (' + HARD_PEER_CAP + ')' : 'Let them in'}
				onclick={() => admitFromPlay(card.peerId)}>Admit</button
			>
			<button type="button" class="jr-no" data-join-decline={card.peerId} onclick={() => declineFromPlay(card.peerId)}>Decline</button>
		</div>
	{:else}
		<p class="jr-empty">Nobody is waiting to join.</p>
	{/each}
	{#if $sessionHost === null}
		<label class="jr-auto">
			<input
				type="checkbox"
				class="tp-check"
				id="game-auto-admit"
				checked={$gameMenus.autoAdmit}
				onchange={(e) => setGameMenus({ autoAdmit: /** @type {HTMLInputElement} */ (e.currentTarget).checked })}
			/>
			<span>
				Auto-admit while playing
				<span class="jr-hint">For this game. People are let in while you play; AI agents and blocked people still ask.</span>
			</span>
		</label>
	{/if}
</div>

<style>
	.jr-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.jr-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--surface-2);
	}
	.jr-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.jr-who {
		font-weight: 600;
	}
	.jr-id {
		font-family: var(--font-ui-mono);
	}
	.jr-label {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.jr-yes,
	.jr-no {
		min-height: 36px;
		padding: 4px 14px;
		border-radius: 8px;
		font-weight: 600;
		border: 1px solid transparent;
	}
	.jr-yes {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.jr-yes:disabled {
		opacity: 0.5;
	}
	.jr-no {
		background: var(--surface-1);
	}
	.jr-yes:focus-visible,
	.jr-no:focus-visible,
	.jr-auto input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.jr-empty {
		padding: 8px;
		color: var(--text-muted);
	}
	.jr-auto {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 8px;
		padding: 8px;
		border-radius: 8px;
	}
	.jr-auto:hover {
		background: var(--surface-hover);
	}
	.jr-hint {
		display: block;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
