<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { flowEdges, flowValues } from '../../../stores/flowStore';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// Controls are described by the catalog spec for this node type
	$: spec = findNodeSpec(data.type);
	// One-way flow: render from data, write through setNodeData (replicates to peers)

	// A WIRED param shows the incoming live value instead of its slider — the
	// manual value is overridden anyway (resolveInputs). Free to render: the
	// runtime already publishes every value node's output into flowValues ~6/s
	// for the card readouts, so this is a lookup, not a new evaluation.
	$: wiredSource = (key: string) =>
		($flowEdges as any[]).find((e) => e.target === id && e.targetHandle === key)?.source ?? null;
	function fmt(v: any) {
		if (v === undefined || v === null) return '…';
		if (typeof v === 'number') return (+v).toFixed(2);
		if (Array.isArray(v)) return v.map((n) => (+n).toFixed(1)).join(', ');
		return String(v);
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- 133: a value input handle per numeric param (Number/Math/... drive it) -->
	{#if spec?.params}
		{#each spec.params.filter((pr: any) => pr.kind === 'range') as param, i}
			<Socket kind="target" nodeType={data.type} position={Position.Left} id={param.key} style={`top: ${34 + i * 38}px`} />
		{/each}
	{/if}
	<div class="flex w-full flex-col gap-1">
		{#if spec?.params}
			{#each spec.params as param}
				<label class="flex flex-col">
					<span class="flex justify-between">
						<span>{param.key}</span>
						{#if param.kind === 'range' && !wiredSource(param.key)}
							<span>{data[param.key] ?? spec.defaults[param.key]}</span>
						{/if}
					</span>
					{#if param.kind === 'range' && wiredSource(param.key)}
						<!-- wired: the incoming value drives this param — show it live -->
						<span class="wired-value rounded bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px] text-primary-300" title="Driven by the wired input">
							◈ {fmt($flowValues[wiredSource(param.key)])}
						</span>
					{:else if param.kind === 'range'}
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
