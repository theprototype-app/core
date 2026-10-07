<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;
	// One-way flow: render from data, write through setNodeData (replicates to peers)
	const DEFAULT_COLOR = '#ff4000'; // tokens-ok: the picker's starting value (user data)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex items-center space-x-2">
		<input
			class="nodrag nopan border-md h-6 w-6"
			type="color"
			value={data.color ?? DEFAULT_COLOR}
			on:input={(e) => setNodeData(id, { color: e.currentTarget.value })}
		/>
		<p>{data.color ?? DEFAULT_COLOR}</p>
	</div>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
</NodeWrapper>
