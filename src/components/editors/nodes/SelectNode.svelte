<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// B4.6: Select — outputs `a` when index < 0.5, else `b`. Pairs with the
	// switcher (which outputs an index) and compare/gate booleans; the only other
	// way to CHOOSE between two wired values was a script node.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : typeof live === 'boolean' ? String(live) : (+live).toFixed(2);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="index" style="top: 30px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 54px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="b" style="top: 78px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between"><span>out</span><span class="font-mono">{readout}</span></div>
		{#each [['index', 'idx'], ['a', 'a'], ['b', 'b']] as [key, label]}
			<label class="flex items-center gap-1">
				<span class="w-6 text-gray-400">{label}</span>
				<DragRow nodrag step={0.01} decimals={2} value={data[key] ?? 0} onchange={(/** @type {number} */ v) => setNodeData(id, { [key]: v })} />
			</label>
		{/each}
	</div>
</NodeWrapper>
