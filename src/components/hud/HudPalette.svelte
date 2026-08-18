<script>
	// 21-D2 — the "add an element" palette, in the left sidebar BELOW the screens list.
	//
	// `ShaderSidebar.svelte`'s shape, which is itself the node editor's `Sidebar.svelte`
	// shape: grouped entries with a group accent dot, click/tap to add, native HTML5 drag to
	// place. Touch has no HTML5 drag, so a tap is the touch path — same reasoning as both
	// existing palettes.
	//
	// The entries come from `hudKinds.paletteGroups()`, so a new kind appears here with no
	// edit at all. The topbar keeps only the four most-used kinds as shortcuts.
	import { paletteGroups } from '$lib/hudKinds';
	import Icon from '../ui/Icon.svelte';

	/** @type {{ onPick: (kind: string) => void }} */
	let { onPick } = $props();

	/** the same group colours the properties pane and the artboard badges use */
	/** @type {Record<string, string>} */
	const GROUP_ACCENT = { Display: '#38bdf8', Input: '#f0abfc', Layout: '#4ade80' };

	let filter = $state('');
	const groups = $derived(
		paletteGroups()
			.map((entry) => ({
				...entry,
				items: entry.items.filter(
					(def) =>
						!filter.trim() ||
						(def.label + ' ' + def.key + ' ' + entry.group).toLowerCase().includes(filter.trim().toLowerCase())
				)
			}))
			.filter((entry) => entry.items.length > 0)
	);
</script>

<div id="hud-palette" class="hud-pal">
	<input
		id="hud-palette-filter"
		class="hud-pal-filter"
		placeholder="Filter elements…"
		value={filter}
		oninput={(/** @type {any} */ e) => (filter = e.currentTarget.value)}
	/>
	<p class="hud-pal-hint">Drag onto the board, or click to add it.</p>
	{#each groups as entry (entry.group)}
		<p class="hud-pal-group">
			<span class="hud-pal-dot" style="background: {GROUP_ACCENT[entry.group] ?? '#94a3b8'}"></span>
			{entry.group}
		</p>
		{#each entry.items as def (def.key)}
			<button
				class="hud-pal-item"
				data-hud-kind={def.key}
				draggable="true"
				title={def.summary}
				ondragstart={(/** @type {any} */ e) => e.dataTransfer?.setData('application/x-hud-kind', def.key)}
				onclick={() => onPick(def.key)}
			>
				<Icon name={def.icon} size={13} />
				<span>{def.label}</span>
			</button>
		{/each}
	{/each}
	{#if !groups.length}
		<p class="hud-pal-hint">No element matches “{filter}”.</p>
	{/if}
</div>

<style>
	.hud-pal {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.375rem;
		/* pan-y is what lets a touch DRAG be told apart from a scroll */
		touch-action: pan-y;
	}
	.hud-pal-filter {
		border-radius: 0.2rem;
		background: rgb(17 24 39 / 0.6);
		padding: 0.15rem 0.35rem;
		font-size: 11px;
	}
	.hud-pal-hint {
		padding: 0.1rem 0;
		font-size: 10px;
		font-style: italic;
		opacity: 0.55;
	}
	.hud-pal-group {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-top: 0.3rem;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.65;
	}
	.hud-pal-dot {
		height: 6px;
		width: 6px;
		border-radius: 999px;
	}
	.hud-pal-item {
		display: flex;
		cursor: grab;
		align-items: center;
		gap: 0.4rem;
		border-radius: 0.25rem;
		border: 1px solid rgb(75 85 99 / 0.45);
		background: rgb(31 41 55 / 0.5);
		padding: 0.2rem 0.35rem;
		text-align: left;
		font-size: 11px;
	}
	.hud-pal-item:hover {
		border-color: var(--accent, #ef562f);
		background: rgb(55 65 81 / 0.7);
	}
</style>
