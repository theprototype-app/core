<script lang="ts">
	// 21-D6 — the card for `setcamera` and `gamestart`, the two nodes that name a CAMERA.
	//
	// A camera is picked from the scene's camera MARKERS, so this is a real list rather than
	// a typed uuid — but it stays a `<select>` with an explicit "— none —" sentinel (the
	// ObjectSelectorNode shape) so clearing it is possible, and a node whose camera has been
	// deleted says so instead of looking empty.
	//
	// What the card has to explain, because it is the thing that gets reported as a bug:
	// activating a camera is LOCAL on every peer. The trigger replicated, so everyone runs
	// this node and everyone's view moves — but no message ever says "look here", which is
	// the house rule (a peer's graph must never seize another peer's viewpoint).
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { listCameraObjects } from '$lib/cameraObjects';
	import { gameState } from '$lib/gameState';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// $objectsGroup is the dependency: THREE trees are not reactive, so the poke after a
	// create is the only signal a camera list gets.
	const camerasOf = (_group: any) => listCameraObjects();
	$: cameras = camerasOf($objectsGroup);
	$: chosen = String(data.camera ?? '');
	$: missing = !!chosen && !cameras.some((c: any) => c.uuid === chosen);
	$: isStart = data.type === 'gamestart';
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	{#if isStart}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="camera" style="top: 34px" />
	{:else}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 34px" />
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="camera" style="top: 72px" />
	{/if}
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>camera</span>
			<select
				class="nodrag"
				value={chosen}
				on:change={(e) => setNodeData(id, { camera: e.currentTarget.value })}
			>
				<option value="">— none —</option>
				{#each cameras as cam (cam.uuid)}
					<option value={cam.uuid}>{cam.name || 'Camera'}</option>
				{/each}
				{#if missing}
					<!-- keep the authored value selectable, so opening this card cannot silently
					     rewrite a graph whose camera is merely not loaded yet -->
					<option value={chosen}>(missing camera)</option>
				{/if}
			</select>
		</label>
		{#if isStart}
			<label class="flex flex-col">
				<span>when state is</span>
				<select
					class="nodrag"
					value={data.state ?? 'playing'}
					on:change={(e) => setNodeData(id, { state: e.currentTarget.value })}
				>
					{#each ['menu', 'playing', 'paused', 'over'] as s (s)}<option value={s}>{s}</option>{/each}
				</select>
			</label>
			<span class="gc-note">
				Every peer looks here when the game reaches this state — including someone who
				joins later.
			</span>
		{:else}
			<span class="gc-note">Moves each peer's own view. Nothing is sent; the trigger already was.</span>
		{/if}
		{#if missing}
			<span class="gc-warn">That camera is not in the scene.</span>
		{/if}
		<span class="gc-state">state: {$gameState.state}</span>
	</div>
</NodeWrapper>

<style>
	.gc-note {
		font-size: 10px;
		line-height: 1.3;
		opacity: 0.62;
	}
	.gc-warn {
		font-size: 10px;
		color: #fbbf24;
	}
	.gc-state {
		margin-top: 2px;
		border-radius: 2px;
		background: rgb(17 24 39 / 0.7);
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 10px;
		color: #6ee7b7;
	}
</style>
