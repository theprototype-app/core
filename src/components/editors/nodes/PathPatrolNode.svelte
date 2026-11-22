<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import Icon from '../../ui/Icon.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { pathCaptureNode, togglePathCapture } from '$lib/pathCapture';
	import { findNodeAnyGraph } from '../../../stores/flowStore';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { pathObjectsIn, patrolStateOf } from '$lib/path/pathRuntime.js';
	import { convertPatrolNode, editPathObject, createPath, toastRefusal } from '$lib/path/pathActions.js';

	// 78 F4: the Path patrol card. Its job is to walk a PATH OBJECT (picked here or wired into
	// `path`): every timing (waits, speeds, eases, jumps, events, the walk mode) lives on the
	// Path, so the card holds only which Path, an offset and whether to face along it. A node
	// saved before 1.64 carries clicked `points` — it keeps walking them exactly as before and
	// offers Convert, which turns them into a Path object (one undo step).
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: capturing = $pathCaptureNode === id;
	$: waypointCount = (data.points ?? []).length;
	$: paths = pathObjectsIn($objectsGroup);
	$: chosen = data.path && data.path !== '-None-' ? paths.find((o: any) => o.uuid === data.path) : null;
	$: legacy = !chosen && waypointCount > 0;
	// F7-ready live state (the runtime's per-walker record; refreshed with the scene poke)
	$: live = chosen ? firstWalkerState($objectsGroup) : null;
	const graphOf = (nodeId: string) => findNodeAnyGraph((n: any) => n.id === nodeId)?.graphId;
	// the group argument is the reactive dependency: the card re-reads on every scene poke
	function firstWalkerState(_group: unknown) {
		return patrolStateOf(id);
	}
	function newPath() {
		const r: any = createPath({});
		if (r.object) setNodeData(id, { path: r.object.uuid }, graphOf(id));
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="path" style="top: 34px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 58px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>path</span>
			<select
				class="nodrag nopan"
				data-testid="patrol-path"
				value={chosen ? chosen.uuid : ''}
				on:change={(e) => setNodeData(id, { path: e.currentTarget.value }, graphOf(id))}
			>
				<option value="">{legacy ? 'clicked waypoints' : '— choose a Path —'}</option>
				{#each paths as p (p.uuid)}
					<option value={p.uuid}>{p.name || 'Path'}</option>
				{/each}
				{#if data.path && !chosen}<option value={data.path}>(missing Path)</option>{/if}
			</select>
		</label>
		{#if chosen}
			<div class="flex gap-1">
				<button
					class="nodrag nopan flex flex-1 items-center justify-center gap-1 rounded bg-surface-active px-1 py-0.5 text-text hover:bg-border-strong"
					on:click={() => editPathObject(chosen.uuid)}><Icon name="spline" size={16} aria-hidden="true" /> Edit path</button
				>
			</div>
			<label class="flex flex-col">
				<span class="flex justify-between"><span>offset (s)</span><span>{data.offset ?? 0}</span></span>
				<input
					class="nodrag nopan accent-accent"
					type="range"
					min="0"
					max="30"
					step="0.5"
					value={data.offset ?? 0}
					on:input={(e) => setNodeData(id, { offset: +e.currentTarget.value }, graphOf(id))}
				/>
			</label>
			<label class="flex items-center gap-1">
				<input
					class="nodrag nopan"
					type="checkbox"
					checked={data.face !== false}
					on:change={(e) => setNodeData(id, { face: e.currentTarget.checked }, graphOf(id))}
				/>
				<span>face along the path</span>
			</label>
			{#if live}
				<span class="text-[10px] text-text-muted" data-testid="patrol-live"
					>{live.kind === 'wait' ? `waiting at ${live.point + 1}` : `walking to ${live.next + 1}`}</span
				>
			{/if}
		{:else if legacy}
			<span class="text-[10px] text-text-muted">
				{waypointCount} clicked waypoint{waypointCount === 1 ? '' : 's'}{#if waypointCount < 2}&nbsp;(need 2+){/if}
			</span>
			<button
				class="nodrag nopan flex items-center justify-center gap-1 rounded bg-accent-fill px-1 py-0.5 text-on-accent"
				data-testid="patrol-convert"
				title="Turn these waypoints into a Path object you can edit (waits, speeds, events) — the walk stays the same"
				disabled={waypointCount < 2}
				on:click={() => toastRefusal(convertPatrolNode(id))}><Icon name="waypoints" size={16} aria-hidden="true" /> Convert to a Path</button
			>
			<div class="flex gap-1">
				<button
					class="nodrag nopan flex-1 rounded px-1 py-0.5 {capturing
						? 'bg-accent-fill text-on-accent'
						: 'bg-surface-active text-text hover:bg-border-strong'}"
					aria-pressed={capturing}
					on:click={() => togglePathCapture(id)}
				>
					{capturing ? 'Placing… (Esc / Done)' : 'Capture clicks'}
				</button>
				<button
					class="nodrag nopan rounded-sm bg-surface-active px-1 py-0.5 text-text hover:bg-border-strong"
					on:click={() => setNodeData(id, { points: [] }, graphOf(id))}
				>
					Clear
				</button>
			</div>
			<label class="flex flex-col">
				<span class="flex justify-between"><span>speed</span><span>{data.speed ?? 1}</span></span>
				<input
					class="nodrag nopan accent-accent"
					type="range"
					min="0.1"
					max="5"
					step="0.1"
					value={data.speed ?? 1}
					on:input={(e) => setNodeData(id, { speed: +e.currentTarget.value }, graphOf(id))}
				/>
			</label>
			<label class="flex flex-col">
				<span>mode</span>
				<select
					class="nodrag nopan"
					value={data.mode ?? 'loop'}
					on:change={(e) => setNodeData(id, { mode: e.currentTarget.value }, graphOf(id))}
				>
					<option value="loop">loop</option>
					<option value="pingpong">ping-pong</option>
				</select>
			</label>
		{:else}
			<button
				class="nodrag nopan flex items-center justify-center gap-1 rounded bg-surface-active px-1 py-0.5 text-text hover:bg-border-strong"
				data-testid="patrol-new-path"
				title="Add a Path object in the scene and walk it"
				on:click={newPath}><Icon name="plus" size={16} aria-hidden="true" /> New Path</button
			>
			<span class="text-[10px] text-text-muted">Pick a Path, wire one into "path", or add one.</span>
		{/if}
	</div>
</NodeWrapper>
