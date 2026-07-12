<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// Phase 134: object-action nodes. Connect the source (right) to an Object
	// Selector; the left input drives the action. LookAt -> target (object/point),
	// Set Color -> color, Visibility -> on (boolean). Base-managed, local per peer.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	const INPUT: Record<string, string> = { lookat: 'target', setcolor: 'color', visibility: 'on' };
	$: handleId = INPUT[data.type] ?? 'in';
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="target" position={Position.Left} id={handleId} style="top: 30px" />
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#if data.type === 'lookat'}
			<p class="text-[10px] text-gray-400">faces the wired target object/point</p>
		{:else if data.type === 'setcolor'}
			<label class="flex items-center gap-2">
				<input class="nodrag h-5 w-7" type="color" value={data.color ?? '#ff4000'}
					on:input={(e) => setNodeData(id, { color: e.currentTarget.value })} />
				<span class="text-[10px] text-gray-400">or wire a color</span>
			</label>
		{:else if data.type === 'visibility'}
			<label class="flex items-center gap-2">
				<input class="nodrag" type="checkbox" checked={data.on !== false}
					on:change={(e) => setNodeData(id, { on: e.currentTarget.checked })} />
				<span>{data.on !== false ? 'visible' : 'hidden'}</span>
			</label>
		{/if}
	</div>
</NodeWrapper>
