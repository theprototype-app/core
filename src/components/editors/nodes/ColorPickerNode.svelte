<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	let value = data.color ?? '#ff4000';
	// Local change -> replicate to peers; remote change -> update local input
	$: if (value !== data.color) setNodeData(id, { color: value });
	$: if (data.color && data.color !== value) value = data.color;
</script>

<NodeWrapper type={data.type}>
	<div class="flex items-center space-x-2">
		<input bind:value class="nodrag border-md h-6 w-6" type="color" />
		<p>{value}</p>
	</div>
	<Handle type="source" position={Position.Right} />
</NodeWrapper>
