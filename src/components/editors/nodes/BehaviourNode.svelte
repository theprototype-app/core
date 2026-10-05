<script lang="ts">
	// 34 R3 (D1): a Behaviour node's card — its name, whether it runs (and where: the authority
	// runs the handlers), and the way into its derived live node view (D2). No sockets: a
	// behaviour listens to kit events and acts through the kit.
	import NodeWrapper from './NodeWrapper.svelte';
	import { behaviourViewOpen, activeGraphId, scriptFileErrors } from '../../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { onMount } from 'svelte';

	export let id: string;
	export let data: any;

	/** behaviours/app.js, loaded by flowRuntime already (dynamic: the card must not pull it into the editor's import graph) */
	let status: any = null;
	onMount(() => {
		let off = () => {};
		import('$lib/behaviours/app.js').then((m) => {
			off = m.behaviourStatus.subscribe((all: any) => (status = all[id] ?? null));
		});
		return () => off();
	});
	$: state = data.enabled === false ? 'off' : (status?.status ?? 'loading');
	$: handlers = status?.model?.handlers?.length ?? 0;
	$: firstError = status?.errors?.[0];
	$: pending = $scriptFileErrors[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-1" data-behaviour-card={id}>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-200" title={data.name}>{data.name || 'Behaviour'}</span>
		<span class="flex items-center gap-1 text-[10px] text-gray-400">
			<span
				class="inline-block h-2 w-2 rounded-full"
				class:bg-emerald-400={state === 'running'}
				class:bg-amber-400={state === 'loading'}
				class:bg-red-500={state === 'error'}
				class:bg-gray-500={state === 'off'}
			></span>
			<span data-behaviour-state>{state}</span>
			{#if state === 'running'}· {handlers} handler{handlers === 1 ? '' : 's'}{/if}
		</span>
		<div class="flex gap-1">
			<button
				class="nodrag behaviour-open rounded-sm bg-[#ff4000] px-2 py-0.5 text-white"
				on:click={() => behaviourViewOpen.set({ id, graphId: $activeGraphId })}
			>
				Open view
			</button>
			<button
				class="nodrag behaviour-code rounded-sm bg-gray-600 px-2 py-0.5 text-white"
				title="Edit this behaviour's source in the code workspace (Ctrl+S reloads it)"
				on:click={() => import('$lib/codeWorkspace').then((m) => m.openCode({ source: 'behaviour', ref: { nodeId: id, graphId: $activeGraphId } }))}
			>
				Code
			</button>
			<button
				class="nodrag rounded-sm bg-gray-600 px-2 py-0.5 text-white"
				title={data.enabled === false ? 'Run this behaviour' : 'Stop this behaviour (its state is kept)'}
				on:click={() => setNodeData(id, { enabled: data.enabled === false })}
			>
				{data.enabled === false ? 'Run' : 'Stop'}
			</button>
		</div>
		{#if pending}
			<span class="max-w-[200px] wrap-break-word text-[10px] text-amber-400" title={pending}>⚠ {pending}</span>
		{/if}
		{#if firstError}
			<span class="max-w-[200px] wrap-break-word text-[10px] text-red-500" title={firstError.message}>⚠ {firstError.line ? 'line ' + firstError.line + ': ' : ''}{firstError.message}</span>
		{/if}
	</div>
</NodeWrapper>
