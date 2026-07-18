<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 133: a two-input operator — Math (add/sub/mul/div/min/max/mod),
	// Compare (> < = >= <= !=), Gate (AND/OR/NOT/XOR). Inputs come from the a/b
	// handles (wired value/logic nodes); unconnected handles fall back to the
	// manual a/b fields. Output is a number (Math) or boolean (Compare/Gate),
	// shown live on the card.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const OPS: Record<string, [string, string][]> = {
		math: [['add', '+'], ['sub', '−'], ['mul', '×'], ['div', '÷'], ['min', 'min'], ['max', 'max'], ['mod', 'mod']],
		compare: [['gt', '>'], ['lt', '<'], ['eq', '='], ['gte', '≥'], ['lte', '≤'], ['neq', '≠']],
		gate: [['and', 'AND'], ['or', 'OR'], ['not', 'NOT'], ['xor', 'XOR']]
	};
	$: ops = OPS[data.type] ?? OPS.math;
	$: isGate = data.type === 'gate';
	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : typeof live === 'boolean' ? (live ? 'true' : 'false') : (+live).toFixed(2);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 30px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="b" style="top: 54px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>out</span><span class="font-mono">{readout}</span>
		</div>
		<select class="nodrag" value={data.op ?? ops[0][0]} on:change={(e) => setNodeData(id, { op: e.currentTarget.value })}>
			{#each ops as [value, glyph]}
				<option {value}>{glyph}</option>
			{/each}
		</select>
		{#if isGate}
			<label class="flex items-center gap-1">
				<input class="nodrag" type="checkbox" checked={!!data.a}
					on:change={(e) => setNodeData(id, { a: e.currentTarget.checked })} /> a
			</label>
			{#if data.op !== 'not'}
				<label class="flex items-center gap-1">
					<input class="nodrag" type="checkbox" checked={!!data.b}
						on:change={(e) => setNodeData(id, { b: e.currentTarget.checked })} /> b
				</label>
			{/if}
		{:else}
			<label class="flex items-center gap-1">
				<span class="w-3 text-gray-400">a</span>
				<input class="nodrag w-full" type="number" step="0.1" value={data.a ?? 0}
					on:change={(e) => setNodeData(id, { a: +e.currentTarget.value })} />
			</label>
			<label class="flex items-center gap-1">
				<span class="w-3 text-gray-400">b</span>
				<input class="nodrag w-full" type="number" step="0.1" value={data.b ?? 0}
					on:change={(e) => setNodeData(id, { b: +e.currentTarget.value })} />
			</label>
		{/if}
	</div>
</NodeWrapper>
