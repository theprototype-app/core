<script>
	// 36 F22 / S6 / S12 — the Alt+click cycle's chip ("2 of 4 · Fish orange") by the cursor:
	// while Alt is held it previews what an Alt+click would select; after the click it confirms
	// the pick for a moment. The polite live region announces each pick for screen readers.
	// Theme tokens only; pointer-events none (it never takes a click).
	import { pickCycleHint, pickCycleAnnouncement } from '$lib/pickCycle';
</script>

{#if $pickCycleHint}
	<div
		id="pick-cycle-hint"
		class="pick-cycle-hint"
		class:picked={$pickCycleHint.mode === 'picked'}
		data-mode={$pickCycleHint.mode}
		data-index={$pickCycleHint.index}
		data-of={$pickCycleHint.of}
		style:left={$pickCycleHint.x + 14 + 'px'}
		style:top={$pickCycleHint.y + 14 + 'px'}
		aria-hidden="true"
	>
		<span class="pick-cycle-count">{$pickCycleHint.index + 1} of {$pickCycleHint.of}</span>
		<span class="pick-cycle-name">{$pickCycleHint.name}</span>
		{#if $pickCycleHint.mode === 'preview'}<span class="pick-cycle-key">Alt+click</span>{/if}
	</div>
{/if}
<div id="pick-cycle-live" class="sr-only" role="status" aria-live="polite">{$pickCycleAnnouncement}</div>

<style>
	.pick-cycle-hint {
		position: fixed;
		z-index: var(--z-toast, 1200);
		pointer-events: none;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 260px;
		padding: 3px 8px;
		border-radius: 8px;
		font-size: 11.5px;
		line-height: 1.3;
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		border: 1px solid var(--border, #4b5563);
		box-shadow: 0 6px 16px rgb(0 0 0 / 0.3);
	}
	.pick-cycle-hint.picked {
		border-color: var(--accent, #60a5fa);
	}
	.pick-cycle-count {
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		color: var(--accent, #60a5fa);
		white-space: nowrap;
	}
	.pick-cycle-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pick-cycle-key {
		color: var(--muted, #9ca3af);
		white-space: nowrap;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
