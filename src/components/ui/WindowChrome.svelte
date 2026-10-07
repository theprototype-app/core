<script>
	// 38 R3 — ONE window header for everything (SPEC §2 WindowChrome, §4):
	//   size="modal"  56px, 18px title, close                 (Settings, Modules, Sessions …)
	//   size="panel"  48px, icon + 15px title + actions + close (Inspector, Explorer, Chat …)
	//   size="tool"   40px, 13px title, optional count, close   (Objects, floating tools)
	// Same close / pin / popout icons and positions everywhere. `actions` renders before the
	// built-in buttons (a filter toggle, "Install from file…", a menu).
	//
	// It is CHROME ONLY — like shared/WindowShell — and never owns window behaviour: open /
	// close / pin / dock / float / drag stay with the caller (SPEC §0). A floating window's
	// drag hooks onto the header through `bind:headerEl` or `headerAttrs` (spread on the
	// header: a data-drag-handle, an onpointerdown), and pin/close just call back.
	//
	// The root wears `.tp-ui`, so the whole window body paints from the SPEC tokens.
	// `body={false}` renders the header alone (a caller that keeps its own scroller).
	// Mobile (SPEC §6): `onback` turns the header into the nav bar "‹ Back · Title · Close".
	//
	// 38 R6 — wearing it on a window that already exists. A floating/docked window's ROOT is
	// its behaviour (dragWindow, dockable, tabbable, focusStack act on it), so it keeps that
	// element and takes only the header from here:
	//   bare          no box of its own — the header row alone (the caller's root is the
	//                 window, painted by the global `.tp-window` surface)
	//   headerClass   extra classes on the header: `ui-panel-header move-handle` is what
	//                 dragWindow / windowGrip / docking grip on and what suites query
	//   heading       replaces icon + title (a label that sheds its text at narrow widths,
	//                 an inline search field — the header rankings stay the caller's)
	//   closeAttrs    on the close button (an id, the tooltip with its shortcut "Close (O)")
	import Icon from './Icon.svelte';

	/** @type {{size?: 'modal'|'panel'|'tool', title?: string, icon?: string, count?: number|string, titleId?: string, onclose?: (() => void) | null, closeLabel?: string, onpin?: (() => void) | null, pinned?: boolean, pinAttrs?: Record<string, any>, onpopout?: (() => void) | null, onback?: (() => void) | null, backLabel?: string, bare?: boolean, headerClass?: string, closeAttrs?: Record<string, any>, heading?: import('svelte').Snippet, body?: boolean, padded?: boolean, elevated?: boolean, headerEl?: HTMLElement | null, headerAttrs?: Record<string, any>, actions?: import('svelte').Snippet, footer?: import('svelte').Snippet, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		size = 'panel',
		title = '',
		icon = '',
		count = undefined,
		titleId = undefined,
		onclose = null,
		closeLabel = '',
		onpin = null,
		pinned = false,
		pinAttrs = {},
		onpopout = null,
		onback = null,
		backLabel = 'Back',
		bare = false,
		headerClass = '',
		closeAttrs = {},
		heading = undefined,
		body = true,
		padded = true,
		elevated = false,
		headerEl = $bindable(null),
		headerAttrs = {},
		actions = undefined,
		footer = undefined,
		children = undefined,
		...rest
	} = $props();

	const iconSize = $derived(size === 'tool' ? 14 : 16);
	const hasCount = $derived(count !== undefined && count !== null && count !== '');
</script>

<div class="tp-ui wc wc-{size}" class:wc-elevated={elevated} class:wc-headless-body={!body} class:wc-bare={bare} {...rest}>
	<header class="wc-head {headerClass}" class:wc-nav={!!onback} bind:this={headerEl} {...headerAttrs}>
		{#if onback}
			<button type="button" class="wc-back" onclick={onback}>
				<Icon name="chevron-left" size={20} strokeWidth={1.75} />
				<span>{backLabel}</span>
			</button>
		{/if}
		{#if heading}
			{@render heading()}
		{:else}
			{#if icon && size === 'panel' && !onback}
				<span class="wc-icon" aria-hidden="true"><Icon name={icon} size={16} strokeWidth={1.75} /></span>
			{/if}
			<h2 class="wc-title" id={titleId}>{title}</h2>
		{/if}
		{#if hasCount}<span class="wc-count">{count}</span>{/if}
		{#if actions}<div class="wc-actions">{@render actions()}</div>{/if}
		{#if onpopout}
			<button type="button" class="wc-btn" aria-label="Pop out" title="Pop out" onclick={onpopout}>
				<Icon name="external-link" size={iconSize} strokeWidth={1.75} />
			</button>
		{/if}
		{#if onpin}
			<button
				type="button"
				class="wc-btn"
				aria-label={pinned ? 'Unpin' : 'Pin'}
				title={pinned ? 'Unpin' : 'Pin'}
				aria-pressed={pinned}
				onclick={onpin}
				{...pinAttrs}
			>
				<Icon name={pinned ? 'pin' : 'pin-off'} size={iconSize} strokeWidth={1.75} />
			</button>
		{/if}
		{#if onclose}
			<button type="button" class="wc-btn wc-close" aria-label={closeLabel || (title ? `Close ${title}` : 'Close')} title="Close" onclick={onclose} {...closeAttrs}>
				<Icon name="x" size={size === 'tool' ? 14 : 18} strokeWidth={1.75} />
			</button>
		{/if}
	</header>
	{#if body}
		<div class="wc-body" class:wc-padded={padded}>
			{@render children?.()}
		</div>
		{#if footer}
			<footer class="wc-foot">{@render footer()}</footer>
		{/if}
	{/if}
</div>

<style>
	.wc {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		box-sizing: border-box;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-window);
		overflow: hidden;
	}
	.wc-modal {
		background: var(--surface-1);
		border-radius: var(--radius-modal);
	}
	.wc-elevated {
		box-shadow: var(--shadow-window);
	}
	.wc-headless-body {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	/* header only, inside a window that owns its own box (see `bare`) */
	.wc-bare {
		flex-shrink: 0;
		overflow: visible;
		background: transparent;
		border: 0;
		border-radius: 0;
	}

	.wc-head {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		gap: var(--space-2);
		box-sizing: border-box;
		height: 48px;
		padding: 0 var(--space-2) 0 14px;
		border-bottom: 1px solid var(--border);
	}
	.wc-modal .wc-head {
		height: 56px;
		gap: 10px;
		padding: 0 10px 0 22px;
	}
	.wc-tool .wc-head {
		height: 40px;
		padding: 0 6px 0 12px;
	}
	.wc-icon {
		display: inline-flex;
		color: var(--badge-text);
	}
	.wc-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-panel-title);
		font-weight: 600;
		color: var(--text);
	}
	.wc-modal .wc-title {
		font-size: var(--fs-modal-title);
		letter-spacing: -0.01em;
	}
	.wc-tool .wc-title {
		font-size: var(--fs-desc);
	}
	.wc-count {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.wc-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.wc-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: var(--icon-button);
		height: var(--icon-button);
		padding: 0;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.wc-modal .wc-btn {
		width: 38px;
		height: 38px;
		border-radius: var(--radius-button);
	}
	.wc-tool .wc-btn {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-input);
	}
	.wc-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.wc-btn[aria-pressed='true'] {
		color: var(--accent-text);
	}
	/* an icon is the BUTTON's face, not a target of its own: the press (and a hit test at the
	   button's centre) lands on the button */
	.wc-head :global(button svg) {
		pointer-events: none;
	}
	/* a header's ink is the window's, also when the header wears `ui-panel-header` (whose
	   @apply'd gray-100 would otherwise win over inheritance) */
	.wc-head {
		color: var(--text);
		font-family: var(--font-ui);
		font-weight: 400;
	}

	/* Header pieces a CALLER renders (heading / actions snippets compile in the caller's
	   scope, so these are global under .wc-head): the label that can shed its text, an icon
	   action with the same box as the built-in pin/close, and a short text action
	   ("Clear all", "Apply"). */
	.wc-head :global(.wc-label) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		min-width: 0;
		white-space: nowrap;
		font-size: var(--fs-panel-title);
		font-weight: 600;
		color: var(--text);
	}
	.wc-tool .wc-head :global(.wc-label) {
		font-size: var(--fs-desc);
	}
	.wc-head :global(.wc-label svg) {
		color: var(--text-muted);
	}
	.wc-head :global(.wc-sub) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.wc-head :global(.wc-act) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		flex-shrink: 0;
		width: var(--icon-button);
		height: var(--icon-button);
		padding: 0;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
	}
	.wc-tool .wc-head :global(.wc-act) {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-input);
	}
	.wc-head :global(.wc-act-text) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	/* a caller's legacy quiet button (an editor's Apply / Reload riding in its header) takes
	   the text-action look rather than the old gray-700 chip */
	:global(:where(.wc-head .ui-button-quiet)) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-desc);
		font-weight: 500;
	}
	:global(:where(.wc-head .ui-button-quiet:hover:not(:disabled))) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.wc-head :global(:is(.wc-act, .wc-act-text):hover:not(:disabled)) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.wc-head :global(:is(.wc-act, .wc-act-text)[aria-pressed='true']) {
		color: var(--accent-text);
		background: var(--accent-soft);
	}
	.wc-head :global(:is(.wc-act, .wc-act-text):disabled) {
		opacity: 0.45;
		cursor: default;
	}

	/* mobile nav bar: ‹ Back · Title · Close, title centred */
	.wc-nav {
		position: relative;
		padding: 0 6px;
	}
	.wc-nav .wc-title {
		position: absolute;
		left: 96px;
		right: 96px;
		flex: none;
		text-align: center;
		pointer-events: none;
	}
	.wc-nav .wc-close {
		margin-left: auto;
	}
	.wc-back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 44px;
		padding: 0 10px 0 4px;
		border: 0;
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		font-size: var(--fs-body);
		cursor: pointer;
	}

	.wc-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.wc-padded {
		padding: var(--space-4);
	}
	.wc-modal .wc-padded {
		padding: 18px 22px 24px;
	}
	.wc-tool .wc-padded {
		padding: var(--space-3);
	}
	.wc-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-4);
		flex-shrink: 0;
		padding: 14px 20px 14px 24px;
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 85%, var(--bg-app));
	}

	@media (max-width: 639.98px) {
		.wc-head,
		.wc-modal .wc-head {
			height: 56px;
		}
		.wc-btn,
		.wc-modal .wc-btn,
		.wc-tool .wc-btn,
		.wc-head :global(.wc-act),
		.wc-tool .wc-head :global(.wc-act) {
			width: 44px;
			height: 44px;
		}
		.wc-modal .wc-title {
			font-size: 1.0625rem;
		}
	}
</style>
