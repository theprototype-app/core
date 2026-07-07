<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const options = ['cube', 'pyramid'];

	let selectedShape = data.shape ?? options[0];
	// Local change -> replicate to peers; remote change -> update local input
	$: if (selectedShape !== data.shape) setNodeData(id, { shape: selectedShape });
	$: if (data.shape && data.shape !== selectedShape) selectedShape = data.shape;
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<div class="nodrag flex flex-col">
		{#each options as option}
			<label class="flex">
				<input bind:group={selectedShape} class="accent-[#ff4000]" type="radio" value={option} />
				<span class="ml-2">{option}</span>
			</label>
		{/each}
	</div>
</NodeWrapper>
