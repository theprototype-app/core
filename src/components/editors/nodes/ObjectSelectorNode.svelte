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

	let selected = data.selected ?? '-None-';
	// Local change -> replicate to peers; remote change -> update local input
	$: if (selected !== data.selected) setNodeData(id, { selected: selected });
	$: if (data.selected && data.selected !== selected) selected = data.selected;
</script>

<NodeWrapper type={data.type}>
	<div class="flex items-center space-x-2">
		<select bind:value={selected} class="nodrag">
			<option>-None-</option>
			{#each items as option}
				<option value={option.id}>{option.name}</option>
			{/each}
		</select>
	</div>
	<Handle type="target" position={Position.Left} />
</NodeWrapper>
