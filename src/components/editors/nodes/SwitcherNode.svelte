<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// 4.4: the items LIST is adjustable node data (edited in the Flow ⓘ tab);
	// the node outputs the selected INDEX (a number source). `shape` is kept in
	// sync for the legacy geometry-swap path on saved graphs.
	$: options = Array.isArray(data.items) && data.items.length ? data.items : ['cube', 'pyramid'];
	$: selected = Math.min(Math.max(data.index ?? Math.max(options.indexOf(data.shape ?? 'cube'), 0), 0), options.length - 1);
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="nodrag flex flex-col">
		{#each options as option, i}
			<label class="flex">
				<input
					class="accent-[#ff4000]"
					type="radio"
					name={`shape-${id}`}
					value={option}
					checked={selected === i}
					on:change={() => setNodeData(id, { index: i, shape: option })}
				/>
				<span class="ml-2">{option}</span>
			</label>
		{/each}
	</div>
</NodeWrapper>
