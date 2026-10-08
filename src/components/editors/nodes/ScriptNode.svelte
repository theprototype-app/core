<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { scriptEditorOpen, scriptErrors, scriptFileErrors, flowValues } from '../../../stores/flowStore';
	import { scriptInputs, scriptOutputs } from '$lib/scriptIO';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: error = $scriptErrors[id];
	// 36-code: a workspace save that did NOT reach this node (it keeps its last good code)
	$: pending = $scriptFileErrors[id];
	$: file = data.src?.kind === 'asset' && data.src.hash ? data.src.name : '';
	$: lines = (data.code ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
	// 34 D3: declared sockets make it v2. With no declaration the card is the v1 card,
	// byte-for-byte: the a/b/c inputs and the effect output.
	$: inputs = scriptInputs(data);
	$: outputs = scriptOutputs(data);
	$: live = ($flowValues[id] as any)?.__handles ?? null;

	function fmt(v: any) {
		if (v === undefined || v === null) return '–';
		if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
		if (Array.isArray(v)) return v.map((n) => Math.round(Number(n) * 100) / 100).join(', ');
		return String(v);
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	{#if !inputs}
		<!-- 133: wire value nodes into data.a / data.b / data.c for the code to read -->
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="a" style="top: 30px" />
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="b" style="top: 52px" />
		<Socket kind="target" nodeType={data.type} position={Position.Left} id="c" style="top: 74px" />
	{/if}
	{#if !outputs.length}
		<Socket kind="source" nodeType={data.type} position={Position.Right} />
	{/if}
	<div class="flex w-full flex-col gap-1">
		{#if data.name}
			<span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-2" title={data.name}>{data.name}</span>
		{/if}
		{#if inputs}
			<!-- one labelled ROW per declared socket, the handle anchored to its row (the
			     ObjectFlowNode shape) so the card stretches with the declaration -->
			{#each inputs as socket (socket.name)}
				<div class="script-in relative -mx-3 flex h-5 items-center px-3" data-socket={socket.name}>
					<Socket kind="target" nodeType="script" id={socket.name} position={Position.Left} forceType={socket.type} style="top: 50%;" />
					<span class="max-w-full truncate text-[10px] text-text-2">{socket.name} <span class="text-text-faint">{socket.type}</span></span>
				</div>
			{/each}
		{/if}
		{#each outputs as socket (socket.name)}
			<div class="script-out relative -mx-3 flex h-5 items-center justify-end gap-1 px-3" data-socket={socket.name}>
				<span class="max-w-[90px] truncate font-mono text-[10px] text-accent-text" title="live value">{fmt(live?.[socket.name])}</span>
				<span class="truncate text-[10px] text-text-2">{socket.name}</span>
				<Socket kind="source" nodeType="script" id={socket.name} position={Position.Right} forceType={socket.type} style="top: 50%;" />
			</div>
		{/each}
		<span class="text-[10px] text-text-muted">{lines} line{lines === 1 ? '' : 's'} of code</span>
		{#if file}
			<span class="script-file max-w-[180px] truncate text-[10px] text-accent-text" title="Runs the script file {file} — saving the file reloads every node bound to it">📄 {file}</span>
		{/if}
		<button
			class="nodrag nopan rounded-sm bg-accent-fill px-2 py-0.5 text-on-accent hover:brightness-110"
			on:click={() => scriptEditorOpen.set(id)}
		>
			Edit code
		</button>
		{#if error}
			<span class="max-w-[180px] wrap-break-word text-[10px] text-ink-bad" title={error}>⚠ {error}</span>
		{/if}
		{#if pending}
			<span class="script-pending max-w-[180px] wrap-break-word text-[10px] text-ink-warn" title={pending}>⚠ {pending}</span>
		{/if}
	</div>
</NodeWrapper>
