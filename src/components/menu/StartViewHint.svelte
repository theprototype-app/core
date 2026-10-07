<script>
	// 36 L2 — what the start view says while a scene loads (startView.js owns the rules):
	//   held  "Loading… camera is held" while the scene's "Hold camera until loaded" setting
	//         keeps the camera on its start view, with "Take control" after 1.5 s (Esc too)
	//   back  "Back to start view" for ~6 s after a load the user moved the camera during
	// Lives under the scene-load bar in the toast stack, so it never covers the viewport's
	// middle. Theme tokens only.
	import { startViewHint, releaseHold, backToStartView } from '$lib/startView';
</script>

{#if $startViewHint?.kind === 'held'}
	<div class="sv-wrap">
		<div id="start-view-hint" class="sv-card" role="status" aria-live="polite" data-tour="start-view-held">
			<span class="sv-text">Loading… camera is held</span>
			{#if $startViewHint.takeControl}
				<button id="start-view-take-control" class="sv-btn" data-tour="start-view-take-control" title="Move the camera now (Esc)" onclick={() => releaseHold('user')}>
					Take control
				</button>
			{/if}
		</div>
	</div>
{:else if $startViewHint?.kind === 'back'}
	<div class="sv-wrap">
		<button id="start-view-back" class="sv-card sv-back" data-tour="start-view-back" title="Fly back to where this scene opened (Home)" onclick={() => backToStartView()}>
			Back to start view
		</button>
	</div>
{/if}

<style>
	.sv-wrap {
		position: relative;
		z-index: var(--z-toast);
		display: flex;
		justify-content: center;
		margin-bottom: 6px;
		pointer-events: none;
	}
	.sv-card {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 5px 6px 5px 12px;
		border-radius: 999px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text);
		font-size: 12px;
		line-height: 1.3;
		box-shadow: var(--shadow-window);
		animation: sv-in 0.16s ease-out;
	}
	.sv-text {
		color: var(--text-muted);
	}
	.sv-btn {
		font-size: 11.5px;
		font-weight: 600;
		padding: 3px 11px;
		border-radius: 999px;
		border: none;
		background: var(--accent-fill);
		color: var(--on-accent);
		cursor: pointer;
	}
	.sv-back {
		padding: 5px 14px;
		font-weight: 600;
		cursor: pointer;
	}
	.sv-back:hover,
	.sv-btn:hover {
		filter: brightness(1.1);
	}
	@keyframes sv-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sv-card {
			animation: none;
		}
	}
</style>
