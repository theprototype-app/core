<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { flowValues } from '../../../stores/flowStore';

	// 21-E6: Move Input — this peer's own WASD as two number outputs. Its own card for
	// the same reason Sequence has one: several SOURCE handles need labelled rows
	// rather than the single right-edge dot the spec-driven AnimationNode draws.
	//
	// The card says LOCAL out loud, because that is the one thing about it a user could
	// otherwise only discover as a bug: every peer reads its OWN keys, so a peer that
	// is not pressing anything reads 0 and always will. Nothing is streamed — a
	// replicated movement axis would be a 60Hz message and would also be WRONG, since
	// two players are meant to move independently.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	const AXES = [
		{ id: 'x', label: 'x  A / D' },
		{ id: 'y', label: 'y  S / W' }
	];
	// the live per-handle value, published into flowValues like every value node
	$: handles = ($flowValues[id] as any)?.__handles ?? {};
	const fmt = (v: any) => (typeof v === 'number' ? (v > 0 ? '+1' : v < 0 ? '-1' : '0') : '0');
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-0.5">
		{#each AXES as axis (axis.id)}
			<div class="relative -mx-3 flex h-6 items-center gap-1 px-3">
				<span class="font-mono text-[10px] text-gray-300">{axis.label}</span>
				<span
					class="ml-auto w-6 shrink-0 text-right font-mono text-[11px]"
					class:text-primary-300={!!handles[axis.id]}
					class:text-gray-400={!handles[axis.id]}
				>
					{fmt(handles[axis.id])}
				</span>
				<Socket kind="source" nodeType={data.type} position={Position.Right} id={axis.id} style="top: 50%;" />
			</div>
		{/each}
		<p class="text-[10px] text-gray-400">your own keys — every peer reads its own</p>
	</div>
</NodeWrapper>
