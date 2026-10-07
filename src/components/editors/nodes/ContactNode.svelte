<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import { objectsGroup } from '../../../stores/sceneStore';

	// 36 X6: On Impact / On Enter / On Exit — the OnClapNode shape. The pulse stays on the
	// ordinary right-edge dot (so existing wiring into an Object Selector / Counter is
	// untouched); a `filter` OBJECT input makes it fire only when the other body is that
	// object, and the `other` output carries the body it touched (wire it into Look At,
	// Distance …). Initiator-detected; the other body rides the replicated stamp.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: live = $flowValues[id] as any;
	$: pulsing = (live && typeof live === 'object' ? live.__default : live) === 1;
	$: other = live && typeof live === 'object' ? live.__handles?.other ?? '' : '';
	$: otherName = other ? ($objectsGroup as any)?.getObjectByProperty?.('uuid', other)?.name ?? other.slice(0, 8) : '—';
	$: impact = data.type === 'onimpact';
	$: verb = impact ? 'impact!' : data.type === 'onexit' ? 'left' : 'entered';
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<Socket kind="target" nodeType={data.type} position={Position.Left} id="filter" style="top: 50%;" />
			<span class="text-[10px] text-text-2">only with</span>
		</div>
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {pulsing ? 'var(--ink-good)' : 'var(--control-off)'}"></span>
			<span>{pulsing ? verb : 'idle'}</span>
		</div>
		{#if impact}
			<label class="flex items-center gap-1">
				<span class="w-14 shrink-0 text-[10px] text-text-muted">min m/s</span>
				<input
					class="nodrag nopan flex-1"
					type="range"
					min="0"
					max="10"
					step="0.1"
					value={data.minStrength ?? 1}
					on:change={(e) => setNodeData(id, { minStrength: +e.currentTarget.value })}
				/>
				<span class="w-6 text-right font-mono text-[10px] text-text-muted">{(+(data.minStrength ?? 1)).toFixed(1)}</span>
			</label>
		{/if}
		<div class="relative -mx-3 flex h-5 items-center gap-1 px-3">
			<span class="text-[10px] text-text-2">other</span>
			<span class="ml-auto max-w-[80px] truncate font-mono text-[10px] text-text-muted">{otherName}</span>
			<Socket kind="source" nodeType={data.type} position={Position.Right} id="other" forceType="object" style="top: 50%;" />
		</div>
	</div>
</NodeWrapper>
