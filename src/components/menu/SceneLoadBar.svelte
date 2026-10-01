<script>
	// 33 L1 — the scene-load bar. A load may take time; it says so instead of freezing:
	// "Loading Castle Courtyard — 34 / 182 objects", a real progress bar, and Cancel while the
	// objects are still being built (sceneLoader.cancelLoad runs the load's own undo). Once
	// the scene is whole and only kit models are still arriving from their pack, the bar
	// keeps counting but Cancel is gone — there is nothing half-built left to take back.
	//
	// NON-MODAL by design: it lives in the toast stack's first slot (the spectator banner's
	// spot, so arriving toasts never shove it), the rest of the UI stays usable, and opening
	// another scene simply supersedes this load. It appears only after a short delay so a
	// small scene that loads at once does not flash a bar.
	import { fly } from 'svelte/transition';
	import { sceneLoad, cancelLoad } from '$lib/sceneLoader';

	const SHOW_AFTER_MS = 250;

	let visible = $state(false);
	/** @type {any} */
	let timer = null;
	let shownFor = 0;

	$effect(() => {
		const job = $sceneLoad;
		if (!job) {
			clearTimeout(timer);
			timer = null;
			visible = false;
			shownFor = 0;
			return;
		}
		if (visible && shownFor === job.id) return;
		if (shownFor !== job.id) {
			visible = false;
			shownFor = job.id;
			clearTimeout(timer);
			timer = setTimeout(() => (visible = true), SHOW_AFTER_MS);
		}
	});

	const pct = $derived(
		$sceneLoad && $sceneLoad.total > 0 ? Math.round((100 * $sceneLoad.done) / $sceneLoad.total) : 0
	);
	const verb = $derived($sceneLoad?.verb ?? 'Loading');
	const what = $derived(
		$sceneLoad?.phase === 'reading' || $sceneLoad?.phase === 'preparing'
			? 'getting ready…'
			: $sceneLoad?.phase === 'models'
				? 'models ' + $sceneLoad.done + ' / ' + $sceneLoad.total
				: ($sceneLoad?.done ?? 0) + ' / ' + ($sceneLoad?.total ?? 0) + ' objects'
	);
</script>

{#if visible && $sceneLoad}
	<div class="scene-load" transition:fly={{ y: -8, duration: 160 }}>
		<div
			id="scene-load-bar"
			class="scene-load-card"
			role="status"
			aria-live="polite"
			data-done={$sceneLoad.done}
			data-total={$sceneLoad.total}
			data-phase={$sceneLoad.phase}
		>
			<div class="scene-load-row">
				<p class="scene-load-text">
					{verb} <strong>{$sceneLoad.name}</strong>
					<span class="scene-load-count">— {what}</span>
				</p>
				{#if $sceneLoad.cancellable}
					<button id="scene-load-cancel" class="scene-load-cancel" onclick={() => cancelLoad()}>Cancel</button>
				{/if}
			</div>
			<div
				class="scene-load-track"
				class:indeterminate={$sceneLoad.phase === 'reading' || $sceneLoad.phase === 'preparing' || $sceneLoad.total === 0}
				role="progressbar"
				aria-label={verb + ' ' + $sceneLoad.name}
				aria-valuemin="0"
				aria-valuemax={$sceneLoad.total}
				aria-valuenow={$sceneLoad.done}
			>
				<div class="scene-load-fill" style:width={pct + '%'}></div>
			</div>
		</div>
	</div>
{/if}

<style>
	.scene-load {
		position: relative;
		z-index: var(--z-toast);
		display: flex;
		justify-content: center;
		margin-bottom: 6px;
		pointer-events: none;
	}
	.scene-load-card {
		pointer-events: auto;
		width: min(420px, 94vw);
		padding: 8px 10px 9px 12px;
		border-radius: 12px;
		background: var(--color-form, rgb(31 41 55 / 0.97));
		border: 1px solid rgb(255 255 255 / 0.1);
		border-left: 3px solid #60a5fa;
		box-shadow: 0 10px 26px rgb(0 0 0 / 0.4);
		backdrop-filter: blur(6px);
	}
	.scene-load-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.scene-load-text {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		font-size: 12.5px;
		line-height: 1.35;
		color: #e5e7eb;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.scene-load-text strong {
		color: #fff;
		font-weight: 650;
	}
	.scene-load-count {
		color: #9ca3af;
		font-variant-numeric: tabular-nums;
	}
	.scene-load-cancel {
		flex: 0 0 auto;
		font-size: 11.5px;
		font-weight: 600;
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid rgb(255 255 255 / 0.18);
		background: transparent;
		color: #e5e7eb;
		cursor: pointer;
	}
	.scene-load-cancel:hover {
		background: rgb(255 255 255 / 0.08);
	}
	.scene-load-track {
		position: relative;
		margin-top: 7px;
		height: 4px;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.1);
		overflow: hidden;
	}
	.scene-load-fill {
		height: 100%;
		border-radius: inherit;
		background: #60a5fa;
		transition: width 0.15s linear;
	}
	.indeterminate .scene-load-fill {
		width: 35% !important;
		animation: scene-load-slide 1.1s ease-in-out infinite;
	}
	@keyframes scene-load-slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.indeterminate .scene-load-fill {
			animation: none;
		}
		.scene-load-fill {
			transition: none;
		}
	}
</style>
