<script lang="ts">
	import type { Snippet } from 'svelte'

	// 197: reusable window CHROME. A MAIN area flanked by a collapsible PRIMARY
	// sidebar and a SECONDARY panel that can show one of several MODES (e.g.
	// Properties / Settings), each with its own vertical tab. The secondary auto-
	// reflows to the side OPPOSITE the primary. Chrome-ONLY: it owns collapse /
	// side / resize / persistence + the tabs and knows NOTHING about its contents
	// (folders, nodes, ...). Consumers fill topbar/primary/main/secondary snippet
	// slots; `secondary` receives the active mode key. Prefs are LOCAL, persisted
	// per-window under `key`; nothing here is replicated.
	type Mode = { key: string; icon: string; label: string }
	let {
		key,
		primaryLabel = 'sidebar',
		primaryDefaultOpen = true,
		primaryDefaultWidth = 176,
		secondaryModes = [{ key: 'settings', icon: '⚙', label: 'Settings' }] as Mode[],
		secondaryDefaultOpen = false,
		topbar,
		primary,
		main,
		secondary
	}: {
		key: string
		primaryLabel?: string
		primaryDefaultOpen?: boolean
		primaryDefaultWidth?: number
		secondaryModes?: Mode[]
		secondaryDefaultOpen?: boolean
		topbar?: Snippet
		primary?: Snippet
		main?: Snippet
		secondary?: Snippet<[string]>
	} = $props()

	const LS = typeof localStorage === 'undefined' ? null : localStorage
	const readBool = (k: string, d: boolean) => {
		const v = LS?.getItem(k)
		return v == null ? d : v !== 'false'
	}

	// deliberate one-time prop reads: `key` is static per window and the Default*
	// props only seed first-run state (persisted to localStorage afterwards)
	// svelte-ignore state_referenced_locally
	let primaryOpen = $state(readBool(`ws:${key}:primaryOpen`, primaryDefaultOpen))
	// svelte-ignore state_referenced_locally
	let secondaryOpen = $state(readBool(`ws:${key}:secondaryOpen`, secondaryDefaultOpen))
	// svelte-ignore state_referenced_locally
	let secondaryMode = $state(LS?.getItem(`ws:${key}:secondaryMode`) ?? secondaryModes[0]?.key ?? 'settings')
	// PINNED = the user opened this panel via its tab (stays put); an auto-open via
	// showSecondary() is transient and the consumer may close it (e.g. on deselect)
	// svelte-ignore state_referenced_locally
	let secondaryPinned = $state(LS?.getItem(`ws:${key}:secondaryPinned`) === 'true')
	// svelte-ignore state_referenced_locally
	let side = $state<'left' | 'right'>(LS?.getItem(`ws:${key}:side`) === 'right' ? 'right' : 'left')
	// svelte-ignore state_referenced_locally
	let primaryWidth = $state(Number(LS?.getItem(`ws:${key}:primaryWidth`)) || primaryDefaultWidth)

	// the secondary always sits on the opposite edge from the primary (179)
	let secondarySide = $derived<'left' | 'right'>(side === 'left' ? 'right' : 'left')

	function togglePrimary() {
		primaryOpen = !primaryOpen
		LS?.setItem(`ws:${key}:primaryOpen`, String(primaryOpen))
	}
	function switchSide() {
		side = side === 'left' ? 'right' : 'left'
		LS?.setItem(`ws:${key}:side`, side)
	}
	function persistSecondary() {
		LS?.setItem(`ws:${key}:secondaryOpen`, String(secondaryOpen))
		LS?.setItem(`ws:${key}:secondaryMode`, secondaryMode)
		LS?.setItem(`ws:${key}:secondaryPinned`, String(secondaryPinned))
	}
	// a tab click PINS the panel (user chose to open it)
	function clickMode(m: string) {
		if (secondaryOpen && secondaryMode === m) secondaryOpen = false
		else {
			secondaryMode = m
			secondaryOpen = true
			secondaryPinned = true
		}
		persistSecondary()
	}
	// imperative API for consumers (e.g. open the inspector when an item is picked).
	// Opening a CLOSED panel this way is transient (unpinned); if it's already open
	// (pinned by the user) we keep the pin.
	export function showSecondary(m: string) {
		if (!secondaryOpen) secondaryPinned = false
		secondaryMode = m
		secondaryOpen = true
		persistSecondary()
	}
	export function hideSecondary() {
		secondaryOpen = false
		persistSecondary()
	}
	export function secondaryStatus() {
		return { open: secondaryOpen, mode: secondaryMode, pinned: secondaryPinned }
	}

	// primary-sidebar resize (chrome): drag the handle; width persists per-window
	let resizing = $state(false)
	function startResize(e: PointerEvent) {
		resizing = true
		;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
		e.preventDefault()
	}
	function doResize(e: PointerEvent) {
		if (!resizing) return
		const dx = side === 'left' ? e.movementX : -e.movementX
		primaryWidth = Math.min(Math.max(110, primaryWidth + dx), 460)
	}
	function endResize(e: PointerEvent) {
		if (!resizing) return
		resizing = false
		;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
		LS?.setItem(`ws:${key}:primaryWidth`, String(primaryWidth))
	}

	// flex order: primary hugs `side`; edges are constant so they hug the window
	// border once their panel is gone; main in the middle.
	let primaryPanelOrder = $derived(side === 'left' ? 0 : 6)
	let primaryEdgeOrder = $derived(side === 'left' ? 2 : 4)
	let secondaryTabsOrder = $derived(secondarySide === 'left' ? 2 : 4)
	let secondaryPanelOrder = $derived(secondarySide === 'left' ? 0 : 6)

	let activeMode = $derived(secondaryModes.find((m) => m.key === secondaryMode) ?? secondaryModes[0])
	// arrow points the way the panel would move: ‹ collapses a left tree / expands
	// a right one, and vice-versa. Same button reused open OR closed.
	let chevron = $derived((side === 'left') === primaryOpen ? '‹' : '›')
