<script>
	// 36 U9 — "Replace model…" for a loading/failed placeholder: pick a pack item (replaces
	// IN PLACE — same object, same pose, refilled on every peer) or a library model (imported
	// at the placeholder's pose; a new object). Non-modal like every panel-shaped dialog.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { packs, loadPacks, listPackItems } from '$lib/packs';
	import { explorerItems } from '$lib/explorer';
	import { replaceModelTarget, replaceWithPackItem, replaceWithLibraryItem } from '$lib/replaceModel';
	import ThemedSelect from '../ui/ThemedSelect.svelte';

	let open = $state(false);
	let source = $state('library');
	let query = $state('');
	/** @type {any[]} */
	let packItems = $state.raw([]);
	let loading = $state(false);
	let busy = $state(false);
	/** the person picked a source themselves (stop defaulting to the first pack) */
	let touched = false;

	$effect(() => {
		open = !!$replaceModelTarget;
	});
	$effect(() => {
		if (open && !$packs.length) loadPacks();
	});
	// default to the first default pack once the list exists (pieces mostly come from packs)
	$effect(() => {
		if (open && source === 'library' && $packs.length && !touched) source = 'pack:' + $packs[0].name;
	});

	$effect(() => {
		const name = source.startsWith('pack:') ? source.slice(5) : null;
		if (!name) return;
		const pack = $packs.find((/** @type {any} */ p) => p.name === name);
		if (!pack) return;
		loading = true;
		listPackItems(pack)
			.then((items) => {
				if (source === 'pack:' + name) packItems = items;
			})
			.finally(() => (loading = false));
	});

	const sources = $derived([
		{ value: 'library', name: 'Library models' },
		...$packs.map((/** @type {any} */ p) => ({ value: 'pack:' + p.name, name: p.title || p.name }))
	]);
	/** @type {any[]} */
	const rows = $derived.by(() => {
		const q = query.trim().toLowerCase();
		/** @type {any[]} */
		let list;
		if (source === 'library') {
			list = $explorerItems.filter((/** @type {any} */ i) => i.kind === 'object').map((/** @type {any} */ i) => ({ key: i.id, label: i.name, thumb: i.thumbnail, lib: i }));
		} else {
			list = packItems
				// an animated (functional) item replicates as bytes, never a reference
				.filter((/** @type {any} */ i) => !i.behavior)
				.map((/** @type {any} */ i) => (i.glbUrl ? { key: i.glbUrl, label: i.label || i.name, thumb: i.resolvedThumb || i.thumbs?.[0], pack: i } : { key: i.id, label: i.name, thumb: i.thumbnail, lib: i }));
		}
		return q ? list.filter((r) => String(r.label).toLowerCase().includes(q)) : list;
	});

	function close() {
		replaceModelTarget.set(null);
	}
	/** @param {any} row */
	async function choose(row) {
		const uuid = $replaceModelTarget;
		if (!uuid || busy) return;
		busy = true;
		try {
			if (row.pack) replaceWithPackItem(uuid, row.pack);
			else await replaceWithLibraryItem(uuid, row.lib);
		} finally {
			busy = false;
			close();
		}
	}
</script>

<ModalDialog
	title="Replace model"
	bind:open
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	oncancel={close}
	outsideclose
	width="md"
>
	<div id="replace-model" class="flex flex-col gap-2 text-sm">
		<p class="text-xs opacity-80">
			Pick what goes where the placeholder is. A pack item keeps the object (its links, notes and flows) and loads on every peer; a library model is added as a new object.
		</p>
		<div class="flex gap-2">
			<div class="w-1/2">
				<ThemedSelect id="replace-model-source" items={sources} bind:value={source} onchange={() => (touched = true)} />
			</div>
			<input id="replace-model-search" class="ui-input w-1/2" type="text" placeholder="Search…" bind:value={query} />
		</div>
		<div class="replace-grid" data-count={rows.length} use:minimalScroll>
			{#if loading}
				<p class="col-span-full p-2 text-xs opacity-70">Loading the pack…</p>
			{:else if !rows.length}
				<p class="col-span-full p-2 text-xs opacity-70">Nothing here{query ? ' matches "' + query + '"' : ''}.</p>
			{/if}
			{#each rows as row (row.key)}
				<button class="replace-card" data-key={row.key} title={row.label} disabled={busy} onclick={() => choose(row)}>
					{#if row.thumb}
						<img src={row.thumb} alt="" loading="lazy" />
					{:else}
						<span class="replace-noimg" aria-hidden="true"></span>
					{/if}
					<span class="replace-label">{row.label}</span>
				</button>
			{/each}
		</div>
	</div>
</ModalDialog>

<style>
	.replace-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
		gap: 6px;
		max-height: 50vh;
		overflow-y: auto;
	}
	.replace-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 6px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--surface-inset);
		color: var(--text);
		cursor: pointer;
	}
	.replace-card:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.replace-card img,
	.replace-noimg {
		width: 72px;
		height: 72px;
		object-fit: contain;
		border-radius: 4px;
		background: var(--bg-app);
	}
	.replace-label {
		font-size: 11px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
