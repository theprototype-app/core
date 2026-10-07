<script>
	// 33 L1 — the scene-load bar. A load may take time; it says so instead of freezing:
	// "Loading Castle Courtyard — 34 / 182 objects" and a real progress bar — from the click
	// (36 F21: "downloading…" while the file arrives), while the objects are built and while
	// kit models are still arriving from their pack. (No Cancel button since 36 S5.)
	//
	// NON-MODAL by design: it lives in the toast stack's first slot (the spectator banner's
	// spot, so arriving toasts never shove it), the rest of the UI stays usable, and opening
	// another scene simply supersedes this load. It appears only after a short delay so a
	// small scene that loads at once does not flash a bar.
	// 36 S5 (user, 2026-10-05): NO Cancel button — opening another scene is how a load is
	// abandoned (the newest load wins at once, F20); the bar only says what is happening.
	import { sceneLoad } from '$lib/sceneLoader';

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
	// 36 F21: a click's load is on screen from the click — its file downloading first
	const what = $derived(
		$sceneLoad?.phase === 'fetching'
			? 'downloading…'
			: $sceneLoad?.phase === 'reading' || $sceneLoad?.phase === 'preparing'
				? 'getting ready…'
				: ($sceneLoad?.done ?? 0) + ' / ' + ($sceneLoad?.total ?? 0) + ' objects'
	);
	const waiting = $derived(
		$sceneLoad?.phase === 'fetching' || $sceneLoad?.phase === 'reading' || $sceneLoad?.phase === 'preparing' || $sceneLoad?.total === 0
	);
</script>

{#if visible && $sceneLoad}
	<!-- a CSS entrance, not svelte's `fly`: a JS transition reads getComputedStyle on mount, which
	     forces a whole-document layout in the middle of a load (measured inside its longest task) -->
	<div class="scene-load">
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
			</div>
			<div
				class="scene-load-track"
				class:indeterminate={waiting}
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
		animation: scene-load-in 0.16s ease-out;
		width: min(420px, 94vw);
		padding: 8px 10px 9px 12px;
		border-radius: 12px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		box-shadow: var(--shadow-window);
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
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.scene-load-text strong {
		color: var(--text);
		font-weight: 650;
	}
	.scene-load-count {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.scene-load-track {
		position: relative;
		margin-top: 7px;
		height: 4px;
		border-radius: 999px;
		background: var(--surface-inset);
		overflow: hidden;
	}
	.scene-load-fill {
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transition: width 0.15s linear;
	}
	.indeterminate .scene-load-fill {
		width: 35% !important;
		animation: scene-load-slide 1.1s ease-in-out infinite;
	}
	@keyframes scene-load-in {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
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
		.indeterminate .scene-load-fill,
		.scene-load-card {
			animation: none;
		}
		.scene-load-fill {
			transition: none;
		}
	}
</style>
