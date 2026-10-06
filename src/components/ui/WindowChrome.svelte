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
	import Icon from './Icon.svelte';

	/** @type {{size?: 'modal'|'panel'|'tool', title?: string, icon?: string, count?: number|string, titleId?: string, onclose?: (() => void) | null, closeLabel?: string, onpin?: (() => void) | null, pinned?: boolean, pinAttrs?: Record<string, any>, onpopout?: (() => void) | null, onback?: (() => void) | null, backLabel?: string, body?: boolean, padded?: boolean, elevated?: boolean, headerEl?: HTMLElement | null, headerAttrs?: Record<string, any>, actions?: import('svelte').Snippet, footer?: import('svelte').Snippet, children?: import('svelte').Snippet} & Record<string, any>} */
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

<div class="tp-ui wc wc-{size}" class:wc-elevated={elevated} class:wc-headless-body={!body} {...rest}>
	<header class="wc-head" class:wc-nav={!!onback} bind:this={headerEl} {...headerAttrs}>
		{#if onback}
			<button type="button" class="wc-back" onclick={onback}>
				<Icon name="chevron-left" size={20} strokeWidth={1.75} />
				<span>{backLabel}</span>
			</button>
		{/if}
		{#if icon && size === 'panel' && !onback}
			<span class="wc-icon" aria-hidden="true"><Icon name={icon} size={16} strokeWidth={1.75} /></span>
		{/if}
		<h2 class="wc-title" id={titleId}>{title}</h2>
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
			<button type="button" class="wc-btn wc-close" aria-label={closeLabel || (title ? `Close ${title}` : 'Close')} title="Close" onclick={onclose}>
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
		.wc-tool .wc-btn {
			width: 44px;
			height: 44px;
		}
		.wc-modal .wc-title {
			font-size: 1.0625rem;
		}
	}
</style>
