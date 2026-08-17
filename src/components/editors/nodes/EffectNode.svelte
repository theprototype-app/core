<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// Phase 134: object-action nodes. Connect the source (right) to an Object
	// Selector; the left input drives the action. LookAt -> target (object/point),
	// Set Color -> color, Visibility -> on (boolean). Base-managed, local per peer.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	const INPUT: Record<string, string> = {
		lookat: 'target',
		setcolor: 'color',
		visibility: 'on',
		setuniform: 'value'
	};
	$: handleId = INPUT[data.type] ?? 'in';
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id={handleId} style="top: 30px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#if data.type === 'lookat'}
			<p class="text-[10px] text-gray-400">faces the wired target object/point</p>
		{:else if data.type === 'setcolor'}
			<label class="flex items-center gap-2">
				<input class="nodrag h-5 w-7" type="color" value={data.color ?? '#ff4000'}
					on:input={(e) => setNodeData(id, { color: e.currentTarget.value })} />
				<span class="text-[10px] text-gray-400">or wire a color</span>
			</label>
		{:else if data.type === 'setuniform'}
			<label class="flex w-full flex-col gap-0.5">
				<span class="text-[9px] text-gray-400">uniform</span>
				<input class="nodrag w-full font-mono text-[10px]" type="text" placeholder="u_c1_value"
					value={data.uniform ?? ''}
					on:change={(e) => setNodeData(id, { uniform: e.currentTarget.value })} />
			</label>
			<p class="text-[9px] leading-tight text-gray-500">
				the name shown beside that param in the Shader editor
			</p>
		{:else if data.type === 'visibility'}
			<label class="flex items-center gap-2">
				<input class="nodrag" type="checkbox" checked={data.on !== false}
					on:change={(e) => setNodeData(id, { on: e.currentTarget.checked })} />
				<span>{data.on !== false ? 'visible' : 'hidden'}</span>
			</label>
		{/if}
	</div>
</NodeWrapper>
