<script>
	// Templates modal ("Templates" sidebar row): General / Examples / Community tabs
	// of loadable starting scenes. Content + storage architecture documented in
	// $lib/sceneTemplates.js — this file is presentation only. Runes-mode.
	import { untrack } from 'svelte';
	import { Modal } from 'flowbite-svelte';
	import { FilePlus, Image as ImageIcon, RefreshCw } from '@lucide/svelte';
	import { templatesModalOpen, hidePanels, restorePanels } from '../../stores/appStore.js';
	import {
		templates,
		examples,
		templatesState,
		communityEntries,
		communityState,
		loadingSlug,
		loadTemplatesIndex,
		loadCommunityGallery,
		loadRemoteScene,
		confirmClearScene,
		SUBMIT_URL
	} from '$lib/sceneTemplates';
	import { licenseLabel } from '$lib/packs';

	let tab = $state('general');

	// panel-hide lifecycle + index fetch on open. Side reads go through untrack so
	// hidePanels' store reads can't retrigger the effect (effect-depth gotcha).
	$effect(() => {
		const open = $templatesModalOpen;
		untrack(() => {
			if (open) {
				hidePanels();
				loadTemplatesIndex();
			} else if (open === false) {
				restorePanels();
			}
		});
	});
	// the Community manifest fetches lazily, first time the tab is opened
	$effect(() => {
		const wants = $templatesModalOpen && tab === 'community';
		untrack(() => {
			if (wants) loadCommunityGallery();
		});
	});

	function pickBlank() {
		templatesModalOpen.set(false);
		confirmClearScene();
	}
	/** @param {any} entry */
	function pickEntry(entry) {
		// close first (the Sessions Load precedent) — the load path talks through
		// toasts/confirms from here on
		templatesModalOpen.set(false);
		loadRemoteScene(entry);
	}
	/** @param {number} n */
	function sizeLabel(n) {
		if (!n) return '';
		return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
	}
	/** @param {any} e thumb failed to load — drop to the placeholder */
	function hideThumb(e) {
		e.target.style.display = 'none';
		const ph = e.target.nextElementSibling;
		if (ph) ph.style.display = 'flex';
	}
</script>

