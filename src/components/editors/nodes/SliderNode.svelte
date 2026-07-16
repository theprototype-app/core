<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
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

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<label class="flex w-full flex-col">
		<span class="flex justify-between">
			<span>scale</span>
			<span>{((data.value ?? 20) / 20).toFixed(2)}×</span>
		</span>
		<input
			class="nodrag accent-[#ff4000]"
			style="direction: rtl;"
			type="range"
			{min}
			{max}
			value={data.value ?? 20}
			on:input={(e) => setNodeData(id, { value: +e.currentTarget.value })}
		/>
	</label>
</NodeWrapper>
