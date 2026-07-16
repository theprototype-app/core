<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { customNodeDefs, scriptErrors, nodeDesignerOpen } from '../../../stores/flowStore';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// instance of a user-designed definition: controls come from the def
	$: def = $customNodeDefs.find((d) => d.id === data.defId) ?? null;
	$: error = $scriptErrors[id];
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={def?.name ?? 'custom'}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#if !def}
			<span class="text-[10px] text-red-500">definition missing</span>
		{:else}
			{#each def.params ?? [] as param}
				<label class="flex flex-col">
					<span class="flex justify-between">
						<span>{param.key}</span>
						{#if param.kind === 'range'}
							<span>{data[param.key] ?? param.min ?? 0}</span>
						{/if}
					</span>
					{#if param.kind === 'range'}
						<input
							class="nodrag accent-[#ff4000]"
							type="range"
							min={param.min}
							max={param.max}
							step={param.step}
							value={data[param.key] ?? param.min ?? 0}
							on:input={(e) => setNodeData(id, { [param.key]: +e.currentTarget.value })}
						/>
					{:else if param.kind === 'select'}
						<select
							class="nodrag"
							value={data[param.key] ?? param.options?.[0]}
							on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
						>
							{#each param.options ?? [] as option}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{/if}
				</label>
			{/each}
			<button
				class="nodrag rounded bg-gray-600 px-2 py-0.5 text-[10px] text-white"
				on:click={() => nodeDesignerOpen.set(def)}
			>
				Edit definition
			</button>
		{/if}
		{#if error}
			<span class="max-w-[180px] break-words text-[10px] text-red-500" title={error}>⚠ {error}</span>
		{/if}
	</div>
</NodeWrapper>
