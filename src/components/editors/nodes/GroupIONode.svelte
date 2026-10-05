<script lang="ts">
	// 36 U11: the two boundary cards drawn INSIDE an open group — "Group inputs" on the
	// left, "Group outputs" on the right — one socket per group socket, wired to the inner
	// endpoints they stand for. They are never stored or replicated (the view builds them).
	// The empty ＋ socket exposes a new one: drag an inner node's socket onto it.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { ioHandle } from '$lib/nodeGroups';

	type $$Props = NodeProps;
	export let data: any;

	$: inbound = data?.kind === 'in';
	$: entries = (data?.entries ?? []) as any[];
</script>

<div class="tp-group-io" data-io={inbound ? 'in' : 'out'}>
	<NodeWrapper type="group" label={inbound ? 'Group inputs' : 'Group outputs'} accent="var(--muted, #9ca3af)">
		<div class="flex w-full flex-col gap-0.5">
			{#each entries as entry (entry.key)}
				<div class="relative -mx-3 flex h-5 items-center px-3 {inbound ? 'justify-end' : 'justify-start'}">
					<span class="truncate" title={entry.name}>{entry.name}</span>
					{#if inbound}
						<Socket kind="source" nodeType="group" id={ioHandle('i', entry.to?.[0], entry.to?.[1])} position={Position.Right} forceType={entry.type ?? 'any'} style="top: 50%;" />
					{:else}
						<Socket kind="target" nodeType="group" id={ioHandle('o', entry.from?.[0], entry.from?.[1])} position={Position.Left} forceType={entry.type ?? 'any'} style="top: 50%;" />
					{/if}
				</div>
			{/each}
			<div class="relative -mx-3 flex h-5 items-center px-3 text-gray-500 {inbound ? 'justify-end' : 'justify-start'}" title="Drag an inner socket here to expose it">
				<span>＋ new</span>
				{#if inbound}
					<Socket kind="source" nodeType="group" id="i|+" position={Position.Right} forceType="any" style="top: 50%;" />
				{:else}
					<Socket kind="target" nodeType="group" id="o|+" position={Position.Left} forceType="any" style="top: 50%;" />
				{/if}
			</div>
		</div>
	</NodeWrapper>
</div>

<style>
	.tp-group-io :global(.node-card) {
		border-style: dashed;
		opacity: 0.92;
	}
</style>
