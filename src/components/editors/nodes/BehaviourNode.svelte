<script lang="ts">
	// 34 R3 (D1): a Behaviour node's card — its name, whether it runs (and where: the authority
	// runs the handlers), and the way into its derived live node view (D2).
	// 36 (U10): a behaviour that declares `inputs` / `outputs` has SOCKETS — triggers in on the
	// left (each runs its handler), state values and emitted events out on the right, with the
	// live replicated value beside each value output. Without the lists: no sockets, as before.
	import { Position } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import Socket from './Socket.svelte';
	import { behaviourViewOpen, activeGraphId, scriptFileErrors } from '../../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { onMount } from 'svelte';

	export let id: string;
	export let data: any;

	/** behaviours/app.js, loaded by flowRuntime already (dynamic: the card must not pull it into the editor's import graph) */
	let status: any = null;
	let live: any = null;
	let sockets: { inputs: any[]; outputs: any[] } = { inputs: [], outputs: [] };
	let socketsOf: ((code: string) => any) | null = null;
	onMount(() => {
		let off = () => {};
		let offLive = () => {};
		let timer: any = null;
		import('$lib/behaviours/app.js').then((m) => {
			off = m.behaviourStatus.subscribe((all: any) => (status = all[id] ?? null));
			// live values: the runtime announces every change; repaint at most ~6x a second
			offLive = m.runtime.onChange(() => {
				if (timer) return;
				timer = setTimeout(() => {
					timer = null;
					live = m.behaviourState(id);
				}, 160);
			});
			live = m.behaviourState(id);
		});
		import('$lib/behaviours/sockets.js').then((m) => (socketsOf = m.behaviourSockets));
		return () => {
			off();
			offLive();
			if (timer) clearTimeout(timer);
		};
	});
	$: sockets = socketsOf ? socketsOf(String(data.code ?? '')) : { inputs: [], outputs: [] };
	function fmt(v: any) {
		if (v === undefined || v === null) return '–';
		if (typeof v === 'number') return String(Math.round(v * 100) / 100);
		if (typeof v === 'string') return v.length > 18 ? v.slice(0, 17) + '…' : v;
		if (typeof v === 'boolean') return v ? 'yes' : 'no';
		return Array.isArray(v) ? '[' + v.length + ']' : '{…}';
	}
	$: state = data.enabled === false ? 'off' : (status?.status ?? 'loading');
	$: handlers = status?.model?.handlers?.length ?? 0;
	$: firstError = status?.errors?.[0];
	$: pending = $scriptFileErrors[id];
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-1" data-behaviour-card={id}>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-2" title={data.name}>{data.name || 'Behaviour'}</span>
		{#each sockets.inputs as socket (socket.name)}
			<div class="behaviour-in relative -mx-3 flex h-5 items-center px-3" data-socket={socket.name}>
				<Socket kind="target" nodeType="behaviour" id={socket.name} position={Position.Left} forceType="event" style="top: 50%;" />
				<span class="max-w-full truncate text-[10px] text-text-2">▸ {socket.name}</span>
			</div>
		{/each}
		{#each sockets.outputs as socket (socket.name)}
			<div class="behaviour-out relative -mx-3 flex h-5 items-center justify-end gap-1 px-3" data-socket={socket.name}>
				{#if socket.kind === 'value'}
					<span class="max-w-[110px] truncate font-mono text-[10px] text-accent-text" title="live value (replicated)">{fmt(live?.[socket.name])}</span>
				{/if}
				<span class="truncate text-[10px] text-text-2">{socket.name}{socket.kind === 'event' ? ' ⚡' : ''}</span>
				<Socket kind="source" nodeType="behaviour" id={socket.name} position={Position.Right} forceType={socket.type} style="top: 50%;" />
			</div>
		{/each}
		<span class="flex items-center gap-1 text-[10px] text-text-muted">
			<span
				class="inline-block h-2 w-2 rounded-full"
				class:bg-ink-good={state === 'running'}
				class:bg-ink-warn={state === 'loading'}
				class:bg-ink-bad={state === 'error'}
				class:bg-control-off={state === 'off'}
			></span>
			<span data-behaviour-state>{state}</span>
			{#if state === 'running'}· {handlers} handler{handlers === 1 ? '' : 's'}{/if}
		</span>
		<div class="flex gap-1">
			<button
				class="nodrag nopan behaviour-open rounded-sm bg-accent-fill px-2 py-0.5 text-on-accent hover:brightness-110"
				on:click={() => behaviourViewOpen.set({ id, graphId: $activeGraphId })}
			>
				Open view
			</button>
			<button
				class="nodrag nopan behaviour-code rounded-sm bg-surface-active px-2 py-0.5 text-text hover:bg-border-strong"
				title="Edit this behaviour's source in the code workspace (Ctrl+S reloads it)"
				on:click={() => import('$lib/codeWorkspace').then((m) => m.openCode({ source: 'behaviour', ref: { nodeId: id, graphId: $activeGraphId } }))}
			>
				Code
			</button>
			<button
				class="nodrag nopan rounded-sm bg-surface-active px-2 py-0.5 text-text hover:bg-border-strong"
				title={data.enabled === false ? 'Run this behaviour' : 'Stop this behaviour (its state is kept)'}
				on:click={() => setNodeData(id, { enabled: data.enabled === false })}
			>
				{data.enabled === false ? 'Run' : 'Stop'}
			</button>
		</div>
		{#if pending}
			<span class="max-w-[200px] wrap-break-word text-[10px] text-ink-warn" title={pending}>⚠ {pending}</span>
		{/if}
		{#if firstError}
			<span class="max-w-[200px] wrap-break-word text-[10px] text-ink-bad" title={firstError.message}>⚠ {firstError.line ? 'line ' + firstError.line + ': ' : ''}{firstError.message}</span>
		{/if}
	</div>
</NodeWrapper>
