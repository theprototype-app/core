<script lang="ts">
	import type { Snippet } from 'svelte'
	import { minimalScroll } from '$lib/ui/minimalScroll.js'
	// 41 G18: on a phone both sidebars start HIDDEN until the user opens them (per window, per device)
	import { readPanelOpen, writePanelOpen, handheld } from '$lib/ui/handheldPanels.js'
	import { uiScale } from '$lib/uiScale'
	import PaneHandle from '../ui/PaneHandle.svelte'
	import Icon from '../ui/Icon.svelte'
	import { paneLocks } from '$lib/ui/paneLocks.js'
	import { edgeFade } from '$lib/ui/edgeFade.js'

	// 197: reusable window CHROME. A MAIN area flanked by a collapsible PRIMARY
	// sidebar and a SECONDARY panel that can show one of several MODES (e.g.
	// Properties / Settings), each with its own vertical tab. The secondary auto-
	// reflows to the side OPPOSITE the primary. Chrome-ONLY: it owns collapse /
	// side / resize / persistence + the tabs and knows NOTHING about its contents
	// (folders, nodes, ...). Consumers fill topbar/primary/main/secondary snippet
	// slots; `secondary` receives the active mode key. Prefs are LOCAL, persisted
	// per-window under `key`; nothing here is replicated.
	// Mode.icon: a Lucide name from ui/Icon.svelte, or a text glyph (78-int PL42: no emoji)
	type Mode = { key: string; icon: string; label: string }
	let {
		key,
		primaryLabel = 'sidebar',
		primaryDefaultOpen = true,
		primaryDefaultWidth = 176,
		secondaryModes = [{ key: 'settings', icon: 'settings', label: 'Settings' }] as Mode[],
		secondaryDefaultOpen = false,
		secondaryDefaultWidth = 224,
		// 36 B14: Settings on a phone shows its sections as a chip strip in the topbar, so it
		// draws no sidebar at all; and a window with no secondary modes draws no tab column
		hidePrimary = false,
		// showhide-v8 §3: what the MAIN area is called in the narrow header (Files, Layout, Image ...)
		mainLabel = 'View',
		// false = this window keeps its own narrow layout (the Image editor stacks its panel UNDER the canvas, because a
		// crop is dragged on the image while the panel shows)
		narrowHeader = true,
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
		secondaryDefaultWidth?: number
		hidePrimary?: boolean
		mainLabel?: string
		narrowHeader?: boolean
		topbar?: Snippet
		primary?: Snippet
		main?: Snippet
		secondary?: Snippet<[string]>
	} = $props()

	const LS = typeof localStorage === 'undefined' ? null : localStorage

	// deliberate one-time prop reads: `key` is static per window and the Default*
	// props only seed first-run state (persisted to localStorage afterwards)
	// svelte-ignore state_referenced_locally
	let primaryOpen = $state(readPanelOpen(`ws:${key}:primaryOpen`, primaryDefaultOpen))
	// svelte-ignore state_referenced_locally
	let secondaryOpen = $state(readPanelOpen(`ws:${key}:secondaryOpen`, secondaryDefaultOpen))
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
	// 21-I2: the secondary resizes too (it was a hardcoded 14rem). This is the width the
	// USER chose and the one that persists; what gets RENDERED is `secondaryEff` below.
	// svelte-ignore state_referenced_locally
	let secondaryWidth = $state(Number(LS?.getItem(`ws:${key}:secondaryWidth`)) || secondaryDefaultWidth)

	// the secondary always sits on the opposite edge from the primary (179)
	let secondarySide = $derived<'left' | 'right'>(side === 'left' ? 'right' : 'left')

	// 18-B, and the reason this is not a constant: a flat cap is how a grip ends up off
	// screen. This shell lives in a dock the user can shrink to a few hundred pixels, so
	// the ceiling is MEASURED from the container and re-applied when it shrinks.
	const SEC_MIN = 140
	const MAIN_MIN = 160
	// showhide-v8: the panes' handles take NO margin (they hang over the content's edge), so no chrome column is left
	const CHROME = 0
	let rootW = $state(0)
	// 53 A1: the two widths are DESIGN px (stored and clamped as at 100 %) and drawn × the UI scale,
	// like every CSS length around them — so a stored width needs no rescale when the scale changes
	const k = $derived($uiScale / 100)
	let secondaryMax = $derived(
		Math.max(SEC_MIN, (rootW || 640) / k - CHROME - (primaryOpen ? primaryWidth : 0) - MAIN_MIN)
	)
	// This derived IS the re-clamp: a dock that SHRINKS narrows the panel on the next
	// frame, with no effect and no write. The pref is kept WHOLE, so widening the dock
	// again gives the user their width back instead of having eaten it -- which is also
	// why the clamp is not folded into the stored value.
	let secondaryEff = $derived(Math.min(secondaryWidth, secondaryMax))

	// showhide-v8 §3 — THE NARROW HEADER (owner: the Animation tab's phone view is the model for every docked window
	// "instead of sidebars"). On a touch handheld, when the shell is narrower than NARROW_W design px (a folded phone,
	// or one half of a split dock on the unfolded one), the side panes stop being columns with edge handles: ONE header
	// row names every view — the primary pane, the main area, each secondary mode — and ONE shows at a time, full
	// width. The main area stays MOUNTED (hidden) while a pane is up, so a canvas or a scroll position survives a
	// look at the settings. The header scrolls sideways when its views do not fit (the edge fade says there is more).
	// A pane picked here is remembered per window (`ws:<key>:narrowPane`), the phone rule the column panes keep.
	const NARROW_W = 560
	const touchHandheld = handheld()
	const narrow = $derived(narrowHeader && touchHandheld && rootW > 0 && rootW / k < NARROW_W)
	const paneKeys = $derived([...(hidePrimary || !primary ? [] : ['primary']), 'main', ...secondaryModes.map((m) => m.key)])
	// svelte-ignore state_referenced_locally
	let narrowPane = $state(LS?.getItem(`ws:${key}:narrowPane`) ?? 'main')
	const pane = $derived(paneKeys.includes(narrowPane) ? narrowPane : 'main')
	const narrowMode = $derived(narrow && pane !== 'main' && pane !== 'primary' ? pane : null)
	/** a header tap: the view in front tapped again goes back to the main area (the old tab toggle) */
	function pickPane(p: string) {
		narrowPane = p === pane && p !== 'main' ? 'main' : p
		if (narrowPane !== 'main' && narrowPane !== 'primary') secondaryMode = narrowPane
		LS?.setItem(`ws:${key}:narrowPane`, narrowPane)
	}
	const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

	// showhide-v8 (owner 2026-11-09, "allow locking sidebars"): a locked window's handles stop hiding / showing panes
	const locked = $derived(!!$paneLocks[key])
	function togglePrimary() {
		if (locked) return
		primaryOpen = !primaryOpen
		writePanelOpen(`ws:${key}:primaryOpen`, primaryOpen)
	}
	function switchSide() {
		side = side === 'left' ? 'right' : 'left'
		LS?.setItem(`ws:${key}:side`, side)
	}
	function persistSecondary() {
		// on a phone only a panel the user OPENED (pinned) is remembered open: one a pick opened
		// for a moment (showSecondary) must not greet them next time
		writePanelOpen(`ws:${key}:secondaryOpen`, handheld() ? secondaryOpen && secondaryPinned : secondaryOpen)
		LS?.setItem(`ws:${key}:secondaryMode`, secondaryMode)
		LS?.setItem(`ws:${key}:secondaryPinned`, String(secondaryPinned))
	}
	// showhide-v8: the ONE right handle shows / hides the secondary pane on its last mode (its modes are tabs inside it)
	function toggleSecondary() {
		if (locked) return
		if (secondaryOpen) secondaryOpen = false
		else {
			secondaryOpen = true
			secondaryPinned = true
		}
		persistSecondary()
	}
	// a tab click PINS the panel (user chose to open it); the tab in front closes it (the old stacked-tab toggle)
	function clickMode(m: string) {
		// showhide-v8: the modes are tabs INSIDE the open pane now, so the front tab stays (the handle hides the pane)
		if (secondaryOpen && secondaryMode === m) return
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
	/** @param auto an AUTOMATIC open (an element selected, a brush armed): in the narrow header it leaves the view in
	 *  front alone, or a tap on the layout would swap the layout away under the finger */
	export function showSecondary(m: string, auto = false) {
		if (!secondaryOpen) secondaryPinned = false
		secondaryMode = m
		secondaryOpen = true
		persistSecondary()
		// narrow: a user's pick (a menu's "Properties") shows that view for now (not remembered: not a header tap)
		if (narrow && !auto) narrowPane = m
	}
	export function hideSecondary() {
		secondaryOpen = false
		persistSecondary()
		if (narrow && narrowMode) narrowPane = 'main'
	}
	export function secondaryStatus() {
		if (narrow) return { open: !!narrowMode, mode: narrowMode ?? secondaryMode, pinned: secondaryPinned, narrow: true }
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
		const dx = (side === 'left' ? e.movementX : -e.movementX) / k
		primaryWidth = Math.min(Math.max(110, primaryWidth + dx), 460)
	}
	function endResize(e: PointerEvent) {
		if (!resizing) return
		resizing = false
		;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
		LS?.setItem(`ws:${key}:primaryWidth`, String(primaryWidth))
	}

	// 21-I2: the same gesture for the SECONDARY panel. Its grip lives in the tab column,
	// which already sits on that panel's INNER edge on either side -- so the drag SIGN
	// flips with `secondarySide`: the panel grows when the pointer moves AWAY from the
	// window border it hugs (left panel -> rightwards, right panel -> leftwards).
	let resizingSec = $state(false)
	function startSecResize(e: PointerEvent) {
		resizingSec = true
		;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
		e.preventDefault()
	}
	function doSecResize(e: PointerEvent) {
		if (!resizingSec) return
		const dx = (secondarySide === 'left' ? e.movementX : -e.movementX) / k
		// from the RENDERED width, so a drag that starts against the ceiling tracks the
		// pointer instead of first replaying the pref it was clamped from
		secondaryWidth = Math.min(Math.max(SEC_MIN, secondaryEff + dx), secondaryMax)
	}
	function endSecResize(e: PointerEvent) {
		if (!resizingSec) return
		resizingSec = false
		;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
		LS?.setItem(`ws:${key}:secondaryWidth`, String(secondaryWidth))
	}
	/** dblclick on the grip = back to the default width (the 18-B window rule) */
	function resetSecondary() {
		secondaryWidth = secondaryDefaultWidth
		LS?.removeItem(`ws:${key}:secondaryWidth`)
	}

	// flex order: primary hugs `side`; edges are constant so they hug the window
	// border once their panel is gone; main in the middle.
	let primaryPanelOrder = $derived(side === 'left' ? 0 : 6)
	let primaryEdgeOrder = $derived(side === 'left' ? 2 : 4)
	let secondaryTabsOrder = $derived(secondarySide === 'left' ? 2 : 4)
	let secondaryPanelOrder = $derived(secondarySide === 'left' ? 0 : 6)

	let activeMode = $derived(secondaryModes.find((m) => m.key === secondaryMode) ?? secondaryModes[0])
	// showhide-v8: the modes' icons are Lucide names; the glyphs older callers passed map onto them (no emoji in the UI)
	const GLYPHS: Record<string, string> = { 'ⓘ': 'info', '✎': 'pencil', '⟲': 'history' }
	const iconOf = (m?: Mode) => (m ? (GLYPHS[m.icon] ?? m.icon) : 'settings')
	// the handles sit BELOW the topbar (owner: "placed lower, covering no controls")
	let topbarH = $state(0)
	const handleTop = $derived(Math.round(topbarH + 8))
</script>

<div class="ws-root relative flex h-full w-full overflow-hidden" class:ws-narrow={narrow} data-ws-narrow={narrow ? '' : undefined} bind:clientWidth={rootW}>
	<!-- showhide-v8 §3: the narrow header — every view of this window, one in front -->
	{#if narrow}
		<div class="ws-hdr tp-noscrollbar" role="tablist" aria-label="Views" use:edgeFade>
			{#each paneKeys as p (p)}
				{@const m = secondaryModes.find((x) => x.key === p)}
				<button
					type="button"
					role="tab"
					class="ws-hdr-btn"
					aria-selected={pane === p}
					data-ws-pane={p}
					data-ws-primary-toggle={p === 'primary' ? '' : undefined}
					data-ws-mode={m ? m.key : undefined}
					title={p === 'primary' ? (pane === 'primary' ? 'Hide ' : 'Show ') + primaryLabel : p === 'main' ? mainLabel : m?.label}
					onclick={() => pickPane(p)}
				>{#if m}<Icon name={iconOf(m)} size={16} aria-hidden="true" />{/if}<span>{p === 'primary' ? cap(primaryLabel) : p === 'main' ? mainLabel : m?.label}</span></button>
			{/each}
		</div>
	{/if}
	<!-- PRIMARY panel; its resize grip rides its inner border (no chrome column: showhide-v8) -->
	{#if narrow ? pane === 'primary' : primaryOpen && !hidePrimary}
		<div class="ws-panel relative flex h-full shrink-0 flex-col" style={narrow ? 'order: 1' : `order: ${primaryPanelOrder}; width: ${primaryWidth * k}px`}>
			<div class="min-h-0 flex-1 overflow-y-auto" use:minimalScroll>{@render primary?.()}</div>
			{#if !locked && !narrow}
				<div
					class="ws-resize"
					class:ws-resize-left={side === 'left'}
					class:ws-resize-right={side === 'right'}
					style="touch-action: none"
					title="Drag to resize"
					data-ws-primary-resize
					onpointerdown={startResize}
					onpointermove={doResize}
					onpointerup={endResize}
				></div>
			{/if}
		</div>
	{/if}

	<!-- MAIN (+ optional topbar): full width when the panes are hidden -->
	<div class="ws-main flex min-w-0 flex-1 flex-col" class:ws-off={narrow && pane !== 'main'} style="order: 3">
		{#if topbar}
			<div class="shrink-0" bind:clientHeight={topbarH}>{@render topbar()}</div>
		{/if}
		<div class="min-h-0 flex-1 overflow-hidden">{@render main?.()}</div>
	</div>

	<!-- SECONDARY panel: its modes are TABS in its header, behind ONE handle (the node editor's right sidebar) -->
	{#if narrow ? !!narrowMode : secondaryOpen}
		<div
			class="ws-panel ws-panel-secondary relative flex h-full shrink-0 flex-col"
			style={narrow ? 'order: 1' : `order: ${secondaryPanelOrder}; width: ${secondaryEff * k}px`}
		>
			{#if !narrow}
			<div class="ws-panel-head flex shrink-0 items-center gap-1 px-1 py-1">
				<div class="ws-modes tp-noscrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Panel">
					{#each secondaryModes as m (m.key)}
						<button
							type="button"
							role="tab"
							class="ws-mode {secondaryMode === m.key ? 'ws-tab-active' : ''}"
							aria-selected={secondaryMode === m.key}
							title={m.label}
							data-ws-mode={m.key}
							onclick={() => clickMode(m.key)}
						><Icon name={iconOf(m)} size={16} aria-hidden="true" /><span class="truncate">{m.label}</span></button>
					{/each}
				</div>
				<button class="ws-mini" title="Switch sidebar side" aria-label="Switch sidebar side" onclick={switchSide} data-ws-switch-side><Icon name="arrow-left-right" size={16} aria-hidden="true" /></button>
				<button class="ws-mini" title="Close" aria-label="Close" disabled={locked} onclick={hideSecondary}><Icon name="x" size={16} aria-hidden="true" /></button>
			</div>
			{/if}
			<div class="min-h-0 flex-1 overflow-y-auto tp-noscrollbar" use:minimalScroll>{@render secondary?.(narrow ? (narrowMode ?? secondaryMode) : secondaryMode)}</div>
			{#if !locked && !narrow}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="ws-resize"
					class:ws-resize-left={secondarySide === 'left'}
					class:ws-resize-right={secondarySide === 'right'}
					style="touch-action: none"
					data-ws-secondary-resize
					title="Drag to resize · double-click to reset"
					onpointerdown={startSecResize}
					onpointermove={doSecResize}
					onpointerup={endSecResize}
					ondblclick={resetSecondary}
				></div>
			{/if}
		</div>
	{/if}

	<!-- showhide-v8: ONE arrow handle per side, hanging over the content's edge (no margin). The primary's on the
	     window edge while it is hidden, on the panel's inner edge while it shows; the secondary's carries its
	     active mode's role icon (the hybrid) -->
	{#if !hidePrimary && !narrow}
		<PaneHandle
			edge={side}
			open={primaryOpen}
			label={primaryLabel}
			windowKey={key}
			onclick={togglePrimary}
			data-ws-primary-toggle
			style="top: {handleTop}px; {side === 'left' ? 'left' : 'right'}: {primaryOpen ? primaryWidth * k : 0}px"
		/>
	{/if}
	{#if secondaryModes.length && !narrow}
		<PaneHandle
			edge={secondarySide}
			open={secondaryOpen}
			label={secondaryModes.length > 1 ? secondaryModes.map((m) => m.label).join(' / ') : (activeMode?.label ?? 'the panel')}
			role={iconOf(activeMode)}
			windowKey={key}
			onclick={toggleSecondary}
			data-ws-secondary-toggle
			style="top: {handleTop}px; {secondarySide === 'left' ? 'left' : 'right'}: {secondaryOpen ? secondaryEff * k : 0}px"
		/>
	{/if}
</div>

<style>
	.ws-panel {
		width: 14rem;
		/* 36 U1: the theme's surface + ink. The panel was gray-800 in every theme while the
		   remapped text utilities inside it turned dark on the light theme: the Explorer's
		   root rows read 1:1 */
		background: var(--ws-panel-bg, var(--surface-2));
		color: var(--ws-panel-fg, var(--text));
		border-inline: 1px solid var(--border);
	}
	/* showhide-v8: the grip rides the panel's INNER border (absolute), so no chrome column eats the content */
	.ws-resize {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		z-index: 21;
		cursor: ew-resize;
	}
	.ws-resize-left {
		right: -3px;
	}
	.ws-resize-right {
		left: -3px;
	}
	.ws-resize:hover {
		background: var(--surface-hover);
	}
	@media (pointer: coarse) {
		.ws-resize {
			width: 14px;
		}
		.ws-resize-left {
			right: -7px;
		}
		.ws-resize-right {
			left: -7px;
		}
	}
	.ws-mode {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		height: 1.5rem;
		padding: 0 6px;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-2);
		cursor: pointer;
		flex-shrink: 0;
	}
	.ws-mode:hover {
		background: var(--surface-hover);
	}
	.ws-tab-active {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.ws-tab-active:hover {
		background: var(--accent-fill);
	}
	.ws-mini {
		display: inline-flex;
		height: 1.25rem;
		width: 1.25rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.ws-mini:hover {
		background: var(--surface-hover);
	}
	/* showhide-v8 §3: the narrow header — a column: the header row, then the ONE view in front at full width */
	.ws-narrow {
		flex-direction: column;
	}
	.ws-narrow > .ws-panel {
		width: 100%;
		height: auto;
		flex: 1 1 0;
		min-height: 0;
		border-inline: 0;
	}
	.ws-narrow > .ws-main {
		min-height: 0;
	}
	.ws-off {
		display: none;
	}
	.ws-hdr {
		order: 0;
		display: flex;
		flex-shrink: 0;
		gap: 2px;
		margin: 4px 8px;
		padding: 2px;
		overflow-x: auto;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
	}
	.ws-hdr-btn {
		flex: 1 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: calc(var(--control-h-sm) - 2px);
		padding: 3px 12px;
		border-radius: var(--radius-input);
		color: var(--text-muted);
		font-size: var(--fs-desc);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	.ws-hdr-btn:hover {
		color: var(--text);
	}
	.ws-hdr-btn[aria-selected='true'] {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	@media (pointer: coarse) {
		.ws-hdr-btn {
			min-height: 40px;
		}
	}
</style>
