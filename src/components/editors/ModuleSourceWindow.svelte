<script lang="ts">
	// 36 (G1, phase 4): a module's own source, READ-ONLY — what double-click on a module node or a
	// Main-graph `coderef` node opens until 36-code's workspace takes over (codeOpen's seam). The
	// promise it keeps is the user's "nothing hidden": every line of the game's logic can be READ
	// from the graph. Changing it is a separate, explicit step: a node bound to a module file gets
	// "Make editable copy" (codeOpen.forkNodeSource); a whole module's file can be saved to the
	// Explorer as the user's own copy to read and edit beside the original.
	import { moduleSourceOpen, moduleSourceFiles } from '$lib/codeOpen';
	import { focusStack } from '$lib/windowFocus';
	import CodeEditor from './CodeEditor.svelte';

	const open = $derived($moduleSourceOpen);
	let files: { file: string; text: string }[] = $state([]);
	let current = $state('');
	let loadedFor = '';
	let saved = $state('');

	$effect(() => {
		const req = open;
		if (!req) return;
		const key = req.module + '|' + (req.file ?? '');
		if (key === loadedFor) return;
		loadedFor = key;
		saved = '';
		void moduleSourceFiles(req.module).then((list) => {
			files = list;
			current = list.find((f) => f.file === req.file)?.file ?? list[0]?.file ?? '';
		});
	});
	const text = $derived(files.find((f) => f.file === current)?.text ?? '');

	async function saveCopy() {
		const { addItemFromBytes } = await import('$lib/explorer');
		const name = (open?.module ?? 'module') + ' - ' + current.split('/').pop();
		const item = await addItemFromBytes(new TextEncoder().encode(text).buffer, name, null, {});
		saved = item?.name ?? name;
	}
	function close() {
		moduleSourceOpen.set(null);
		loadedFor = '';
	}
</script>

{#if open}
	<div
		id="module-source-window"
		use:focusStack
		class="fixed right-0 top-16 z-40 flex h-[70%] w-[520px] max-w-[92vw] flex-col gap-2 rounded-bl-lg bg-gray-800 p-3 text-xs text-gray-200 shadow-xl"
	>
		<div class="flex items-center gap-2">
			<span class="text-sm font-semibold text-gray-100">Module source — {open.module}</span>
			<span id="module-source-readonly" class="rounded-sm bg-gray-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">read-only</span>
			<span class="flex-1"></span>
			<button id="module-source-close" class="rounded-sm bg-gray-600 px-2" onclick={close} aria-label="Close">✕</button>
		</div>
		{#if files.length === 0}
			<p class="text-gray-400">This module's source is not available here — it is not installed on this device.</p>
		{:else}
			<div class="flex flex-wrap gap-1" role="tablist" aria-label="Files">
				{#each files as f (f.file)}
					<button
						role="tab"
						aria-selected={f.file === current}
						data-file={f.file}
						class="rounded-sm px-2 py-0.5 {f.file === current ? 'bg-primary-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
						onclick={() => (current = f.file)}>{f.file}</button
					>
				{/each}
			</div>
			<div class="min-h-0 flex-1">
				{#key current}
					<CodeEditor value={text} readonly={true} line={current === open.file ? open.line : undefined} />
				{/key}
			</div>
			<div class="flex items-center gap-2">
				<button id="module-source-save-copy" class="rounded-sm bg-gray-600 px-2 py-1 hover:bg-gray-500" onclick={saveCopy}
					title="Save this file to your Explorer as your own copy">Save a copy to Explorer</button>
				{#if saved}<span class="text-gray-400">Saved as “{saved}”</span>{/if}
			</div>
			<p class="text-[11px] leading-snug text-gray-400">
				This is the module's own file: it runs the same for everyone, so it cannot be edited here. A node bound to a
				module file offers <em>Make editable copy</em> in its code panel.
			</p>
		{/if}
	</div>
{/if}
