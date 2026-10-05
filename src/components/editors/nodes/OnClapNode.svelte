<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';

	// 31 (Stars Room S3): On Clap — this VR player brought both hands together and held them.
	// The OnHitNode shape: the pulse on the ordinary right-edge dot, `point` and `byMe` as
	// NAMED outputs beside it (the point is a place, so it wires into a Spawn's `position` or
	// an Effect Burst's `at`), and `enabled` as an input so a player setting can switch it.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: live = $flowValues[id] as any;
	$: pulsing = live?.__default === 1;
	$: handles = live?.__handles ?? {};
	$: point = Array.isArray(handles.point) ? handles.point : [0, 0, 0];
	const WHO = ['anyone', 'me'];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<Socket kind="target" nodeType={data.type} position={Position.Left} id="enabled" style="top: 50%;" />
			<span class="text-[10px] text-gray-300">enabled</span>
		</div>
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {pulsing ? '#22c55e' : '#374151'}"></span>
			<span>{pulsing ? 'clap!' : 'idle'}</span>
		</div>
		<label class="flex items-center gap-1">
			<span class="w-14 shrink-0 text-[10px] text-gray-400">who</span>
			<select
				class="nodrag nopan flex-1 rounded bg-gray-700 px-1 text-[11px]"
				value={data.who ?? 'anyone'}
				on:change={(e) => setNodeData(id, { who: e.currentTarget.value })}
			>
				{#each WHO as opt (opt)}<option value={opt}>{opt}</option>{/each}
			</select>
		</label>
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<span class="text-[10px] text-gray-300">point</span>
			<span class="ml-auto font-mono text-[10px] text-gray-400">{point.map((v: number) => (+v).toFixed(1)).join(', ')}</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} id="point" forceType="vector3" style="top: 50%;" />
		</div>
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<span class="text-[10px] text-gray-300">by me</span>
			<span class="ml-auto font-mono text-[10px]" class:text-primary-300={!!handles.byMe} class:text-gray-400={!handles.byMe}>
				{handles.byMe ? 'yes' : 'no'}
			</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} id="byMe" forceType="boolean" style="top: 50%;" />
		</div>
		<p class="text-[10px] text-gray-400">VR: bring both hands together and hold — the point is where they met</p>
	</div>
</NodeWrapper>
