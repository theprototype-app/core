<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues, flowEdges } from '../../../stores/flowStore';
	import { switcherItems, switcherVType, switcherRadioIndex, switcherHandle, MAX_SWITCHER_ITEMS } from '$lib/variadicNodes.js';
	import { addSwitcherItem } from '$lib/variadicEdit.js';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// 4.4: the items LIST is adjustable node data (edited in the Flow ⓘ tab);
	// the node outputs the selected INDEX (a number source). `shape` is kept in
	// sync for the legacy geometry-swap path on saved graphs.
	// 37 (R6): an N-way MULTIPLEXER too. Each item has an input socket (`in<i>`, typed by the
	// node's `vtype`), the named `value` output carries the SELECTED item's input, and a wired
	// `index` overrides the radio. The unnamed output is still the index, so old wires are unchanged.
	$: options = switcherItems(data);
	$: vtype = switcherVType(data);
	$: selected = switcherRadioIndex(data);
	$: indexWired = ($flowEdges as any[]).some((e) => e.target === id && e.targetHandle === 'index');
	$: live = $flowValues[id];
	$: liveIndex = live && typeof live === 'object' ? live.__default : typeof live === 'number' ? live : selected;
	$: liveValue = live && typeof live === 'object' ? live.__handles?.value : undefined;
	function fmt(v: any) {
		if (v === undefined || v === null) return '—';
		if (typeof v === 'number') return (+v).toFixed(2);
		if (typeof v === 'boolean') return v ? 'true' : 'false';
		if (Array.isArray(v)) return v.map((n) => (+n).toFixed(1)).join(', ');
		return String(v);
	}
	// One-way flow: render from data, write through setNodeData (replicates to peers)
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="nodrag nopan flex w-full flex-col">
		<div class="relative -mx-3 flex h-6 items-center justify-between gap-2 px-3" data-socket="index">
			<Socket kind="target" nodeType={data.type} id="index" position={Position.Left} forceType="number" style="top: 50%" />
			<span class="text-gray-400">index</span>
			<span class="font-mono text-[10px] text-gray-400" title="The selected index (the unnamed output)">{indexWired ? '◈ ' : ''}{liveIndex}</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} forceType="number" style="top: 50%" />
		</div>
		{#each options as option, i}
			<label class="relative -mx-3 flex h-6 items-center px-3" data-socket={switcherHandle(i)}>
				<Socket kind="target" nodeType={data.type} id={switcherHandle(i)} position={Position.Left} forceType={vtype} style="top: 50%" />
				<input
					class="accent-[#ff4000]"
					type="radio"
					name={`shape-${id}`}
					value={option}
					checked={(indexWired ? liveIndex : selected) === i}
					disabled={indexWired}
					on:change={() => setNodeData(id, { index: i, shape: option })}
				/>
				<span class="ml-2">{option}</span>
			</label>
		{/each}
		{#if options.length < MAX_SWITCHER_ITEMS}
			<button class="switcher-add mt-0.5 rounded-sm bg-gray-700/70 px-2 py-0.5 text-[11px] hover:bg-gray-600"
				title="Add an item (and its input socket)" on:click={() => addSwitcherItem(id)}>+ item</button>
		{/if}
		<div class="relative -mx-3 mt-0.5 flex h-6 items-center justify-end gap-2 px-3" data-socket="value">
			<span class="font-mono text-[10px] text-gray-300">{fmt(liveValue)}</span>
			<span class="text-gray-400">value · {vtype}</span>
			<Socket kind="source" nodeType={data.type} id="value" position={Position.Right} forceType={vtype} style="top: 50%" />
		</div>
	</div>
</NodeWrapper>
