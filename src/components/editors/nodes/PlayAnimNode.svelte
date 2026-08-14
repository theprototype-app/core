<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { activeGraphId, SCENE_GRAPH } from '../../../stores/flowStore';
	import { animations, playback, clipList } from '$lib/animationPreview';
	import { animatedObjects, clipInfo } from '$lib/animatedImports';

	// 17-E A5: starts / stops an animation when an event fires. Wire On Click (or
	// Key Press, On Enter…) into `trigger` and the door this node lives on opens
	// when someone clicks it. The clip name is optional: empty means the object's
	// DEFAULT clip, so the common case is one node with nothing to fill in.
	//
	// Both animation systems are reachable through the same field — an authored
	// clip is played from its keys, a name the model was IMPORTED with is handed
	// to the mixer instead.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// Suggestions come from the object whose graph is open (an object graph's id IS
	// its owner uuid), which is where these nodes are normally authored. It stays a
	// TEXT field so a node wired to an Object Selector, or authored in the scene
	// graph, can still name a clip this editor cannot enumerate.
	$: owner = $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : null;
	// the store reads are the reactive dependencies; clipList/clipInfo then do the
	// normalization (a v1 save migrates on read) and the mixer lookup
	$: authoredMap = $animations;
	$: importedMap = $animatedObjects;
	$: suggestions = owner
		? [
				...(authoredMap[owner] ? clipList(owner).map((c) => c.name) : []),
				...(importedMap[owner] ? clipInfo(owner).map((c) => c.name) : [])
			]
		: [];
	$: running = !!(owner && $playback[owner]?.playing);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>clip</span>
			<input
				class="nodrag"
				list="playanim-clips-{id}"
				placeholder="default clip"
				value={data.clip ?? ''}
				on:change={(e) => setNodeData(id, { clip: e.currentTarget.value.trim() })}
			/>
			<datalist id="playanim-clips-{id}">
				{#each suggestions as name (name)}
					<option value={name}></option>
				{/each}
			</datalist>
		</label>
		<label class="flex flex-col">
			<span>on trigger</span>
			<select
				class="nodrag"
				value={data.action ?? 'toggle'}
				on:change={(e) => setNodeData(id, { action: e.currentTarget.value })}
			>
				<option value="toggle">toggle</option>
				<option value="play">play</option>
				<option value="stop">stop</option>
				<option value="restart">restart</option>
			</select>
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>speed</span><span>{(data.speed ?? 1).toFixed(1)}×</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="0.1"
				max="4"
				step="0.1"
				value={data.speed ?? 1}
				on:input={(e) => setNodeData(id, { speed: +e.currentTarget.value })}
			/>
		</label>
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full" style="background: {running ? '#22c55e' : '#374151'}"></span>
			<span class="text-[10px] text-gray-400">{running ? 'playing' : 'idle'}</span>
		</div>
	</div>
</NodeWrapper>
