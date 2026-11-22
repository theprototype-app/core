<script lang="ts">
	// 78 PL34 — "What should others call you?" A small card under the Connect pill while a join goes out,
	// for a person with no name of their own (no Edit profile name, no account name). Not a modal: the
	// join carries on behind it, and anyone who ignores it is "Guest N" (guestName.js). Save REMEMBERS the
	// name on this device (the Edit profile keys), so the card never comes back.
	import { onMount } from 'svelte';
	import { joinNameAsk, saveJoinName, nextGuestName, isGuestName } from '$lib/guestName';
	import { peers, userdata, username } from '../../stores/appStore';

	let value = $state('');
	let inputEl: HTMLInputElement | null = $state(null);
	const suggestion = $derived.by(() => {
		const mine = String($username ?? '').trim();
		if (isGuestName(mine)) return mine;
		return nextGuestName($userdata as any[], ($peers as any)?.peer?.id ?? '', false);
	});
	onMount(() => {
		queueMicrotask(() => inputEl?.focus({ preventScroll: true }));
	});
	function submit(e: SubmitEvent) {
		e.preventDefault();
		saveJoinName(value);
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			joinNameAsk.set(false);
		}
	}
</script>

<div id="join-name-ask" class="cx-name-ask tp-ui" role="dialog" aria-labelledby="join-name-title" aria-describedby="join-name-hint">
	<p id="join-name-title" class="cx-name-title">What should others call you?</p>
	<form class="cx-name-row" onsubmit={submit}>
		<input
			bind:this={inputEl}
			id="join-name-input"
			class="tp-field cx-name-input"
			type="text"
			name="session-name"
			autocomplete="nickname"
			maxlength="40"
			placeholder={suggestion}
			aria-label="Your name in the session"
			bind:value
			onkeydown={onKey}
		/>
		<button id="join-name-save" type="submit" class="cx-name-btn cx-name-primary" disabled={!value.trim()}>Save</button>
		<button id="join-name-skip" type="button" class="cx-name-btn" onclick={() => joinNameAsk.set(false)}>Not now</button>
	</form>
	<p id="join-name-hint" class="cx-name-hint">Remembered on this device. Without one you are {suggestion}. Edit profile changes it later.</p>
</div>

<style>
	.cx-name-ask {
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		width: min(360px, calc(100vw - 16px));
		margin-left: calc(min(360px, calc(100vw - 16px)) / -2);
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-window);
		background: var(--surface-1);
		box-shadow: var(--shadow-window);
		color: var(--text);
		pointer-events: auto;
		white-space: normal;
	}
	.cx-name-title {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-body);
		font-weight: 600;
	}
	.cx-name-row {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.cx-name-input {
		flex: 1 1 auto;
		min-width: 0;
	}
	.cx-name-btn {
		flex: 0 0 auto;
		height: var(--control-h-sm);
		padding: 0 var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.cx-name-btn:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	.cx-name-primary {
		border-color: transparent;
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.cx-name-primary:hover:not(:disabled) {
		background: var(--accent-fill);
		filter: brightness(1.08);
	}
	.cx-name-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.cx-name-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.cx-name-hint {
		margin: var(--space-2) 0 0;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	@media (pointer: coarse) {
		.cx-name-btn {
			height: 44px;
		}
		.cx-name-input {
			font-size: 16px;
		}
	}
</style>
