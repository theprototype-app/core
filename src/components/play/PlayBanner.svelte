<script>
	import Icon from '../ui/Icon.svelte';
	// 38 R8 — THE PLAY BANNER (the design review page's play state; NOTES-38 #4): while
	// playing, a small glass bar top-centre says so — the `Playing` badge (--live), a hint
	// and, outside a game, a Stop button. Esc still does what it always did; this only says it.
	//
	// The hint is SCENE data (Configure Scene ▸ Play ▸ Playing banner, the play
	// block's `banner`): the default hint, Hide, or the scene's own words. In a GAME (the
	// game shell offers its menu) Esc opens that menu, so the default hint says so and the
	// corner "Menu · Esc" button (GameShellMenu) stays the way out — no Stop here.
	// Touch has no Esc and its own ✕ (TouchPlayControls), so it shows the badge alone.
	// Not in a headset (DOM is invisible there), not on an embed/export (EmbedChrome owns
	// that player's chrome), not while a HUD menu has the cursor.
	import Badge from '../ui/Badge.svelte';
	import { isLocked, isVRMode, editorMode, playPointerFree } from '../../stores/sceneStore';
	import { embedMode, exitPlay } from '$lib/playMode';
	import { scenePlay } from '$lib/scenePhysics';
	import { hudDocs } from '$lib/hudDocs';
	import { gameLevels, shellMenuAvailable } from '$lib/gameShell';

	// shellMenuAvailable reads its stores through get(), so the dependencies ride as
	// unused arguments (GameShellMenu's idiom)
	const gameNow = (/** @type {any[]} */ ..._deps) => shellMenuAvailable();
	const game = $derived(gameNow($isLocked, $editorMode, $hudDocs, $gameLevels));
	const banner = $derived($scenePlay?.banner ?? null);
	const shown = $derived($isLocked === true && !$isVRMode && !$embedMode && !$playPointerFree && banner?.mode !== 'hide');
	const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
	const custom = $derived(banner?.mode === 'custom' ? banner.text : null);
</script>

{#if shown}
	<div id="play-banner" class="tp-ui hud-glass play-banner" data-game={game ? 'true' : 'false'} role="status">
		<Badge tone="live" text="Playing" />
		{#if custom}
			<span class="pb-hint" data-custom="true">{custom}</span>
		{:else if !coarse}
			<span class="pb-hint">Press <kbd>Esc</kbd> {game ? 'for the menu' : 'to stop'}</span>
		{/if}
		{#if !game && !coarse}
			<button id="play-banner-stop" type="button" class="pb-stop" title="Stop playing (Esc)" aria-label="Stop playing" onclick={() => exitPlay()}>
				<Icon name="square" size={16} fill="currentColor" aria-hidden="true" />
			</button>
		{/if}
	</div>
{/if}

<style>
	.play-banner {
		position: fixed;
		top: max(12px, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-hud);
		display: flex;
		align-items: center;
		gap: 10px;
		height: var(--hud-row-h);
		padding: 0 6px 0 12px;
		border-radius: var(--radius-window);
		pointer-events: none;
		white-space: nowrap;
		max-width: calc(100vw - 24px);
	}
	.pb-hint {
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.pb-hint[data-custom='true'] {
		color: var(--text-2);
	}
	kbd {
		padding: 1px 5px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface-inset);
		color: var(--text-2);
		font: 500 11px var(--font-ui-mono);
	}
	.pb-stop {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border: 0;
		border-radius: 50%;
		background: var(--live);
		color: var(--on-live);
		cursor: pointer;
	}
	.pb-stop:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* a game with no custom text and nothing else to say still shows the badge alone; the
	   padding evens out when the bar ends in text rather than the round button */
	.play-banner:not(:has(.pb-stop)) {
		padding-right: 12px;
	}
</style>
