<script lang="ts">
	// 102-boot-diet-3 — ONE bottom-dock window whose body loads on first open ($lib/lazyPanels.js has the rules).
	// Until the body has loaded this is a LIGHT PLACEHOLDER: closed, it renders nothing; opened, it holds the
	// window's place for the few frames the chunk takes — docked, it reports the dock occupant at the dock's
	// height and draws the tab strip with the window's title (so the dock neither collapses nor jumps); floating,
	// a frame at the window's stored rect and size. Once loaded the body is mounted and STAYS mounted, closed
	// or open, exactly as the static import kept it.
	import { onDestroy } from 'svelte';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { lazyPanels, loadPanel, mark } from '$lib/lazyPanels';
	import { storedPanelLayout } from '$lib/uiLayoutsCore';
	import { safeStorage } from '$lib/safeStorage';
	import {
		setDockOccupant,
		dockHeight,
		dockShownKeys,
		DOCK_TITLES,
		DOCK_ICONS
	} from '$lib/bottomDock';
	import { dragWindow } from '$lib/dragWindow';
	import DockTabs from '../DockTabs.svelte';
	import Icon from '../ui/Icon.svelte';

	let {
		key,
		closed,
		defaultSize,
		defaultRect,
		flow = false
	}: {
		key: string;
		closed: boolean;
		defaultSize: { w: number; h: number };
		defaultRect: { left: number; top: number };
		flow?: boolean;
	} = $props();

	const title = $derived((DOCK_TITLES as Record<string, string>)[key] ?? key);
	const icon = $derived((DOCK_ICONS as Record<string, string>)[key] ?? 'square');
	const Body = $derived(($lazyPanels as Record<string, any>)[key] ?? null);
	let failed = $state(false);

	$effect(() => {
		if (closed || Body) return;
		failed = false;
		loadPanel(key).catch(() => (failed = true));
	});

	// the placeholder's layout: the same keys the window itself reads when it mounts
	const layout = $derived.by(() => {
		void closed; // re-read on every open (a workspace / layout restore may have changed it)
		return storedPanelLayout(safeStorage.getItem, key, defaultSize.w, defaultSize.h);
	});
	const placeholder = $derived(!Body && !closed);
	const dockVisible = $derived(($dockShownKeys as string[]).includes(key));

	// the first-open timing: the body is in the DOM (an effect runs after the mount)
	let markedMount = false;
	$effect(() => {
		if (Body && !markedMount) {
			markedMount = true;
			mark(key, 'mounted');
		}
	});

	// a docked placeholder IS the dock's occupant until the body takes over (the body reports the same key)
	$effect(() => {
		if (!placeholder || !layout.docked) return;
		setDockOccupant(key, true, $dockHeight);
		return () => {
			if (!($lazyPanels as Record<string, any>)[key]) setDockOccupant(key, false);
		};
	});
	onDestroy(() => {
		if (!Body) setDockOccupant(key, false);
	});
</script>

{#if Body}
	{#if flow}<SvelteFlowProvider><Body /></SvelteFlowProvider>{:else}<Body />{/if}
{:else if placeholder}
	{#if layout.docked}
		<div
			class="tp-ui tp-dock-panel fixed inset-x-0 bottom-0 flex flex-col p-2 {dockVisible
				? ''
				: 'hidden'}"
			style="z-index: var(--z-dock); height: {$dockHeight}px"
			data-lazy-panel={key}
			aria-busy="true"
			role="region"
			aria-label="{title} (loading)"
		>
			<DockTabs />
			<div class="lazy-dock-body text-text-2 text-xs">
				<Icon name={icon} size={16} />
				<span
					>{failed
						? `${title} could not load. Close it and open it again.`
						: `Loading ${title}…`}</span
				>
			</div>
		</div>
	{:else}
		<div
			class="ui-panel tp-ui tp-window fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key, defaultRect }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
			style:width="{layout.w}px"
			style:height="{layout.h}px"
			data-lazy-panel={key}
			aria-busy="true"
			role="dialog"
			aria-label="{title} (loading)"
		>
			<div class="ui-panel-header lazy-dock-head">
				<Icon name={icon} size={16} /><span>{title}</span>
			</div>
			<div class="lazy-dock-body text-text-2 text-xs">
				<span
					>{failed
						? `${title} could not load. Close it and open it again.`
						: `Loading ${title}…`}</span
				>
			</div>
		</div>
	{/if}
{/if}

<style>
	.lazy-dock-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.lazy-dock-body {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 0;
	}
</style>
