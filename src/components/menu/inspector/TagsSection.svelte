<script>
	// 102b-flows row 1 — Inspector ▸ Tags: the words an Object Selector set to "By tag" finds
	// (and a behaviour's findAll). A chip per tag with its remove button, a field that adds one on
	// Enter (suggesting the tags the scene already uses). With several objects selected the chips
	// are the union, each saying how many of the selection carry it; adding or removing then acts
	// on the whole selection as ONE undo step.
	import Section from '../../ui/Section.svelte';
	import Icon from '../../ui/Icon.svelte';
	import { sceneRevision, objectsGroup } from '../../../stores/sceneStore';
	import { tagsOf, sceneTags, MAX_TAG_LEN } from '$lib/selectorCore.js';
	import { addTag, removeTag } from '$lib/objectTags.js';

	/** @type {{ objects: any[], disabled?: boolean }} */
	let { objects = [], disabled = false } = $props();

	let draft = $state('');

	const uuids = $derived(objects.map((o) => o.uuid));
	/** the union of the selection's tags, first spelling wins, with how many carry each */
	const chips = $derived.by(() => {
		void $sceneRevision;
		/** @type {Map<string, {tag: string, count: number}>} */
		const map = new Map();
		for (const o of objects)
			for (const t of tagsOf(o)) {
				const hit = map.get(t.toLowerCase());
				if (hit) hit.count++;
				else map.set(t.toLowerCase(), { tag: t, count: 1 });
			}
		return [...map.values()];
	});
	/** the scene's other tags, offered as suggestions */
	const suggestions = $derived.by(() => {
		void $sceneRevision;
		const have = new Set(chips.filter((c) => c.count === objects.length).map((c) => c.tag.toLowerCase()));
		return sceneTags($objectsGroup).filter((t) => !have.has(t.tag.toLowerCase()));
	});
	const many = $derived(objects.length > 1);

	function commit() {
		const tag = draft.trim();
		if (!tag || disabled) return;
		addTag(uuids, tag);
		draft = '';
	}
</script>

<Section variant="panel" label="Tags" aliases={['Tag', 'Labels']} note="Words an Object Selector set to By tag finds. One flow can then drive every object with the tag.">
	<div id="tags-section" class="flex flex-col gap-1.5 text-xs">
		{#if chips.length}
			<ul class="flex flex-wrap gap-1" aria-label="Tags on {many ? 'the selection' : 'this object'}">
				{#each chips as c (c.tag.toLowerCase())}
					<li class="tag-chip" data-tag={c.tag}>
						<span>{c.tag}</span>
						{#if many && c.count < objects.length}<span class="text-text-muted tabular-nums" title="{c.count} of the {objects.length} selected objects have this tag">{c.count}/{objects.length}</span>{/if}
						<button
							type="button"
							class="tag-remove"
							aria-label="Remove tag {c.tag}"
							title="Remove the tag {c.tag}{many ? ' from every selected object' : ''}"
							{disabled}
							onclick={() => removeTag(uuids, c.tag)}><Icon name="x" size={16} aria-hidden="true" /></button
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-text-muted">No tags yet.</p>
		{/if}
		<label class="flex items-center gap-2 text-text-muted">
			<span class="sr-only">Add a tag</span>
			<input
				id="tags-add"
				class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
				list="tags-known"
				placeholder={many ? 'Add a tag to all selected' : 'Add a tag'}
				title="Type a tag and press Enter"
				maxlength={MAX_TAG_LEN}
				autocomplete="off"
				{disabled}
				bind:value={draft}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					}
				}}
			/>
			<button type="button" id="tags-add-button" class="tag-add" title="Add the tag (Enter)" aria-label="Add the tag" disabled={disabled || !draft.trim()} onclick={commit}
				><Icon name="plus" size={16} aria-hidden="true" /></button
			>
		</label>
		<datalist id="tags-known">
			{#each suggestions as s (s.tag.toLowerCase())}<option value={s.tag}>{s.count} object{s.count === 1 ? '' : 's'}</option>{/each}
		</datalist>
	</div>
</Section>

<style>
	.tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.125rem 0.0625rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text);
	}
	.tag-remove,
	.tag-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		min-height: 1.25rem;
		border-radius: 999px;
		color: var(--color-text-muted);
	}
	.tag-remove:hover,
	.tag-add:hover:not(:disabled) {
		color: var(--color-text);
		background: var(--color-surface-hover);
	}
	.tag-remove:focus-visible,
	.tag-add:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}
	.tag-add:disabled {
		opacity: 0.4;
	}
</style>
