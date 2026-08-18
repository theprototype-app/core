<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// Phase 134: a delay line — passes its wired input re-evaluated at a
	// clock-shifted time (deterministic phase delay). Wire a Time/Loop into 'a'.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: live = $flowValues[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 30px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>delayed</span><span class="font-mono">{typeof live === 'number' ? live.toFixed(2) : '—'}</span>
		</div>
		<label class="flex items-center gap-1"><span class="w-12 text-gray-400">delay</span>
			<DragRow nodrag step={0.01} decimals={2} min={0} value={data.delay ?? 1} onchange={(/** @type {number} */ v) => setNodeData(id, { delay: v })} />
			<span class="text-gray-400">s</span></label>
	</div>
</NodeWrapper>