{#snippet card(/** @type {any} */ entry)}
	<button
		class="tpl-card flex flex-col overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/70 text-left"
		data-scene-slug={entry.slug}
		disabled={$loadingSlug === entry.slug}
		title={'Load "' + entry.title + '" — replaces the current scene (a backup is stashed first)'}
		onclick={() => pickEntry(entry)}
	>
		{#if entry.thumbUrl}
			<img src={entry.thumbUrl} alt={entry.title} class="h-24 w-full object-cover" loading="lazy" onerror={hideThumb} />
			<div class="tpl-thumb-ph hidden h-24 w-full items-center justify-center bg-gray-700 text-gray-400">
				<ImageIcon size={20} aria-hidden="true" />
			</div>
		{:else}
			<div class="flex h-24 w-full items-center justify-center bg-gray-700 text-gray-400">
				<ImageIcon size={20} aria-hidden="true" />
			</div>
		{/if}
		<div class="flex flex-1 flex-col gap-1 p-2">
			<p class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-gray-100">{entry.title}</p>
			{#if entry.description}
				<p class="tpl-desc text-xs text-gray-400">{entry.description}</p>
			{/if}
			<p class="mt-auto text-[10px] text-gray-500">
				{#if entry.author}{entry.author}{/if}
				{#if entry.author && entry.license}·{/if}
				{#if entry.license}<span title={licenseLabel(entry.license)}>{entry.license}</span>{/if}
				{#if entry.bytes}<span class="pl-1">{sizeLabel(entry.bytes)}</span>{/if}
			</p>
		</div>
	</button>
{/snippet}

{#snippet skeletons()}
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
		{#each [0, 1, 2] as i (i)}
			<div class="h-40 animate-pulse rounded-lg border border-gray-700/60 bg-gray-800/70"></div>
		{/each}
	</div>
{/snippet}

<Modal
	title="Templates"
	bind:open={$templatesModalOpen}
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') templatesModalOpen.set(false);
	}}
	outsideclose
	size="lg"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div id="templates-modal" class="p-1">
		<div class="tpl-tabs" role="tablist">
			<button
				id="templates-tab-general"
				class="tpl-tab"
				class:active={tab === 'general'}
				role="tab"
				aria-selected={tab === 'general'}
				onclick={() => (tab = 'general')}>General</button
			>
			<button
				id="templates-tab-examples"
				class="tpl-tab"
				class:active={tab === 'examples'}
				role="tab"
				aria-selected={tab === 'examples'}
				onclick={() => (tab = 'examples')}>Examples</button
			>
			<button
				id="templates-tab-community"
				class="tpl-tab"
				class:active={tab === 'community'}
				role="tab"
				aria-selected={tab === 'community'}
				onclick={() => (tab = 'community')}>Community</button
			>
		</div>

		{#if tab === 'general'}
			{#if $templatesState === 'loading' || $templatesState === 'idle'}
				{@render skeletons()}
			{:else}
				{#if $templatesState === 'fallback'}
					<p id="templates-fallback-note" class="mb-2 text-xs italic text-gray-500">
						Showing the bundled starters — the scene library couldn't be reached.
					</p>
				{/if}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					<button
						id="template-blank"
						class="tpl-card tpl-blank flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-600 p-4 text-gray-300"
						title="Clear the scene and start fresh (peers see it too)"
						onclick={pickBlank}
					>
						<FilePlus size={24} aria-hidden="true" />
						<span class="text-sm font-semibold">Blank scene</span>
						<span class="text-[10px] text-gray-500">Start from nothing</span>
					</button>
					{#each $templates as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
				{#if $templatesState === 'error'}
					<div class="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-gray-600 p-3 text-sm text-gray-400">
						<span class="flex-1">Couldn't load the template library and nothing is bundled.</span>
						<button id="templates-retry" class="ui-button-quiet" onclick={() => loadTemplatesIndex(true)}>
							<RefreshCw size={14} aria-hidden="true" /> Retry
						</button>
					</div>
				{/if}
			{/if}
		{:else if tab === 'examples'}
			{#if $templatesState === 'loading' || $templatesState === 'idle'}
				{@render skeletons()}
			{:else if $examples.length}
				{#if $templatesState === 'fallback'}
					<p class="mb-2 text-xs italic text-gray-500">
						Showing bundled examples — the scene library couldn't be reached.
					</p>
				{/if}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					{#each $examples as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
			{:else}
				<div id="examples-empty" class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-gray-600 p-6 text-center">
					<p class="text-sm text-gray-400">
						{$templatesState === 'ready'
							? 'No examples published yet — check back after the next content release.'
							: 'Examples are curated online content — reconnect to browse them.'}
					</p>
					{#if $templatesState !== 'ready'}
						<button id="examples-retry" class="ui-button-quiet" onclick={() => loadTemplatesIndex(true)}>
							<RefreshCw size={14} aria-hidden="true" /> Retry
						</button>
					{/if}
				</div>
			{/if}
		{:else}
			{#if $communityState === 'loading' || $communityState === 'idle'}
				{@render skeletons()}
			{:else if $communityState === 'ready'}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					{#each $communityEntries as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
				<p class="mt-3 text-xs text-gray-500">
					Community scenes are contributed via pull request and reviewed before they appear.
					<a class="tpl-link" href={SUBMIT_URL} target="_blank" rel="noopener">Submit yours on GitHub</a>
				</p>
			{:else}
				<div id="community-empty" class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-gray-600 p-6 text-center">
					<p class="text-sm text-gray-400">
						{$communityState === 'error'
							? "Couldn't reach the community gallery — check your connection."
							: 'No community scenes yet — be the first!'}
					</p>
					<p class="text-xs text-gray-500">
						Scenes are shared as pull requests and reviewed before they appear here.
					</p>
					<div class="flex items-center gap-2">
						<a id="community-submit-link" class="tpl-link text-sm" href={SUBMIT_URL} target="_blank" rel="noopener">
							Submit yours on GitHub
						</a>
						{#if $communityState === 'error'}
							<button id="community-retry" class="ui-button-quiet" onclick={() => loadCommunityGallery(true)}>
								<RefreshCw size={14} aria-hidden="true" /> Retry
							</button>
						{/if}
					</div>
				</div>
			{/if}
		{/if}

		<p class="mt-4 border-t border-gray-700/60 pt-2 text-xs text-gray-500">
			Loading a scene replaces the current one for everyone — a backup session is stashed first,
			and connected peers are asked before anything changes.
		</p>
	</div>
</Modal>

<style>
	/* General / Examples / Community read as real tabs (the ModulesManager pattern) */
	.tpl-tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 0.85rem;
		border-bottom: 1px solid rgb(75 85 99 / 0.6);
	}
	.tpl-tab {
		padding: 0.4rem 1.1rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: rgb(156 163 175);
		background: none;
		border: 0;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		cursor: pointer;
	}
	.tpl-tab:hover {
		color: rgb(229 231 235);
	}
	.tpl-tab.active {
		color: #fff;
		border-bottom-color: var(--color-primary-600, #2563eb);
	}
	.tpl-card {
		cursor: pointer;
		transition: border-color 0.12s ease;
		min-height: 10rem;
	}
	.tpl-card:hover {
		border-color: var(--color-primary-600, #2563eb);
	}
	.tpl-card:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.tpl-blank:hover {
		color: #fff;
	}
	/* clamp long descriptions to two lines so the grid rows stay even */
	.tpl-desc {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.tpl-link {
		color: #93c5fd;
		text-decoration: underline;
	}
	.tpl-link:hover {
		color: #bfdbfe;
	}
	/* thumb onerror fallback: img hides itself, this reveals */
	.tpl-thumb-ph {
		display: none;
	}
</style>
