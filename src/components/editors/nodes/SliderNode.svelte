<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const min = 0;
	const max = 40;
	// One-way flow: render from data, write through setNodeData (replicates to peers).
	// A local bind:value would get clobbered by the store round-trip.
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<input
		class="nodrag accent-[#ff4000]"
		style="direction: rtl;"
		type="range"
		{min}
		{max}
		value={data.value ?? 20}
		on:input={(e) => setNodeData(id, { value: +e.currentTarget.value })}
	/>
</NodeWrapper>
