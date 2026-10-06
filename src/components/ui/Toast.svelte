<script>
	// 38 R3 — one toast's LOOK (SPEC §5: toasts stack max 3, the rest go to the notification
	// centre as "+N more"). Which toasts show, for how long and in what order stay with
	// Toasts.svelte (behaviour lock); its lane renders each one through this.
	//   message, icon (default info), tone (info / ok / warn / bad → the icon's ink)
	//   repeat     ×N for a message that came again (the "Retrying…" ×11 case)
	//   actionLabel + onaction   one inline action;  ondismiss   the × button
	//   more       a number: render the "+N more in notifications" pill instead (onmore)
	import Icon from './Icon.svelte';

	/** @type {{message?: string, icon?: string, tone?: 'info'|'ok'|'warn'|'bad', repeat?: number, actionLabel?: string, onaction?: () => void, ondismiss?: () => void, more?: number, onmore?: () => void} & Record<string, any>} */
	let {
		message = '',
		icon = 'info',
		tone = 'info',
		repeat = 0,
		actionLabel = '',
		onaction = undefined,
		ondismiss = undefined,
		more = 0,
		onmore = undefined,
		...rest
	} = $props();
</script>

{#if more > 0}
	<button type="button" class="tp-ui toast-more" onclick={onmore} {...rest}>+{more} more in notifications</button>
{:else}
	<div class="tp-ui toast toast-{tone}" {...rest}>
		<span class="toast-icon" aria-hidden="true"><Icon name={icon} size={16} strokeWidth={1.75} /></span>
		<span class="toast-msg">{message}</span>
		{#if repeat > 1}<span class="toast-repeat" title={`Shown ${repeat} times`}>×{repeat}</span>{/if}
		{#if actionLabel && onaction}
			<button type="button" class="toast-action" onclick={onaction}>{actionLabel}</button>
		{/if}
		{#if ondismiss}
			<button type="button" class="toast-x" aria-label="Dismiss" onclick={ondismiss}><Icon name="x" size={14} strokeWidth={1.75} /></button>
		{/if}
	</div>
{/if}

<style>
	.toast {
		display: flex;
		align-items: center;
		gap: 10px;
		box-sizing: border-box;
		min-height: 40px;
		padding: 8px 8px 8px 12px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-window);
		color: var(--text);
		font-size: var(--fs-desc);
	}
	.toast-icon {
		display: inline-flex;
		color: var(--accent-text);
	}
	.toast-ok .toast-icon {
		color: var(--ink-good);
	}
	.toast-warn .toast-icon {
		color: var(--ink-warn);
	}
	.toast-bad .toast-icon {
		color: var(--ink-bad);
	}
	.toast-msg {
		flex: 1;
		min-width: 0;
		line-height: 1.4;
	}
	.toast-repeat {
		flex-shrink: 0;
		padding: 1px 6px;
		border-radius: var(--radius-pill);
		background: var(--surface-inset);
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	.toast-action {
		flex-shrink: 0;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
	}
	.toast-action:hover,
	.toast-x:hover {
		background: var(--surface-hover);
	}
	.toast-x {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.toast-more {
		align-self: center;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--text-muted);
		font: inherit;
		font-size: var(--fs-section);
		cursor: pointer;
	}
	.toast-more:hover {
		color: var(--text);
	}
	@media (max-width: 639.98px) {
		.toast-x,
		.toast-action {
			min-width: 44px;
			height: 44px;
		}
	}
</style>
