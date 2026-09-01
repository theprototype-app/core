<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// 21-E4: Sequence — ONE event in, four ordered events out. Its own card because
	// it is the only node in the group with several OUTPUTS, and four source handles
	// need four labelled rows (the ObjectFlowNode pattern) rather than the single
	// right-edge dot the spec-driven AnimationNode draws.
	//
	// The delays are CUMULATIVE, which is why each row reads "wait N, then step k":
	// the runtime adds them up from the input stamp, so step1's default 0 fires
	// immediately and the fields below it are gaps rather than absolute times.
	// Nothing here is scheduled — every step's moment is stamp + offset, derived per
	// peer from the one replicated stamp (see scheduledMoment in flowRuntime).
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	const STEPS = [1, 2, 3, 4];
	// the live per-handle pulse, published into flowValues like every value node
	$: handles = ($flowValues[id] as any)?.__handles ?? {};
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-0.5">
		<div class="relative -mx-3 flex h-5 items-center px-3">
			<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 50%;" />
			<span class="text-[10px] text-gray-300">trigger</span>
		</div>
		{#each STEPS as step (step)}
			<div class="relative -mx-3 flex h-6 items-center gap-1 px-3">
				<span class="w-10 shrink-0 text-[10px] text-gray-400">wait</span>
				<DragRow
					nodrag
					step={0.05}
					decimals={2}
					min={0}
					value={data['delay' + step] ?? 0}
					onchange={(v: number) => setNodeData(id, { ['delay' + step]: v })}
				/>
				<span
					class="w-12 shrink-0 text-right text-[10px]"
					class:text-primary-300={!!handles['step' + step]}
					class:text-gray-300={!handles['step' + step]}
				>
					{handles['step' + step] ? '● ' : ''}step{step}
				</span>
				<Socket kind="source" nodeType={data.type} position={Position.Right} id={`step${step}`} style="top: 50%;" />
			</div>
		{/each}
		<p class="text-[10px] text-gray-400">delays add up from the trigger</p>
	</div>
</NodeWrapper>
