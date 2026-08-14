<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { activeGraphId, SCENE_GRAPH, flowValues } from '../../../stores/flowStore';
	import { animations, playback, clipList } from '$lib/animationPreview';

	// 17-E F3: reads an object's animation transport as a NUMBER — the readable half
	// of Animation Finished. Unwired inside an object graph it reports the graph's
	// owner (the implicit-owner rule), so the common case is a card with nothing
	// filled in.
	//
	// `progress` runs 0..1 through the A/B window, which is what the transport
	// actually loops over, so a clip playing a trimmed range still reads 0..1.
	// Nothing here replicates: the transport does (a synced-clock stamp), so every
	// peer reads the same number from the same data.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// clip suggestions come from the object whose graph is open — an object graph's
	// id IS its owner uuid. It stays a TEXT field so a node wired to an Object
	// Selector, or authored in the scene graph, can still name a clip this editor
	// cannot enumerate (the PlayAnimNode precedent).
	$: owner = $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : null;
	$: authoredMap = $animations;
	$: suggestions = owner && authoredMap[owner] ? clipList(owner).map((c) => c.name) : [];
	$: read = data.read ?? 'progress';
	$: value = typeof $flowValues[id] === 'number' ? $flowValues[id] : 0;
	$: running = !!(owner && $playback[owner]?.playing);
	// progress and playing are unitless; the rest are clip seconds
	$: shown = read === 'playing' ? (value ? 'yes' : 'no') : read === 'progress' ? value.toFixed(3) : value.toFixed(2) + 's';
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="target" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>clip</span>
			<input
				class="nodrag"
				list="animstate-clips-{id}"
				placeholder="any clip"
				value={data.clip ?? ''}
				on:change={(e) => setNodeData(id, { clip: e.currentTarget.value.trim() })}
			/>
			<datalist id="animstate-clips-{id}">
				{#each suggestions as name (name)}
					<option value={name}></option>
				{/each}
			</datalist>
		</label>
		<label class="flex flex-col">
			<span>read</span>
			<select
				class="nodrag"
				value={read}
				on:change={(e) => setNodeData(id, { read: e.currentTarget.value })}
			>
				<option value="progress">progress (0-1)</option>
				<option value="playing">playing (1/0)</option>
				<option value="position">position (s)</option>
				<option value="duration">duration (s)</option>
				<option value="remaining">remaining (s)</option>
			</select>
		</label>
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {running ? '#22c55e' : '#374151'}"></span>
			<span class="rounded-sm bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px] text-primary-300"
				>{shown}</span
			>
		</div>
	</div>
</NodeWrapper>
