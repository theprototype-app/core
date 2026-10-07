<script lang="ts">
	// 36 I5 — the screen surface of the tour engine (T1): a card anchored next to the step's
	// `data-tour` target, with a spotlight ring around the target. The rest of the app stays
	// usable (the spotlight is click-through), because a tour that blocks the thing it points at
	// teaches nothing. A VR tour shown here is the PREVIEW (Settings → Tours on a screen): the
	// same steps, with the controller diagrams inline.
	import { onMount, onDestroy } from 'svelte'
	import { activeTour, tours } from '$lib/tours/index.js'
	import { installTours, BUILTIN_TARGETS, FAMILY_KEY } from '$lib/tours/builtin.js'
	import { placeCard, targetSelectors, SPOT_PAD } from '$lib/tours/place.js'
	import { controllerSvg, litFor, familyLabel } from '$lib/tours/controllerArt.js'
	import { isVRMode } from '../../stores/sceneStore'
	import { safeStorage } from '$lib/safeStorage'
	import { minimalScroll } from '$lib/ui/minimalScroll.js'

	let uninstall: (() => void) | null = null
	onMount(() => {
		uninstall = installTours()
	})
	onDestroy(() => uninstall?.())

	let tour = $derived($activeTour && !$isVRMode && ($activeTour.surface === 'card' || $activeTour.preview) ? $activeTour : null)

	let cardEl: HTMLElement | null = $state(null)
	let spot: { x: number; y: number; w: number; h: number } | null = $state(null)
	let pos = $state({ x: 0, y: 0, side: 'center', w: 340 })
	// the preview's controller pair: what the headset last reported, else Quest 3 / 3S
	let family: any = $state(safeStorage.getItem(FAMILY_KEY) || 'quest3')

	function findTarget(target: string | undefined): HTMLElement | null {
		for (const selector of targetSelectors(target ?? '', BUILTIN_TARGETS)) {
			let el: Element | null = null
			try {
				el = document.querySelector(selector)
			} catch {
				el = null
			}
			const rect = el?.getBoundingClientRect()
			if (el instanceof HTMLElement && rect && rect.width > 0 && rect.height > 0) return el
		}
		return null
	}

	function layout() {
		if (!tour) return
		const el = tour.step.placement === 'center' ? null : findTarget(tour.step.target)
		const r = el?.getBoundingClientRect()
		spot = r ? { x: r.x - SPOT_PAD, y: r.y - SPOT_PAD, w: r.width + 2 * SPOT_PAD, h: r.height + 2 * SPOT_PAD } : null
		const vw = window.innerWidth
		const vh = window.innerHeight
		const card = { w: Math.min(360, vw - 24), h: cardEl?.offsetHeight || 200 }
		pos = placeCard(spot, card, vw, vh, tour.step.placement ?? 'auto')
	}

	// re-place on every step, on resize, and on a slow poll (targets move: docks, the pill reflow)
	$effect(() => {
		if (!tour) return
		void tour.step.id
		void family
		const frame = requestAnimationFrame(() => {
			layout()
			// a second pass once the card has its real height
			requestAnimationFrame(layout)
			cardEl?.focus({ preventScroll: true })
		})
		window.addEventListener('resize', layout)
		const poll = setInterval(layout, 400)
		return () => {
			cancelAnimationFrame(frame)
			window.removeEventListener('resize', layout)
			clearInterval(poll)
		}
	})

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			tours.skip()
		} else if (e.key === 'ArrowRight') {
			e.preventDefault()
			tours.next()
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault()
			tours.back()
		}
	}

	const artColors = {
		line: 'var(--text-muted)',
		fill: 'var(--surface-2)',
		accent: 'var(--accent)',
		accentFill: 'var(--accent-fill)',
		text: 'var(--text)',
		label: 'var(--on-accent)'
	}
</script>

