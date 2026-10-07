<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// 24-A A2: On Hit — a hand (VR controller) or a walking player KNOCKED the connected
	// body (A1's probe). The pulse sits on the ordinary right-edge dot so it wires like On
	// Click (into an Object Selector, a Counter, a trigger input); `speed` and `byMe`
	// are NAMED value outputs beside it, which is why this is its own card rather than
	// the spec-driven AnimationNode's single dot (the Sequence / Move Input rule).
	//
	// The stamp comes from the hit message's own `at` on EVERY peer — one message per
	// knock, no nodetrigger — so `who` is the one thing read differently per peer:
	// `me` pulses only where the hitting hand was, which is how a per-player count reaches
	// a Set Variable with scope: player without a second writer.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: live = $flowValues[id] as any;
	$: pulsing = live?.__default === 1;
	$: handles = live?.__handles ?? {};
	const WHO = ['anyone', 'me', 'others'];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {pulsing ? 'var(--ink-good)' : 'var(--control-off)'}"></span>
			<span>{pulsing ? 'hit!' : 'idle'}</span>
		</div>
		<div class="flex items-center gap-1">
			<span class="w-14 shrink-0 text-[10px] text-text-muted">min m/s</span>
			<DragRow
				nodrag
				step={0.1}
				decimals={1}
				min={0}
				max={10}
				value={data.minSpeed ?? 0}
				onchange={(v: number) => setNodeData(id, { minSpeed: v })}
			/>
		</div>
		<label class="flex items-center gap-1">
			<span class="w-14 shrink-0 text-[10px] text-text-muted">who</span>
			<select
				class="nodrag nopan flex-1 rounded bg-surface-inset px-1 text-[11px]"
				value={data.who ?? 'anyone'}
				on:change={(e) => setNodeData(id, { who: e.currentTarget.value })}
			>
				{#each WHO as opt (opt)}<option value={opt}>{opt}</option>{/each}
			</select>
		</label>
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<span class="text-[10px] text-text-2">speed</span>
			<span class="ml-auto font-mono text-[10px] text-text-muted">{(+(handles.speed ?? 0)).toFixed(2)}</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} id="speed" forceType="number" style="top: 50%;" />
		</div>
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<span class="text-[10px] text-text-2">by me</span>
			<span class="ml-auto font-mono text-[10px]" class:text-accent-text={!!handles.byMe} class:text-text-muted={!handles.byMe}>
				{handles.byMe ? 'yes' : 'no'}
			</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} id="byMe" forceType="boolean" style="top: 50%;" />
		</div>
		<p class="text-[10px] text-text-muted">connect to the object; pulses when a hand or player knocks it</p>
	</div>
</NodeWrapper>
