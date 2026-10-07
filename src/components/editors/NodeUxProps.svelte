<script>
	// 36 U11: the properties panel for the node editor's own kinds. A GROUP: its name and
	// the names of its sockets (renaming a socket keeps the wire — the name is a label on
	// the inner endpoint it stands for). A NOTE: its title, its markdown description
	// (rendered on the card) and its colour. Every change is ONE undoable, replicated edit.
	import { setNodeData } from '$lib/nodesHandler';
	import { recordFlowNodesEntry } from '$lib/flowGraphs';
	import { NOTE_COLORS } from '$lib/noteColors';

	/** @type {{node: any, graphId: string, onOpen?: (id: string) => void, onUngroup?: (id: string) => void}} */
	let { node, graphId, onOpen = () => {}, onUngroup = () => {} } = $props();

	const isGroup = $derived(node?.type === 'group');

	/** @param {Record<string, any>} patch */
	function commit(patch) {
		/** @type {Record<string, any>} */
		const before = {};
		for (const key of Object.keys(patch)) before[key] = node.data?.[key] === undefined ? undefined : structuredClone(node.data[key]);
		setNodeData(node.id, patch, graphId);
		recordFlowNodesEntry({ op: 'data', graphId, items: [{ id: node.id, before, after: patch }] });
	}

	/** @param {'inputs'|'outputs'} list @param {number} index @param {string} name */
	function renameSocket(list, index, name) {
		const next = (node.data?.[list] ?? []).map((/** @type {any} */ e, /** @type {number} */ i) =>
			i === index ? { ...e, name: name.trim() || e.name } : e
		);
		commit({ [list]: next });
	}

	/** @param {'inputs'|'outputs'} list @param {number} index */
	function removeSocket(list, index) {
		commit({ [list]: (node.data?.[list] ?? []).filter((/** @type {any} */ _e, /** @type {number} */ i) => i !== index) });
	}
</script>

{#if isGroup}
	<p class="ui-section-label">Group</p>
	<label class="flex flex-col gap-1"
		>Name
		<input
			id="flow-group-name"
			class="ui-input"
			value={node.data?.label ?? 'Group'}
			onchange={(e) => commit({ label: e.currentTarget.value.trim() || 'Group' })}
		/></label
	>
	<p class="text-[11px] text-text-muted">{(node.data?.children ?? []).length} nodes inside</p>
	<div class="flex gap-1">
		<button id="flow-group-open" class="flex-1 rounded-sm bg-surface-active px-2 py-1 hover:bg-border-strong" onclick={() => onOpen(node.id)}
			>Open</button
		>
		<button id="flow-group-ungroup" class="flex-1 rounded-sm bg-surface-active px-2 py-1 hover:bg-border-strong" onclick={() => onUngroup(node.id)}
			>Ungroup</button
		>
	</div>
	{#each [['inputs', 'Inputs'], ['outputs', 'Outputs']] as [list, title] (list)}
		<p class="ui-section-label mt-1">{title}</p>
		{#each node.data?.[list] ?? [] as entry, i (entry.key)}
			<div class="flex items-center gap-1" data-socket-key={entry.key}>
				<input
					class="ui-input flex-1 group-socket-input"
					data-list={list}
					value={entry.name}
					title={'Stands for ' + (list === 'inputs' ? entry.to?.join('.') : entry.from?.join('.'))}
					onchange={(e) => renameSocket(/** @type {any} */ (list), i, e.currentTarget.value)}
				/>
				<span class="text-[10px] text-text-faint">{entry.type ?? 'any'}</span>
				<button
					class="rounded-sm bg-surface-active px-1.5 hover:bg-danger hover:text-on-danger"
					title="Hide this socket (a wire still crossing the boundary brings it back)"
					aria-label="Remove socket"
					onclick={() => removeSocket(/** @type {any} */ (list), i)}>✕</button
				>
			</div>
		{:else}
			<p class="text-[11px] text-text-faint">None — wires that cross the group's edge appear here.</p>
		{/each}
	{/each}
{:else}
	<p class="ui-section-label">Note</p>
	<label class="flex flex-col gap-1"
		>Title
		<input
			id="flow-note-title"
			class="ui-input"
			value={node.data?.title ?? 'Note'}
			onchange={(e) => commit({ title: e.currentTarget.value, label: e.currentTarget.value || 'Note' })}
		/></label
	>
	<label class="flex flex-col gap-1"
		>Description (markdown)
		<textarea
			id="flow-note-text"
			class="ui-input font-mono"
			rows="8"
			placeholder={'# Heading\n- a list\n**bold**, *italic*, `code`, [link](https://…)'}
			value={node.data?.text ?? ''}
			onchange={(e) => commit({ text: e.currentTarget.value })}
		></textarea></label
	>
	<p class="ui-section-label">Colour</p>
	<div id="flow-note-colors" class="flex flex-wrap gap-1.5">
		{#each NOTE_COLORS as color (color)}
			<button
				class="note-swatch tp-note-{color}"
				class:active={(node.data?.color ?? 'yellow') === color}
				data-color={color}
				title={color}
				aria-label={'Note colour ' + color}
				aria-pressed={(node.data?.color ?? 'yellow') === color}
				onclick={() => commit({ color })}
			></button>
		{/each}
	</div>
	{#if node.data?.frame?.length}
		<p class="text-[11px] text-text-muted">Frames {node.data.frame.length} node{node.data.frame.length === 1 ? '' : 's'} — dragging the note carries them.</p>
	{/if}
{/if}

<style>
	.note-swatch {
		width: 20px;
		height: 20px;
		border-radius: 9999px;
		border: 2px solid var(--border-strong);
		background: rgb(var(--note-rgb) / 0.85);
	}
	.note-swatch.active {
		border-color: var(--text);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.tp-note-yellow { --note-rgb: var(--note-yellow, 234 179 8); }
	.tp-note-blue { --note-rgb: var(--note-blue, 59 130 246); }
	.tp-note-green { --note-rgb: var(--note-green, 34 197 94); }
	.tp-note-pink { --note-rgb: var(--note-pink, 236 72 153); }
	.tp-note-purple { --note-rgb: var(--note-purple, 168 85 247); }
	.tp-note-gray { --note-rgb: var(--note-gray, 148 163 184); }
</style>
