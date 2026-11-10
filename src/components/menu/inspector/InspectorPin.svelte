<script>
	// 78-int PL14 — the Inspector's pin, "Follow the selection" (15-O `inspectorPinned`, LOCAL): one
	// button, id `#inspector-pin` kept for every caller and suite. It lives in the sidebar STRIP on a
	// wider screen (SidebarStrips) and at the end of the filter row in a pop-out window; the phone has
	// it as the first item of the tab's long-press menu ($lib/dockMenu).
	import Icon from '../../ui/Icon.svelte';
	import { inspectorPinned } from '../../../stores/appStore';

	/** @type {{class?: string, size?: 16 | 20} & Record<string, any>} */
	let { class: cls = 'ins-pin-btn', size = 16, ...rest } = $props();
</script>

<button
	type="button"
	id="inspector-pin"
	class={cls}
	class:on={$inspectorPinned}
	aria-pressed={$inspectorPinned}
	aria-label={$inspectorPinned ? 'Stop following the selection' : 'Follow the selection'}
	title={$inspectorPinned
		? 'Following the selection: this panel stays open and shows what you select. Click to stop'
		: 'Follow the selection: keep this panel open and show what you select'}
	onclick={() => inspectorPinned.update((v) => !v)}
	{...rest}
>
	<Icon name={$inspectorPinned ? 'pin' : 'pin-off'} {size} aria-hidden="true" />
</button>

<style>
	.ins-pin-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		color: var(--text-muted);
		background: transparent;
	}
	.ins-pin-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.ins-pin-btn.on {
		color: var(--accent-text);
	}
</style>