{#if tour}
	{#if spot}
		<div
			id="tour-spotlight"
			class="tour-spot"
			style="left: {spot.x}px; top: {spot.y}px; width: {spot.w}px; height: {spot.h}px;"
			aria-hidden="true"
		></div>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		id="tour-card"
		bind:this={cardEl}
		use:minimalScroll
		class="tour-card"
		class:sheet={pos.side.startsWith('sheet')}
		style="left: {pos.x}px; top: {pos.y}px; width: {pos.w}px;"
		role="dialog"
		aria-modal="false"
		aria-labelledby="tour-title"
		tabindex="-1"
		data-tour-id={tour.id}
		data-step={tour.step.id}
		data-side={pos.side}
		onkeydown={onKeydown}
	>
		<div class="tour-head">
			<span class="tour-name">{tour.title}{tour.preview ? ' · preview' : ''}</span>
			<span class="tour-count" id="tour-count">{tour.index + 1} / {tour.total}</span>
		</div>
		<h3 id="tour-title" class="tour-title">{tour.step.title}</h3>
		<p class="tour-body">{tour.step.body}</p>
		{#if tour.step.controls}
			<div class="tour-art" data-family={family}>
				{@html controllerSvg({ family, lit: litFor(tour.step.controls), colors: artColors })}
			</div>
			{#if tour.preview}
				<div class="tour-family" role="group" aria-label="Controllers">
					<button class:on={family === 'quest2'} onclick={() => (family = 'quest2')}>Quest 2</button>
					<button class:on={family === 'quest3'} onclick={() => (family = 'quest3')}>Quest 3 / 3S</button>
				</div>
			{:else}
				<p class="tour-dim">{familyLabel(family)}</p>
			{/if}
		{/if}
		{#if tour.step.hint}
			<p class="tour-hint">→ {tour.step.hint}</p>
		{/if}
		<div class="tour-actions">
			<button id="tour-skip" class="tour-link" onclick={() => tours.skip()}>Skip</button>
			<button id="tour-never" class="tour-link" onclick={() => tours.dontShowAgain()}>Don't show again</button>
			<span class="tour-spacer"></span>
			{#if !tour.first}
				<button id="tour-back" class="tour-btn" onclick={() => tours.back()}>Back</button>
			{/if}
			<button id="tour-next" class="tour-btn tour-primary" onclick={() => tours.next()}>{tour.last ? 'Done' : 'Next'}</button>
		</div>
	</div>
{/if}

<style>
	.tour-spot {
		position: fixed;
		z-index: calc(var(--z-modal) - 6);
		border-radius: 12px;
		pointer-events: none;
		outline: 2px solid var(--accent);
		outline-offset: 0;
		box-shadow: 0 0 0 9999px var(--scrim);
		transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease;
		animation: tour-pulse 1.8s ease-in-out infinite;
	}
	@keyframes tour-pulse {
		50% {
			outline-offset: 4px;
		}
	}
	.tour-card {
		position: fixed;
		z-index: calc(var(--z-modal) - 5);
		max-height: calc(100dvh - 24px);
		overflow-y: auto;
		padding: 14px 16px 12px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: var(--surface-1);
		color: var(--text);
		box-shadow: var(--shadow-window);
		transition: left 0.25s ease, top 0.25s ease;
		outline: none;
		user-select: none;
	}
	.tour-head {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.tour-title {
		margin: 4px 0 6px;
		font-size: 16px;
		font-weight: 700;
		line-height: 1.25;
	}
	.tour-body {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.45;
		color: var(--text-2);
	}
	.tour-art {
		margin: 10px auto 2px;
		max-width: 280px;
	}
	.tour-art :global(svg) {
		width: 100%;
		height: auto;
		display: block;
	}
	.tour-dim {
		margin: 0;
		text-align: center;
		font-size: 11px;
		color: var(--text-muted);
	}
	.tour-family {
		display: flex;
		justify-content: center;
		gap: 4px;
		margin-top: 2px;
	}
	.tour-family button {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--text-muted);
	}
	.tour-family button.on {
		color: var(--text);
		border-color: var(--accent);
	}
	.tour-hint {
		margin: 8px 0 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent-text);
	}
	.tour-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		flex-wrap: wrap;
	}
	.tour-spacer {
		flex: 1;
	}
	.tour-link {
		font-size: 12px;
		color: var(--text-muted);
		padding: 4px 2px;
	}
	.tour-link:hover {
		color: var(--text);
		text-decoration: underline;
	}
	.tour-btn {
		font-size: 13px;
		padding: 5px 12px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
	}
	.tour-btn:hover {
		background: var(--surface-hover);
	}
	.tour-primary {
		background: var(--accent-fill);
		border-color: var(--accent-fill);
		color: var(--on-accent);
	}
	.tour-primary:hover {
		background: var(--accent-fill);
		filter: brightness(0.92);
	}
	.tour-card.sheet {
		border-radius: 16px;
	}
	@media (prefers-reduced-motion: reduce) {
		.tour-spot,
		.tour-card {
			transition: none;
			animation: none;
		}
	}
</style>
