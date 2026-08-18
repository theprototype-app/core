<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import DragRow from '../../ui/DragRow.svelte';

	// Phase 133: an x/y/z constant (feeds positions/offsets). Output is [x,y,z].
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	const AXES = ['x', 'y', 'z'] as const;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#each AXES as axis}
			<label class="flex items-center gap-1">
				<span class="w-3 text-gray-400">{axis}</span>
				<DragRow nodrag step={0.01} decimals={2} value={data[axis] ?? 0} onchange={(/** @type {number} */ v) => setNodeData(id, { [axis]: v })} />
			</label>
		{/each}
	</div>
</NodeWrapper>
