<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// B4.6: Map Range — remap `a` from [inMin..inMax] to [outMin..outMax], with an
	// optional clamp. The missing glue between free-range sources (time, distance,
	// counter) and bounded effect params.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : (+live).toFixed(2);
	const FIELDS: [string, string][] = [['inMin', 'in min'], ['inMax', 'in max'], ['outMin', 'out min'], ['outMax', 'out max']];
	const DEFAULTS: Record<string, number> = { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 30px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between"><span>out</span><span class="font-mono">{readout}</span></div>
		{#each FIELDS as [key, label]}
			<label class="flex items-center gap-1">
				<span class="w-12 text-gray-400">{label}</span>
				<DragRow nodrag step={0.01} decimals={2} value={data[key] ?? DEFAULTS[key]} onchange={(/** @type {number} */ v) => setNodeData(id, { [key]: v })} />
			</label>
		{/each}
		<label class="flex items-center gap-1">
			<input class="nodrag" type="checkbox" checked={data.clamp ?? true}
				on:change={(e) => setNodeData(id, { clamp: e.currentTarget.checked })} /> clamp
		</label>
	</div>
</NodeWrapper>
