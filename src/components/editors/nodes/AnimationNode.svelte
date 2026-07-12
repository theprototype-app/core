<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// Controls are described by the catalog spec for this node type
	$: spec = findNodeSpec(data.type);
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Handle type="source" position={Position.Right} />
	<!-- 133: a value input handle per numeric param (Number/Math/... drive it) -->
	{#if spec?.params}
		{#each spec.params.filter((pr: any) => pr.kind === 'range') as param, i}
			<Handle type="target" position={Position.Left} id={param.key} style={`top: ${34 + i * 38}px`} />
		{/each}
	{/if}
	<div class="flex w-full flex-col gap-1">
		{#if spec?.params}
			{#each spec.params as param}
				<label class="flex flex-col">
					<span class="flex justify-between">
						<span>{param.key}</span>
						{#if param.kind === 'range'}
							<span>{data[param.key] ?? spec.defaults[param.key]}</span>
						{/if}
					</span>
					{#if param.kind === 'range'}
						<input
							class="nodrag accent-[#ff4000]"
							type="range"
							min={param.min}
							max={param.max}
							step={param.step}
							value={data[param.key] ?? spec.defaults[param.key]}
							on:input={(e) => setNodeData(id, { [param.key]: +e.currentTarget.value })}
						/>
					{:else if param.kind === 'select'}
						<select
							class="nodrag"
							value={data[param.key] ?? spec.defaults[param.key]}
							on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
						>
							{#each param.options as option}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{/if}
				</label>
			{/each}
		{/if}
	</div>
</NodeWrapper>
