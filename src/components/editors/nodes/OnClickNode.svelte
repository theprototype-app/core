<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { flowValues } from '../../../stores/flowStore';

	// Phase 134: pulses (1 for a short window) when its connected object is
	// clicked. The click replicates as one small trigger message with a shared
	// timestamp, so every peer's downstream math agrees. Connect to an Object
	// Selector (which object) and/or a Counter (count the clicks).
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: pulsing = $flowValues[id] === 1;
	// CL-C: the same pulse card serves the sensor overlap triggers
	const COPY: Record<string, [string, string]> = {
		onclick: ['clicked!', 'connect to the object; pulses on click'],
		onenter: ['entered!', 'pulses when something enters the sensor object'],
		onexit: ['exited!', 'pulses when a sensor overlap ends'],
		animfinished: ['finished!', 'pulses when the clip on this object reaches its end']
	};
	$: copy = COPY[data.type] ?? COPY.onclick;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {pulsing ? '#22c55e' : '#374151'}"></span>
			<span>{pulsing ? copy[0] : 'idle'}</span>
		</div>
		<p class="text-[10px] text-gray-400">{copy[1]}</p>
	</div>
</NodeWrapper>
