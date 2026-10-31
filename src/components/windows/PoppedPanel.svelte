<script lang="ts">
	// 70 W2 — ONE PANEL inside a pop-out window: the registered component ($lib/windows/panelRegistry)
	// mounted with `popped: true`, which forces its floating layout and skips the main window's chrome
	// duties. Its window root (`.tp-window`, a toolbox, the Inspector, the code workspace) is marked
	// `data-docked="pop"`: windows.css then lays it out as the window's content and hides its own
	// title / ✕ / Dock buttons the way a sidebar tab does — the pop-out's header is that chrome now.
	// A tab that is not in front stays mounted (its state survives a tab switch) and is hidden.
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { observe } from '$lib/windows/winEnv.js';
	import { panelTitles } from '$lib/windows/panelRegistry.js';

	let { key, active = true, api }: { key: string; active?: boolean; api: any } = $props();

	// svelte-ignore state_referenced_locally
	const entry = api.entryOf(key);
	let Comp: any = $state(null);
	let pane: HTMLElement | null = $state(null);

	$effect(() => {
		let live = true;
		entry?.load().then((m: any) => live && (Comp = m.default));
		return () => {
			live = false;
		};
	});

	// the panel closed ITSELF while popped (a shortcut, its own close path): it leaves the window, closed
	$effect(() => {
		if (!entry) return;
		let seenOpen = false;
		return entry.isOpen.subscribe((open: boolean) => {
			if (open) seenOpen = true;
			else if (seenOpen) api.closed(key);
		});
	});

	const ROOTS = [':scope > .tp-window', ':scope > * > .tp-window', ':scope > .toolbox', ':scope > #inspector', ':scope > .code-ws-popped'].join(', ');
	$effect(() => {
		const el = pane;
		if (!el) return;
		const mark = () => {
			for (const root of el.querySelectorAll(ROOTS)) if (root.getAttribute('data-docked') !== 'pop') root.setAttribute('data-docked', 'pop');
		};
		mark();
		return observe(el, 'MutationObserver', mark, { childList: true, subtree: true });
	});
</script>

<div bind:this={pane} class="tp-pop-pane" class:tp-pop-hidden={!active} data-pop-key={key} role="tabpanel" aria-label={$panelTitles[key] ?? api.titleOf(key)}>
	{#if Comp}
		{#if entry.wrap === 'flow'}
			<SvelteFlowProvider><Comp popped={true} /></SvelteFlowProvider>
		{:else}
			<Comp popped={true} />
		{/if}
	{/if}
</div>

<style>
	.tp-pop-pane {
		position: relative;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.tp-pop-hidden {
		display: none;
	}
</style>
