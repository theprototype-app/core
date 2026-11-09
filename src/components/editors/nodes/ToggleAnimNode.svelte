<script lang="ts">
	// 78 F3 / F8 — the Toggle Animation card: its inputs, its settings, the POSES it moves
	// between (captured from the object: move it where you want it, press Set) and its outputs.
	// Two poses by default (closed / open); Add pose makes named ones (ajar, half...) that
	// "go to" reaches by name. Everything writes through setNodeData, so it replicates.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { flowEdges, flowNodes, flowValues, activeGraphId, SCENE_GRAPH } from '../../../stores/flowStore';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: spec = findNodeSpec('toggleanim');
	const INPUT_LABELS: Record<string, string> = {
		trigger: 'toggle',
		open: 'open',
		close: 'close',
		goto: 'go to (the pose below)',
		pose: 'pose - a name or number',
		enabled: 'enabled - unwired = on'
	};
	const OUTPUTS = ['isOpen', 'moving', 'pose', 'opened', 'closed'];

	/** the object the node moves: the Object Selector it feeds, else the flow's owner */
	$: target = (() => {
		const sel = ($flowEdges as any[])
			.filter((e) => e.source === id)
			.map((e) => ($flowNodes as any[]).find((n) => n.id === e.target))
			.find((n) => n?.type === 'objectselector');
		const uuid = sel?.data?.selected;
		if (uuid && uuid !== '-None-') return uuid;
		return $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : null;
	})();

	$: poses = Array.isArray(data.poses) && data.poses.length >= 2 ? data.poses : null;
	$: rows = poses ?? [{ name: 'closed' }, { name: 'open' }];
	$: live = $flowValues[id]?.__handles ?? null;

	/** the object's pose right now (local transform) */
	function current() {
		const o: any = target ? ($objectsGroup as any)?.getObjectByProperty?.('uuid', target) : null;
		if (!o) return null;
		const r = (n: number) => +n.toFixed(4);
		return { p: o.position.toArray().map(r), r: [o.rotation.x, o.rotation.y, o.rotation.z].map(r), s: o.scale.toArray().map(r) };
	}
	/** the list to edit: the captured poses, or the defaults built from where the object stands */
	function editable(now: any) {
		if (poses) return poses.map((p: any) => ({ ...p }));
		return [
			{ name: 'closed', ...now },
			{ name: 'open', p: now.p, r: [now.r[0], +(now.r[1] + Math.PI / 2).toFixed(4), now.r[2]], s: now.s }
		];
	}
	function capture(i: number) {
		const now = current();
		if (!now) return;
		const list = editable(now);
		list[i] = { ...list[i], ...now };
		setNodeData(id, { poses: list });
	}
	function rename(i: number, name: string) {
		const now = current();
		if (!now && !poses) return;
		const list = editable(now);
		list[i] = { ...list[i], name: name.trim() || list[i].name };
		setNodeData(id, { poses: list });
	}
	function addPose() {
		const now = current();
		if (!now) return;
		const list = editable(now);
		list.splice(list.length - 1, 0, { name: 'pose ' + list.length, ...now });
		setNodeData(id, { poses: list });
	}
	function removePose(i: number) {
		if (!poses || poses.length <= 2) return;
		setNodeData(id, { poses: poses.filter((_: any, k: number) => k !== i) });
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		{#each spec?.inputs ?? [] as key (key)}
			<div class="relative -mx-3 flex h-5 items-center px-3">
				<Socket kind="target" nodeType={data.type} position={Position.Left} id={key} style="top: 50%;" />
				<span class="max-w-full truncate text-[10px] text-text-2">{INPUT_LABELS[key] ?? key}</span>
			</div>
		{/each}
		{#each spec?.params ?? [] as param (param.key)}
			<label class="flex flex-col">
				<span class="flex justify-between"><span>{param.label ?? param.key}</span>{#if param.kind === 'range'}<span>{data[param.key] ?? spec.defaults[param.key]}</span>{/if}</span>
				{#if param.kind === 'range'}
					<input class="nodrag nopan accent-accent" type="range" min={param.min} max={param.max} step={param.step} value={data[param.key] ?? spec.defaults[param.key]} on:input={(e) => setNodeData(id, { [param.key]: +e.currentTarget.value })} />
				{:else if param.kind === 'select'}
					<select class="nodrag nopan" value={data[param.key] ?? spec.defaults[param.key]} on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}>
						{#each param.options ?? [] as option}<option value={option}>{option}</option>{/each}
					</select>
				{:else}
					<input class="nodrag nopan w-full rounded-sm bg-surface-inset px-1.5 py-0.5 font-mono text-[11px]" type="text" placeholder={param.placeholder ?? ''} maxlength={param.maxLength ?? null} value={data[param.key] ?? ''} on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })} />
				{/if}
			</label>
		{/each}

		<span class="mt-1 text-[10px] text-text-2">Poses {#if !poses}<span class="text-text-muted">(open = a quarter turn until you Set it)</span>{/if}</span>
		{#each rows as row, i (i)}
			<div class="toggle-pose flex items-center gap-1" data-pose={i} class:toggle-pose-now={live && live.pose === i}>
				<input class="nodrag nopan min-w-0 flex-1 rounded-sm bg-surface-inset px-1 py-0.5 text-[11px]" type="text" maxlength="24" value={row.name} aria-label="Pose name" on:change={(e) => rename(i, e.currentTarget.value)} />
				<button class="nodrag nopan toggle-btn" title="Set this pose to where the object stands now" disabled={!target} on:click={() => capture(i)}>Set</button>
				{#if poses && poses.length > 2}
					<button class="nodrag nopan toggle-btn" aria-label="Remove pose" title="Remove this pose" on:click={() => removePose(i)}>×</button>
				{/if}
			</div>
		{/each}
		<button class="nodrag nopan toggle-btn self-start" title="Add a named pose before the last one" disabled={!target} on:click={addPose}>Add pose</button>

		{#each OUTPUTS as key (key)}
			<div class="relative -mx-3 flex h-5 items-center justify-end px-3">
				<span class="text-[10px] text-text-2">{key}{#if live && (key === 'isOpen' || key === 'pose')}<span class="text-text-muted"> · {key === 'isOpen' ? (live.isOpen ? 'open' : 'closed') : live.pose}</span>{/if}</span>
				<Socket kind="source" nodeType={data.type} position={Position.Right} id={key} style="top: 50%;" />
			</div>
		{/each}
		{#if spec?.note}<span class="node-note">{spec.note}</span>{/if}
	</div>
</NodeWrapper>

<style>
	.toggle-btn {
		padding: 0 6px;
		border-radius: 4px;
		font-size: 10px;
		background: var(--surface-inset);
		color: var(--text);
	}
	.toggle-btn:disabled {
		opacity: 0.5;
	}
	.toggle-pose-now input {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.node-note {
		margin-top: 2px;
		font-size: 9px;
		line-height: 1.25;
		color: var(--text-muted);
	}
</style>
