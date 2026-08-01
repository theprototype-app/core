<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from '../../components/editors/nodes/NodeWrapper.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { pressTriggerNode } from './module.js';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// any top-level scene object can act as the button
	let items: { id: string; name: string }[] = [];
	$: items = $objectsGroup
		? $objectsGroup.children.map((child: any) => ({ id: child.uuid, name: child.name || child.type }))
		: [];
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>button object</span>
			<select
				class="nodrag"
				value={data.button ?? '-None-'}
				on:change={(e) => setNodeData(id, { button: e.currentTarget.value })}
			>
				<option>-None-</option>
				{#each items as option}
					<option value={option.id}>{option.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col">
			<span>mode</span>
			<select
				class="nodrag"
				value={data.mode ?? 'toggle'}
				on:change={(e) => setNodeData(id, { mode: e.currentTarget.value })}
			>
				<option value="toggle">toggle</option>
				<option value="push">push (springs back)</option>
			</select>
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>height</span><span>{data.height ?? 2}</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="-4"
				max="4"
				step="0.1"
				value={data.height ?? 2}
				on:input={(e) => setNodeData(id, { height: +e.currentTarget.value })}
			/>
		</label>
		<div class="flex items-center justify-between">
			<span class="flex items-center gap-1">
				<span
					class="inline-block h-2 w-2 rounded-full"
					style="background-color: {data.pressed ? '#22c55e' : '#6b7280'}"
				></span>
				{data.pressed ? 'pressed' : 'released'}
			</span>
			<button
				class="nodrag rounded-sm bg-[#ff4000] px-2 text-white"
				on:click={() => pressTriggerNode({ id, data })}
			>
				Press
			</button>
		</div>
	</div>
</NodeWrapper>
