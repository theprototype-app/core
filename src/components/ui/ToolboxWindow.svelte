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
	//   `.tbx-sec-head` collapsible section header (see ToolboxSection.svelte).
	// - 18-C1: an optional `tabs` snippet renders BETWEEN the header and the
	//   body. It sits outside the scrolling body on purpose, so the element-mode
	//   tabs stay pinned while the tool list scrolls.
	import { GripVertical } from '@lucide/svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';

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
</script>

<div
	{id}
	class="ui-panel toolbox"
	style="z-index: var(--z-window); --tbx-w: {width}px"
	use:dragWindow={{ key, defaultRect, resizable: true, axis: 'x', minW }}
	use:focusStack={key}
>
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
	}
	/* destructive one-shot */
	.toolbox :global(.tbx-danger) {
		color: var(--tbx-danger);
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
