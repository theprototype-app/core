<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex items-center space-x-2">
		<input
			class="nodrag border-md h-6 w-6"
			type="color"
			value={data.color ?? '#ff4000'}
			on:input={(e) => setNodeData(id, { color: e.currentTarget.value })}
		/>
		<p>{data.color ?? '#ff4000'}</p>
	</div>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
</NodeWrapper>
