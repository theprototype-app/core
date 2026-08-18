<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// Phase 134: THE loop primitive — cycles from..to at a rate on the synced
	// clock. wrap (sawtooth) / pingpong (triangle) / once (clamp). Deterministic.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: live = $flowValues[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>loop</span><span class="font-mono">{typeof live === 'number' ? live.toFixed(2) : '—'}</span>
		</div>
		<select class="nodrag" value={data.mode ?? 'wrap'} on:change={(e) => setNodeData(id, { mode: e.currentTarget.value })}>
			<option value="wrap">wrap</option>
			<option value="pingpong">pingpong</option>
			<option value="once">once</option>
		</select>
		<label class="flex items-center gap-1"><span class="w-10 text-gray-400">from</span>
			<DragRow nodrag step={0.01} decimals={2} value={data.from ?? 0} onchange={(/** @type {number} */ v) => setNodeData(id, { from: v })} /></label>
		<label class="flex items-center gap-1"><span class="w-10 text-gray-400">to</span>
			<DragRow nodrag step={0.01} decimals={2} value={data.to ?? 1} onchange={(/** @type {number} */ v) => setNodeData(id, { to: v })} /></label>
		<label class="flex items-center gap-1"><span class="w-10 text-gray-400">rate</span>
			<input class="nodrag w-full accent-[#ff4000]" type="range" min="0.1" max="5" step="0.1" value={data.rate ?? 1}
				on:input={(e) => setNodeData(id, { rate: +e.currentTarget.value })} /></label>
	</div>
</NodeWrapper>
