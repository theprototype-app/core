<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { objectsGroup, sceneRevision } from '../../../stores/sceneStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { pickOf, matchOf, resolveSelector, sceneTags, describeSet } from '$lib/selectorCore.js';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// List of objects currently in the scene
	let sceneObjects: any;
	$: sceneObjects = $objectsGroup;
	let items: { id: string; name: string }[] = [];
	$: items = sceneObjects
		? sceneObjects.children.map((child: any) => ({ id: child.uuid, name: child.name || child.type }))
		: [];
	// One-way flow: render from data, write through setNodeData (replicates to peers)

	// 102b-flows: pick ONE object (the default, what every saved selector is) or a SET — every object
	// with a tag, every object in a group, or every object whose name matches. Effects wired in act
	// on all of them; triggers wired in fire for any of them (Fired Object says which).
	const PICKS = [
		{ value: 'object', label: 'One object', title: 'Drive one object' },
		{ value: 'tag', label: 'By tag', title: 'Drive every object with a tag (Inspector > Tags)' },
		{ value: 'group', label: 'By group', title: 'Drive every object inside a group' },
		{ value: 'name', label: 'By name', title: 'Drive every object whose name matches: Star* , *coin* , enemy ? (no * = contains)' }
	];
	let pick: string;
	$: pick = pickOf(data);
	let match: string;
	$: match = matchOf(data);
	/** the groups a "By group" selector can name: any object with children (nested ones too) */
	let groups: { id: string; name: string }[] = [];
	$: groups = pick === 'group' ? groupsOf(sceneObjects, $sceneRevision) : [];
	let tags: { tag: string; count: number }[] = [];
	$: tags = pick === 'tag' ? (void $sceneRevision, sceneTags(sceneObjects)) : [];
	/** the resolved set, re-read on every scene change */
	let set: string[] = [];
	$: set = pick !== 'object' ? (void $sceneRevision, resolveSelector(data, sceneObjects)) : [];
	const nameOf = (uuid: string) => sceneObjects?.getObjectByProperty?.('uuid', uuid)?.name || null;

	function groupsOf(root: any, _rev: number) {
		const out: { id: string; name: string }[] = [];
		root?.traverse?.((o: any) => {
			if (o === root || !o.children?.length || o.isMesh || o.userData?.helper) return;
			if (o.type === 'Group' || o.type === 'Object3D') out.push({ id: o.uuid, name: o.name || 'Group' });
		});
		return out;
	}
	function setPick(next: string) {
		// back to one object: the fields go, so the node is exactly a plain selector again
		if (next === 'object') setNodeData(id, { pick: undefined, match: undefined });
		else setNodeData(id, { pick: next, match: next === pick ? match : '' });
	}
	const placeholder: Record<string, string> = { tag: 'tag', name: 'Star* or coin' };
</script>

<NodeWrapper type={data.type} label={data.label}>
	<div class="flex w-full flex-col gap-1">
		<select
			class="nodrag nopan"
			aria-label="What this selector picks"
			title={PICKS.find((p) => p.value === pick)?.title}
			data-selector-pick
			value={pick}
			on:change={(e) => setPick(e.currentTarget.value)}
		>
			{#each PICKS as p (p.value)}
				<option value={p.value} title={p.title}>{p.label}</option>
			{/each}
		</select>
		{#if pick === 'object'}
			<select
				class="nodrag nopan"
				aria-label="Object"
				value={data.selected ?? '-None-'}
				on:change={(e) => setNodeData(id, { selected: e.currentTarget.value })}
			>
				<option>-None-</option>
				{#each items as option}
					<option value={option.id}>{option.name}</option>
				{/each}
			</select>
		{:else if pick === 'group'}
			<select
				class="nodrag nopan"
				aria-label="Group"
				data-selector-match
				value={match}
				on:change={(e) => setNodeData(id, { match: e.currentTarget.value })}
			>
				<option value="">-None-</option>
				{#each groups as g (g.id)}
					<option value={g.id}>{g.name}</option>
				{/each}
			</select>
		{:else}
			<input
				class="nodrag nopan ui-input px-1 py-0.5 text-xs"
				aria-label={pick === 'tag' ? 'Tag' : 'Name pattern'}
				title={PICKS.find((p) => p.value === pick)?.title}
				data-selector-match
				list={pick === 'tag' ? 'selector-tags-' + id : undefined}
				placeholder={placeholder[pick]}
				maxlength="120"
				value={match}
				on:change={(e) => setNodeData(id, { match: e.currentTarget.value.trim() })}
				on:keydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
			{#if pick === 'tag'}
				<datalist id={'selector-tags-' + id}>
					{#each tags as t (t.tag)}<option value={t.tag}>{t.count} object{t.count === 1 ? '' : 's'}</option>{/each}
				</datalist>
			{/if}
		{/if}
		{#if pick !== 'object'}
			<span class="selector-count text-[length:var(--fs-badge)] text-text-muted" data-selector-count={set.length} title={describeSet(set, nameOf, 8)}>
				{set.length === 0 ? 'matches no objects' : `${set.length} object${set.length === 1 ? '' : 's'}`}
			</span>
		{/if}
	</div>
	<Socket kind="target" nodeType={data.type} position={Position.Left} />
	<!-- the chosen object, as a value: this is what every `object` input in the
	     catalog wires from. Declared in flowSockets since 165; the card simply
	     never offered the handle, so those inputs were unreachable.
	     102b-flows: for a set, the member a trigger fired for last (else the first). -->
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
</NodeWrapper>
