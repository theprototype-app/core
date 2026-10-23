<script>
	// 47-cc0 (C1/C2) — THE ASSET BROWSER: free CC0 models, skies and textures from Poly Haven and
	// PBR materials from ambientCG, searchable by name and category, at a resolution you pick (1k on
	// a Quest or a phone, 2k on a desktop by default). It is a floating window that docks like the
	// other hosted windows ($lib/dockHost 'assets') and becomes a bottom sheet on a phone.
	//
	// Presentation only: the lists come through $lib/cc0/cc0Fetch (the LOCAL response cache), and
	// every download lands through $lib/cc0/cc0Import — the Explorer's own import entry for files,
	// the environment picker's write for a sky, the material preset library for a material.
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { focusStack } from '$lib/windowFocus';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		assetBrowserOpen,
		assetBrowserKind,
		assetBrowserRes
	} from '$lib/cc0/assetBrowserState.js';
	import {
		CC0_KINDS,
		CC0_SITES,
		RESOLUTIONS,
		ACG_PAGE,
		normalizePolyHaven,
		normalizeAmbientCg,
		ambientCgTotal,
		normalizePhCategories,
		normalizeAcgCategories,
		filterRows,
		creditLine
	} from '$lib/cc0/cc0Core.js';
	import {
		phList,
		phCategories,
		acgPage,
		acgCategories,
		forgetCc0Memo
	} from '$lib/cc0/cc0Fetch.js';
	import {
		importCc0,
		cc0Jobs,
		rowKey,
		heldItemFor,
		placeItem,
		applyPresetToSelection,
		errorText
	} from '$lib/cc0/cc0Import.js';
	import { explorerItems, revealItem } from '$lib/explorer';
	import { editEnvSky } from '$lib/environment';
	import { materialPresets } from '$lib/materialPresets';
	import { selectedObjects } from '../../stores/sceneStore';
	import { showToast, explorerClose } from '../../stores/appStore';
	import { untrack } from 'svelte';

	/** the first page of a Poly Haven list (they arrive whole) and each "Show more" */
	const PAGE = 60;

	const kind = $derived(CC0_KINDS.find((k) => k.key === $assetBrowserKind) ?? CC0_KINDS[0]);
	let query = $state('');
	let category = $state('');
	/** @type {any[]} */
	let rows = $state.raw([]);
	/** @type {{id: string, label: string, count: number}[]} */
	let categories = $state.raw([]);
	let loading = $state(false);
	/** a list that could not load at all: what to tell the person */
	let listError = $state('');
	/** the list is a saved answer: when it was taken, and why we fell back to it */
	let staleAt = $state(0);
	let staleWhy = $state('');
	let shown = $state(PAGE);
	let acgTotal = $state(0);
	/** key -> a card's last error */
	/** @type {Record<string, string>} */
	let cardError = $state({});
	let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
	/** a load in flight is superseded by the next one (tab switch, a new search) */
	let ticket = 0;

	/** 57 M5: the Avatars tab lists CC-BY collections only when asked (their credit is kept) */
	let includeCcBy = $state(false);
	const listed = $derived(kind.source === 'polyhaven' || kind.source === 'osa');
	const filtered = $derived(listed ? filterRows(rows, { query, category }) : rows);
	const visible = $derived(listed ? filtered.slice(0, shown) : filtered);
	const more = $derived(listed ? filtered.length > shown : rows.length < acgTotal);
	const selectionCount = $derived(($selectedObjects ?? []).length);

	/** @param {boolean} [fresh] */
	async function load(fresh = false) {
		const my = ++ticket;
		loading = true;
		listError = '';
		staleAt = 0;
		staleWhy = '';
		try {
			if (kind.source === 'polyhaven') {
				const [list, cats] = await Promise.all([
					phList(kind.phType ?? '', fresh),
					phCategories(kind.phType ?? '', fresh).catch(() => null)
				]);
				if (my !== ticket) return;
				rows = normalizePolyHaven(list.data, /** @type {any} */ (kind.key));
				categories = cats ? normalizePhCategories(cats.data) : [];
				noteStale(list);
			} else if (kind.source === 'osa') {
				// 57 M5: the Open Source Avatars registry (VRM avatars; CC0 unless CC-BY is asked for)
				const { osaList } = await import('$lib/avatars/osaRegistry.js');
				const list = await osaList({ fresh, includeCcBy });
				if (my !== ticket) return;
				rows = list.rows;
				categories = list.categories;
				noteStale(list);
			} else {
				const [page, cats] = await Promise.all([
					acgPage({ query: query.trim(), category, fresh }),
					acgCategories(fresh).catch(() => null)
				]);
				if (my !== ticket) return;
				rows = normalizeAmbientCg(page.data);
				acgTotal = ambientCgTotal(page.data);
				categories = cats ? normalizeAcgCategories(cats.data) : categories;
				noteStale(page);
			}
		} catch (err) {
			if (my !== ticket) return;
			rows = [];
			listError = errorText(err);
		} finally {
			if (my === ticket) loading = false;
		}
	}
	/** @param {any} r */
	function noteStale(r) {
		if (!r?.stale) return;
		staleAt = r.at;
		staleWhy = r.error?.message ?? '';
	}

	async function loadMoreAcg() {
		const my = ticket;
		loading = true;
		try {
			const page = await acgPage({ query: query.trim(), category, offset: rows.length });
			if (my !== ticket) return;
			rows = [...rows, ...normalizeAmbientCg(page.data)];
			acgTotal = ambientCgTotal(page.data);
		} catch (err) {
			showToast(errorText(err));
		} finally {
			if (my === ticket) loading = false;
		}
	}

	// a tab switch (or opening the window) loads that tab; the search/category reset with it
	$effect(() => {
		void $assetBrowserKind;
		untrack(() => {
			query = '';
			category = '';
			shown = PAGE;
			rows = [];
			categories = [];
			load();
		});
	});

	// ambientCG searches on the server: a typed query re-asks after a pause, a category at once
	let searchTimer = 0;
	/** @param {string} v */
	function onSearch(v) {
		query = v;
		shown = PAGE;
		if (kind.source !== 'ambientcg') return;
		clearTimeout(searchTimer);
		searchTimer = window.setTimeout(() => load(), 350);
	}
	/** @param {string} v */
	function onCategory(v) {
		category = v ?? '';
		shown = PAGE;
		if (kind.source === 'ambientcg') load();
	}

	function refresh() {
		forgetCc0Memo();
		load(true);
	}

	$effect(() => {
		const up = () => (online = true);
		const down = () => (online = false);
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		return () => {
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
			clearTimeout(searchTimer);
		};
	});

	/** the preset this browser made for a material row, if it is still in the library
	 * @param {any} row @param {any[]} list */
	function heldPreset(row, list) {
		return (
			list.find(
				(p) => p.payload?.source?.site === row.source && p.payload?.source?.id === row.id
			) ?? null
		);
	}
	/** @param {any} row @param {any[]} _items (an unused argument so the card re-derives on a Library change) */
	const heldItem = (row, _items) => heldItemFor(row);

	/** @param {any} row @param {any} [opts] */
	async function bring(row, opts = {}) {
		const key = rowKey(row);
		cardError = { ...cardError, [key]: '' };
		try {
			const made = await importCc0(row, $assetBrowserRes, opts);
			if (made.item) {
				if (row.kind === 'hdris')
					showToast(
						(opts.applySky === false ? 'Added ' : 'Lighting the scene with ') + made.item.name
					);
				else
					showToast('Added ' + made.item.name + ' to the Library', [
						{ label: 'Show', action: () => show(made.item) }
					]);
			} else if (made.preset) {
				showToast(
					'Saved ' +
						made.preset.name +
						' to your materials' +
						(opts.applyToSelection && selectionCount ? ' and applied it' : '')
				);
			}
			return made;
		} catch (err) {
			const message = errorText(err);
			cardError = { ...cardError, [key]: message };
			return null;
		}
	}

	/** @param {any} item */
	function show(item) {
		explorerClose.set(false);
		revealItem(item.id);
	}

	/** @param {any} row */
	async function place(row) {
		const held = heldItemFor(row) ?? (await bring(row))?.item;
		if (held) await placeItem(held);
	}

	/** 57 M5: an avatar goes straight into the scene as a VRM character, its credit kept @type {Record<string, boolean>} */
	let placing = $state({});
	/** @param {any} row */
	async function placeAvatar(row) {
		const key = rowKey(row);
		placing = { ...placing, [key]: true };
		cardError = { ...cardError, [key]: '' };
		try {
			const res = await fetch(row.vrm);
			if (!res.ok) throw new Error('the avatar file is unreachable (HTTP ' + res.status + ')');
			const bytes = await res.arrayBuffer();
			const { importFile } = await import('$lib/fileHandler.svelte.js');
			const { osaProvenance } = await import('$lib/avatars/osaRegistry.js');
			const uuid = await importFile(
				new File([bytes], row.name + '.vrm'),
				row.name,
				'vrm',
				undefined,
				undefined,
				{ provenance: osaProvenance(row) }
			);
			if (uuid)
				showToast(
					'Placed ' +
						row.name +
						(row.licence === 'CC0-1.0'
							? ' (CC0)'
							: ' — ' +
								row.licence +
								': credit ' +
								(row.authors[0] || row.project) +
								' where you share it')
				);
		} catch (err) {
			cardError = { ...cardError, [key]: errorText(err) };
		} finally {
			placing = { ...placing, [key]: false };
		}
	}

	/** @param {any} row */
	async function useSky(row) {
		const held = heldItemFor(row);
		if (held?.hash) {
			editEnvSky({ hdri: { src: 'hash:' + held.hash, name: held.name } });
			showToast('Lighting the scene with ' + held.name);
			return;
		}
		await bring(row, { applySky: true });
	}

	/** @param {any} row @param {any} preset */
	async function applyMaterial(row, preset) {
		if (!selectionCount) {
			showToast('Select an object first, then apply the material');
			return;
		}
		if (preset) {
			const n = await applyPresetToSelection(preset.payload ?? preset);
			if (n) showToast('Applied ' + (preset.name ?? preset.label));
			return;
		}
		await bring(row, { applyToSelection: true });
	}

	/** @param {number} n */
	function mb(n) {
		return n ? (n / 1048576).toFixed(1) + ' MB' : '';
	}
	/** @param {number} at */
	function when(at) {
		try {
			return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
		} catch {
			return '';
		}
	}
