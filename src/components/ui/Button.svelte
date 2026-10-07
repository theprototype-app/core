<script>
	// 38 R3 — THE button (SPEC §2 Button). Variants:
	//   primary    ONE per view (the accent fill)        secondary  accent-muted fill
	//   outline    border-strong outline                 ghost      accent-text, no chrome
	//   warn-text  soft-destructive text (Reset…)        danger     destructive CONFIRM only
	//   icon       square icon button (needs `label`)    live       ONLY Play: the --live fill
	// `size` md (36 desktop / 44 touch) or sm (32 / 44). `icon` / `iconRight` take Icon names.
	// Renders an <a> when `href` is set. Label text comes from children, or `text`.
	// `count` (a number) / `dot` draw a notification badge on an icon button.
	import Icon from './Icon.svelte';

	/** @type {{variant?: 'primary'|'secondary'|'outline'|'ghost'|'warn-text'|'danger'|'icon'|'live', size?: 'md'|'sm', type?: 'button'|'submit'|'reset', disabled?: boolean, icon?: string, iconRight?: string, label?: string, text?: string, title?: string, pressed?: boolean, href?: string, full?: boolean, count?: number|string, dot?: boolean, onclick?: (e: MouseEvent) => void, children?: import('svelte').Snippet} & Record<string, any>} */
	let {
		variant = 'secondary',
		size = 'md',
		type = 'button',
		disabled = false,
		icon = '',
		iconRight = '',
		label = '',
		text = '',
		title = undefined,
		pressed = undefined,
		href = undefined,
		full = false,
		count = undefined,
		dot = false,
		onclick = undefined,
		children = undefined,
		...rest
	} = $props();

	const iconOnly = $derived(variant === 'icon' || (variant === 'live' && !children && !text));
	const iconSize = $derived(variant === 'live' ? 20 : 16);
</script>

{#snippet inner()}
	{#if icon}<Icon name={icon} size={iconSize} />{/if}
	{#if !iconOnly}
		{#if children}{@render children()}{:else}{text}{/if}
	{/if}
	{#if iconRight}<Icon name={iconRight} size={16} />{/if}
	{#if count !== undefined && count !== null && count !== '' && count !== 0}<span class="btn-count" aria-hidden="true">{count}</span>{:else if dot}<span class="btn-dot" aria-hidden="true"></span>{/if}
{/snippet}

{#if href && !disabled}
	<a
		class="tp-ui btn btn-{variant} btn-{size}"
		class:btn-icon-only={iconOnly}
		class:btn-full={full}
		{href}
		aria-label={iconOnly ? label || title : undefined}
		{title}
		{...rest}>{@render inner()}</a
	>
{:else}
	<button
		class="tp-ui btn btn-{variant} btn-{size}"
		class:btn-icon-only={iconOnly}
		class:btn-full={full}
		{type}
		{disabled}
		aria-label={iconOnly ? label || title : undefined}
		aria-pressed={pressed}
		{title}
		{onclick}
		{...rest}>{@render inner()}</button
	>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		box-sizing: border-box;
		height: var(--control-h);
		padding: 0 14px;
		border: 1px solid transparent;
		border-radius: var(--radius-button);
		font: inherit;
		font-size: var(--fs-body);
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color 0.12s ease,
			color 0.12s ease,
			border-color 0.12s ease;
	}
	.btn-sm {
		height: var(--control-h-sm);
		padding: 0 12px;
		font-size: var(--fs-desc);
	}
	.btn-full {
		width: 100%;
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn[data-kit-state='focus'] {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* primary: the accent FILL. --accent-fill (not --accent) because white text on the SPEC
	   accent is 3.9:1 and SPEC §8 wants 4.5 — every theme states a fill its --on-accent reads
	   on (theme.css "READABLE STATE INK"). */
	.btn-primary {
		padding: 0 16px;
		background: var(--accent-fill);
		color: var(--on-accent);
		font-weight: 600;
	}
	.btn-primary:hover:not(:disabled),
	.btn-primary[data-kit-state='hover'] {
		background: color-mix(in srgb, var(--accent-fill) 88%, var(--on-accent));
	}
	.btn-secondary {
		background: var(--accent-muted);
		color: var(--accent-soft-text);
	}
	.btn-secondary:hover:not(:disabled),
	.btn-secondary[data-kit-state='hover'] {
		background: color-mix(in srgb, var(--accent-muted) 85%, var(--accent-soft-text));
	}
	.btn-outline {
		border-color: var(--border-strong);
		background: transparent;
		color: var(--text);
	}
	.btn-outline:hover:not(:disabled),
	.btn-outline[data-kit-state='hover'] {
		background: var(--surface-hover);
	}
	.btn-ghost,
	.btn-warn-text {
		padding: 0 10px;
		background: transparent;
	}
	.btn-ghost {
		color: var(--accent-text);
	}
	.btn-warn-text {
		color: var(--warn-text);
	}
	.btn-ghost:hover:not(:disabled),
	.btn-ghost[data-kit-state='hover'],
	.btn-warn-text:hover:not(:disabled),
	.btn-warn-text[data-kit-state='hover'] {
		background: var(--surface-hover);
	}
	.btn-danger {
		background: var(--danger);
		color: var(--on-danger);
		font-weight: 600;
	}
	.btn-danger:hover:not(:disabled),
	.btn-danger[data-kit-state='hover'] {
		background: color-mix(in srgb, var(--danger) 88%, var(--on-danger));
	}
	.btn-icon {
		position: relative;
		width: var(--icon-button);
		height: var(--icon-button);
		padding: 0;
		background: transparent;
		color: var(--text-muted);
	}
	.btn-icon:hover:not(:disabled),
	.btn-icon[data-kit-state='hover'] {
		background: var(--surface-hover);
		color: var(--text);
	}
	.btn-count {
		position: absolute;
		top: 2px;
		right: 1px;
		min-width: 16px;
		height: 16px;
		box-sizing: border-box;
		padding: 0 4px;
		border-radius: var(--radius-pill);
		background: var(--accent-fill);
		color: var(--on-accent);
		font: 600 10px/16px var(--font-ui-mono);
		text-align: center;
		box-shadow: 0 0 0 2px var(--surface-1);
	}
	.btn-dot {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--surface-1);
	}
	.btn-icon[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	/* live: ONLY Play / record / live. A round 44px button when it is icon-only. */
	.btn-live {
		background: var(--live);
		color: var(--on-live);
		font-weight: 600;
	}
	.btn-live.btn-icon-only {
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 50%;
	}
	.btn-live:hover:not(:disabled),
	.btn-live[data-kit-state='hover'] {
		filter: brightness(1.08);
	}
</style>
