<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import DragRow from '../../ui/DragRow.svelte';

	// H3: keyboard trigger node. Click "capture", press a key — the node fires a
	// replicated pulse whenever anyone presses that key (held keys keep it high).
	// The event.code (e.g. KeyR, Digit1, Space) replicates like any node data.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	let capturing = false;
	function onCaptureKey(e: KeyboardEvent) {
		e.preventDefault();
		e.stopPropagation();
		capturing = false;
		setNodeData(id, { code: e.code });
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- one column (the wrapper slot is a flex ROW) -->
	<div class="flex w-full flex-col gap-1">
		<button
			class="nodrag w-full rounded-sm border border-gray-600 px-1 py-0.5 text-xs {capturing ? 'bg-primary-700 text-white' : ''}"
			on:click={() => (capturing = true)}
			on:keydown={capturing ? onCaptureKey : undefined}
			on:blur={() => (capturing = false)}
		>
			{capturing ? 'press a key…' : data.code ?? 'KeyR'}
		</button>
		<label class="flex w-full flex-col">
			<span class="text-gray-400">edge</span>
			<!-- 21-E3: down = the original pulse (held keys keep it high); up = the falling
			     edge, the other half of hold-to-show; held = the same read, said as a level -->
			<select
				class="nodrag rounded-sm border border-gray-600 bg-transparent px-1 py-0.5 text-xs"
				value={data.edge ?? 'down'}
				on:change={(e) => setNodeData(id, { edge: e.currentTarget.value })}
			>
				{#each ['down', 'up', 'held'] as opt (opt)}<option value={opt}>{opt}</option>{/each}
			</select>
		</label>
		<label class="flex w-full flex-col">
			<span class="text-gray-400">pulse (s)</span>
			<DragRow nodrag step={0.01} decimals={2} min={0.1} value={data.pulse ?? 0.3} onchange={(/** @type {number} */ v) => setNodeData(id, { pulse: v })} />
		</label>
	</div>
</NodeWrapper>
