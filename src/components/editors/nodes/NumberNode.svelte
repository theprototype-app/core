<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// Phase 133: a constant number output. One-way flow: render from data, write
	// through setNodeData (replicates). Its output feeds consumer input handles.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="source" position={Position.Right} />
	<label class="flex w-full flex-col">
		<span>value</span>
		<input
			class="nodrag"
			type="number"
			step={data.step ?? 1}
			value={data.value ?? 0}
			on:change={(e) => setNodeData(id, { value: +e.currentTarget.value })}
		/>
	</label>
</NodeWrapper>
