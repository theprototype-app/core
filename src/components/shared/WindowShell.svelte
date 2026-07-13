<script lang="ts">
	import type { Snippet } from 'svelte'

	// 197: reusable window CHROME. A MAIN area flanked by a collapsible PRIMARY
	// sidebar and a SECONDARY (settings/inspector) sidebar that auto-reflows to the
	// side OPPOSITE the primary. Chrome-ONLY: it owns collapse / side / persistence
	// + the toggle tabs and knows NOTHING about its contents (folders, nodes, ...) —
	// consumers fill the `topbar` / `primary` / `main` / `secondary` snippet slots
	// and decide what `secondary` renders (settings vs. selected-item props).
	// Modeled on Flow's palette/props panels (Nodes.svelte). Prefs are LOCAL,
	// persisted per-window under `key`; nothing here is replicated.
	let {
		key,
		primaryLabel = 'Sidebar',
		secondaryLabel = 'Settings',
		primaryDefaultOpen = true,
		secondaryDefaultOpen = false,
		primaryDefaultWidth = 176,
		primaryIcon = '☰',
		secondaryIcon = '⚙',
		topbar,
		primary,
		main,
		secondary
	}: {
		key: string
		primaryLabel?: string
		secondaryLabel?: string
		primaryDefaultOpen?: boolean
		secondaryDefaultOpen?: boolean
		primaryDefaultWidth?: number
		primaryIcon?: string
		secondaryIcon?: string
		topbar?: Snippet
		primary?: Snippet
		main?: Snippet
		secondary?: Snippet
	} = $props()

	const LS = typeof localStorage === 'undefined' ? null : localStorage
	const readBool = (k: string, d: boolean) => {
		const v = LS?.getItem(k)
		return v == null ? d : v !== 'false'
	}

	let primaryOpen = $state(readBool(`ws:${key}:primaryOpen`, primaryDefaultOpen))
	let secondaryOpen = $state(readBool(`ws:${key}:secondaryOpen`, secondaryDefaultOpen))
	let side = $state<'left' | 'right'>(LS?.getItem(`ws:${key}:side`) === 'right' ? 'right' : 'left')
	let primaryWidth = $state(Number(LS?.getItem(`ws:${key}:primaryWidth`)) || primaryDefaultWidth)

	// the secondary always sits on the opposite edge from the primary (179)
	let secondarySide = $derived<'left' | 'right'>(side === 'left' ? 'right' : 'left')

	// primary-sidebar resize (chrome): drag the splitter; width persists per-window
	let resizing = $state(false)
	function startResize(e: PointerEvent) {
		resizing = true
		;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
		e.preventDefault()
	}
	function doResize(e: PointerEvent) {
		if (!resizing) return
		// dragging toward `main` grows the panel; direction flips when on the right
		const dx = side === 'left' ? e.movementX : -e.movementX
		primaryWidth = Math.min(Math.max(110, primaryWidth + dx), 460)
	}
	function endResize(e: PointerEvent) {
		if (!resizing) return
		resizing = false
		;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
		LS?.setItem(`ws:${key}:primaryWidth`, String(primaryWidth))
	}

	function togglePrimary() {
		primaryOpen = !primaryOpen
		LS?.setItem(`ws:${key}:primaryOpen`, String(primaryOpen))
	}
	function toggleSecondary() {
		secondaryOpen = !secondaryOpen
		LS?.setItem(`ws:${key}:secondaryOpen`, String(secondaryOpen))
	}
	function switchSide() {
		side = side === 'left' ? 'right' : 'left'
		LS?.setItem(`ws:${key}:side`, side)
	}

	// flex order: primary hugs `side`, secondary the opposite; main in the middle.
	// tab sits between main and its panel (panel is further out), like Flow.
	let primaryTabOrder = $derived(side === 'left' ? 1 : 5)
	let primaryPanelOrder = $derived(side === 'left' ? 0 : 6)
	let secondaryTabOrder = $derived(secondarySide === 'left' ? 1 : 5)
	let secondaryPanelOrder = $derived(secondarySide === 'left' ? 0 : 6)
</script>

