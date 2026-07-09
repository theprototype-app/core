<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { scriptEditorOpen, scriptErrors } from '../../../stores/flowStore';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	$: error = $scriptErrors[id];
	$: lines = (data.code ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
</script>

<NodeWrapper type={data.type}>
	<Handle type="source" position={Position.Right} />
	<div class="flex w-full flex-col gap-1">
		<span class="text-[10px] text-gray-400">{lines} line{lines === 1 ? '' : 's'} of code</span>
		<button
			class="nodrag rounded bg-[#ff4000] px-2 py-0.5 text-white"
			on:click={() => scriptEditorOpen.set(id)}
		>
			Edit code
		</button>
		{#if error}
			<span class="max-w-[180px] break-words text-[10px] text-red-500" title={error}>⚠ {error}</span>
		{/if}
	</div>
</NodeWrapper>
