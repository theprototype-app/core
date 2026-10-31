<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { activeGraphId, SCENE_GRAPH } from '../../../stores/flowStore';
	import { animatedObjects, clipInfo } from '$lib/animatedImports';

	// 57 M3: Blend by Speed — idle / walk / run by a SPEED, blended (a 1D blend: idle→walk below the
	// walk speed, walk→run below the run speed) and smoothed over `crossfade` seconds, so a
	// character never snaps between poses. Unwired, the speed is the object's own (the Velocity
	// node's reading). Empty clip fields pick the model's clips by name (Idle / Walk / Run).
	// LOCAL on every peer: each one blends from the speed it already sees.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: owner = $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : null;
	$: importedMap = $animatedObjects;
	$: suggestions = owner && importedMap[owner] ? clipInfo(owner).map((c) => c.name) : [];
	const SLOTS = [
		{ key: 'idle', hint: 'Idle' },
		{ key: 'walk', hint: 'Walk' },
		{ key: 'run', hint: 'Run' }
	];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="speed" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<span class="text-[10px] text-text-muted">speed (m/s) — unwired: its own</span>
		{#each SLOTS as slot (slot.key)}
			<label class="flex flex-col">
				<span>{slot.key}</span>
				<input
					class="nodrag nopan"
					list="blendspeed-clips-{id}"
					placeholder={'auto (' + slot.hint + ')'}
					value={data[slot.key] ?? ''}
					on:change={(e) => setNodeData(id, { [slot.key]: e.currentTarget.value.trim() })}
				/>
			</label>
		{/each}
		<datalist id="blendspeed-clips-{id}">
			{#each suggestions as name (name)}
				<option value={name}></option>
			{/each}
		</datalist>
		{#each [{ key: 'walkSpeed', label: 'walk speed', min: 0.2, max: 4, step: 0.1, unit: 'm/s', fallback: 1.4 }, { key: 'runSpeed', label: 'run speed', min: 0.5, max: 10, step: 0.1, unit: 'm/s', fallback: 3.5 }, { key: 'crossfade', label: 'crossfade', min: 0, max: 1, step: 0.05, unit: 's', fallback: 0.25 }] as r (r.key)}
			<label class="flex flex-col">
				<span class="flex justify-between"><span>{r.label}</span><span>{Number(data[r.key] ?? r.fallback).toFixed(2)} {r.unit}</span></span>
				<input
					class="nodrag nopan accent-accent"
					type="range"
					min={r.min}
					max={r.max}
					step={r.step}
					aria-label={r.label}
					value={data[r.key] ?? r.fallback}
					on:input={(e) => setNodeData(id, { [r.key]: +e.currentTarget.value })}
				/>
			</label>
		{/each}
	</div>
</NodeWrapper>
