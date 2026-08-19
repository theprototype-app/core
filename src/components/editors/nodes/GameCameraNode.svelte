<script lang="ts">
	// 21-D6 — the card for the nodes that name a CAMERA: `setcamera`, `gamestart` and
	// (L-C) `setlook`. A third case rather than a third component, because the camera
	// picker, the missing-camera handling and the "this is LOCAL per peer" note are the
	// whole card and all three need them.
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
	import { cameraPreview } from '$lib/cameraPreview';

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
	$: isLook = data.type === 'setlook';
	// for setlook an empty camera is MEANINGFUL — it targets the scene look — so the
	// sentinel says so instead of reading as "unset"
	$: noneLabel = isLook ? '— the scene look —' : '— none —';
	// A camera look only composes while its camera is the ACTIVE one. With "look
	// through it too" on, this node makes that true itself; with it off, and nothing
	// looking through that camera, firing the node changes nothing on screen — which is
	// how it was first reported, so the card says so rather than failing silently.
	$: activates = isLook && data.activate !== false && !!chosen;
	$: willBeSilent = isLook && !activates && !!chosen && $cameraPreview?.uuid !== chosen;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	{#if isStart}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="camera" style="top: 34px" />
	{:else}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 34px" />
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="camera" style="top: 72px" />
		{#if isLook}
			<Socket kind="target" nodeType={data.type} position={Position.Left} id="on" style="top: 110px" />
		{/if}
	{/if}
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>camera</span>
			<select
				class="nodrag"
				value={chosen}
				on:change={(e) => setNodeData(id, { camera: e.currentTarget.value })}
			>
				<option value="">{noneLabel}</option>
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
		{:else if isLook}
			<label class="flex flex-col">
				<span>look</span>
				<select
					class="nodrag"
					value={data.on === false ? 'off' : 'on'}
					on:change={(e) => setNodeData(id, { on: e.currentTarget.value === 'on' })}
				>
					<option value="on">on</option>
					<option value="off">off</option>
				</select>
			</label>
			<label class="flex flex-col">
				<span>look through it too</span>
				<select
					class="nodrag"
					value={data.activate === false ? 'no' : 'yes'}
					on:change={(e) => setNodeData(id, { activate: e.currentTarget.value === 'yes' })}
				>
					<option value="yes">yes</option>
					<option value="no">no</option>
				</select>
			</label>
			<span class="gc-note">
				Switches that look for each peer when the trigger fires. It does not edit the saved
				look, so turning it off here never changes what anyone has authored.
			</span>
			{#if willBeSilent}
				<span class="gc-warn">
					Nothing is looking through that camera, so this will not change the picture. Turn
					"look through it too" on, or use a Set Active Camera node.
				</span>
			{/if}
		{:else}
			<span class="gc-note">Moves each peer's own view. Nothing is sent; the trigger already was.</span>
		{/if}
		{#if missing}
			<span class="gc-warn">That camera is not in the scene.</span>
		{/if}
		{#if !isLook}
			<!-- the game-state readout belongs to the two game nodes; a look switch is not
			     tied to the game state at all -->
			<span class="gc-state">state: {$gameState.state}</span>
		{/if}
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
