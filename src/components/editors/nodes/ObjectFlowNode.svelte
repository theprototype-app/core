<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowGraphs, SCENE_GRAPH } from '../../../stores/flowStore';
	import { objectsGroup } from '../../../stores/sceneStore';

	// H5: an object flow EMBEDDED in the scene graph. Sockets come from the flow's
	// declared Flow Input / Flow Output interface nodes — inputs on the left feed
	// the flow's Flow Inputs, its Flow Output values surface on the right (one
	// frame of latency). Pick a target object below; only objects that HAVE a
	// flow are listed.
	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: candidates = Object.keys($flowGraphs)
		.filter((g) => g !== SCENE_GRAPH)
		.map((uuid) => {
			const object = ($objectsGroup as any)?.getObjectByProperty?.('uuid', uuid);
			return { uuid, name: object?.name || object?.type || uuid.slice(0, 8) };
		});

	// declared interface of the picked flow (names deduped, first declaration wins)
	$: iface = (() => {
		const graph = $flowGraphs[data.flowUuid];
		const inputs: { name: string; vtype: string }[] = [];
		const outputs: { name: string }[] = [];
		if (graph) {
			const seenIn = new Set();
			const seenOut = new Set();
			for (const n of graph.nodes as any[]) {
				if (n.type === 'flowinput') {
					const name = n.data?.name ?? 'value';
					if (!seenIn.has(name)) { seenIn.add(name); inputs.push({ name, vtype: n.data?.vtype ?? 'number' }); }
				} else if (n.type === 'flowoutput') {
					const name = n.data?.name ?? 'out';
					if (!seenOut.has(name)) { seenOut.add(name); outputs.push({ name }); }
				}
			}
		}
		return { inputs, outputs };
	})();

	// stacked socket offsets: header ~30px + picker ~40px, then 22px per row
	const ROW0 = 74;
	const ROW = 22;
</script>

<NodeWrapper type="objectselector" label={data.label ?? 'Object Flow'}>
	<label class="flex w-full flex-col">
		<span>object</span>
		<select
			class="nodrag"
			value={data.flowUuid ?? ''}
			on:change={(e) => setNodeData(id, { flowUuid: e.currentTarget.value })}
		>
			<option value="">— pick a flow —</option>
			{#each candidates as c (c.uuid)}
				<option value={c.uuid}>{c.name}</option>
			{/each}
		</select>
	</label>
	{#each iface.inputs as socket, i (socket.name)}
		<Socket kind="target" nodeType="objectflow" id={socket.name} position={Position.Left} top={ROW0 + i * ROW} forceType={socket.vtype} />
	{/each}
	{#each iface.outputs as socket, i (socket.name)}
		<Socket kind="source" nodeType="objectflow" id={socket.name} position={Position.Right} top={ROW0 + i * ROW} forceType="number" />
	{/each}
	<div class="flex w-full flex-col gap-0.5 text-[10px]">
		{#each iface.inputs as socket (socket.name)}
			<div class="text-left">▸ {socket.name}</div>
		{/each}
		{#each iface.outputs as socket (socket.name)}
			<div class="text-right">{socket.name} ▸</div>
		{/each}
		{#if data.flowUuid && !iface.inputs.length && !iface.outputs.length}
			<div class="text-center opacity-60">no Flow Input/Output declared</div>
		{/if}
	</div>
</NodeWrapper>
