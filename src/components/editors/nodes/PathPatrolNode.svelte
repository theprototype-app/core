<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { pathCaptureNode, togglePathCapture } from '$lib/pathCapture';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: capturing = $pathCaptureNode === id;
	$: waypointCount = (data.points ?? []).length;
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<span class="text-[10px] text-gray-400">
			{waypointCount} waypoint{waypointCount === 1 ? '' : 's'}
			{#if waypointCount < 2}(need 2+){/if}
		</span>
		<div class="flex gap-1">
			<button
				class="nodrag flex-1 rounded px-1 py-0.5 text-white {capturing
					? 'bg-green-600'
					: 'bg-[#ff4000]'}"
				on:click={() => togglePathCapture(id)}
			>
				{capturing ? 'Capturing… (click scene)' : 'Capture clicks'}
			</button>
			<button
				class="nodrag rounded bg-gray-600 px-1 py-0.5 text-white"
				on:click={() => setNodeData(id, { points: [] })}
			>
				Clear
			</button>
		</div>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>speed</span><span>{data.speed ?? 1}</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="0.1"
				max="5"
				step="0.1"
				value={data.speed ?? 1}
				on:input={(e) => setNodeData(id, { speed: +e.currentTarget.value })}
			/>
		</label>
		<label class="flex flex-col">
			<span>mode</span>
			<select
				class="nodrag"
				value={data.mode ?? 'loop'}
				on:change={(e) => setNodeData(id, { mode: e.currentTarget.value })}
			>
				<option value="loop">loop</option>
				<option value="pingpong">ping-pong</option>
			</select>
		</label>
	</div>
</NodeWrapper>
