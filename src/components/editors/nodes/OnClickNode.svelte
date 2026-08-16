<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { flowValues, activeGraphId, SCENE_GRAPH } from '../../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { animations, markersOf } from '$lib/animationPreview';

	// Phase 134: pulses (1 for a short window) when its connected object is
	// clicked. The click replicates as one small trigger message with a shared
	// timestamp, so every peer's downstream math agrees. Connect to an Object
	// Selector (which object) and/or a Counter (count the clicks).
	type $$Props = NodeProps;
	export let id: string;
	export let data;
	$: pulsing = $flowValues[id] === 1;
	// CL-C: the same pulse card serves the sensor overlap triggers
	const COPY: Record<string, [string, string]> = {
		onclick: ['clicked!', 'connect to the object; pulses on click'],
		onenter: ['entered!', 'pulses when something enters the sensor object'],
		onexit: ['exited!', 'pulses when a sensor overlap ends'],
		animfinished: ['finished!', 'pulses when the clip on this object reaches its end'],
		// 17-E F5: the same pulse card, plus a marker NAME to watch for
		animmarker: ['marker!', 'pulses as the playhead crosses a marker; blank = any']
	};
	$: copy = COPY[data.type] ?? COPY.onclick;
	// F5: suggest the marker names the object whose graph is open actually has — an
	// object graph's id IS its owner uuid (the PlayAnimNode precedent). It stays a
	// TEXT field so a node wired to an Object Selector, or authored in the scene
	// graph, can still name a marker this editor cannot enumerate.
	$: owner = $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : null;
	$: markerMap = $animations;
	$: markerNames = owner && markerMap[owner] ? [...new Set(markersOf(owner).map((m) => m.name))] : [];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#if data.type === 'animmarker'}
			<label class="flex flex-col">
				<span>marker</span>
				<input
					class="nodrag"
					list="animmarker-names-{id}"
					placeholder="any marker"
					value={data.name ?? ''}
					on:change={(e) => setNodeData(id, { name: e.currentTarget.value.trim() })}
				/>
				<datalist id="animmarker-names-{id}">
					{#each markerNames as name (name)}
						<option value={name}></option>
					{/each}
				</datalist>
			</label>
		{/if}
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {pulsing ? '#22c55e' : '#374151'}"></span>
			<span>{pulsing ? copy[0] : 'idle'}</span>
		</div>
		<p class="text-[10px] text-gray-400">{copy[1]}</p>
	</div>
</NodeWrapper>
