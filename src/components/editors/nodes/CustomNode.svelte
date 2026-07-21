<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { customNodeDefs, scriptErrors, nodeDesignerOpen, flowEdges, flowValues } from '../../../stores/flowStore';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// instance of a user-designed definition: controls come from the def
	$: def = $customNodeDefs.find((d) => d.id === data.defId) ?? null;
	$: error = $scriptErrors[id];
	// One-way flow: render from data, write through setNodeData (replicates to peers)

	// wired params show the incoming live value instead of the slider (the manual
	// value is overridden anyway); a flowValues lookup — no new evaluation
	$: wiredSource = (key: string) =>
		($flowEdges as any[]).find((e) => e.target === id && e.targetHandle === key)?.source ?? null;
	function fmt(v: any) {
		if (v === undefined || v === null) return '…';
		if (typeof v === 'number') return (+v).toFixed(2);
		if (Array.isArray(v)) return v.map((n) => (+n).toFixed(1)).join(', ');
		return String(v);
	}
</script>

<NodeWrapper type={def?.name ?? 'custom'}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- B4.5: one input socket per RANGE param (the runtime already resolves
	     wired inputs via resolveInputs — only the sockets were missing) -->
	{#each (def?.params ?? []).filter((p: any) => p.kind === 'range') as param, i (param.key)}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id={param.key} style={`top: ${34 + i * 38}px`} />
	{/each}
	<div class="flex w-full flex-col gap-1">
		{#if !def}
			<span class="text-[10px] text-red-500">definition missing</span>
		{:else}
			{#each def.params ?? [] as param}
				<label class="flex flex-col">
					<span class="flex justify-between">
						<span>{param.key}</span>
						{#if param.kind === 'range' && !wiredSource(param.key)}
							<span>{data[param.key] ?? param.min ?? 0}</span>
						{/if}
					</span>
					{#if param.kind === 'range' && wiredSource(param.key)}
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
