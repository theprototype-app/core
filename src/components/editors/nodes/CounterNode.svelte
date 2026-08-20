<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 134: counts pulses from a wired trigger (On Click). up / down / reset
	// per pulse; outputs the running count. State rides the shared trigger log,
	// so both peers' counts agree.
	// 21-E4: a second EVENT input zeroes it, which is what a round-2 score needs -
	// the `op` select stays for a counter with nothing wired into reset.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: count = $flowValues[id] ?? 0;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="pulse" style="top: 30px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="reset" style="top: 54px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>count</span><span class="font-mono text-sm">{count}</span>
		</div>
		<select class="nodrag" value={data.op ?? 'up'} on:change={(e) => setNodeData(id, { op: e.currentTarget.value })}>
			<option value="up">count up</option>
			<option value="down">count down</option>
			<option value="reset">reset to 0</option>
		</select>
		<p class="text-[10px] text-gray-400">wire an event into pulse; the second input resets to 0</p>
	</div>
</NodeWrapper>
