<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowValues } from '../../../stores/flowStore';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { pathObjectsIn } from '$lib/path/pathRuntime.js';

	// 78 F4: On Path Event — pulses when a walker on a Path arrives at a point carrying an event
	// name. Blank path = any Path, blank event = any event. The event list offers the names the
	// chosen Path's points carry (any name can still be typed).
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: paths = ($objectsGroup, pathObjectsIn($objectsGroup));
	$: chosen = data.path ? paths.find((o: any) => o.uuid === data.path) : null;
	$: names = [
		...new Set(
			(chosen ? [chosen] : paths).flatMap((o: any) =>
				(o.userData?.spline?.points ?? []).map((p: any) => p.event).filter(Boolean)
			)
		)
	];
	$: pulsing = $flowValues[id] === 1;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>path</span>
			<select
				class="nodrag nopan"
				data-testid="path-event-path"
				value={chosen ? chosen.uuid : ''}
				on:change={(e) => setNodeData(id, { path: e.currentTarget.value })}
			>
				<option value="">any path</option>
				{#each paths as p (p.uuid)}
					<option value={p.uuid}>{p.name || 'Path'}</option>
				{/each}
				{#if data.path && !chosen}<option value={data.path}>(missing Path)</option>{/if}
			</select>
		</label>
		<label class="flex flex-col">
			<span>event</span>
			<input
				class="nodrag nopan"
				data-testid="path-event-name"
				list={'path-events-' + id}
				placeholder="any event"
				value={data.event ?? ''}
				on:change={(e) => setNodeData(id, { event: e.currentTarget.value.trim() })}
			/>
			<datalist id={'path-events-' + id}>
				{#each names as n (n)}<option value={n}></option>{/each}
			</datalist>
		</label>
		<span class="flex items-center gap-1 text-[10px] text-text-muted">
			<span
				class="h-2 w-2 rounded-full"
				style="background: {pulsing ? 'var(--ink-good)' : 'var(--control-off)'}"
			></span>
			{pulsing ? 'arrived' : 'listening'}
		</span>
	</div>
</NodeWrapper>
