<script>
	// The shader palette (plan SH3), the node editor's Sidebar.svelte shape: grouped
	// entries, click/tap to add at the pane centre, native HTML5 drag to place. Touch
	// has no HTML5 drag, so a tap is the touch path — same reasoning as the flow palette.
	import { shaderNodeDefs, SURFACE_NODE } from '$lib/shaderCatalog';

	let { onPick = (/** @type {string} */ _key) => {} } = $props();

	// the Surface output is created with the graph and there is exactly one, so it is
	// not something you add
	const defs = shaderNodeDefs().filter((def) => def.key !== SURFACE_NODE);
	const groups = [...new Set(defs.map((def) => def.group))];

	/** @type {Record<string, string>} */
	const GROUP_ACCENT = {
		Input: '#38bdf8',
		Math: '#2dd4bf',
		Channel: '#facc15',
		UV: '#4ade80',
		Utility: '#c084fc',
		Output: '#fb923c'
	};

	/** @param {DragEvent} event @param {string} key */
	function onDragStart(event, key) {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData('application/shadernode', key);
		event.dataTransfer.effectAllowed = 'move';
	}
</script>

<div class="shader-palette-list" id="shader-palette">
	{#each groups as group (group)}
		<div class="shader-palette-group">
			<span class="dot" style="background: {GROUP_ACCENT[group] ?? '#94a3b8'}"></span>
			{group}
		</div>
		{#each defs.filter((d) => d.group === group) as def (def.key)}
			<button
				class="shader-palette-item"
				draggable="true"
				title={def.key}
				ondragstart={(e) => onDragStart(e, def.key)}
				onclick={() => onPick(def.key)}
			>
				{def.label}
			</button>
		{/each}
	{/each}
</div>

<style>
	.shader-palette-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px;
		touch-action: pan-y;
	}
	.shader-palette-group {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #6b7280;
		padding: 6px 4px 2px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		flex: 0 0 auto;
	}
	.shader-palette-item {
		text-align: left;
		font-size: 11px;
		color: #e5e7eb;
		padding: 3px 6px;
		border-radius: 3px;
		cursor: grab;
	}
	.shader-palette-item:hover {
		background: rgba(255, 255, 255, 0.08);
	}
</style>
