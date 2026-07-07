<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const options = ['cube', 'pyramid'];
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<div class="nodrag flex flex-col">
		{#each options as option}
			<label class="flex">
				<input
					class="accent-[#ff4000]"
					type="radio"
					name={`shape-${id}`}
					value={option}
					checked={(data.shape ?? 'cube') === option}
					on:change={() => setNodeData(id, { shape: option })}
				/>
				<span class="ml-2">{option}</span>
			</label>
		{/each}
	</div>
</NodeWrapper>
