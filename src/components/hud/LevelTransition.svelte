<script>
	// 93 LP1 / LP2 / LP3 — the level-change cover (fade / iris / card), the game's loading screen, and the
	// "Checkpoint" flash. LOCAL to this player; state lives in gameLevels/transition.js + loading.js +
	// checkpoints.js. DOM only: in a headset transition.js fades a sphere instead (DOM is invisible there).
	// Colours an AUTHOR picked for their loading screen are data (inline style); everything else is tokens.
	import { onDestroy } from 'svelte';
	import { Flag } from '@lucide/svelte';
	import { levelTransition, TRANSITION_MS, reducedMotion } from '../../lib/gameLevels/transition.js';
	import { levelLoading } from '../../lib/gameLevels/loading.js';
	import { checkpointFlash } from '../../lib/gameLevels/checkpoints.js';
	import { isVRMode } from '../../stores/sceneStore';
	import { hudImageFor, resolveHudImage } from '../../lib/hudImages.js';
	import { bundledLoadingPath } from '../../lib/gameLevels/exportLoading.js';

	const t = $derived($levelTransition);
	const covering = $derived(t.phase === 'out' || t.phase === 'covered');
	// the cover mounts with the phase change, so it is switched on a moment LATER (a CSS transition needs a
	// first frame without `.on` to run from)
	let on = $state(false);
	$effect(() => {
		if (!covering) {
			on = false;
			return;
		}
		const id = setTimeout(() => (on = true), 20);
		return () => clearTimeout(id);
	});
	const ms = $derived(/** @type {any} */ (TRANSITION_MS)[t.kind] ?? 300);
	const still = $derived(reducedMotion());

	const load = $derived($levelLoading);
	const cfg = $derived(load.config);
	const pct = $derived(Math.round(load.progress * 100));
	/** announced at 25 % steps (a screen reader is not read every 100 ms) */
	const spoken = $derived(Math.floor(pct / 25) * 25);

	/** a library image (an Explorer hash) or a plain URL @param {string} ref */
	function imageUrl(ref) {
		if (!ref) return '';
		if (/^(https?:|data:image\/|blob:)/.test(ref)) return ref;
		if (bundledLoadingPath(ref)) return ref; // an export's own copy
		const hit = hudImageFor(ref);
		if (!hit) void resolveHudImage(ref).then(() => (imageTick += 1));
		return hit ?? '';
	}
	let imageTick = $state(0);
	const bgUrl = $derived.by(() => {
		void imageTick; // re-read once a pulled image lands
		return cfg.preset === 'image' && cfg.image ? imageUrl(cfg.image) : '';
	});
	const logoUrl = $derived.by(() => {
		void imageTick;
		return cfg.logo ? imageUrl(cfg.logo) : '';
	});

	// tips rotate every 4 s while the screen is up
	let tipIndex = $state(0);
	/** @type {ReturnType<typeof setInterval> | null} */
	let tipTimer = null;
	$effect(() => {
		if (load.active && (cfg.tips?.length ?? 0) > 1) {
			tipTimer = setInterval(() => (tipIndex = (tipIndex + 1) % (cfg.tips?.length ?? 1)), 4000);
			return () => {
				if (tipTimer) clearInterval(tipTimer);
				tipTimer = null;
			};
		}
	});

	// the checkpoint flash: 1.6 s
	let flashing = $state(false);
	/** @type {ReturnType<typeof setTimeout> | null} */
	let flashTimer = null;
	const flash = $derived($checkpointFlash);
	$effect(() => {
		if (!flash) return;
		flashing = true;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashing = false), 1600);
	});
	onDestroy(() => {
		if (flashTimer) clearTimeout(flashTimer);
	});
</script>

