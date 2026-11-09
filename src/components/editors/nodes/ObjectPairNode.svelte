<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import DragRow from '../../ui/DragRow.svelte';

	// Phase 134: sensors between two object inputs (wire Object Selector nodes to
	// a/b). Distance -> number; Proximity -> boolean when within radius.
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: isProximity = data.type === 'proximity';
	$: live = $flowValues[id];
	$: readout = live === undefined ? '—' : typeof live === 'boolean' ? (live ? 'near' : 'far') : (+live).toFixed(2);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 30px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="b" style="top: 54px" />
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<div class="flex justify-between">
			<span>{isProximity ? 'within' : 'dist'}</span><span class="font-mono">{readout}</span>
		</div>
		<p class="text-[10px] text-text-muted">{isProximity && data.to === 'player' ? 'wire an Object Selector to a' : 'wire two Object Selectors to a/b'}</p>
		{#if isProximity}
			<!-- 78 F10: to: player = b is THIS peer's player (each peer reads its own) -->
			<label class="flex items-center gap-1"><span class="w-12 text-text-muted">to</span>
				<select
					class="nodrag nopan flex-1 text-[10px]"
					data-proximity-to
					aria-label="Measure to"
					value={data.to ?? 'object'}
					on:change={(e) => setNodeData(id, { to: e.currentTarget.value })}
				>
					<option value="object">object b</option>
					<option value="player">my player</option>
				</select></label>
			<label class="flex items-center gap-1"><span class="w-12 text-text-muted">radius</span>
				<DragRow nodrag step={0.01} decimals={2} min={0} value={data.radius ?? 3} onchange={(/** @type {number} */ v) => setNodeData(id, { radius: v })} /></label>
		{/if}
	</div>
</NodeWrapper>
