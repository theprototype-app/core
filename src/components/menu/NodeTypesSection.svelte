<script module>
	// what the I4 settings search matches this section by, beyond its row names
	export const keywords = ['node', 'nodes', 'node types', 'node manager', 'palette', 'hide', 'disable', 'enable', 'flow', 'catalog'];
</script>

<script>
	// 36 B7: THE NODE MANAGER — switch node types off on this device. A switched-off type leaves the
	// node palette, the add menus and the node search; nodes of that type already in a graph keep
	// working (a graph is shared, this preference is not). The disabledModules pattern: a persisted
	// list, one switch per type, a group switch for the whole group.
	//
	// 37-settings (R21, docs/settings-inventory.md §3.8): one NavRow per palette group ("12 of 14 on")
	// opening that group's SUB-PAGE — "All <group> nodes" then one toggle per type — instead of a
	// 3-column grid of ~200 checkboxes. The filter lists matching types inline, their group as the
	// path. "Turn all on" is the footer's "Reset Node types to defaults". Same key: disabledNodeTypes.
	import { getContext } from 'svelte';
	import Section from '../ui/Section.svelte';
	import SettingRow from '../ui/SettingRow.svelte';
	import NavRow from '../ui/NavRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import { NAV_CONTEXT } from '$lib/settingsNav';
	import { nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups } from '$lib/moduleSDK';
	import { disabledNodeTypes, setNodeTypesEnabled } from '$lib/nodeTypePrefs';
	import { flowGraphs } from '../../stores/flowStore';

	const nav = /** @type {any} */ (getContext(NAV_CONTEXT));
	const sub = nav?.sub;

	let filter = $state('');
	/** @type {{group: string, items: {type: string, label: string}[]}[]} */
	const groups = $derived([...nodeCatalog, ...$moduleNodeGroups]);
	const used = $derived.by(() => {
		/** @type {Record<string, number>} */
		const counts = {};
		for (const g of Object.values($flowGraphs ?? {})) for (const n of /** @type {any} */ (g).nodes ?? []) counts[n.type] = (counts[n.type] ?? 0) + 1;
		return counts;
	});
	const q = $derived(filter.trim().toLowerCase());
	const matches = $derived(
		q
			? groups.flatMap((g) => g.items.filter((i) => (i.label + ' ' + i.type + ' ' + g.group).toLowerCase().includes(q)).map((i) => ({ ...i, group: g.group })))
			: []
	);
	/** the group whose sub-page is open ("nodes:<group>") */
	const openGroup = $derived($sub?.id?.startsWith('nodes:') ? (groups.find((g) => 'nodes:' + g.group === $sub.id) ?? null) : null);

	/** @param {{items: {type: string}[]}} g @param {string[]} off */
	const onCount = (g, off) => g.items.filter((i) => !off.includes(i.type)).length;
	/** @param {string} type @returns {string} */
	const usedText = (type) => (used[type] ? used[type] + ' in use' : '');
</script>

<div id="node-types-section" class="nt" data-keywords={keywords.join(' ')}>
	{#if openGroup}
		{@const types = openGroup.items.map((i) => i.type)}
		{@const allOn = types.every((t) => !$disabledNodeTypes.includes(t))}
		<Section variant="card" label={openGroup.group} badge="This device">
			<SettingRow id="row-node-group-all" label={'All ' + openGroup.group + ' nodes'} description="Every type in this group at once." data-group={openGroup.group}>
				<Toggle data-nt="group-toggle" label={'All ' + openGroup.group + ' nodes'} checked={allOn} onchange={(on) => setNodeTypesEnabled(types, on)} />
			</SettingRow>
			{#each openGroup.items as item (item.type)}
				<SettingRow label={item.label} description={usedText(item.type)} data-node-type={item.type}>
					<Toggle data-nt="type-toggle" label={item.label} checked={!$disabledNodeTypes.includes(item.type)} onchange={(on) => setNodeTypesEnabled([item.type], on)} />
				</SettingRow>
			{/each}
		</Section>
	{:else}
		<div class="nt-filter">
			<SearchField id="node-types-filter" size="sm" placeholder="Filter node types" label="Filter node types" bind:value={filter} />
		</div>
		{#if q}
			<Section variant="card" label={matches.length ? matches.length + ' matching' : 'No match'}>
				{#each matches as item (item.type)}
					<SettingRow label={item.label} description={item.group + (usedText(item.type) ? ' · ' + usedText(item.type) : '')} data-node-type={item.type}>
						<Toggle data-nt="type-toggle" label={item.label} checked={!$disabledNodeTypes.includes(item.type)} onchange={(on) => setNodeTypesEnabled([item.type], on)} />
					</SettingRow>
				{/each}
			</Section>
		{:else}
			<Section variant="card" label="Groups" badge="This device">
				{#each groups as group (group.group)}
					<NavRow
						label={group.group}
						value={onCount(group, $disabledNodeTypes) + ' of ' + group.items.length + ' on'}
						data-group={group.group}
						onclick={() => nav.openSub('nodes:' + group.group, group.group, 'nodetypes')}
					/>
				{/each}
			</Section>
		{/if}
	{/if}
</div>

<style>
	.nt {
		display: contents;
	}
	.nt-filter {
		max-width: 320px;
	}
</style>