{#if !$isVRMode}
	{#if t.phase !== 'idle' && t.kind !== 'none'}
		<div
			id="level-transition"
			class="lt-cover lt-{t.kind}"
			class:on
			class:still
			style:--lt-ms={ms + 'ms'}
			data-kind={t.kind}
			data-phase={t.phase}
			aria-hidden={t.kind !== 'card'}
		>
			{#if t.kind === 'iris'}<div class="lt-iris-hole"></div>{/if}
			{#if t.kind === 'card' && t.title}
				<div class="lt-card" role="status" aria-live="polite">
					<p class="lt-card-title">{t.title}</p>
					{#if t.goal}<p class="lt-card-goal">{t.goal}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if load.active}
		<div
			id="level-loading"
			class="ll ll-{cfg.preset}"
			class:still
			data-preset={cfg.preset}
			data-progress={pct}
			style:background-color={cfg.background || null}
			style:color={cfg.textColor || null}
			style:background-image={bgUrl ? `url("${bgUrl}")` : null}
		>
			<div class="ll-body">
				{#if logoUrl && cfg.preset !== 'bar'}
					<img class="ll-logo" src={logoUrl} alt="" />
				{/if}
				{#if cfg.title}<p class="ll-title">{cfg.title}</p>{/if}
				{#if (cfg.preset === 'logo' || cfg.preset === 'item') && !still}
					<span class="ll-spinner" aria-hidden="true"></span>
				{/if}
				{#if cfg.preset === 'item' && cfg.item}<p class="ll-item">{cfg.item}</p>{/if}
				<div
					class="ll-track"
					class:thick={cfg.bar.style === 'thick'}
					role="progressbar"
					aria-label={cfg.title ? 'Loading ' + cfg.title : 'Loading the next level'}
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={pct}
				>
					<div class="ll-fill" style:width={pct + '%'} style:background-color={cfg.bar.color || null}></div>
				</div>
				{#if cfg.tips?.length}
					<p class="ll-tip">{cfg.tips[tipIndex % cfg.tips.length]}</p>
				{/if}
			</div>
			<span class="sr-only" aria-live="polite">Loading {spoken} percent</span>
		</div>
	{/if}

	{#if flashing && flash}
		<div id="checkpoint-flash" class="cp-flash" class:still role="status" aria-live="polite">
			<Flag size={16} aria-hidden="true" />
			<span>{flash.name}</span>
		</div>
	{/if}
{/if}

<style>
	/* over the HUD and the editor chrome, under popovers / modals / toasts */
	.lt-cover,
	.ll {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-popover) - 2);
		pointer-events: none;
	}
	.lt-cover {
		background: var(--bg-app);
		opacity: 0;
		transition: opacity var(--lt-ms) ease;
	}
	.lt-cover.on {
		opacity: 1;
		pointer-events: auto;
	}
	/* the iris: a hole that closes (its shadow is the cover) */
	.lt-iris {
		background: transparent;
		opacity: 1;
		overflow: hidden;
	}
	.lt-iris-hole {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 160vmax;
		height: 160vmax;
		border-radius: 50%;
		transform: translate(-50%, -50%);
		box-shadow: 0 0 0 200vmax var(--bg-app);
		transition:
			width var(--lt-ms) ease-in,
			height var(--lt-ms) ease-in;
	}
	.lt-iris.on .lt-iris-hole {
		width: 0;
		height: 0;
	}
	.lt-card {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 16px;
		text-align: center;
	}
	.lt-card-title {
		margin: 0;
		font-size: 2rem;
		font-weight: 700;
		color: var(--text);
	}
	.lt-card-goal {
		margin: 0;
		max-width: 36rem;
		font-size: var(--fs-body);
		color: var(--text-muted);
	}
	.still,
	.still .lt-iris-hole {
		transition: none;
	}

	.ll {
		z-index: calc(var(--z-popover) - 1);
		pointer-events: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--bg-app);
		background-size: cover;
		background-position: center;
		color: var(--text);
	}
	.ll-bar {
		align-items: flex-end;
	}
	.ll-body {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		width: min(420px, calc(100vw - 32px));
		padding: 24px 16px;
	}
	.ll-image .ll-body {
		margin-top: auto;
		border-radius: 12px;
		background: var(--scrim);
	}
	.ll-logo {
		max-width: 160px;
		max-height: 120px;
		object-fit: contain;
	}
	.ll-title {
		margin: 0;
		font-size: var(--fs-panel-title);
		font-weight: 650;
	}
	.ll-item {
		margin: 0;
		font-size: var(--fs-desc);
		opacity: 0.85;
	}
	.ll-spinner {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 3px solid var(--surface-active);
		border-top-color: var(--accent);
		animation: ll-spin 0.9s linear infinite;
	}
	@keyframes ll-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.ll-track {
		width: 100%;
		height: 4px;
		border-radius: 999px;
		background: var(--surface-active);
		overflow: hidden;
	}
	.ll-track.thick {
		height: 10px;
	}
	.ll-fill {
		height: 100%;
		background: var(--accent);
		border-radius: inherit;
		transition: width 0.12s linear;
	}
	.still .ll-fill {
		transition: none;
	}
	.ll-tip {
		margin: 0;
		min-height: 1.4em;
		font-size: var(--fs-desc);
		text-align: center;
		opacity: 0.9;
	}

	.cp-flash {
		position: fixed;
		top: 72px;
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-hud);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: 999px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text);
		font-size: var(--fs-body);
		box-shadow: var(--shadow-window);
		pointer-events: none;
		animation: cp-in 0.18s ease-out;
	}
	.cp-flash.still {
		animation: none;
	}
	@keyframes cp-in {
		from {
			opacity: 0;
			transform: translate(-50%, -6px);
		}
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
