<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// List of objects currently in the scene
	let sceneObjects: any;
	$: sceneObjects = $objectsGroup;
	let items: { id: string; name: string }[] = [];
	$: items = sceneObjects
		? sceneObjects.children.map((child: any) => ({ id: child.uuid, name: child.name || child.type }))
		: [];
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type}>
	<div class="flex items-center space-x-2">
		<select
			class="nodrag"
			value={data.selected ?? '-None-'}
			on:change={(e) => setNodeData(id, { selected: e.currentTarget.value })}
		>
			<option>-None-</option>
			{#each items as option}
				<option value={option.id}>{option.name}</option>
			{/each}
		</select>
	</div>
	<Handle type="target" position={Position.Left} />
</NodeWrapper>
