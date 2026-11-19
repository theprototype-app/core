<script>
	// 95 SM2 — THE EXPORT PROGRESS PILL, extracted unchanged from RecordingDialog (36-share, 68 V9) so
	// Share a moment shows the SAME progress (percent, frames, Cancel, the Hide chip) instead of a
	// second one. The markup and the ids are the dialog's: `idPrefix` 'recording' (the default) keeps
	// #recording-bar / #recording-progress / #recording-percent / #recording-time / #recording-shrink /
	// #recording-cancel byte-identical for its suites. `inline` places it in the flow of a dialog
	// instead of floating over the viewport.

	/** @type {{status: string, percent: number, label: string, detail?: string, frames?: number, total?: number,
	 *   ariaLabel?: string, idPrefix?: string, inline?: boolean, shrinkable?: boolean, small?: boolean,
	 *   cancellable?: boolean, oncancel?: () => void}} */
	let {
		status,
		percent,
		label,
		detail = '',
		frames = undefined,
		total = undefined,
		ariaLabel = 'Export progress',
		idPrefix = 'recording',
		inline = false,
		shrinkable = false,
		small = $bindable(false),
		cancellable = true,
		oncancel = undefined
	} = $props();
</script>

<div id="{idPrefix}-bar" class="rec-bar" class:rec-small={small} class:rec-inline={inline} role="status" aria-live="polite" data-status={status} data-percent={percent}>
	<span class="rec-dot" aria-hidden="true"></span>
	{#if !small}
		<span class="rec-label">{label}</span>
	{/if}
	<div id="{idPrefix}-progress" class="rec-track" role="progressbar" aria-label={ariaLabel} aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
		<div class="rec-fill" style:width="{percent}%"></div>
	</div>
	<span id="{idPrefix}-percent" class="rec-time">{percent}%</span>
	{#if !small && detail}
		<span id="{idPrefix}-time" class="rec-time" data-frames={frames} data-total={total}>{detail}</span>
	{/if}
	{#if shrinkable}
		<button
			id="{idPrefix}-shrink"
			type="button"
			class="rec-cancel"
			aria-pressed={small}
			title={small ? 'Show the render details' : 'Keep working: shrink this to a small chip while it renders'}
			onclick={() => (small = !small)}>{small ? 'Details' : 'Hide'}</button
		>
	{/if}
	{#if cancellable}
		<button id="{idPrefix}-cancel" type="button" class="rec-cancel" onclick={() => oncancel?.()}>Cancel</button>
	{/if}
</div>

<style>
	/* the progress pill: above the Controls HUD, under modals/toasts */
	.rec-bar {
		position: fixed;
		left: 50%;
		bottom: calc(var(--controls-inset, 0px) + 72px);
		transform: translateX(-50%);
		z-index: var(--z-hud, 45);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border-radius: 999px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text);
		font-size: 12px;
		box-shadow: var(--shadow-window);
		max-width: calc(100vw - 32px);
	}
	/* 95: the same pill inside a dialog */
	.rec-bar.rec-inline {
		position: static;
		transform: none;
		box-shadow: none;
		max-width: none;
	}
	/* 68 V9: the chip form — out of the way at the bottom-right corner */
	.rec-bar.rec-small {
		left: auto;
		right: 16px;
		transform: none;
		gap: 6px;
		padding: 4px 8px;
	}
	.rec-bar.rec-small .rec-track {
		width: 56px;
		flex: none;
	}
	.rec-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--live);
		animation: rec-pulse 1.2s ease-in-out infinite;
		flex: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.rec-dot {
			animation: none;
		}
	}
	@keyframes rec-pulse {
		50% {
			opacity: 0.35;
		}
	}
	.rec-track {
		width: 140px;
		height: 6px;
		border-radius: 3px;
		background: var(--border-strong);
		overflow: hidden;
		flex: 1 1 80px;
	}
	.rec-fill {
		height: 100%;
		background: var(--accent);
	}
	.rec-time {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.rec-cancel {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		border-radius: 999px;
		padding: 3px 10px;
		cursor: pointer;
	}
</style>
