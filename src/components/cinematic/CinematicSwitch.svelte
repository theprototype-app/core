<script>
	// 100 C1 — THE CINEMATIC VIEW SWITCH: "Preview" on the viewport, the quality choice beside it, and the
	// two chips while it is on ("Not shown in Cinematic view: …", and the dynamic step down). A lazy
	// component: App.svelte mounts it only where cinematicState offered the view (a strong desktop on
	// Chrome's WebGPU path), so phones, Quest and headsets never download it. Everything here is LOCAL to
	// this device: a peer in the same session sees nothing change.
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Badge from '../ui/Badge.svelte';
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { embedMode } from '$lib/playMode';
	import { cinematicState, cinematicPrefs, toggleCinematic, setCinematicQuality } from '$lib/cinematic/cinematicState.js';
	import { QUALITY, QUALITY_HINT, QUALITY_STEPS, HIGH_MAX_PIXELS } from '$lib/cinematic/cinematicCore.js';
	import { safeStorage } from '$lib/safeStorage';

	let menuOpen = $state(false);
	let pixels = $state(0);
	/** @type {HTMLElement | null} */
	let root = $state(null);

	const on = $derived($cinematicState.mode === 'on');
	const busy = $derived($cinematicState.mode === 'entering' || $cinematicState.mode === 'leaving');
	const visible = $derived(!!$cinematicState.offered && $isLocked !== true && !$isVRMode && !$embedMode);
	const highAllowed = $derived(pixels <= HIGH_MAX_PIXELS);
	const options = $derived(
		QUALITY_STEPS.map((q) => ({
			value: q,
			label: QUALITY[q].label,
			title: q === 'high' && !highAllowed ? 'Not at this window size (more than 2560 x 1440 pixels)' : QUALITY_HINT[q],
			disabled: q === 'high' && !highAllowed
		}))
	);
	const dropText = $derived(on && $cinematicState.dropped > 0 ? 'Lowered to ' + QUALITY[$cinematicState.quality].label + ' to keep it smooth' : '');
	const title = $derived(
		$cinematicState.mode === 'entering'
			? 'Starting the Cinematic view…'
			: on
				? 'Cinematic view is on: back to the standard view (Shift+Z)'
				: 'Cinematic view: bounced light and reflections, on this computer only (Shift+Z)'
	);

	// 100-int: the first time the switch shows on a device, one line says what it does (the 1.68 moment-hint shape)
	const HINT_KEY = 'cinematic:hintSeen';
	let hint = $state(false);
	$effect(() => {
		if (!visible || on) return;
		try {
			if (safeStorage.getItem(HINT_KEY) === '1') return;
			safeStorage.setItem(HINT_KEY, '1');
		} catch {
			return;
		}
		hint = true;
		const t = setTimeout(() => (hint = false), 8000);
		return () => clearTimeout(t);
	});
	$effect(() => {
		if (on || menuOpen) hint = false;
	});

	function measure() {
		const v = document.getElementById('viewport');
		const r = v?.getBoundingClientRect();
		pixels = r ? Math.round(r.width * devicePixelRatio) * Math.round(r.height * devicePixelRatio) : 0;
	}

	function openMenu() {
		measure();
		menuOpen = !menuOpen;
	}

	$effect(() => {
		if (!menuOpen) return;
		/** @param {PointerEvent} e */
		const away = (e) => {
			if (root && !root.contains(/** @type {Node} */ (e.target))) menuOpen = false;
		};
		/** @param {KeyboardEvent} e */
		const esc = (e) => {
			if (e.key === 'Escape') menuOpen = false;
		};
		window.addEventListener('pointerdown', away, true);
		window.addEventListener('keydown', esc);
		return () => {
			window.removeEventListener('pointerdown', away, true);
			window.removeEventListener('keydown', esc);
		};
	});
</script>

