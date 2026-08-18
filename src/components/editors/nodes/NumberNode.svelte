<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import DragRow from '../../ui/DragRow.svelte';

	// Phase 133: a constant number output. One-way flow: render from data, write
	// through setNodeData (replicates). Its output feeds consumer input handles.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<label class="flex w-full flex-col">
		<span>value</span>
		<DragRow nodrag value={data.value ?? 0} step={(data.step ?? 1) / 100} decimals={2}
			onchange={(/** @type {number} */ v) => setNodeData(id, { value: v })} />
	</label>
</NodeWrapper>