</script>

{#if $assetBrowserOpen}
	<div
		id="asset-browser-window"
		class="ui-panel tp-ui tp-window tp-themed fixed flex flex-col overflow-hidden outline-hidden"
		tabindex="-1"
		use:dragWindow={{
			key: 'assetBrowserWindow',
			defaultRect: { left: 160, top: 96 },
			resizable: true,
			minW: 300,
			minH: 260
		}}
		use:bottomDockable={{ key: 'assets' }}
		use:focusStack={'assets'}
		style="z-index: var(--z-window); width: 560px; height: 600px"
		data-keywords="cc0 free assets poly haven ambientcg models hdri sky textures materials download avatars vrm characters"
	>
		<div
			data-sb-headless
			class="ui-panel-header move-handle flex shrink-0 cursor-move items-center gap-2 py-1.5 select-none"
		>
			<Icon name="package-open" size={16} aria-hidden="true" />
			<span class="flex-1 text-sm font-semibold">Free assets (CC0)</span>
			<button
				id="asset-browser-refresh"
				class="rounded-sm p-1 hover:brightness-150"
				title="Ask the sites again (skips the saved answer)"
				aria-label="Refresh"
				onclick={refresh}><Icon name="refresh-cw" size={16} aria-hidden="true" /></button
			>
			<button
				id="asset-browser-close"
				class="rounded-sm p-1 hover:brightness-150"
				title="Close"
				aria-label="Close the asset browser"
				onclick={() => assetBrowserOpen.set(false)}
				><Icon name="x" size={16} aria-hidden="true" /></button
			>
		</div>

		<div class="ab-top shrink-0 px-2 pt-1">
			<Tabs
				idPrefix="asset-browser"
				label="Asset kind"
				tabs={CC0_KINDS.map((k) => ({ id: k.key, label: k.label }))}
				value={$assetBrowserKind}
				onchange={(v) => assetBrowserKind.set(v)}
			/>
			<div class="ab-filters">
				<SearchField
					id="asset-browser-search"
					size="sm"
					value={query}
					placeholder={'Search ' + kind.label.toLowerCase()}
					label="Search assets"
					oninput={onSearch}
					onclear={() => onSearch('')}
				/>
				<ThemedSelect
					id="asset-browser-category"
					class="ab-cat"
					clip={false}
					value={category}
					placeholder="All categories"
					items={[
						{ value: '', name: 'All categories' },
						...categories.map((c) => ({ value: c.id, name: c.label + ' (' + c.count + ')' }))
					]}
					onchange={onCategory}
				/>
				<Segmented
					id="asset-browser-res"
					label="Resolution"
					options={RESOLUTIONS.map((r) => ({
						value: r,
						label: r,
						title:
							r === '1k'
								? 'Small files — right for a Quest or a phone'
								: r === '2k'
									? 'The desktop default'
									: 'Big files: slow to share with peers'
					}))}
					value={$assetBrowserRes}
					onchange={(v) => assetBrowserRes.set(v)}
				/>
				{#if kind.source === 'osa'}
					<label
						class="ab-ccby"
						title="CC-BY collections need a credit: the avatar keeps it, and Export / Publish remind you"
					>
						<input
							id="asset-browser-ccby"
							type="checkbox"
							class="tp-check"
							bind:checked={includeCcBy}
							onchange={() => load()}
						/> Include CC-BY
					</label>
				{/if}
			</div>
		</div>

		{#if !online || staleAt}
			<p id="asset-browser-stale" class="ab-banner" role="status">
				<Icon name="wifi-off" size={16} aria-hidden="true" />
				<span
					>{!online ? 'You are offline. ' : ''}{staleAt
						? 'Showing the list saved ' + when(staleAt) + '.'
						: ''}
					{!online ? 'Downloads need a connection.' : staleWhy}</span
				>
			</p>
		{/if}

		<div
			id="asset-browser-grid-wrap"
			class="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
			use:minimalScroll
		>
			{#if listError}
				<div id="asset-browser-status" class="ab-error" role="alert" data-state="error">
					<Icon name="circle-alert" size={20} aria-hidden="true" />
					<p>{listError}</p>
					<Button variant="secondary" size="sm" icon="refresh-cw" onclick={refresh}
						>Try again</Button
					>
				</div>
			{:else if loading && !rows.length}
				<p id="asset-browser-status" class="ab-muted" data-state="loading">
					<Icon name="loader-circle" size={16} aria-hidden="true" /> Loading {kind.label.toLowerCase()}…
				</p>
			{:else if !visible.length}
				<p id="asset-browser-status" class="ab-muted" data-state="empty">
					Nothing matches{query ? ' “' + query + '”' : ''}. Try another word or category.
				</p>
			{/if}

			<ul id="asset-browser-grid" class="ab-grid" data-kind={kind.key} data-count={visible.length}>
				{#each visible as row (rowKey(row))}
					{@const key = rowKey(row)}
					{@const job = $cc0Jobs[key]}
					{@const item =
						row.kind === 'models' || row.kind === 'hdris' ? heldItem(row, $explorerItems) : null}
					{@const preset =
						row.kind === 'textures' || row.kind === 'materials'
							? heldPreset(row, $materialPresets)
							: null}
					<li
						class="ab-card"
						data-asset-id={row.id}
						data-kind={row.kind}
						data-held={item || preset ? 'true' : 'false'}
						title={creditLine({ site: row.source, ...row })}
					>
						<div class="ab-thumb">
							{#if row.thumb}
								<img
									src={row.thumb}
									alt=""
									loading="lazy"
									referrerpolicy="no-referrer"
									onerror={(e) => /** @type {any} */ (e.currentTarget).classList.add('ab-noimg')}
								/>
							{/if}
							{#if item || preset}<span class="ab-held" title="In your library"
									><Icon name="check" size={16} aria-hidden="true" /></span
								>{/if}
						</div>
						<p class="ab-name">{row.name}</p>
						<p class="ab-by">
							{row.authors.join(', ') ||
								CC0_SITES[/** @type {'polyhaven'|'ambientcg'} */ (row.source)].label}{row.source ===
							'osa'
								? ' · ' + (row.licence === 'CC0-1.0' ? 'CC0' : row.licence)
								: ''}
						</p>
						{#if job}
							<div
								class="ab-progress"
								role="progressbar"
								aria-valuemin="0"
								aria-valuemax={job.total || 100}
								aria-valuenow={job.done}
								data-phase={job.phase}
							>
								<span
									style:width={job.total
										? Math.min(100, (job.done / job.total) * 100) + '%'
										: '30%'}
								></span>
							</div>
							<p class="ab-phase">
								{job.phase}
								{job.total ? mb(job.done) + ' / ' + mb(job.total) : ''}
							</p>
						{:else}
							<div class="ab-acts">
								{#if row.kind === 'avatars'}
									<Button
										variant="primary"
										size="sm"
										full
										icon="person-standing"
										data-act="place-avatar"
										disabled={!!placing[key]}
										onclick={() => placeAvatar(row)}
										>{placing[key] ? 'Placing…' : 'Add to scene'}</Button
									>
								{:else if row.kind === 'models'}
									{#if item}
										<Button
											variant="primary"
											size="sm"
											full
											data-act="place"
											onclick={() => place(row)}>Add to scene</Button
										>
										<Button
											variant="ghost"
											size="sm"
											full
											data-act="show"
											title="Show it in the Explorer"
											onclick={() => show(item)}>Library</Button
										>
									{:else}
										<Button
											variant="secondary"
											size="sm"
											full
											icon="download"
											data-act="library"
											onclick={() => bring(row)}>Add to Library</Button
										>
									{/if}
								{:else if row.kind === 'hdris'}
									<Button
										variant={item ? 'primary' : 'secondary'}
										size="sm"
										full
										icon="sun"
										data-act="sky"
										onclick={() => useSky(row)}>Use as sky</Button
									>
								{:else}
									{#if !preset}
										<Button
											variant="secondary"
											size="sm"
											icon="download"
											data-act="library"
											title="Save it to your material presets"
											onclick={() => bring(row)}>Add</Button
										>
									{/if}
									<Button
										variant={preset ? 'primary' : 'secondary'}
										size="sm"
										icon="palette"
										data-act="apply"
										disabled={!selectionCount}
										title={selectionCount
											? 'Put it on the selected object' + (selectionCount > 1 ? 's' : '')
											: 'Select an object first'}
										onclick={() => applyMaterial(row, preset)}>Apply</Button
									>
								{/if}
							</div>
						{/if}
						{#if cardError[key]}<p class="ab-card-error" role="alert">{cardError[key]}</p>{/if}
					</li>
				{/each}
			</ul>
			{#if more && !listError}
				<div class="flex justify-center py-2">
					<Button
						id="asset-browser-more"
						variant="ghost"
						size="sm"
						disabled={loading}
						onclick={() => (kind.source === 'polyhaven' ? (shown += PAGE) : loadMoreAcg())}
						>Show more</Button
					>
				</div>
			{/if}
		</div>

		<p class="ab-foot shrink-0">
			Every asset here is <strong>CC0</strong> (public domain) —
			<a href={CC0_SITES.polyhaven.home} target="_blank" rel="noopener noreferrer">Poly Haven</a>
			and
			<a href={CC0_SITES.ambientcg.home} target="_blank" rel="noopener noreferrer">ambientCG</a
			>{kind.source === 'osa' ? '' : '.'} Credits stay with each file.
			{#if kind.source === 'osa'}Avatars: the <a
					href={CC0_SITES.osa.home}
					target="_blank"
					rel="noopener noreferrer">Open Source Avatars</a
				> registry — CC0 collections, CC-BY ones on request (their credit is kept).{/if}
		</p>
	</div>
{/if}

<style>
	.ab-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px 0 4px;
	}
	.ab-ccby {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--text-muted);
	}
	.ab-filters :global(.ab-cat) {
		min-width: 120px;
		flex: 1 1 140px;
	}
	.ab-banner {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 8px;
		padding: 4px 8px;
		border-radius: var(--radius-card, 6px);
		background: var(--surface-2);
		color: var(--text-muted);
		font-size: 11px;
	}
	.ab-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
		gap: 8px;
	}
	.ab-card {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 4px;
		border-radius: var(--radius-card, 6px);
		background: var(--surface-2);
		border: 1px solid var(--border);
	}
	.ab-thumb {
		position: relative;
		aspect-ratio: 1 / 1;
		border-radius: 4px;
		overflow: hidden;
		background: var(--surface-3, var(--surface-2));
	}
	.ab-card[data-kind='hdris'] .ab-thumb {
		aspect-ratio: 2 / 1;
	}
	.ab-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.ab-thumb img:global(.ab-noimg) {
		visibility: hidden;
	}
	.ab-held {
		position: absolute;
		top: 4px;
		right: 4px;
		display: flex;
		padding: 2px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
	}
	.ab-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ab-by,
	.ab-phase,
	.ab-muted,
	.ab-foot {
		font-size: 11px;
		color: var(--text-muted);
	}
	.ab-by {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ab-acts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
		min-width: 0;
	}
	.ab-acts > :global(*) {
		flex: 1 1 0;
		min-width: 0;
	}
	.ab-progress {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
		margin-top: 4px;
	}
	.ab-progress span {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 120ms linear;
	}
	.ab-card-error {
		font-size: 11px;
		color: var(--ink-bad);
	}
	.ab-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 18px 12px;
		text-align: center;
		color: var(--ink-bad);
		font-size: 12px;
	}
	.ab-muted {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 4px;
	}
	.ab-foot {
		padding: 6px 10px 8px;
		border-top: 1px solid var(--border);
	}
	.ab-foot a {
		color: var(--accent);
		text-decoration: underline;
	}
	/* a phone: a bottom sheet over the bar (the main menu's and the profile menu's rule) */
	:global(:root.phone-shell) #asset-browser-window {
		position: fixed !important;
		top: auto !important;
		left: 0 !important;
		right: 0 !important;
		bottom: var(--ps-bar-h, 0px) !important;
		width: auto !important;
		height: var(--ps-sheet-max, 78vh) !important;
		max-height: var(--ps-sheet-max, 92vh) !important;
		border-radius: 18px 18px 0 0 !important;
	}
	:global(:root.phone-shell) #asset-browser-window .ab-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
</style>
