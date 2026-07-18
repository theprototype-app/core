<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 133: a SEEDED random value in [min,max]. Seed = node id, so every
	// peer computes the same number; an optional re-roll interval ticks on the
	// synced clock (still deterministic). Live value shown on the card.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: live = $flowValues[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>random</span>
			<span class="font-mono">{typeof live === 'number' ? live.toFixed(2) : '—'}</span>
		</div>
		<label class="flex items-center gap-1">
			<span class="w-12 text-gray-400">min</span>
			<input class="nodrag w-full" type="number" step="0.1" value={data.min ?? 0}
				on:change={(e) => setNodeData(id, { min: +e.currentTarget.value })} />
		</label>
		<label class="flex items-center gap-1">
			<span class="w-12 text-gray-400">max</span>
			<input class="nodrag w-full" type="number" step="0.1" value={data.max ?? 1}
				on:change={(e) => setNodeData(id, { max: +e.currentTarget.value })} />
		</label>
		<label class="flex items-center gap-1">
			<span class="w-12 text-gray-400">every</span>
			<input class="nodrag w-full" type="number" step="0.5" min="0" value={data.interval ?? 0}
				on:change={(e) => setNodeData(id, { interval: +e.currentTarget.value })} />
			<span class="text-gray-400">s</span>
		</label>
	</div>
</NodeWrapper>
