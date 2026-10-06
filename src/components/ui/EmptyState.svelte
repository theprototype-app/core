<script>
	// 38 R3 — an empty view (SPEC §2 EmptyState): ONE line of what goes here + ONE action.
	// Explorer folders, Objects, Chat, Notes, the notification centre, a filter with no hits.
	//   title        the one line ("No objects yet")
	//   description  optional second line, muted (keep it short)
	//   actionLabel + onaction   the one action (a secondary Button); or `action` snippet
	import Icon from './Icon.svelte';
	import Button from './Button.svelte';

	/** @type {{title?: string, description?: string, icon?: string, actionLabel?: string, onaction?: () => void, compact?: boolean, action?: import('svelte').Snippet} & Record<string, any>} */
	let {
		title = '',
		description = '',
		icon = '',
		actionLabel = '',
		onaction = undefined,
		compact = false,
		action = undefined,
		...rest
	} = $props();
</script>

<div class="tp-ui es" class:es-compact={compact} {...rest}>
	{#if icon}<span class="es-icon" aria-hidden="true"><Icon name={icon} size={20} strokeWidth={1.75} /></span>{/if}
	<p class="es-title">{title}</p>
	{#if description}<p class="es-desc">{description}</p>{/if}
	{#if action}
		<div class="es-action">{@render action()}</div>
	{:else if actionLabel && onaction}
		<div class="es-action"><Button variant="secondary" size="sm" onclick={onaction}>{actionLabel}</Button></div>
	{/if}
</div>

<style>
	.es {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: var(--space-6) var(--space-4);
		text-align: center;
	}
	.es-compact {
		padding: var(--space-4) var(--space-3);
	}
	.es-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		margin-bottom: 6px;
		border-radius: 50%;
		background: var(--surface-inset);
		color: var(--text-faint);
	}
	.es-title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: 500;
		color: var(--text);
	}
	.es-desc {
		margin: 0;
		max-width: 36ch;
		font-size: var(--fs-desc);
		line-height: 1.45;
		color: var(--text-muted);
	}
	.es-action {
		margin-top: var(--space-2);
	}
</style>
