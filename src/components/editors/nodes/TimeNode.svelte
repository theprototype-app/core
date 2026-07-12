<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 133: the synced clock as a value. Modes: t (raw seconds),
	// sin(t*rate) [-1..1], saw [0..1], pingpong [0..1..0]. Reads the shared
	// clock so peers agree. Live output shown on the card.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: live = $flowValues[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>time</span>
			<span class="font-mono">{typeof live === 'number' ? live.toFixed(2) : '—'}</span>
		</div>
		<select
			class="nodrag"
			value={data.mode ?? 'sin'}
			on:change={(e) => setNodeData(id, { mode: e.currentTarget.value })}
		>
			<option value="t">t (seconds)</option>
			<option value="sin">sin</option>
			<option value="saw">saw</option>
			<option value="pingpong">pingpong</option>
		</select>
		<label class="flex items-center gap-1">
			<span class="w-10 text-gray-400">rate</span>
			<input class="nodrag w-full accent-[#ff4000]" type="range" min="0.1" max="5" step="0.1"
				value={data.rate ?? 1}
				on:input={(e) => setNodeData(id, { rate: +e.currentTarget.value })} />
			<span class="font-mono">{(data.rate ?? 1).toFixed(1)}</span>
		</label>
	</div>
</NodeWrapper>
