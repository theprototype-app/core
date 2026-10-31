<script>
	// fix-batch-2: the visible mode while a Path patrol node places waypoints. It used to be
	// a toast and a toggle on the node card, which leaves the screen the moment the editor
	// shows another graph — and the mode kept eating viewport clicks with nothing to say so.
	// The shared ToolboxWindow shell, like the spline and measure sessions.
	import Icon from '../ui/Icon.svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import { pathCaptureNode, endPathCapture } from '$lib/pathCapture';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowGraphs } from '../../stores/flowStore';
	import { isVRMode } from '../../stores/sceneStore';

	const found = $derived.by(() => {
		const id = $pathCaptureNode;
		if (!id) return null;
		for (const [graphId, graph] of Object.entries($flowGraphs ?? {})) {
			const node = /** @type {any} */ (graph).nodes?.find((/** @type {any} */ n) => n.id === id);
			if (node) return { node, graphId };
		}
		return null;
	});
	const active = $derived(!$isVRMode && !!found);
	const count = $derived(found?.node.data?.points?.length ?? 0);

	function undoLast() {
		if (!found || !count) return;
		setNodeData(found.node.id, { points: found.node.data.points.slice(0, -1) }, found.graphId);
	}
</script>

{#if active}
	<ToolboxWindow id="path-capture-toolbar" key="pathCaptureToolbox" title="Placing waypoints" width={210}>
		{#snippet actions()}
			<button
				id="path-capture-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title="Finish placing waypoints (Esc)"
				onclick={() => endPathCapture()}><Icon name="check" size={16} aria-hidden="true" /></button
			>
		{/snippet}

		<div class="tbx-row text-xs" id="path-capture-readout" aria-live="polite">
			<span>
				<b id="path-capture-count">{count}</b> waypoint{count === 1 ? '' : 's'}{count < 2 ? ' (need 2+)' : ''}
			</span>
		</div>
		<div class="tbx-row text-xs text-text-muted">
			Click the scene to add · drag a marker to move it · right-click removes · Esc or ✓ to finish
		</div>
		<div class="tbx-row">
			<button id="path-capture-undo" class="tbx-cmd" disabled={!count} title="Remove the last waypoint" onclick={undoLast}>Undo last point</button>
		</div>
	</ToolboxWindow>
{/if}
