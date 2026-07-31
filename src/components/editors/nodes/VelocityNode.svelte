<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { flowValues } from '../../../stores/flowStore';

	// CL-C C3: live speed (m/s) of the wired object — or the graph owner when
	// unwired inside an object graph. LOCAL feed: exact-ish on the physics
	// initiator (per-step write-back deltas), an ~10Hz move-delta APPROXIMATION
	// on every other peer (broadcast-gated); 0 when nothing moves / no sim.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;
	$: speed = typeof $flowValues[id] === 'number' ? $flowValues[id] : 0;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="target" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<span class="rounded bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px] text-primary-300"
			>{speed.toFixed(2)} m/s</span
		>
		<p class="text-[10px] text-gray-400">object speed; approximate on non-sim peers</p>
	</div>
</NodeWrapper>
