<script>
	// 21-B B3: the play-mode crosshair. A 4px dot that grows into a ring over
	// something you could pick up, and shows the carry distance while you hold
	// it. Presentation only — every decision it renders was already made in
	// playInteract.js.
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { playInteractState } from '$lib/playInteract';

	// the scroll hint is worth exactly one showing, so it is a LOCAL pref and
	// never touches the wire
	let hintSeen = $state(
		typeof localStorage !== 'undefined' && localStorage.getItem('playCarryHintSeen') === 'true'
	);

	const reticle = $derived($playInteractState);
	const visible = $derived($isLocked && !$isVRMode && reticle.mode !== 'off');
	const carrying = $derived(reticle.mode === 'carrying');

	$effect(() => {
		if (!carrying || hintSeen) return;
		hintSeen = true;
		try {
			localStorage.setItem('playCarryHintSeen', 'true');
		} catch {}
	});
</script>

{#if visible}
	<div class="reticle-wrap" aria-hidden="true">
		<div
			id="play-reticle"
			class="reticle"
			class:aiming={reticle.mode === 'aiming'}
			class:carrying
		></div>
		{#if carrying}
			<div class="reticle-note">
				{reticle.distance.toFixed(1)} m
				{#if !hintSeen}<span class="hint">· scroll to push / pull</span>{/if}
			</div>
		{:else if reticle.blocked}
			<div class="reticle-note">held by {reticle.blocked}</div>
		{/if}
	</div>
{/if}

<style>
	.reticle-wrap {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		pointer-events: none;
		z-index: 2;
	}
	.reticle {
		width: 4px;
		height: 4px;
		border-radius: 9999px;
		background: var(--icon-strong, #e5e7eb);
		box-shadow: 0 0 2px rgba(0, 0, 0, 0.9);
		transition:
			width 90ms ease,
			height 90ms ease,
			border-color 90ms ease;
	}
	.reticle.aiming,
	.reticle.carrying {
		width: 16px;
		height: 16px;
		background: transparent;
		border: 2px solid var(--icon-accent, var(--accent, #38bdf8));
	}
	.reticle.carrying {
		border-color: var(--icon-strong, #e5e7eb);
	}
	.reticle-note {
		font-size: 11px;
		color: var(--icon-strong, #e5e7eb);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
	}
	.hint {
		opacity: 0.75;
	}
</style>
