<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { flowEdges, flowValues } from '../../../stores/flowStore';
	import { moduleInputHandles } from '$lib/moduleNodeIO';
	import { moduleNodeGroups } from '$lib/moduleSDK';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// Controls are described by the catalog spec for this node type
	$: spec = findNodeSpec(data.type);
	// One-way flow: render from data, write through setNodeData (replicates to peers)

	// A1: range params keep their sockets exactly where they were; a module's
	// declared inputs follow. Without a socket a declared input is unwirable.
	// $moduleNodeGroups is read purely as a DEPENDENCY: moduleInputHandles is a
	// plain object lookup, so a module installed AFTER this card mounted would
	// otherwise never grow its sockets (the non-reactive-registry family).
	$: rangeKeys = (spec?.params ?? []).filter((pr: any) => pr.kind === 'range').map((pr: any) => pr.key);
	// `_groups` is the dependency, not an argument: the registry is a plain object,
	// so the store read is the only thing that can re-run this.
	const declaredHandles = (type: string, _groups: any[]): string[] => moduleInputHandles(type);
	$: targetHandles = [
		...rangeKeys,
		...declaredHandles(data.type, $moduleNodeGroups).filter((h: string) => !rangeKeys.includes(h))
	];

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
	<!-- 133: a value input handle per numeric param (Number/Math/... drive it)
	     A1: plus one per input a MODULE declared that has no range param of its own
	     (an event trigger, an object target) — appended AFTER the range sockets so
	     every existing node's handle positions are byte-unchanged.
	     21-B B6: a spec that declares `inputs` opts out of the whole pixel-offset
	     scheme and renders LABELLED ROWS below instead — two stacks of absolutely
	     positioned handles on one card stop agreeing with the rows they name. -->
	{#if !spec?.inputs}
		{#each targetHandles as handle, i}
			<Socket kind="target" nodeType={data.type} position={Position.Left} id={handle} style={`top: ${34 + i * 38}px`} />
		{/each}
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
					{:else if param.kind === 'text'}
						<!-- A1: free text. `change` (commit/blur), NOT `input` — setNodeData
						     replicates the whole node, so per-keystroke = one message each. -->
						<input
							class="nodrag w-full rounded-sm bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px]"
							type="text"
							placeholder={param.placeholder ?? ''}
							maxlength={param.maxLength ?? null}
							value={data[param.key] ?? spec.defaults[param.key] ?? ''}
							on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
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
