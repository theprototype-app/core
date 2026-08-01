<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';

	// CL-C C1: collider override node — shape/scale/sensor are consumed by
	// physics.js at sim start AND live (mid-sim rebuild, CL-A A2). The node
	// WINS over the Inspector's collider pick (flow-overrides-Inspector, the
	// mass precedent). Shape 'object' hulls the object wired into `source`.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;
	$: spec = findNodeSpec(data.type);
	$: shapes = spec?.params?.find((p: any) => p.key === 'shape')?.options ?? ['box'];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- the object to HULL when shape = object -->
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="source" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>shape</span>
			<select
				class="nodrag"
				value={data.shape ?? 'box'}
				on:change={(e) => setNodeData(id, { shape: e.currentTarget.value })}
			>
				{#each shapes as option}
					<option value={option}>{option}</option>
				{/each}
			</select>
		</label>
		{#if (data.shape ?? 'box') === 'object'}
			<p class="text-[10px] text-gray-400">◄ wire an Object Selector into source</p>
		{/if}
		<label class="flex flex-col">
			<span class="flex justify-between"><span>scale</span><span>{(+(data.scale ?? 1)).toFixed(2)}</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="0.25"
				max="4"
				step="0.05"
				value={data.scale ?? 1}
				on:input={(e) => setNodeData(id, { scale: +e.currentTarget.value })}
			/>
		</label>
		<label class="nodrag flex items-center gap-1.5">
			<input
				type="checkbox"
				checked={!!data.sensor}
				on:change={(e) => setNodeData(id, { sensor: e.currentTarget.checked })}
			/>
			<span>sensor</span>
		</label>
		<p class="text-[10px] text-gray-400">overrides the Inspector collider; applies live</p>
	</div>
</NodeWrapper>