</script>

<div class="ws-root flex h-full w-full overflow-hidden">
	<!-- PRIMARY panel -->
	{#if primaryOpen}
		<div class="ws-panel flex h-full shrink-0 flex-col overflow-y-auto" style="order: {primaryPanelOrder}; width: {primaryWidth}px">
			{@render primary?.()}
		</div>
	{/if}
	<!-- PRIMARY edge: the SAME collapse bar whether open or closed (arrow flips);
	     the resize handle only exists while there's a panel to resize -->
	<div class="ws-edge shrink-0" style="order: {primaryEdgeOrder}">
		<button
			class="ws-edge-btn"
			onclick={togglePrimary}
			data-ws-primary-toggle
			title={primaryOpen ? `Hide ${primaryLabel}` : `Show ${primaryLabel}`}
		>{chevron}</button>
		{#if primaryOpen}
			<div
				class="ws-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
		{/if}
	</div>

	<!-- MAIN (+ optional topbar) -->
	<div class="ws-main flex min-w-0 flex-1 flex-col" style="order: 3">
		{#if topbar}
			<div class="shrink-0">{@render topbar()}</div>
		{/if}
		<div class="min-h-0 flex-1 overflow-hidden">{@render main?.()}</div>
	</div>

	<!-- SECONDARY mode tabs (stacked): they hug the border when the panel is closed -->
	<div class="ws-tabs shrink-0" style="order: {secondaryTabsOrder}">
		{#each secondaryModes as m (m.key)}
			<button
				class="ws-tab-btn {secondaryOpen && secondaryMode === m.key ? 'ws-tab-active' : ''}"
				title={m.label}
				data-ws-mode={m.key}
				onclick={() => clickMode(m.key)}
			>{m.icon}</button>
		{/each}
	</div>
	<!-- SECONDARY panel -->
	{#if secondaryOpen}
		<div class="ws-panel ws-panel-secondary flex h-full shrink-0 flex-col overflow-y-auto" style="order: {secondaryPanelOrder}">
			<div class="ws-panel-head flex shrink-0 items-center gap-1 px-2 py-1">
				<span class="flex-1 truncate text-xs font-semibold opacity-80">{activeMode?.label}</span>
				<button class="ws-mini" title="Switch sidebar side" onclick={switchSide} data-ws-switch-side>⇄</button>
				<button class="ws-mini" title="Close" onclick={hideSecondary}>✕</button>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto">{@render secondary?.(secondaryMode)}</div>
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
	.ws-edge {
		position: relative;
		display: flex;
		width: 0.5rem;
		flex-direction: column;
	}
	.ws-edge-btn {
		display: flex;
		height: 1.75rem;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
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
	.ws-tabs {
		display: flex;
		width: 1rem;
		flex-direction: column;
		gap: 1px;
		padding-top: 2rem;
	}
	.ws-tab-btn {
		display: flex;
		height: 3.25rem;
		width: 100%;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		color: rgb(203 213 225);
		background: rgb(55 65 81);
		cursor: pointer;
	}
	.ws-tab-btn:first-child {
		border-radius: 0.25rem 0 0 0;
	}
	.ws-tab-btn:hover {
		background: rgb(75 85 99);
	}
	.ws-tab-active {
		background: rgb(37 99 235);
		color: white;
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
