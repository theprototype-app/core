<script lang="ts">
	// A6.4: the card for a node type NOTHING in this app defines — almost always a
	// node from a module the player has not installed, which is exactly what a game
	// template produces on a fresh machine.
	//
	// Without it xyflow falls back to its own bare default card: a tiny unlabelled
	// box with no hint of what is wrong, so a perfectly good scene looks broken. This
	// is the CustomNode "definition missing" shape scaled up to say what to DO.
	//
	// It renders NO sockets. There is no spec, so there is nothing to know about the
	// node's shape — and drawing guesses would let a user wire edges that the real
	// node, once installed, does not accept. `serializeNode` copies `data` wholesale,
	// so the node still round-trips a save byte-identically while it sits here.
	import { type NodeProps } from '@xyflow/svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { modulesOpen } from '../../../stores/appStore';
	import { requiredModuleFor } from '$lib/moduleRequirements';

	type $$Props = NodeProps;
	export let data: any;

	// the scene may name the module this node came from (a .tpscene's `modules`
	// field, remembered at load) — say so when we know, stay vague when we do not
	$: provider = requiredModuleFor(data?.type ?? '');
</script>

<NodeWrapper type={data?.type ?? 'unknown'} label={'⚠ ' + (data?.type ?? 'unknown')} accent="#facc15">
	<div class="flex w-full max-w-[190px] flex-col gap-1.5">
		<span class="text-[10px] leading-snug text-yellow-300">
			This node comes from a module that isn't installed.
		</span>
		{#if provider}
			<span class="text-[10px] text-gray-400">Provided by <span class="font-mono">{provider}</span></span>
		{/if}
		<span class="text-[10px] leading-snug text-gray-500">
			It is kept exactly as saved, so installing the module brings it back to life.
		</span>
		<button
			class="nodrag rounded-sm bg-yellow-600/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-yellow-600"
			onclick={() => modulesOpen.set(true)}
		>
			Install module
		</button>
	</div>
</NodeWrapper>