{#if visible}
	<div id="cinematic-switch" class="cine" bind:this={root} data-mode={$cinematicState.mode} data-quality={$cinematicState.quality}>
		<div class="cine-pill">
			<button
				id="cinematic-toggle"
				type="button"
				class="cine-toggle"
				aria-pressed={on}
				aria-busy={busy}
				disabled={busy}
				{title}
				aria-label={on ? 'Cinematic view on' : 'Cinematic view off'}
				onclick={() => toggleCinematic()}
			>
				<Icon name={busy ? 'loader-circle' : 'sparkles'} size={16} aria-hidden="true" />
				<span>Preview</span>
			</button>
			<button
				id="cinematic-quality"
				type="button"
				class="cine-more"
				aria-haspopup="true"
				aria-expanded={menuOpen}
				aria-label="Cinematic view quality"
				title="Quality"
				onclick={openMenu}
			>
				<Icon name="chevron-down" size={16} aria-hidden="true" />
			</button>
		</div>
		{#if menuOpen}
			<div id="cinematic-menu" class="cine-menu" role="group" aria-label="Cinematic view quality">
				<Segmented
					id="cinematic-q"
					label="Quality"
					options={options}
					value={$cinematicPrefs.quality}
					onchange={(q) => setCinematicQuality(q)}
				/>
				<p class="cine-hint">{QUALITY_HINT[$cinematicPrefs.quality]}. Only on this computer: nobody else's view changes.</p>
			</div>
		{/if}
		{#if hint}
			<p id="cinematic-hint" class="cine-first tp-ui hud-glass" role="status">New: Preview shows bounced light and reflections, on this computer only (Shift+Z)</p>
		{/if}
		{#if on && $cinematicState.notShown}
			<div id="cinematic-not-shown" class="cine-chip"><Badge tone="warn" text={$cinematicState.notShown} /></div>
		{/if}
		{#if dropText}
			<div id="cinematic-dropped" class="cine-chip"><Badge tone="warn" text={dropText} /></div>
		{/if}
	</div>
{/if}

<style>
	.cine {
		position: fixed;
		/* the GameChip's band, on the right: under the Connect bar when it is docked across the top */
		top: calc(var(--connect-bottom, 0px) + 68px);
		right: 16px;
		z-index: calc(var(--z-window) - 2);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		max-width: min(420px, calc(100vw - 32px));
		pointer-events: none;
	}
	.cine > * {
		pointer-events: auto;
	}
	.cine-pill {
		display: flex;
		align-items: center;
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		font-size: 12px;
		line-height: 1;
		user-select: none;
		overflow: hidden;
	}
	.cine-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 10px 0 10px;
		color: inherit;
		font-weight: 600;
	}
	.cine-toggle[aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
	}
	.cine-toggle:hover:not(:disabled),
	.cine-more:hover {
		background: var(--surface-hover);
	}
	.cine-toggle[aria-pressed='true']:hover:not(:disabled) {
		background: var(--accent);
		filter: brightness(1.08);
	}
	.cine-toggle:disabled {
		opacity: 0.7;
	}
	.cine-more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 32px;
		width: 28px;
		color: inherit;
		border-left: 1px solid var(--border);
	}
	.cine-toggle:focus-visible,
	.cine-more:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
		outline-offset: calc(-1 * var(--focus-ring-width));
	}
	.cine-menu {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		width: 280px;
		border-radius: var(--radius-card);
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
	}
	.cine-hint {
		margin: 0;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.cine-chip {
		max-width: 100%;
	}
	.cine-first {
		margin: 0;
		padding: 4px 10px;
		border-radius: var(--radius-window);
		font-size: var(--fs-desc);
		color: var(--text-2);
		max-width: 280px;
		text-align: right;
	}
	@media (prefers-reduced-motion: no-preference) {
		.cine-toggle :global(.lucide-loader-circle) {
			animation: cine-spin 1s linear infinite;
		}
	}
	@keyframes cine-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
