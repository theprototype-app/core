<script lang="ts">
	import { Button } from 'flowbite-svelte';
	import {
		annotations,
		activeAnnotation,
		setAnnotation,
		deleteAnnotation
	} from '$lib/annotationsHandler';

	// Note editor card: opens for a clicked pin ({id}) or a new draft ({draft}).

	$: existing = $activeAnnotation?.id
		? $annotations.find((a) => a.id === $activeAnnotation.id)
		: null;
	$: draft = $activeAnnotation?.draft ?? null;

	let text = '';
	let lastKey = '';
	$: {
		const key = existing?.id ?? draft?.id ?? '';
		if (key !== lastKey) {
			lastKey = key;
			text = existing?.text ?? draft?.text ?? '';
		}
	}

	function save() {
		const base = existing ?? draft;
		if (!base || !text.trim()) return;
		setAnnotation({ ...base, text: text.trim(), ts: Date.now() });
		$activeAnnotation = null;
	}

	function remove() {
		if (existing) deleteAnnotation(existing.id);
		$activeAnnotation = null;
	}
</script>

{#if existing || draft}
	<div
		class="fixed right-4 top-24 z-40 w-72 rounded-lg border border-amber-500/60 bg-white p-3 shadow-xl dark:bg-gray-800"
	>
		<p class="mb-2 text-xs font-semibold uppercase text-amber-500">
			{existing ? 'Note' : 'New note'}
		</p>
		<!-- svelte-ignore a11y_autofocus -->
		<textarea
			class="h-24 w-full resize-none rounded-sm border border-gray-300 bg-transparent p-2 text-sm text-gray-800 dark:border-gray-600 dark:text-gray-100"
			placeholder="Write a note…"
			autofocus
			bind:value={text}
			on:keydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					save();
				}
				if (e.key === 'Escape') $activeAnnotation = null;
			}}
		></textarea>
		{#if existing}
			<p class="mb-2 text-xs text-gray-400">
				{existing.author} — {new Date(existing.ts).toLocaleString()}
			</p>
		{/if}
		<div class="flex justify-end gap-2">
			{#if existing}
				<Button size="xs" color="red" onclick={remove}>Delete</Button>
			{/if}
			<Button size="xs" color="alternative" onclick={() => ($activeAnnotation = null)}>Close</Button>
			<Button size="xs" onclick={save}>Save</Button>
		</div>
	</div>
{/if}
