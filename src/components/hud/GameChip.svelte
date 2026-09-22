<script>
	// 30 P1 — THE EDITOR STOPS MASQUERADING AS THE GAME (roadmap 30 fork 4).
	//
	// A scene with a game shell used to paint its menu over the EDITOR — "TOWERS / Start
	// round" sitting on top of the scene you were building, its buttons live, so a Start
	// press in the editor started the round for every peer without anybody pressing Play.
	// HudLayer now keeps a game's screens off the viewport outside play (the HUD editor's
	// preview eye still shows them, inert). This chip is what stands in for them: one
	// line saying the scene IS a game and where its state is, and the one button an
	// author needs to try it — ▶ Test play (back to the menu, enter play, Start screen).
	//
	// LOCAL chrome: editor only, never in embed mode (an embed has its own ▶), never in a
	// headset (DOM is invisible there), and it replicates nothing — Test play's reset goes
	// through the game shell's own write path, which is what replicates.
	import { Eye, EyeOff } from '@lucide/svelte';
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { hudIsGame, hudPreviewInViewport } from '$lib/hudDocs';
	import { gameState } from '$lib/gameState';
	import { embedMode } from '$lib/playMode';

	const visible = $derived($hudIsGame && $isLocked !== true && !$isVRMode && !$embedMode);
	const stateLabel = $derived(String($gameState?.state ?? 'menu'));
</script>

{#if visible}
	<div id="game-chip" class="game-chip" data-game-state={stateLabel}>
		<span class="game-chip-label">Game · <span class="game-chip-state">{stateLabel}</span></span>
		<button
			id="game-chip-preview"
			type="button"
			class="game-chip-icon"
			aria-pressed={$hudPreviewInViewport}
			aria-label={$hudPreviewInViewport ? 'Hide the game screens in the editor' : 'Show the game screens in the editor (preview, buttons inert)'}
			title={$hudPreviewInViewport ? 'Hide the game screens in the editor' : 'Preview the game screens in the editor (buttons inert)'}
			onclick={() => hudPreviewInViewport.update((on) => !on)}
		>
			{#if $hudPreviewInViewport}<Eye size={14} aria-hidden="true" />{:else}<EyeOff size={14} aria-hidden="true" />{/if}
		</button>
	</div>
{/if}

<style>
	.game-chip {
		position: fixed;
		/* under the logo (8..56px), and under the Connect bar when that is docked full-width
		   across the top — `--connect-bottom` is 0 otherwise */
		top: calc(var(--connect-bottom, 0px) + 68px);
		left: 16px;
		/* the authoring HUD band: over the viewport, under every window (--z-window 40) */
		z-index: 38;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 4px 4px 10px;
		border-radius: 9999px;
		background: var(--surface, #1f2937);
		color: var(--icon-strong, #e5e7eb);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
		font-size: 12px;
		line-height: 1;
		user-select: none;
	}
	.game-chip-label {
		white-space: nowrap;
		opacity: 0.85;
	}
	.game-chip-state {
		font-weight: 600;
	}
	.game-chip-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 9999px;
		color: inherit;
		opacity: 0.8;
	}
	.game-chip-icon:hover,
	.game-chip-icon[aria-pressed='true'] {
		opacity: 1;
		background: rgba(255, 255, 255, 0.08);
	}
</style>
