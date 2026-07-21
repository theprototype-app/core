<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

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
	<button
		class="nodrag w-full rounded border border-gray-600 px-1 py-0.5 text-xs {capturing ? 'bg-primary-700 text-white' : ''}"
		on:click={() => (capturing = true)}
		on:keydown={capturing ? onCaptureKey : undefined}
		on:blur={() => (capturing = false)}
	>
		{capturing ? 'press a key…' : data.code ?? 'KeyR'}
	</button>
	<label class="flex w-full flex-col">
		<span>pulse (s)</span>
		<input
			class="nodrag"
			type="number"
			min="0.1"
			step="0.1"
			value={data.pulse ?? 0.3}
			on:change={(e) => setNodeData(id, { pulse: +e.currentTarget.value })}
		/>
	</label>
</NodeWrapper>
