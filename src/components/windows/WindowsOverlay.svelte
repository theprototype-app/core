<script lang="ts">
	// 70 W4/W5 — the MAIN window's half of pop-out windows:
	//   DROP ZONES (W4) while a panel is dragged out of a pop-out window: the bottom dock, the left and
	//   the right sidebar each take it there; anywhere else in the app puts it back where it was.
	//   THE RESTORE BAR (W5) while a saved multi-window layout is waiting to reopen: browsers open one
	//   pop-up per click, so the bar reads "Open N windows", then "Open window k of N" — one click
	//   each, unless the site may open pop-ups, where the first click opens them all.
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import { panelDrag, PANEL_DRAG_TYPE } from '$lib/windows/panelPlaces.js';
	import { windowApi, restoreQueue, restoreNext, dismissRestore } from '$lib/windows/panelHost.js';

	type Where = 'bottom' | 'left' | 'right' | null;
	let over: Where | 'main' | false = $state(false);

	const isPanelDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes(PANEL_DRAG_TYPE) && !!get(panelDrag);

	function dragOver(e: DragEvent, where: Where | 'main') {
		if (!isPanelDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		over = where;
	}
	function drop(e: DragEvent, where: Where) {
		const st = get(panelDrag);
		if (!isPanelDrag(e) || !st) return;
		e.preventDefault();
		e.stopPropagation();
		over = false;
		panelDrag.set(null);
		windowApi.dropToMain(st.key, where);
	}

	const opened = $derived($restoreQueue ? $restoreQueue.total - $restoreQueue.windows.length : 0);
	const label = $derived(!$restoreQueue ? '' : opened === 0 ? ($restoreQueue.total === 1 ? 'Open the window' : `Open ${$restoreQueue.total} windows`) : `Open window ${opened + 1} of ${$restoreQueue.total}`);
</script>

{#if $panelDrag}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="panel-drop-zones"
		class="pdz-root"
		ondragover={(e) => dragOver(e, 'main')}
		ondragleave={(e) => e.target === e.currentTarget && (over = false)}
		ondrop={(e) => drop(e, null)}
	>
		<div class="pdz-zone pdz-left" class:pdz-over={over === 'left'} data-zone="left" ondragover={(e) => dragOver(e, 'left')} ondrop={(e) => drop(e, 'left')}>
			<Icon name="panel-left" size={20} aria-hidden="true" /><span>Left sidebar</span>
		</div>
		<div class="pdz-zone pdz-right" class:pdz-over={over === 'right'} data-zone="right" ondragover={(e) => dragOver(e, 'right')} ondrop={(e) => drop(e, 'right')}>
			<Icon name="panel-right" size={20} aria-hidden="true" /><span>Right sidebar</span>
		</div>
		<div class="pdz-zone pdz-bottom" class:pdz-over={over === 'bottom'} data-zone="bottom" ondragover={(e) => dragOver(e, 'bottom')} ondrop={(e) => drop(e, 'bottom')}>
			<Icon name="panel-bottom" size={20} aria-hidden="true" /><span>Bottom dock</span>
		</div>
		<div class="pdz-hint" class:pdz-over={over === 'main'}>Drop here to put it back where it was</div>
	</div>
{/if}

{#if $restoreQueue}
	<div id="restore-windows-bar" class="rwb tp-ui" role="status">
		<Icon name="app-window" size={16} aria-hidden="true" />
		<span>Your pop-out windows from last time</span>
		<Button id="restore-windows-open" variant="primary" size="sm" onclick={() => restoreNext()}>{label}</Button>
		<button class="rwb-x" aria-label="Forget these windows" title="Keep everything in this window (forgets the saved windows)" onclick={dismissRestore}><Icon name="x" size={16} aria-hidden="true" /></button>
	</div>
{/if}

<style>
	.pdz-root {
		position: fixed;
		inset: 0;
		z-index: var(--z-portal);
		background: color-mix(in srgb, var(--surface-1) 18%, transparent);
	}
	.pdz-zone {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 2px dashed color-mix(in srgb, var(--accent) 60%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-1) 80%, transparent);
		color: var(--text);
		font-size: 13px;
		font-weight: 600;
	}
	.pdz-zone :global(*) {
		pointer-events: none;
	}
	.pdz-left {
		left: 12px;
		top: 72px;
		bottom: 30%;
		width: 22%;
	}
	.pdz-right {
		right: 12px;
		top: 72px;
		bottom: 30%;
		width: 22%;
	}
	.pdz-bottom {
		left: 12px;
		right: 12px;
		bottom: 12px;
		height: calc(30% - 24px);
	}
	.pdz-zone.pdz-over {
		border-style: solid;
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 22%, var(--surface-1));
	}
	.pdz-hint {
		position: absolute;
		left: 50%;
		top: 35%;
		transform: translateX(-50%);
		padding: 6px 12px;
		border-radius: 8px;
		background: var(--surface-1);
		color: var(--text-2, var(--text));
		font-size: 12px;
		pointer-events: none;
	}
	.pdz-hint.pdz-over {
		color: var(--text);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.rwb {
		position: fixed;
		top: 64px;
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-toast-low);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 8px 6px 12px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-1);
		color: var(--text);
		font-size: 12px;
		box-shadow: var(--shadow-window);
	}
	.rwb-x {
		display: inline-flex;
		padding: 4px;
		border-radius: 6px;
	}
	.rwb-x:hover {
		background: color-mix(in srgb, var(--text) 10%, transparent);
	}
</style>
