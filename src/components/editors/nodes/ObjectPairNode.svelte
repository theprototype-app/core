<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 134: sensors between two object inputs (wire Object Selector nodes to
	// a/b). Distance -> number; Proximity -> boolean when within radius.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: isProximity = data.type === 'proximity';
	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : typeof live === 'boolean' ? (live ? 'near' : 'far') : (+live).toFixed(2);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="target" position={Position.Left} id="a" style="top: 30px" />
	<Handle type="target" position={Position.Left} id="b" style="top: 54px" />
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>{isProximity ? 'within' : 'dist'}</span><span class="font-mono">{readout}</span>
		</div>
		<p class="text-[10px] text-gray-400">wire two Object Selectors to a/b</p>
		{#if isProximity}
			<label class="flex items-center gap-1"><span class="w-12 text-gray-400">radius</span>
				<input class="nodrag w-full" type="number" step="0.1" min="0" value={data.radius ?? 3}
					on:change={(e) => setNodeData(id, { radius: +e.currentTarget.value })} /></label>
		{/if}
	</div>
</NodeWrapper>
