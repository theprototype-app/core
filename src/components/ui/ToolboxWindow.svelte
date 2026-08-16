<script>
	// M0 (mesh toolbox): the generic floating TOOLBOX shell — a small
	// professional tool-palette window (Photoshop/Blender idiom) shared by the
	// mesh-edit and sculpt toolboxes (and future tool panels).
	//
	// - Drag by the HEADER only (`.move-handle` lives on the header, not the
	//   root — dragWindow ignores pointerdowns on buttons, so header actions
	//   stay clickable).
	// - Width-resizable via dragWindow's grip (`axis: 'x'`): the body is an
	//   auto-fill grid of fixed square cells, so dragging the edge changes the
	//   COLUMN count and the tools reflow — button size never changes, and the
	//   height always hugs the content.
	// - The default width lives in CSS through --tbx-w (never inline `width`):
	//   dragWindow's reset removes the inline width a grip drag wrote, and the
	//   CSS rule must win again or an auto-width grid collapses to one column.
	// - Theming: authored DIRECTLY against theme tokens with fallback chains —
	//   dark AND light define no --surface/--accent tokens, so every var() here
	//   must end in a literal (accent falls back through Tailwind's
	//   --color-primary-600). Content buttons that need the theme REMAP layer
	//   (bg-primary-600 etc.) keep using utility classes — both work inside.
	// - Content contract (all styled from here via :global so consumers carry
	//   zero CSS): `.tbx-label` full-width section mini-label · `.tbx-row`
	//   full-width flex row · `.tbx-seg` segmented control (text buttons with
	//   the utility-class active recipe) · `.tbx-btn` square icon button
	//   (+`aria-pressed` for toggles, `.tbx-danger`, `.tbx-flash` one-shot
	//   feedback, `.tbx-disabled`) · `.tbx-hbtn` header icon button
	//   (+`.tbx-done` / `.tbx-ok`) · `.tbx-primary` pill action (Apply/Commit) ·
	//   `.tbx-sel` a parameterized tool that is SELECTED but not armed ·
	//   `.tbx-check` a boolean option's checkbox ·
	//   `.tbx-sec-head` collapsible section header (see ToolboxSection.svelte).
	// - 18-C1: an optional `tabs` snippet renders BETWEEN the header and the
	//   body. It sits outside the scrolling body on purpose, so the element-mode
	//   tabs stay pinned while the tool list scrolls.
	// - 18-C3: at <=640px the toolbox is a bottom SHEET instead of a floating
	//   window — a tool palette you have to drag around is unusable on a phone.
	//   Solved here rather than in each toolbox, so Sculpt gets it for free.
	// - The reactive parts of the root `style` are `style:` DIRECTIVES, never
	//   interpolations inside the style ATTRIBUTE. Svelte re-renders an attribute
	//   by re-setting the whole thing, which wipes every inline property
	//   dragWindow wrote — left/top/width and `--dw-top`. `sheetH` is filled in by
	//   an effect one tick after mount, so every toolbox painted at the top-left
	//   corner and then jumped to its parked spot when the next observer
	//   re-applied it (reported as "the keys window appears in the corner first").
	//   `style:` writes ONE property via setProperty and leaves the rest alone —
	//   the pattern Flow.svelte already uses for its width/height.
	import { GripVertical } from '@lucide/svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { notesDrawerOpen, inspectorClose } from '../../stores/appStore';

	/** @type {{ id: string, title: string, key: string,
	 *   defaultRect?: { left?: number, top?: number, right?: number, bottom?: number },
	 *   minW?: number, width?: number, tabs?: any, actions?: any, status?: any, children: any }} */
	let {
		id,
		title,
		key,
		defaultRect = { left: 12, top: 76 },
		minW = 134,
		width = 174,
		tabs = null,
		actions = null,
		status = null,
		children
	} = $props();

	// 18-C3: the exact 640 breakpoint the Inspector and the notes drawer use for
	// their sheets — NOT the 820 "narrow drawer" one, or the 641-820 range would
	// get a bottom sheet where a floating palette still fits.
	let sheetMode = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(max-width: 640px)');
		sheetMode = mq.matches;
		const on = () => (sheetMode = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	// One bottom sheet at a time. The toolbox cannot close itself (it belongs to
	// an edit session — Done/Esc end it), so it closes the others instead.
	$effect(() => {
		if (!sheetMode) return;
		notesDrawerOpen.set(false);
		inspectorClose.set(true);
	});

	// sheet height, dragged from the grabber and persisted per toolbox
	let sheetH = $state(0);
	const sheetKey = $derived('tbxSheetH:' + key);
	$effect(() => {
		if (sheetH || typeof window === 'undefined') return;
		const saved = parseInt(localStorage.getItem(sheetKey) || '');
		sheetH = !saved || Number.isNaN(saved) ? Math.round(window.innerHeight * 0.4) : saved;
	});
	let sheetResizing = $state(false);
	/** @param {PointerEvent} e */
	function startSheetResize(e) {
		sheetResizing = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
		e.preventDefault();
		e.stopPropagation(); // never start a window DRAG from the grabber
	}
	/** @param {PointerEvent} e */
	function doSheetResize(e) {
		if (!sheetResizing) return;
		// bottom:0, so height = viewport height - finger y; the ceiling clears the
		// Connect bar + the top-right chrome, exactly as the Inspector sheet does
		const cb =
			parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--connect-bottom')) || 54;
		const maxH = Math.max(180, window.innerHeight - cb - 56);
		sheetH = Math.min(Math.max(140, window.innerHeight - e.clientY), maxH);
	}
	/** @param {PointerEvent} e */
	function endSheetResize(e) {
		if (!sheetResizing) return;
		sheetResizing = false;
		// releasePointerCapture THROWS when the pointer was never captured, and it
		// used to run before the write — so a capture quirk silently cost the user
		// their height. The persist does not depend on it.
		try {
			/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
		} catch {}
		try {
			localStorage.setItem(sheetKey, String(sheetH));
		} catch {}
	}
</script>

<div
	{id}
	class="ui-panel toolbox"
	class:tbx-sheet={sheetMode}
	style="z-index: var(--z-window)"
	style:--tbx-w="{width}px"
	style:--tbx-sheet-h="{sheetH}px"
	use:dragWindow={{ key, defaultRect, resizable: true, axis: 'x', minW, inert: () => sheetMode }}
	use:focusStack={key}
>
	{#if sheetMode}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="tbx-sheet-resize"
			onpointerdown={startSheetResize}
			onpointermove={doSheetResize}
			onpointerup={endSheetResize}
		>
			<div class="tbx-sheet-grab"></div>
		</div>
	{/if}
	<div class="toolbox-header move-handle">
		<GripVertical size={14} aria-hidden="true" />
		<span class="toolbox-title">{title}</span>
		<span class="toolbox-spacer"></span>
		{@render actions?.()}
	</div>
	{#if tabs}
		<div class="tbx-tabs" role="tablist">
			{@render tabs()}
		</div>
	{/if}
	<div class="toolbox-body">
		{@render children()}
	</div>
	{#if status}
		<div class="toolbox-status">
			{@render status()}
		</div>
	{/if}
</div>

<style>
	.toolbox {
		/* alias tokens — every chain ENDS in a literal (dark/light define none) */
		--tbx-hover: var(--hover, #4b5563);
		--tbx-border: var(--border, rgb(55 65 81 / 0.6));
		--tbx-text: var(--text-2, #d1d5db);
		--tbx-muted: var(--muted, #9ca3af);
		--tbx-accent: var(--accent, var(--color-primary-600, #2563eb));
		--tbx-danger: var(--icon-danger, #f87171);
		/* fixed SQUARE cell — px on purpose: rem would shrink under bit8's 11px
		   root font, and the requirement is that resizing changes the row count,
		   never the button size */
		--tbx-btn: 36px;
		position: fixed;
		width: var(--tbx-w, 174px);
		/* 18-B: the window may never be taller than the screen. The height is not
		   resizable (axis:'x' — it hugs its content), so a tall toolbox used to
		   simply overflow the bottom, taking its own resize grip off-screen with
		   it: measured at y=830 on a 720px viewport, where no real mouse can
		   reach it. The BODY scrolls instead (below); header and status stay put. */
		display: flex;
		flex-direction: column;
		/* `--dw-top` is the window's own offset, published by dragWindow — the cap
		   is the space BELOW the window, not the whole viewport */
		max-height: calc(100vh - var(--dw-top, 24px) - 12px);
		user-select: none;
		font-size: 13px;
		/* own the SURFACE from tokens: `ui-panel`'s background is compiled from
		   `@apply bg-gray-800` straight onto the class, so the theme remap layer
		   (which targets literal `.bg-gray-800` class NAMES) never rethemes it —
		   without this the toolbox stayed dark in every theme. The ui-panel class
		   stays for radius/shadow + the bit8/contrast personality hooks. */
		background: var(--surface, #1f2937);
		border-color: var(--tbx-border);
		color: var(--tbx-text);
	}
	.toolbox-header {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 3px 4px 3px 8px;
		border-bottom: 1px solid var(--tbx-border);
		color: var(--tbx-muted);
		cursor: move;
		touch-action: none;
	}
	.toolbox-title {
		color: var(--tbx-text);
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.toolbox-spacer {
		flex: 1 1 0;
		min-width: 4px;
	}
	.toolbox-body {
		display: grid;
		grid-template-columns: repeat(auto-fill, var(--tbx-btn));
		gap: 4px;
		justify-content: start;
		padding: 8px;
		/* the scrolling part of the max-height above. `min-height: 0` is what lets a
		   grid child of a flex column actually shrink instead of forcing the parent
		   past its max-height; `overscroll-behavior` keeps a scroll at the end of
		   the list from chaining to the page behind. */
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.toolbox-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 10px;
		padding: 4px 10px;
		border-top: 1px solid var(--tbx-border);
		font-size: 11px;
		color: var(--tbx-muted);
	}
	/* the JS-injected grip draws a hardcoded white gradient — retheme it */
	.toolbox :global(.dw-resize) {
		background: linear-gradient(
			135deg,
			transparent 45%,
			var(--tbx-muted) 45%,
			var(--tbx-muted) 55%,
			transparent 55%
		) !important;
		opacity: 0.6;
	}

	/* ---- 18-C3: bottom SHEET at <=640px ----
	   The !important is load-bearing, not laziness: dragWindow writes left/top/
	   width (and --dw-top) as INLINE styles, which no stylesheet rule can beat.
	   The action stays mounted and harmless — this is the same override the
	   What's New window uses to become a full-screen sheet. */
	.tbx-sheet-resize {
		display: none;
		flex: 0 0 auto;
		height: 18px;
		align-items: center;
		justify-content: center;
		cursor: ns-resize;
		touch-action: none;
	}
	.tbx-sheet-grab {
		width: 40px;
		height: 4px;
		border-radius: 9999px;
		background: rgb(148 163 184 / 0.7);
	}
	@media (max-width: 640px) {
		.toolbox.tbx-sheet {
			left: 0 !important;
			right: 0 !important;
			top: auto !important;
			bottom: 0 !important;
			width: 100vw !important;
			max-width: 100vw !important;
			height: var(--tbx-sheet-h, 40vh) !important;
			/* never rise above the Connect bar + the top-right chrome */
			max-height: calc(100vh - var(--connect-bottom, 54px) - 56px) !important;
			border-radius: 0.75rem 0.75rem 0 0 !important;
			/* The sheet's BACKGROUND runs to the very bottom, but its CONTENTS stop
			   above the Controls HUD — the Inspector sheet's contract. The padding
			   is on the ROOT, not the body, so the status footer clears the HUD too.
			   Deliberately NO z-index override: Controls sits on --z-hud, above the
			   window tier, so it stays visible AND clickable over the sheet. */
			padding-bottom: var(--controls-inset, 0px) !important;
		}
		.toolbox.tbx-sheet .tbx-sheet-resize {
			display: flex;
		}
		/* a sheet is not draggable, and its width grip is meaningless */
		.toolbox.tbx-sheet .toolbox-header {
			cursor: default;
		}
		.toolbox.tbx-sheet :global(.dw-resize) {
			display: none !important;
		}
		/* the body is the only scrolling part: header, tabs and status stay put */
		.toolbox.tbx-sheet .toolbox-body {
			max-height: none;
			flex: 1 1 auto;
		}
	}

	/* ---- 18-C1: element-mode TABS (pinned above the scrolling body) ---- */
	.tbx-tabs {
		display: flex;
		flex: 0 0 auto;
		gap: 2px;
		padding: 4px 4px 0;
		border-bottom: 1px solid var(--tbx-border);
	}
	/* The active tab carries the literal `bg-primary-600` utility (the e2e
	   contract + the theme remap) AND the `tbx-tab-on` marker, for exactly the
	   reason .tbx-on exists: an unlayered component style beats every layered
	   utility, so in the DARK theme the utility alone paints nothing. */
	.toolbox :global(.tbx-tab) {
		flex: 1 1 0;
		min-width: 0;
		padding: 4px 6px;
		border-radius: 7px 7px 0 0;
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--tbx-muted);
		background: transparent;
	}
	.toolbox :global(.tbx-tab:hover) {
		background: var(--tbx-hover);
		color: var(--tbx-text);
	}
	.toolbox :global(.tbx-tab.tbx-tab-on),
	.toolbox :global(.tbx-tab.tbx-tab-on:hover) {
		background: var(--tbx-accent);
		color: #fff;
	}
	.toolbox :global(.tbx-tab:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: -2px;
	}

	/* ---- content contract (consumer markup, styled from here) ---- */
	/* full-width section mini-label */
	.toolbox :global(.tbx-label) {
		grid-column: 1 / -1;
		margin: 3px 0 -2px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--tbx-muted);
	}
	/* 18-C1: collapsible section header (ToolboxSection.svelte). Same typography
	   as .tbx-label so a collapsed section reads as a heading, plus a chevron and
	   a hit area across the full width. */
	.toolbox :global(.tbx-sec-head) {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 4px 0 -2px;
		padding: 2px 2px 2px 0;
		border-radius: 5px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--tbx-muted);
		text-align: left;
	}
	.toolbox :global(.tbx-sec-head:hover) {
		color: var(--tbx-text);
		background: var(--tbx-hover);
	}
	.toolbox :global(.tbx-sec-head:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: 1px;
	}
	.toolbox :global(.tbx-sec-chev) {
		flex: 0 0 auto;
		transition: transform 0.12s ease;
	}
	.toolbox :global(.tbx-sec-head[aria-expanded='true'] .tbx-sec-chev) {
		transform: rotate(90deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.toolbox :global(.tbx-sec-chev) {
			transition: none;
		}
	}
	/* full-width free-form row (segments, sliders, params) */
	.toolbox :global(.tbx-row) {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
		min-width: 0;
	}
	/* segmented control — text segments; the ACTIVE segment keeps the literal
	   bg-primary-600/bg-gray-700 utility recipe (theme remap + e2e contract) */
	.toolbox :global(.tbx-seg) {
		display: flex;
		flex-wrap: wrap;
		width: max-content;
		max-width: 100%;
		overflow: hidden;
		border: 1px solid var(--tbx-border);
		border-radius: 8px;
		font-size: 12px;
	}
	/* text COMMAND button — commands read as words, tools as icons (six
	   near-identical 18px glyphs in a row are indistinguishable, which is what
	   made "Loop" and "Linked" / "All" and "Invert" get pressed by mistake) */
	.toolbox :global(.tbx-cmd) {
		padding: 2px 7px;
		border-radius: 6px;
		font-size: 11px;
		color: var(--tbx-text);
		background: var(--surface-2, #374151);
	}
	.toolbox :global(.tbx-cmd:hover) {
		background: var(--tbx-hover);
	}
	.toolbox :global(.tbx-cmd:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: 1px;
	}
	/* an ARMED command (a word button that puts the app in a mode — the pivot
	   pick). Same reasoning as .tbx-btn.tbx-on: `.tbx-cmd`'s own background is an
	   UNLAYERED component style and beats the `bg-primary-600` utility outright,
	   so without this the armed state renders plain grey in the dark theme.
	   After :hover, so armed wins while hovered. */
	.toolbox :global(.tbx-cmd.tbx-on),
	.toolbox :global(.tbx-cmd.tbx-on:hover) {
		background: var(--tbx-accent);
		color: #fff;
	}
	.toolbox :global(.tbx-cmd:disabled) {
		opacity: 0.45;
	}
	/* 18-C1: the PRIMARY action of a tool's options (Apply Bevel, Symmetrize…).
	   Replaces four hand-rolled `rounded-full bg-primary-600` pills, which each
	   carried their own padding and none of the theme fallbacks. */
	.toolbox :global(.tbx-primary) {
		padding: 2px 10px;
		border-radius: 9999px;
		font-size: 11px;
		font-weight: 600;
		color: #fff;
		background: var(--tbx-accent);
	}
	.toolbox :global(.tbx-primary:hover) {
		filter: brightness(1.12);
	}
	.toolbox :global(.tbx-primary:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: 2px;
	}
	.toolbox :global(.tbx-primary:disabled) {
		opacity: 0.45;
	}
	/* square icon tool button */
	.toolbox :global(.tbx-btn) {
		width: var(--tbx-btn);
		height: var(--tbx-btn);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--tbx-text);
		background: transparent;
	}
	.toolbox :global(.tbx-btn:hover) {
		background: var(--tbx-hover);
	}
	/* ARMED tool = solid accent. Needs its own marker class: the button also
	   carries the literal `bg-primary-600` utility (the e2e contract + the
	   non-dark theme remap), but component styles are UNLAYERED and beat every
	   layered utility — without this rule the armed fill vanished in the DARK
	   theme (the only one with no !important remap). Sits after :hover so the
	   armed color also wins while hovered. */
	.toolbox :global(.tbx-btn.tbx-on),
	.toolbox :global(.tbx-btn.tbx-on:hover) {
		background: var(--tbx-accent);
		color: #fff;
		/* 18-C4: on the solid accent fill the duotone would be accent-on-accent,
		   so the armed glyph collapses to white monochrome — the Blender
		   active-tool convention */
		--icon-accent: #fff;
	}
	/* 18-C1: SELECTED but not armed — a parameterized one-shot (Bevel, Loop cut)
	   whose options are showing, waiting for Apply. Deliberately a ring rather
	   than a fill: an armed tool changes what a viewport CLICK does, a selected
	   one does not, and the two must not look the same. */
	.toolbox :global(.tbx-btn:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: 1px;
	}
	/* toggle ON = the "tinted well" (deliberately DISTINCT from the solid-accent
	   armed tool, the Blender depressed-toggle vs blue-active-tool convention) */
	.toolbox :global(.tbx-btn[aria-pressed='true']) {
		background: var(--surface-3, #4b5563);
		box-shadow: inset 0 0 0 1px var(--tbx-accent);
		color: var(--tbx-accent);
		/* 18-C4: one state, one colour. A duotone glyph inside an accent-coloured
		   toggle put two accents in one 18px square and read as noise, so a
		   toggled button goes monochrome the way armed and danger already do. */
		--icon-accent: currentColor;
	}
	/* AFTER the aria-pressed rule on purpose: a selected parameterized tool also
	   reports aria-pressed (it IS a state a screen reader should hear), and with
	   equal specificity the later rule wins — placed earlier, the tinted well
	   filled the button and the ring stopped being distinguishable from armed. */
	.toolbox :global(.tbx-btn.tbx-sel),
	.toolbox :global(.tbx-btn.tbx-sel:hover),
	.toolbox :global(.tbx-btn.tbx-sel[aria-pressed='true']) {
		background: transparent;
		box-shadow: inset 0 0 0 2px var(--tbx-accent);
		color: var(--tbx-text);
		/* selected is not a toggle: the ring says "chosen", and the glyph keeps
		   its duotone so it still reads as the same tool */
		--icon-accent: var(--tbx-accent);
	}
	/* a boolean option's CHECKBOX (auto-apply, individual, invert faces, clamp,
	   grid snap). It has to be styled from here for the same reason every other
	   primitive does — but the colour goes on `color`, NOT `background`, and
	   that is load-bearing: flowbite's plugin puts `appearance: none` on every
	   `[type='checkbox']` (so `accent-color` is a no-op) and paints the checked
	   state with `background-color: currentColor !important`, which no
	   background of ours can beat at any specificity. Driving `color` instead
	   makes the tick block the toolbox accent in every theme; measured before
	   this rule, the boxes rendered flowbite blue while the whole palette was
	   orange. `accent-color` is kept for the case where something removes the
	   appearance override — then the native control paints itself correctly. */
	.toolbox :global(.tbx-check) {
		flex: 0 0 auto;
		width: 14px;
		height: 14px;
		margin: 0;
		border: 1px solid var(--tbx-border);
		border-radius: 3px;
		background-color: var(--surface-2, #374151);
		color: var(--tbx-accent);
		accent-color: var(--tbx-accent);
		cursor: pointer;
	}
	.toolbox :global(.tbx-check:focus-visible) {
		outline: 2px solid var(--tbx-accent);
		outline-offset: 1px;
	}
	.toolbox :global(.tbx-check:disabled) {
		opacity: 0.45;
		cursor: default;
	}
	/* destructive one-shot */
	.toolbox :global(.tbx-danger) {
		color: var(--tbx-danger);
		/* a destructive tool reads as ONE colour: a blue accent inside a red
		   button would say the highlighted part is something else */
		--icon-accent: var(--tbx-danger);
	}
	.toolbox :global(.tbx-danger:hover) {
		background: color-mix(in srgb, var(--tbx-danger) 18%, transparent);
	}
	/* disabled-look: still clickable on purpose — the click explains via toast */
	.toolbox :global(.tbx-disabled) {
		opacity: 0.45;
	}
	/* one-shot feedback: a momentary accent flash on commit */
	.toolbox :global(.tbx-flash) {
		animation: -global-tbx-flash 0.25s ease-out;
	}
	@keyframes -global-tbx-flash {
		0% {
			background-color: var(--tbx-accent, #2563eb);
			color: #fff;
		}
		100% {
			background-color: transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toolbox :global(.tbx-flash) {
			animation: none;
		}
	}
	/* header icon buttons (Done / Cancel) */
	.toolbox :global(.tbx-hbtn) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		color: var(--tbx-text);
	}
	.toolbox :global(.tbx-hbtn:hover) {
		background: var(--tbx-hover);
	}
	.toolbox :global(.tbx-hbtn.tbx-done) {
		background: #ff4000; /* the brand Done, same hex as today */
		color: #fff;
	}
	.toolbox :global(.tbx-hbtn.tbx-ok) {
		background: #22c55e; /* collider Done keeps its green */
		color: #fff;
	}
</style>
