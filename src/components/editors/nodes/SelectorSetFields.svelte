<script>
	// 102b-flows — the Object Selector card's "By tag / By group / By name" fields and the live count of
	// what the set resolves to. A lazy chunk: a card set to One object (every saved selector) never
	// loads it. Writes go through setNodeData, as the card's own select does.
	import { objectsGroup, sceneRevision } from '../../../stores/sceneStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { resolveSelector, sceneTags, describeSet } from '$lib/selectorCore.js';

	/** @type {{ id: string, data: any, pick: string, match: string }} */
	let { id, data, pick, match } = $props();
	/** @type {Record<string, string>} */
	const TITLES = { tag: 'Every object with a tag (Inspector > Tags)', group: 'Every object in a group', name: 'Every object whose name matches: Star*, coin (contains)' };
	const title = $derived(TITLES[pick] ?? '');

	const root = $derived($objectsGroup);
	/** the groups a "By group" selector can name: any object with children (nested ones too) */
	const groups = $derived.by(() => {
		void $sceneRevision;
		/** @type {{id: string, name: string}[]} */
		const out = [];
		if (pick !== 'group') return out;
		/** @type {any} */ (root)?.traverse?.((/** @type {any} */ o) => {
			if (o === root || !o.children?.length || o.isMesh || o.userData?.helper) return;
			if (o.type === 'Group' || o.type === 'Object3D') out.push({ id: o.uuid, name: o.name || 'Group' });
		});
		return out;
	});
	const tags = $derived.by(() => {
		void $sceneRevision;
		return pick === 'tag' ? sceneTags(root) : [];
	});
	const set = $derived.by(() => {
		void $sceneRevision;
		return resolveSelector(data, root);
	});
	const nameOf = (/** @type {string} */ uuid) => /** @type {any} */ (root)?.getObjectByProperty?.('uuid', uuid)?.name || null;
	/** @type {Record<string, string>} */
	const placeholder = { tag: 'tag', name: 'Star* or coin' };
</script>

{#if pick === 'group'}
	<select class="nodrag nopan" aria-label="Group" {title} data-selector-match value={match} onchange={(e) => setNodeData(id, { match: e.currentTarget.value })}>
		<option value="">-None-</option>
		{#each groups as g (g.id)}
			<option value={g.id}>{g.name}</option>
		{/each}
	</select>
{:else}
	<input
		class="nodrag nopan ui-input px-1 py-0.5 text-xs"
		aria-label={pick === 'tag' ? 'Tag' : 'Name pattern'}
		{title}
		data-selector-match
		list={pick === 'tag' ? 'selector-tags-' + id : undefined}
		placeholder={placeholder[pick]}
		maxlength="120"
		value={match}
		onchange={(e) => setNodeData(id, { match: e.currentTarget.value.trim() })}
		onkeydown={(e) => {
			if (e.key === 'Enter') e.currentTarget.blur();
		}}
	/>
	{#if pick === 'tag'}
		<datalist id={'selector-tags-' + id}>
			{#each tags as t (t.tag)}<option value={t.tag}>{t.count} object{t.count === 1 ? '' : 's'}</option>{/each}
		</datalist>
	{/if}
{/if}
<span class="selector-count text-[length:var(--fs-badge)] text-text-muted" data-selector-count={set.length} title={describeSet(set, nameOf, 8)}>
	{set.length === 0 ? 'matches no objects' : `${set.length} object${set.length === 1 ? '' : 's'}`}
</span>
