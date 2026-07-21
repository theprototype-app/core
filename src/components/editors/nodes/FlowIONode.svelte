<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// H5: interface nodes — Flow Input / Flow Output DECLARE an object flow's
	// public sockets. Inside the graph a Flow Input is a value source (fed by the
	// scene's embedded Object Flow node, else its fallback); a Flow Output is a
	// sink whose wired value surfaces on the embedded node. One-way flow: render
	// from data, write through setNodeData (replicates).
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const VTYPES = ['number', 'boolean', 'vector3', 'color'];
</script>

<NodeWrapper type={data.type} label={data.label}>
	{#if data.type === 'flowinput'}
		<Socket kind="source" nodeType={data.type} position={Position.Right} forceType={data.vtype ?? 'number'} />
	{:else}
		<Socket kind="target" nodeType={data.type} id="value" position={Position.Left} forceType="number" />
	{/if}
	<label class="flex w-full flex-col">
		<span>name</span>
		<input
			class="nodrag"
			type="text"
			value={data.name ?? (data.type === 'flowinput' ? 'value' : 'out')}
			on:change={(e) => setNodeData(id, { name: e.currentTarget.value.trim() || 'value' })}
		/>
	</label>
	{#if data.type === 'flowinput'}
		<label class="flex w-full flex-col">
			<span>type</span>
			<select
				class="nodrag"
				value={data.vtype ?? 'number'}
				on:change={(e) => setNodeData(id, { vtype: e.currentTarget.value })}
			>
				{#each VTYPES as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</label>
		<label class="flex w-full flex-col">
			<span>fallback</span>
			<input
				class="nodrag"
				type="number"
				value={typeof data.fallback === 'number' ? data.fallback : 0}
				on:change={(e) => setNodeData(id, { fallback: +e.currentTarget.value })}
			/>
		</label>
	{/if}
</NodeWrapper>
