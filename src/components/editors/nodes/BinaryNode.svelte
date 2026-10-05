<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues, flowEdges } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';
	import { isVariadic, variadicInputs, opFolds, MAX_SOCKETS, MIN_SOCKETS } from '$lib/variadicNodes.js';
	import { addVariadicSocket, removeVariadicSocket } from '$lib/variadicEdit.js';

	// Phase 133: a two-input operator — Math (add/sub/mul/div/min/max/mod),
	// Compare (> < = >= <= !=), Gate (AND/OR/NOT/XOR). Inputs come from the a/b
	// handles (wired value/logic nodes); unconnected handles fall back to the
	// manual a/b fields. Output is a number (Math) or boolean (Compare/Gate),
	// shown live on the card.
	// 37 (R6): Math and Gate are VARIADIC — "+ input" grows c..h (up to 8), "−" on a row removes
	// that socket and moves the wires after it down one name (one undo step). The extra sockets
	// have no manual value: wired ones join the fold of a foldable op (add/sub/mul/div/min/max,
	// and/or/xor), unwired ones are skipped. Each socket is a LABELLED ROW, so a handle always sits
	// beside the name it carries however many there are.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	const OPS: Record<string, [string, string][]> = {
		math: [['add', '+'], ['sub', '−'], ['mul', '×'], ['div', '÷'], ['min', 'min'], ['max', 'max'], ['mod', 'mod'], ['pow', 'aᵇ'], ['sin', 'sin'], ['cos', 'cos'], ['abs', '|a|'], ['round', 'round'], ['floor', 'floor'], ['clamp', 'clamp'], ['neg', '−a']],
		compare: [['gt', '>'], ['lt', '<'], ['eq', '='], ['gte', '≥'], ['lte', '≤'], ['neq', '≠']],
		gate: [['and', 'AND'], ['or', 'OR'], ['not', 'NOT'], ['xor', 'XOR']]
	};
	$: ops = OPS[data.type] ?? OPS.math;
	$: isGate = data.type === 'gate';
	$: variadic = isVariadic(data.type);
	$: inputs = variadic ? variadicInputs(data) : ['a', 'b'];
	$: folds = variadic && opFolds(data.type, data.op);
	$: wired = new Set(($flowEdges as any[]).filter((e) => e.target === id).map((e) => e.targetHandle));
	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : typeof live === 'boolean' ? (live ? 'true' : 'false') : (+live).toFixed(2);
	/** is this socket read by the current op? b is unused by NOT; c..h only by a folding op */
	function used(i: number, op: string | undefined, folding: boolean) {
		if (i === 1) return !(isGate && op === 'not');
		return i < 2 || folding;
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>out</span><span class="font-mono">{readout}</span>
		</div>
		<select class="nodrag nopan" value={data.op ?? ops[0][0]} on:change={(e) => setNodeData(id, { op: e.currentTarget.value })}>
			{#each ops as [value, glyph]}
				<option {value}>{glyph}</option>
			{/each}
		</select>
		{#each inputs as key, i (key)}
			<div
				class="relative -mx-3 flex h-6 items-center gap-1 px-3"
				class:opacity-50={!used(i, data.op, folds)}
				data-socket={key}
				title={used(i, data.op, folds) ? '' : 'Not used by this operation'}
			>
				<Socket kind="target" nodeType={data.type} position={Position.Left} id={key} style="top: 50%" />
				<span class="w-3 text-gray-400">{key}</span>
				{#if i < 2 && isGate}
					<input class="nodrag nopan" type="checkbox" checked={!!data[key]} disabled={wired.has(key)}
						on:change={(e) => setNodeData(id, { [key]: e.currentTarget.checked })} />
				{:else if i < 2}
					<DragRow nodrag step={0.01} decimals={2} value={data[key] ?? 0} onchange={(/** @type {number} */ v) => setNodeData(id, { [key]: v })} />
				{:else}
					<span class="flex-1 text-[10px] text-gray-400">{wired.has(key) ? 'wired' : 'unwired — skipped'}</span>
				{/if}
				{#if variadic && inputs.length > MIN_SOCKETS}
					<button class="nodrag nopan variadic-remove ml-auto rounded-sm px-1 leading-none text-gray-400 hover:bg-gray-700 hover:text-gray-100"
						title={'Remove input ' + key} aria-label={'Remove input ' + key}
						on:click={() => removeVariadicSocket(id, i)}>−</button>
				{/if}
			</div>
		{/each}
		{#if variadic && inputs.length < MAX_SOCKETS}
			<button class="nodrag nopan variadic-add rounded-sm bg-gray-700/70 px-2 py-0.5 text-[11px] hover:bg-gray-600"
				title="Add an input socket" on:click={() => addVariadicSocket(id)}>+ input</button>
		{/if}
	</div>
</NodeWrapper>
