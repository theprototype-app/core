<script lang="ts">
	// 36 U11 / N1: a COLLAPSED group. Its sockets are the wires that cross the group's
	// boundary (nodeGroups.computeGroupIO), each handle named after the INNER endpoint it
	// stands for, so a wire drawn onto one becomes a real wire to the real socket inside.
	// Double-click (or Tab) opens it; the properties panel renames it and its sockets.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { runNodeAction } from '$lib/nodeEditorActions';
	import { ioHandle } from '$lib/nodeGroups';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: inputs = (data?.inputs ?? []) as any[];
	$: outputs = (data?.outputs ?? []) as any[];
	$: rows = Math.max(inputs.length, outputs.length);
	$: count = (data?.children ?? []).length;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="tp-group-node"
	on:dblclick|stopPropagation={() => runNodeAction('enterGroup', id)}
	title="Group — double-click or Tab to open it"
>
	<NodeWrapper type="group" label={'⧉ ' + (data?.label ?? 'Group')} accent="var(--accent, #60a5fa)">
		<div class="flex w-full flex-col gap-0.5">
			<span class="text-[10px] text-gray-400">{count} node{count === 1 ? '' : 's'} inside</span>
			{#each Array(rows) as _, i (i)}
				<div class="relative -mx-3 flex h-5 items-center justify-between gap-2 px-3">
					{#if inputs[i]}
						<span class="group-socket-name truncate" title={inputs[i].name}>{inputs[i].name}</span>
						<Socket
							kind="target"
							nodeType="group"
							id={ioHandle('i', inputs[i].to?.[0], inputs[i].to?.[1])}
							position={Position.Left}
							forceType={inputs[i].type ?? 'any'}
							style="top: 50%;"
						/>
					{:else}<span></span>{/if}
					{#if outputs[i]}
						<span class="group-socket-name truncate text-right" title={outputs[i].name}>{outputs[i].name}</span>
						<Socket
							kind="source"
							nodeType="group"
							id={ioHandle('o', outputs[i].from?.[0], outputs[i].from?.[1])}
							position={Position.Right}
							forceType={outputs[i].type ?? 'any'}
							style="top: 50%;"
						/>
					{/if}
				</div>
			{/each}
			{#if !rows}
				<span class="text-[10px] italic text-gray-500">no wires cross it</span>
			{/if}
		</div>
	</NodeWrapper>
</div>

<style>
	.tp-group-node :global(.node-card) {
		border-style: double;
		border-width: 3px;
		border-top-width: 2px;
	}
	.group-socket-name {
		max-width: 46%;
	}
</style>
