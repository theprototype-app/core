<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const min = 0;
	const max = 40;

	let value = data.value ?? 20;
	// Local change -> replicate to peers; remote change -> update local input
	$: if (value !== data.value) setNodeData(id, { value: value });
	$: if (data.value !== undefined && data.value !== value) value = data.value;
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<input class="nodrag accent-[#ff4000]" style="direction: rtl;" type="range" {min} {max} bind:value />
</NodeWrapper>
