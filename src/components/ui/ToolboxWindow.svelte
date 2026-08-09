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
	//   (+`.tbx-done` / `.tbx-ok`).
	import { GripVertical } from '@lucide/svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';

	/** @type {{ id: string, title: string, key: string,
	 *   defaultRect?: { left?: number, top?: number, right?: number, bottom?: number },
	 *   minW?: number, width?: number, actions?: any, status?: any, children: any }} */
	let {
		id,
		title,
		key,
		defaultRect = { left: 12, top: 76 },
		minW = 134,
		width = 174,
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
