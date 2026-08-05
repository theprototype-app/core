<script>
	// Shared panel header: [type badge] Title ........ [actions slot] [pin] [×]
	// onclose optional — omit it to hide the close button. 15-O: `onpin` adds a
	// pin TOGGLE left of the close button (a pinned panel stays open and follows
	// the selection); omit it and nothing extra renders.
	import { Pin, PinOff } from '@lucide/svelte';
	/** @type {{title?: string, badge?: string, onclose?: (() => void) | null, onpin?: (() => void) | null, pinned?: boolean, children?: any}} */
	let {
		title = '',
		badge = '',
		onclose = null,
		onpin = null,
		pinned = false,
		children = null
	} = $props();
</script>

<div class="ui-panel-header">
	{#if badge}
		<span class="ui-badge-type">{badge}</span>
	{/if}
	<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
	{@render children?.()}
	{#if onpin}
		<button
			id="inspector-pin"
			class="ui-button-quiet {pinned ? 'pin-on' : ''}"
			title={pinned
				? 'Unpin — properties then open on double-click or via the context menu'
				: 'Pin — keep this panel open and follow the selection'}
			aria-label={pinned ? 'Unpin the properties panel' : 'Pin the properties panel'}
			aria-pressed={pinned}
			onclick={onpin}
		>
			{#if pinned}
				<Pin size={14} aria-hidden="true" />
			{:else}
				<PinOff size={14} aria-hidden="true" />
			{/if}
		</button>
	{/if}
	{#if onclose}
		<button class="ui-button-quiet" title="Close" onclick={onclose}>✕</button>
	{/if}
</div>

<style>
	/* engaged pin reads as active; unpinned stays quiet like the ✕ */
	.pin-on {
		color: var(--color-primary-400, #60a5fa);
	}
</style>
