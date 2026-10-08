<script>
	// 38 R3 — a row that OPENS something (SPEC §2 NavRow): label, optional current value,
	// chevron → a submenu page or a picker. AI providers, About's links, the Touch-controls
	// button sub-pages, the mobile Settings list. A <button> (or an <a> with `href`; `external`
	// swaps the chevron for an external-link icon and opens a new tab).
	//   value   the current value, faint, before the chevron ("Dark", "2 providers")
	//   icon    a leading Icon name, drawn in a soft accent disc (the mockup's avatar slot)
	//   dot     an unread dot after the label (About & what's new)
	import Icon from './Icon.svelte';
	import Badge from './Badge.svelte';

	/** @type {{label?: string, description?: string, value?: string, icon?: string, badge?: string, dot?: boolean, href?: string, external?: boolean, disabled?: boolean, current?: boolean, onclick?: (e: MouseEvent) => void} & Record<string, any>} */
	let {
		label = '',
		description = '',
		value = '',
		icon = '',
		badge = '',
		dot = false,
		href = undefined,
		external = false,
		disabled = false,
		current = false,
		onclick = undefined,
		...rest
	} = $props();
</script>

{#snippet inner()}
	{#if icon}
		<span class="nr-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
	{/if}
	<span class="nr-text">
		<span class="nr-label">
			{label}
			{#if dot}<span class="nr-dot" aria-hidden="true"></span><span class="sr-only">(new)</span>{/if}
			{#if badge}<Badge tone="scope" text={badge} />{/if}
		</span>
		{#if description}<span class="nr-desc">{description}</span>{/if}
	</span>
	{#if value}<span class="nr-value">{value}</span>{/if}
	<span class="nr-chev" aria-hidden="true"><Icon name={external ? 'external-link' : 'chevron-right'} size={16} /></span>
{/snippet}

{#if href && !disabled}
	<a
		class="tp-ui nr"
		{href}
		target={external ? '_blank' : undefined}
		rel={external ? 'noopener noreferrer' : undefined}
		aria-current={current ? 'page' : undefined}
		{...rest}>{@render inner()}</a
	>
{:else}
	<button type="button" class="tp-ui nr" {disabled} aria-current={current ? 'page' : undefined} {onclick} {...rest}
		>{@render inner()}</button
	>
{/if}

<style>
	.nr {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		box-sizing: border-box;
		width: 100%;
		min-height: var(--nav-row-h);
		padding: var(--nav-row-pad-y) var(--space-4);
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.nr:hover:not(:disabled),
	.nr[data-kit-state='hover'] {
		background: var(--surface-hover);
	}
	.nr[aria-current='page'] {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.nr:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.nr[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.nr-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--badge-bg);
		color: var(--badge-text);
	}
	.nr-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nr-label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--fs-body);
		font-weight: 500;
	}
	.nr-desc {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.nr-value {
		flex-shrink: 0;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.nr-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.nr-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
