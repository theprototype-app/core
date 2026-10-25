<script>
	// 53 (A6) — CAPTIONS ON A FLAT SCREEN. The caption bus (captions.js) holds the live lines;
	// this draws them bottom-centre over the game, at the player's caption size, on a solid
	// backing (captions over a busy scene must not depend on what is behind them). Shown while
	// the player has Captions on (the game menu's Accessibility page) and is playing — Play,
	// Interact, a play link / embed / export — or anywhere when 53-scale's editor switch forces
	// them. A headset draws the same lines on its own strip (vrGamePanel). LOCAL chrome:
	// --z-hud, under the pause menu and the toasts; pointer-events none.
	// 77 C1: SUBTITLES (caption-track cues) come first and show whenever their sequence plays or
	// is scrubbed, editor included — they are authored content, not an accessibility extra.
	import { activeCaptions, captionsShown, captionsForced, subtitleLines } from '$lib/captions';
	import { accessValues } from '$lib/playerAccess';
	import { captionPx } from '$lib/playerAccessCore';
	import { isLocked, isVRMode, editorMode } from '../../stores/sceneStore';
	import { embedMode } from '$lib/playMode';

	const playing = $derived($isLocked === true || $editorMode === 'interact' || $embedMode);
	const busShown = $derived($captionsShown && (playing || $captionsForced) && $activeCaptions.length > 0);
	const shown = $derived(!$isVRMode && (busShown || $subtitleLines.length > 0));
	const px = $derived(captionPx($accessValues.captionSize));
</script>

{#if shown}
	<div id="game-captions" class="captions" style:--caption-px={px + 'px'} aria-live="polite" data-hud-avoid>
		{#each $subtitleLines as sub (sub.seq + sub.id)}
			<p class="caption-line caption-sub" data-caption-source="subtitle">{#if sub.speaker}<span class="caption-speaker">{sub.speaker + ': '}</span>{/if}{sub.text}</p>
		{/each}
		{#if busShown}
			{#each $activeCaptions as cap (cap.id)}
				<p class="caption-line" data-caption-source={cap.source}>{cap.text}</p>
			{/each}
		{/if}
	</div>
{/if}

<style>
	.captions {
		position: fixed;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 10vh);
		transform: translateX(-50%);
		z-index: var(--z-hud);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		width: max-content;
		max-width: min(90vw, 1000px);
		pointer-events: none;
	}
	.caption-line {
		margin: 0;
		padding: 0.2em 0.6em;
		border-radius: 6px;
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		color: var(--text);
		font: 600 var(--caption-px) / 1.3 system-ui, sans-serif;
		text-align: center;
		overflow-wrap: anywhere;
	}
	.caption-sub {
		white-space: pre-line;
	}
	.caption-speaker {
		color: var(--text-muted);
	}
	@media (pointer: coarse) {
		/* clear of the touch play controls along the bottom edge */
		.captions {
			bottom: calc(env(safe-area-inset-bottom, 0px) + 140px);
		}
	}
</style>
