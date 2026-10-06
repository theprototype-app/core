<script lang="ts">
	// 36 (G1): a Code link card — the module (or kit) file whose code runs part of this game, and
	// the way into it. No sockets: it is the Main graph's signpost to logic that lives in code, so
	// "nothing hidden" holds even for a rule no node expresses yet.
	import NodeWrapper from './NodeWrapper.svelte';
	import { activeGraphId } from '../../../stores/flowStore';
	import { openCode } from '$lib/codeOpen';
	import { openCodeRequestFor } from '$lib/graphContract.js';

	let { id, data }: { id: string; data: any } = $props();
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-1" data-coderef={id}>
		{#if data.title}<span class="text-xs text-gray-200">{data.title}</span>{/if}
		<span class="truncate font-mono text-[10px] text-gray-400" title={data.module + '/' + data.file}>
			{data.module || '—'}{data.file ? '/' + data.file : ''}
		</span>
		<button
			class="nodrag nopan coderef-open self-start rounded-sm bg-gray-600 px-2 py-0.5 text-white hover:bg-gray-500"
			onclick={() => openCode(openCodeRequestFor({ id, type: 'coderef', data }, $activeGraphId))}
		>
			Open code
		</button>
	</div>
</NodeWrapper>
