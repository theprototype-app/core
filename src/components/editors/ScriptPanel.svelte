<script>
	import { flowNodes, scriptEditorOpen, scriptErrors } from '../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import CodeEditor from './CodeEditor.svelte';

	// Side panel editing a Script node's code (live, replicated via nodedata).
	// Edits are debounced so peers aren't flooded per keystroke.

	$: node = $flowNodes.find((n) => n.id === $scriptEditorOpen) ?? null;
	$: error = node ? $scriptErrors[node.id] : null;

	let timer;
	function onChange(code) {
		clearTimeout(timer);
		const id = node?.id;
		if (!id) return;
		timer = setTimeout(() => setNodeData(id, { code: code }), 400);
	}
</script>

{#if node}
	<div
		use:focusStack
		use:tabbable={{ key: 'script', title: 'Script', openStore: scriptEditorOpen, isOpen: (v) => !!v, close: () => scriptEditorOpen.set(null) }}
		class="fixed right-0 top-16 z-40 flex h-[70%] w-[420px] max-w-[90vw] flex-col gap-2 rounded-bl-lg bg-gray-800 p-3 text-white shadow-xl"
	>
		<div class="move-handle flex items-center justify-between">
			<span class="font-semibold">Script — runs on every peer</span>
			<button id="script-panel-close" class="rounded bg-gray-600 px-2" on:click={() => scriptEditorOpen.set(null)}>✕</button>
		</div>
		<div class="min-h-0 flex-1">
			<CodeEditor value={node.data.code ?? ''} {onChange} />
		</div>
		{#if error}
			<p class="text-xs text-red-400">⚠ {error}</p>
		{:else}
			<p class="text-xs text-gray-400">
				object, base ({'{'}pos, rot, scale, visible{'}'}), data, time — keep it a pure function
				of these so peers stay in sync.
			</p>
		{/if}
	</div>
{/if}
