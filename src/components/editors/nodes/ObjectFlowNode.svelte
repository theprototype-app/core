<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { flowGraphs, SCENE_GRAPH } from '../../../stores/flowStore';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { selectObject } from '$lib/objectActions';

	// H5: an object flow EMBEDDED in the scene graph. Sockets come from the flow's
	// declared Flow Input / Flow Output interface nodes — one labeled ROW per
	// socket (the card stretches with the interface), with the handle anchored to
	// its row. DOUBLE-CLICK the card to open the object's flow (selects the object;
	// the editor scope follows the selection). Only objects that HAVE a flow are
	// listed in the picker.
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

	function openFlow() {
		// selecting the owner flips the editor scope to its flow (H1 rule)
		if (data.flowUuid) selectObject(data.flowUuid);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div on:dblclick|stopPropagation={openFlow} title="Double-click to open this object's flow">
	<NodeWrapper type="objectselector" label={data.label ?? 'Object Flow'}>
		<div class="flex w-full flex-col gap-0.5">
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
			<!-- one labeled row per declared socket; the row is the handle's
			     positioned ancestor and spans the full card (-mx cancels the
			     wrapper padding), so handles sit ON the card edge, centered on
			     their label — and the card stretches with the interface -->
			{#each iface.inputs as socket (socket.name)}
				<div class="relative -mx-3 flex h-5 items-center px-3">
					<Socket kind="target" nodeType="objectflow" id={socket.name} position={Position.Left} forceType={socket.vtype} style="top: 50%;" />
					<span class="max-w-full truncate text-[10px] text-gray-300">{socket.name}</span>
				</div>
			{/each}
			{#each iface.outputs as socket (socket.name)}
				<div class="relative -mx-3 flex h-5 items-center justify-end px-3">
					<span class="max-w-full truncate text-[10px] text-gray-300">{socket.name}</span>
					<Socket kind="source" nodeType="objectflow" id={socket.name} position={Position.Right} forceType="number" style="top: 50%;" />
				</div>
			{/each}
			{#if data.flowUuid && !iface.inputs.length && !iface.outputs.length}
				<div class="text-center text-[10px] opacity-60">no Flow Input/Output declared</div>
			{/if}
			{#if data.flowUuid}
				<div class="text-center text-[9px] text-gray-500">double-click to open</div>
			{/if}
		</div>
	</NodeWrapper>
</div>
