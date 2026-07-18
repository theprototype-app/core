<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// Phase 133: a boolean switch. Output true/false (drives Gate / Compare / any
	// boolean-consuming handle).
	type $$Props = NodeProps;
	export let id: string;
	export let data;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<label class="flex w-full items-center gap-2">
		<input
			class="nodrag"
			type="checkbox"
			checked={!!data.on}
			on:change={(e) => setNodeData(id, { on: e.currentTarget.checked })}
		/>
		<span class="font-mono">{data.on ? 'true' : 'false'}</span>
	</label>
</NodeWrapper>
