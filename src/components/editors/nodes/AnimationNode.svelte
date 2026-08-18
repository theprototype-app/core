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
	{#if !spec?.inputs}
		{#if spec?.params}
			{#each spec.params.filter((pr: any) => pr.kind === 'range') as param, i}
				<Socket kind="target" nodeType={data.type} position={Position.Left} id={param.key} style={`top: ${34 + i * 38}px`} />
			{/each}
		{/if}
	{/if}
	<div class="flex w-full flex-col gap-1">
		<!-- B6: NAMED sockets declared by the catalog spec (trigger, force, target…)
		     as LABELLED ROWS, the ObjectFlowNode pattern: the handle sits in a
		     relative wrapper whose `-mx-3 px-3` cancels the card padding, so the dot
		     lands ON the card edge, centred on its own label. A bare dot at a
		     computed offset said nothing about what to wire into it, and two stacks
		     of absolute handles on one card stopped lining up with their rows. -->
		{#each spec?.inputs ?? [] as key (key)}
			<div class="relative -mx-3 flex h-5 items-center px-3">
				<Socket kind="target" nodeType={data.type} position={Position.Left} id={key} style="top: 50%;" />
				<span class="max-w-full truncate text-[10px] text-gray-300" title={key}>
					{spec?.inputLabels?.[key] ?? key}
				</span>
			</div>
		{/each}
		{#if spec?.params}
			{#each spec.params as param}
				<label class="relative flex flex-col" class:-mx-3={!!spec?.inputs} class:px-3={!!spec?.inputs}>
					{#if spec?.inputs && param.kind === 'range'}
						<!-- the row owns its handle here, so it cannot drift from its label -->
						<Socket kind="target" nodeType={data.type} position={Position.Left} id={param.key} style="top: 10px;" />
					{/if}
					<span class="flex justify-between">
						<span>{param.key}</span>
						{#if param.kind === 'range' && !wiredSource(param.key)}
							<span>{data[param.key] ?? spec.defaults[param.key]}</span>
						{/if}
					</span>
					{#if param.kind === 'range' && wiredSource(param.key)}
						<!-- wired: the incoming value drives this param — show it live -->
						<span class="wired-value rounded-sm bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px] text-primary-300" title="Driven by the wired input">
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
					{:else if param.kind === 'toggle'}
						<!-- CL-C: boolean param (checkbox) -->
						<span class="nodrag flex items-center gap-1.5">
							<input
								type="checkbox"
								checked={!!(data[param.key] ?? spec.defaults[param.key])}
								on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.checked })}
							/>
						</span>
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
