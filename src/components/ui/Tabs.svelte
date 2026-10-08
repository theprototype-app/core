<script>
	// 38 R3 — switch views of the same window (SPEC §2 Tabs): ONE style for Modules, Templates,
	// Connect (Info / Toasts), Explorer views. Underline tabs with an optional count. A
	// role="tablist" with ONE tab stop and automatic activation — the arrows move and select
	// ($lib/ui/roving.js). `actions` renders at the right end of the strip (a filter field).
	// Pass `panel` to have the active view rendered in a role="tabpanel" wired to its tab;
	// without it, the consumer renders the panel and uses tabId(id) / panelId(id) itself.
	// 38 NOTES-38 #23: `variant="dock"` is the window tab strip from the design page's dock — an
	// inset bar of pill tabs with a view icon (windows.css .tp-dtabs / .tp-dtab, the same classes
	// the bottom dock's strip and a floating window group's strip wear).
	import { rovingIndex } from '$lib/ui/roving.js';
	import Icon from './Icon.svelte';

	/** @typedef {{id: string, label: string, count?: number|string, disabled?: boolean, kitState?: string, icon?: string}} TabDef */
	/** @type {{tabs?: TabDef[], value?: string, label?: string, idPrefix?: string, variant?: 'underline'|'dock', onchange?: (next: string) => void, actions?: import('svelte').Snippet, panel?: import('svelte').Snippet<[string]>} & Record<string, any>} */
	let {
		tabs = [],
		value = $bindable(''),
		label = '',
		idPrefix = 'tabs',
		variant = 'underline',
		onchange = () => {},
		actions = undefined,
		panel = undefined,
		...rest
	} = $props();

	/** @type {HTMLElement[]} */
	const buttons = [];
	const tabId = (/** @type {string} */ id) => `${idPrefix}-tab-${id}`;
	const panelId = (/** @type {string} */ id) => `${idPrefix}-panel-${id}`;
	const activeIndex = $derived(tabs.findIndex((t) => t.id === value));
	const tabStop = $derived(activeIndex >= 0 ? activeIndex : tabs.findIndex((t) => !t.disabled));

	/** @param {number} i */
	function select(i) {
		const t = tabs[i];
		if (!t || t.disabled) return;
		if (t.id !== value) {
			value = t.id;
			onchange(t.id);
		}
	}

	/** @param {KeyboardEvent} e @param {number} i */
	function onKey(e, i) {
		const next = rovingIndex(
			i,
			e.key,
			tabs.map((t) => !!t.disabled),
			'horizontal'
		);
		if (next < 0) return;
		e.preventDefault();
		select(next);
		buttons[next]?.focus();
	}
</script>

<div class="tp-ui tabs" class:tabs-dock={variant === 'dock'} {...rest}>
	<div class="tabs-strip" class:tp-dtabs={variant === 'dock'}>
		<div class="tabs-list" role="tablist" aria-label={label || undefined}>
			{#each tabs as t, i (t.id)}
				<button
					bind:this={buttons[i]}
					type="button"
					role="tab"
					id={tabId(t.id)}
					class={variant === 'dock' ? 'tp-dtab' : 'tab'}
					aria-selected={t.id === value}
					aria-controls={panel ? panelId(t.id) : undefined}
					tabindex={i === tabStop ? 0 : -1}
					disabled={t.disabled}
					data-kit-state={t.kitState}
					onclick={() => select(i)}
					onkeydown={(e) => onKey(e, i)}
				>
					{#if variant === 'dock' && t.icon}<span class="tp-dtab-ico"><Icon name={t.icon} size={16} /></span>{/if}{t.label}{#if t.count !== undefined && t.count !== null && t.count !== ''}<span class="tab-count">{t.count}</span>{/if}
				</button>
			{/each}
		</div>
		{#if actions}<div class="tabs-actions">{@render actions()}</div>{/if}
	</div>
	{#if panel && value}
		<div class="tabs-panel" role="tabpanel" id={panelId(value)} aria-labelledby={tabId(value)}>
			{@render panel(value)}
		</div>
	{/if}
</div>

<style>
	.tabs {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.tabs-strip {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		border-bottom: 1px solid var(--border);
		min-width: 0;
	}
	.tabs-list {
		display: flex;
		gap: var(--space-5);
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tab {
		position: relative;
		flex-shrink: 0;
		height: 40px;
		padding: 0;
		margin-bottom: -1px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--fs-body);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}
	.tab:hover:not(:disabled):not([aria-selected='true']),
	.tab[data-kit-state='hover'] {
		color: var(--text);
	}
	.tab[aria-selected='true'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.tab:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.tab:focus-visible,
	.tab[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: var(--radius-input) var(--radius-input) 0 0;
	}
	.tab-count {
		margin-left: 6px;
		color: var(--text-faint);
		font-weight: 400;
		font-variant-numeric: tabular-nums;
	}
	/* the dock variant: the bar is .tp-dtabs (windows.css); the strip spans the window */
	.tabs-dock .tabs-strip {
		display: flex;
		gap: var(--space-2);
	}
	.tabs-dock .tabs-list {
		gap: 2px;
		align-items: center;
	}
	.tp-dtab[data-kit-state='hover'] {
		color: var(--text);
		background: var(--surface-hover);
	}
	.tp-dtab[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.tp-dtab:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.tabs-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 4px 0;
	}
	.tabs-panel {
		min-height: 0;
	}
	@media (max-width: 639.98px) {
		.tab {
			height: 44px;
		}
	}
</style>