<div class="ws-root flex h-full w-full overflow-hidden">
	<!-- PRIMARY panel + inner edge: collapse chevron on top, resize handle below
	     (kept separate so the drag-to-resize zone never eats the collapse click) -->
	{#if primaryOpen}
		<div class="ws-panel flex h-full shrink-0 flex-col overflow-y-auto" style="order: {primaryPanelOrder}; width: {primaryWidth}px">
			{@render primary?.()}
		</div>
		<div class="ws-edge shrink-0" style="order: {side === 'left' ? 2 : 4}">
			<button class="ws-edge-btn" onclick={togglePrimary} data-ws-primary-toggle title={`Collapse ${primaryLabel}`}>{side === 'left' ? '‹' : '›'}</button>
			<div
				class="ws-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
		</div>
	{:else}
		<div class="relative w-0 shrink-0" style="order: {primaryTabOrder}">
			<button
				class="ws-tab {side === 'right' ? 'ws-tab-mirror' : ''}"
				style="{side === 'left' ? 'left' : 'right'}: -1px"
				title={`Show ${primaryLabel}`}
				onclick={togglePrimary}
				data-ws-primary-toggle
			>{primaryIcon}</button>
		</div>
	{/if}

	<!-- MAIN (+ optional topbar) -->
	<div class="ws-main flex min-w-0 flex-1 flex-col" style="order: 3">
		{#if topbar}
			<div class="ws-topbar shrink-0">{@render topbar()}</div>
		{/if}
		<div class="min-h-0 flex-1 overflow-hidden">{@render main?.()}</div>
	</div>

	<!-- SECONDARY toggle tab (always visible) -->
	<div class="relative w-0" style="order: {secondaryTabOrder}">
		<button
			class="ws-tab {secondarySide === 'right' ? 'ws-tab-mirror' : ''}"
			style="{secondarySide === 'left' ? 'left' : 'right'}: -1px; top: 2.75rem"
			title={secondaryOpen ? `Hide ${secondaryLabel}` : `Show ${secondaryLabel}`}
			onclick={toggleSecondary}
			data-ws-secondary-toggle
		>{secondaryIcon}</button>
	</div>
	<!-- SECONDARY panel -->
	{#if secondaryOpen}
		<div class="ws-panel ws-panel-secondary flex h-full shrink-0 flex-col overflow-y-auto" style="order: {secondaryPanelOrder}">
			<div class="ws-panel-head flex shrink-0 items-center gap-1 px-2 py-1">
				<span class="flex-1 truncate text-xs font-semibold opacity-80">{secondaryLabel}</span>
				<button class="ws-mini" title="Switch sidebar side" onclick={switchSide} data-ws-switch-side>⇄</button>
				<button class="ws-mini" title="Hide {secondaryLabel}" onclick={toggleSecondary}>✕</button>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto">{@render secondary?.()}</div>
		</div>
	{/if}
</div>

<style>
	.ws-panel {
		width: 14rem;
		background: var(--ws-panel-bg, rgb(31 41 55));
		color: var(--ws-panel-fg, rgb(229 231 235));
		border-inline: 1px solid rgb(255 255 255 / 0.06);
	}
	.ws-tab {
		position: absolute;
		top: 2rem;
		display: flex;
		height: 3.5rem;
		width: 1rem;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		color: rgb(226 232 240);
		background: rgb(55 65 81);
		border-radius: 0 0.25rem 0.25rem 0;
		cursor: pointer;
		z-index: 10;
	}
	.ws-tab:hover {
		background: rgb(75 85 99);
	}
	.ws-tab-mirror {
		border-radius: 0.25rem 0 0 0.25rem;
	}
	.ws-edge {
		position: relative;
		display: flex;
		width: 0.5rem;
		flex-direction: column;
	}
	.ws-edge-btn {
		display: flex;
		height: 1.5rem;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		color: rgb(226 232 240);
		background: rgb(55 65 81);
		cursor: pointer;
		z-index: 20;
	}
	.ws-edge-btn:hover {
		background: rgb(75 85 99);
	}
	.ws-resize {
		flex: 1;
		cursor: ew-resize;
		border-inline: 1px solid rgb(255 255 255 / 0.06);
	}
	.ws-resize:hover {
		background: rgb(255 255 255 / 0.08);
	}
	.ws-mini {
		display: inline-flex;
		height: 1.25rem;
		width: 1.25rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		color: rgb(203 213 225);
	}
	.ws-mini:hover {
		background: rgb(255 255 255 / 0.1);
	}
</style>
