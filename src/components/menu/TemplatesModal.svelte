<script>
	// Templates modal ("Templates" sidebar row): General / Examples / Community tabs
	// of loadable starting scenes. Content + storage architecture documented in
	// $lib/sceneTemplates.js — this file is presentation only. Runes-mode.
	import { untrack } from 'svelte';
	// 38 R7: the shared ModalDialog (WindowChrome size="modal"); kit Tabs in the strip under the
	// header (ids templates-tab-<id> are the Tabs' own); chips and cards with the accent selection;
	// tokens only. #templates-modal is the dialog itself now, so it holds the tabs too.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import Icon from '../ui/Icon.svelte';
	import { templatesModalOpen, templatesModalTab, hidePanels, restorePanels } from '../../stores/appStore.js';
	import {
		templates,
		examples,
		games,
		templatesState,
		communityEntries,
		communityState,
		communityNotice,
		loadingSlug,
		loadTemplatesIndex,
		loadCommunityGallery,
		loadCommunityEntry,
		loadRemoteScene,
		saveRemoteSceneToLibrary,
		confirmClearScene,
		tagUnion,
		matchesTags,
		SUBMIT_URL
	} from '$lib/sceneTemplates';
	// 28-A6: a cloud plugin's Community provider — null in the OSS build. Read for two
	// things only: whether the GitHub copy applies, and the provider's own submit control.
	import { communityProvider } from '$lib/cloudHooks';
	import { licenseLabel } from '$lib/packs';
	import { classifyRequirements } from '$lib/moduleRequirements';
	import HeartButton from '../ui/HeartButton.svelte';

	let tab = $state('general');
	const TEMPLATE_TABS = [
		{ id: 'general', label: 'General' },
		{ id: 'examples', label: 'Examples' },
		{ id: 'games', label: 'Games' },
		{ id: 'community', label: 'Community' }
	];
	/** A7: active tag chips, PER TAB — a filter that survived a tab switch would
	 * silently empty the next grid ("the Examples tab is broken"). @type {string[]} */
	let activeTags = $state(/** @type {string[]} */ ([]));

	// the entries the visible tab is showing, before chips
	const tabEntries = $derived(
		tab === 'general' ? $templates : tab === 'examples' ? $examples : tab === 'games' ? $games : $communityEntries
	);
	// chips are DERIVED from the tab's own tags, so a new tag in the index appears
	// without a core release, and a tab with no tags grows no chip row at all
	const chips = $derived(tagUnion(tabEntries));
	// 36-community (C5): the "Mine" chip — a provider that knows who is signed in says so
	// (`provider.mine`) and marks the viewer's own entries; a facet of its own, AND-ed with tags
	let mineOnly = $state(false);
	const mineChip = $derived(tab === 'community' && $communityProvider?.mine === true);
	const shown = $derived(
		tabEntries.filter((/** @type {any} */ e) => matchesTags(e, activeTags) && (!mineOnly || !mineChip || e.mine === true))
	);
	// 36-community (C6): a provider that can write a like puts a heart on its cards
	const canLike = $derived(tab === 'community' && typeof $communityProvider?.toggleLike === 'function');
	/** C6: the card's heart → the provider; the entry is patched with the answer so the grid agrees
	 * @param {any} entry @returns {Promise<{liked: boolean, count: number} | null>} */
	async function toggleLike(entry) {
		const provider = $communityProvider;
		if (typeof provider?.toggleLike !== 'function') return null;
		/** @type {any} */
		let res = null;
		try {
			res = await provider.toggleLike(entry);
		} catch {
			res = null;
		}
		if (!res || typeof res !== 'object') return null;
		const liked = !!res.liked;
		const count = Math.max(0, Number(res.likeCount ?? res.count) || 0);
		communityEntries.update((list) => list.map((/** @type {any} */ e) => (e.slug === entry.slug ? { ...e, liked, likeCount: count } : e)));
		return { liked, count };
	}
	// 28-A6: the provider's submit control replaces "Submit yours on GitHub" when present,
	// and the pull-request copy stands down whenever ANY provider is installed — it would
	// be a false statement about a source core knows nothing about.
	const provided = $derived(!!$communityProvider);
	const submit = $derived(
		$communityProvider?.submit && typeof $communityProvider.submit === 'object' && $communityProvider.submit.label
			? $communityProvider.submit
			: null
	);

	/** @param {string} tag */
	function toggleTag(tag) {
		activeTags = activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag];
	}
	/** @param {string} next */
	function pickTab(next) {
		tab = next;
		activeTags = [];
		mineOnly = false;
	}
	/** A7: what this game needs that this device has not got. Advisory on the card —
	 * the load path prompts properly (A6.2); the badge exists so a player is not
	 * surprised by a dialog. @param {any} entry */
	function needs(entry) {
		if (!entry.modules?.length) return null;
		const { missing, disabled, mismatched } = classifyRequirements(entry.modules);
		const short = entry.modules.map((/** @type {any} */ m) => m.id).join(', ');
		if (missing.length) return { text: 'Needs ' + short, ok: false };
		if (disabled.length) return { text: 'Enable ' + short, ok: false };
		// C5: the gallery index floats on @main while a scene is pinned, so a player can
		// end up on a different module version than the game was built against — and
		// module code runs the simulation, so that is a desync nobody could diagnose.
		// Made VISIBLE rather than prevented (see classifyRequirements).
		if (mismatched.length) {
			const m = mismatched[0];
			return { text: m.id + ' v' + m.want + ' (you have ' + m.have + ')', ok: false, skew: true };
		}
		return { text: short, ok: true };
	}

	// panel-hide lifecycle + index fetch on open. Side reads go through untrack so
	// hidePanels' store reads can't retrigger the effect (effect-depth gotcha).
	$effect(() => {
		const open = $templatesModalOpen;
		untrack(() => {
			if (open) {
				hidePanels();
				loadTemplatesIndex();
				// 31 K3: a caller asked for a tab (the game shell's Main menu -> Games)
				const want = $templatesModalTab;
				if (want) {
					pickTab(want);
					templatesModalTab.set(null);
				}
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
	// 28-A6: a provider swap while the tab is SHOWING resets the memo to idle (see the
	// subscriber in sceneTemplates); ask again then, so the grid follows the source
	// without a tab round-trip. Tracks idle only — tracking every state would re-fetch
	// forever on 'error'.
	$effect(() => {
		const idle = $communityState === 'idle';
		const wants = $templatesModalOpen && tab === 'community';
		untrack(() => {
			if (idle && wants) loadCommunityGallery();
		});
	});

	function pickBlank() {
		templatesModalOpen.set(false);
		// 33 (L2/L3): a NEW scene — resets the game setup and unloads the scene's modules too
		void confirmClearScene({ blank: true });
	}
	/** @param {any} entry */
	function pickEntry(entry) {
		// close first (the Sessions Load precedent) — the load path talks through
		// toasts/confirms from here on
		templatesModalOpen.set(false);
		// 28-A6: a Community card goes through the provider when one is installed
		if (tab === 'community') loadCommunityEntry(entry);
		// 36-community (C4): the tab names the template the game starts from
		else loadRemoteScene(entry, { origin: tab });
	}
	/** 28-A6: the provider's submit control — a link when it names an href, a button
	 * when it names an action (a plugin's publish dialog opens in-app). */
	function runSubmit() {
		try {
			if (typeof submit?.action === 'function') submit.action();
		} catch (e) {
			console.error('community submit action failed:', e);
		}
	}
	/**
	 * 24-C3: the card's SECOND action — file the template into the Library as a scene of
	 * your own, leaving the open scene alone. The modal stays up: saving several starters
	 * in a row is the ordinary use, and nothing here replaced the world, so there is no
	 * confirm to hand off to.
	 * @param {any} entry
	 */
	function saveEntry(entry) {
		void saveRemoteSceneToLibrary(entry);
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
	<!-- 24-C3: the card is TWO buttons in one grid cell — the whole card loads, and a small
	     corner button saves the template into the Library instead. Siblings under one
	     wrapper rather than a button inside a button (invalid HTML, and the click would
	     reach both); `data-scene-slug` stays on the load button, which still carries every
	     word the card shows. -->
	<div class="tpl-card-wrap relative">
	<button
		class="tpl-card flex h-full w-full flex-col overflow-hidden rounded-card border border-border bg-surface-2 text-left"
		data-scene-slug={entry.slug}
		disabled={$loadingSlug === entry.slug}
		title={'Load "' + entry.title + '" — replaces the current scene (a backup is stashed first)'}
		onclick={() => pickEntry(entry)}
	>
		{#if entry.thumbUrl}
			<img src={entry.thumbUrl} alt={entry.title} class="h-24 w-full object-cover" loading="lazy" onerror={hideThumb} />
			<div class="tpl-thumb-ph hidden h-24 w-full items-center justify-center bg-surface-inset text-text-faint">
				<Icon name="image" size={20} aria-hidden="true" />
			</div>
		{:else}
			<div class="flex h-24 w-full items-center justify-center bg-surface-inset text-text-faint">
				<Icon name="image" size={20} aria-hidden="true" />
			</div>
		{/if}
		<div class="flex flex-1 flex-col gap-1 p-2">
			<p class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-text">{entry.title}</p>
			{#if entry.description}
				<p class="tpl-desc text-xs text-text-muted">{entry.description}</p>
			{/if}
			<!-- A7: a game is a module PLUS a scene, so the card says which module up
			     front. Amber when this device has not got it: the load still works and
			     prompts (A6.2 is advisory by design), but nobody should meet that dialog
			     without warning. -->
			{#if needs(entry)}
				{@const req = needs(entry)}
				<span
					class="tpl-needs"
					class:tpl-needs-ok={req?.ok}
					data-needs={entry.slug}
					title={req?.ok
						? 'Installed — every player needs their own copy'
						: req?.skew
							? 'You have a different version than this scene was built against — every player must run the same one, or the game will drift'
							: 'Each player needs this module; loading will offer to install it'}
				>
					<Icon name="puzzle" size={16} aria-hidden="true" />{req?.text}
				</span>
			{/if}
			{#if entry.notice}
				<p class="tpl-notice-line" data-card-notice={entry.slug}>{entry.notice}</p>
			{/if}
			<p class="mt-auto text-[10px] text-text-faint">
				{#if entry.author}{entry.author}{/if}
				{#if entry.author && entry.license}·{/if}
				{#if entry.license}<span title={licenseLabel(entry.license)}>{entry.license}</span>{/if}
				{#if entry.bytes}<span class="pl-1">{sizeLabel(entry.bytes)}</span>{/if}
				<!-- 28-A6: provider-only facts, rendered ONLY when present (a GitHub row has none) -->
				{#if entry.likeCount != null && !canLike}<span class="tpl-likes pl-1" title="Likes">♥ {entry.likeCount}</span>{/if}
				{#if entry.remixOf}<span class="tpl-remix pl-1" title="A remix of another published scene">remix{#if entry.remixOf.title}&nbsp;of {entry.remixOf.title}{/if}</span>{/if}
			</p>
		</div>
	</button>
	<button
		class="tpl-save"
		data-scene-save={entry.slug}
		disabled={$loadingSlug === entry.slug}
		title={'Save "' + entry.title + '" to your Library as a new scene — the current scene stays as it is'}
		aria-label={'Save ' + entry.title + ' to your Library'}
		onclick={() => saveEntry(entry)}
	>
		<Icon name="folder-down" size={16} aria-hidden="true" />
	</button>
	{#if canLike && entry.likeCount != null}
		<!-- 36-community (C6): the heart, a sibling of the load button (never inside it) -->
		<span class="tpl-heart" data-card-heart={entry.slug}>
			<HeartButton count={entry.likeCount} liked={entry.liked === true} label={'Like ' + entry.title} ontoggle={() => toggleLike(entry)} />
		</span>
	{/if}
	</div>
{/snippet}

{#snippet submitControl(/** @type {string} */ id, /** @type {string} */ cls)}
	<!-- 28-A6: the provider's submit control when it has one, the GitHub link otherwise -->
	{#if submit}
		{#if submit.href}
			<a {id} class={cls} href={submit.href} target="_blank" rel="noopener">{submit.label}</a>
		{:else}
			<button {id} class={cls} type="button" onclick={runSubmit}>{submit.label}</button>
		{/if}
	{:else}
		<a {id} class={cls} href={SUBMIT_URL} target="_blank" rel="noopener">Submit yours on GitHub</a>
	{/if}
{/snippet}

{#snippet skeletons()}
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
		{#each [0, 1, 2] as i (i)}
			<div class="h-40 animate-pulse rounded-card border border-border bg-surface-2"></div>
		{/each}
	</div>
{/snippet}

<ModalDialog
	title="Templates"
	bind:open={$templatesModalOpen}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') templatesModalOpen.set(false);
	}}
	width="lg"
	id="templates-modal"
>
	{#snippet bar()}
		<Tabs
			tabs={TEMPLATE_TABS}
			idPrefix="templates"
			label="Templates"
			value={tab}
			onchange={(/** @type {string} */ next) => pickTab(next)}
		/>
	{/snippet}
	<div class="tpl-body">

		<!-- A7: tag chips, shared by all four tabs and derived from the ACTIVE tab's own
		     tags. OR within the facet (see matchesTags) — an AND would empty the grid on
		     the second click, which reads as a broken filter. VR is just a chip. -->
		{#if chips.length || mineChip}
			<div id="templates-chips" class="tpl-chips">
				{#if mineChip}
					<button
						id="templates-chip-mine"
						class="tpl-chip"
						class:active={mineOnly}
						data-chip="__mine"
						aria-pressed={mineOnly}
						title="Only what you published"
						onclick={() => (mineOnly = !mineOnly)}>Mine</button
					>
				{/if}
				{#each chips as tag (tag)}
					<button
						class="tpl-chip"
						class:active={activeTags.includes(tag)}
						data-chip={tag}
						aria-pressed={activeTags.includes(tag)}
						onclick={() => toggleTag(tag)}>{tag}</button
					>
				{/each}
				{#if activeTags.length}
					<button id="templates-chips-clear" class="tpl-chip tpl-chip-clear" onclick={() => (activeTags = [])}>
						Clear
					</button>
				{/if}
			</div>
		{/if}

		{#if tab === 'general'}
			{#if $templatesState === 'loading' || $templatesState === 'idle'}
				{@render skeletons()}
			{:else}
				{#if $templatesState === 'fallback'}
					<p id="templates-fallback-note" class="mb-2 text-xs italic text-text-faint">
						Showing the bundled starters — the scene library couldn't be reached.
					</p>
				{/if}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					<button
						id="template-blank"
						class="tpl-card tpl-blank flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border-strong p-4 text-text-2"
						title="Clear the scene and start fresh (peers see it too)"
						onclick={pickBlank}
					>
						<Icon name="file-plus" size={24} aria-hidden="true" />
						<span class="text-sm font-semibold">Blank scene</span>
						<span class="text-[10px] text-text-faint">Start from nothing</span>
					</button>
					{#each shown as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
				{#if $templatesState === 'error'}
					<div class="mt-3 flex items-center gap-2 rounded-card border border-dashed border-border-strong p-3 text-sm text-text-muted">
						<span class="flex-1">Couldn't load the template library and nothing is bundled.</span>
						<button id="templates-retry" class="tpl-btn" onclick={() => loadTemplatesIndex(true)}>
							<Icon name="refresh-cw" size={16} aria-hidden="true" /> Retry
						</button>
					</div>
				{/if}
			{/if}
		{:else if tab === 'examples'}
			{#if $templatesState === 'loading' || $templatesState === 'idle'}
				{@render skeletons()}
			{:else if $examples.length}
				{#if $templatesState === 'fallback'}
					<p class="mb-2 text-xs italic text-text-faint">
						Showing bundled examples — the scene library couldn't be reached.
					</p>
				{/if}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					{#each shown as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
			{:else}
				<div id="examples-empty" class="flex flex-col items-center gap-2 rounded-card border border-dashed border-border-strong p-6 text-center">
					<p class="text-sm text-text-muted">
						{$templatesState === 'ready'
							? 'No examples published yet — check back after the next content release.'
							: 'Examples are curated online content — reconnect to browse them.'}
					</p>
					{#if $templatesState !== 'ready'}
						<button id="examples-retry" class="tpl-btn" onclick={() => loadTemplatesIndex(true)}>
							<Icon name="refresh-cw" size={16} aria-hidden="true" /> Retry
						</button>
					{/if}
				</div>
			{/if}
		{:else if tab === 'games'}
			{#if $templatesState === 'loading' || $templatesState === 'idle'}
				{@render skeletons()}
			{:else if $games.length}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					{#each shown as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
				{#if !shown.length}
					<p id="games-filtered-empty" class="mt-3 text-xs italic text-text-faint">
						No games match those tags.
					</p>
				{/if}
				<p class="mt-3 text-xs text-text-faint">
					A game is a scene plus a module. Loading one offers to install what it needs —
					<span class="text-text-muted">every player needs their own copy</span>.
				</p>
			{:else}
				<div
					id="games-empty"
					class="flex flex-col items-center gap-2 rounded-card border border-dashed border-border-strong p-6 text-center"
				>
					<Icon name="gamepad-2" size={20} aria-hidden="true" />
					<p class="text-sm text-text-muted">
						{$templatesState === 'ready'
							? 'No games published yet — check back after the next content release.'
							: 'Games are curated online content — reconnect to browse them.'}
					</p>
					{#if $templatesState !== 'ready'}
						<button id="games-retry" class="tpl-btn" onclick={() => loadTemplatesIndex(true)}>
							<Icon name="refresh-cw" size={16} aria-hidden="true" /> Retry
						</button>
					{/if}
				</div>
			{/if}
		{:else}
			<!-- 28-A6: the provider's ONE notice row, above whatever the tab shows. Null in
			     the OSS build, so nothing renders here without a plugin. -->
			{#if $communityNotice}
				<p id="community-notice" class="tpl-notice">
					{$communityNotice.text}
					{#if $communityNotice.href}
						<a class="tpl-link" href={$communityNotice.href} target="_blank" rel="noopener">More</a>
					{/if}
				</p>
			{/if}
			{#if $communityState === 'loading' || $communityState === 'idle'}
				{@render skeletons()}
			{:else if $communityState === 'ready'}
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					{#each shown as entry (entry.slug)}
						{@render card(entry)}
					{/each}
				</div>
				{#if !shown.length && mineOnly}
					<p id="community-mine-empty" class="mt-3 text-xs italic text-text-faint">Nothing published yet — publish a scene and it shows here.</p>
				{/if}
				<p class="mt-3 text-xs text-text-faint">
					{#if !provided}
						Community scenes are contributed via pull request and reviewed before they appear.
					{/if}
					{@render submitControl('community-submit', 'tpl-link')}
				</p>
			{:else}
				<div id="community-empty" class="flex flex-col items-center gap-2 rounded-card border border-dashed border-border-strong p-6 text-center">
					<p class="text-sm text-text-muted">
						{$communityState === 'error'
							? "Couldn't reach the community gallery — check your connection."
							: 'No community scenes yet — be the first!'}
					</p>
					{#if !provided}
						<p class="text-xs text-text-faint">
							Scenes are shared as pull requests and reviewed before they appear here.
						</p>
					{/if}
					<div class="flex items-center gap-2">
						{@render submitControl('community-submit-link', 'tpl-link text-sm')}
						{#if $communityState === 'error'}
							<button id="community-retry" class="tpl-btn" onclick={() => loadCommunityGallery(true)}>
								<Icon name="refresh-cw" size={16} aria-hidden="true" /> Retry
							</button>
						{/if}
					</div>
				</div>
			{/if}
		{/if}

		<p class="mt-4 border-t border-border pt-2 text-xs text-text-faint">
			Loading a scene replaces the current one for everyone — a backup session is stashed first,
			and connected peers are asked before anything changes.
		</p>
	</div>
</ModalDialog>

<style>
	.tpl-body {
		display: flex;
		flex-direction: column;
	}
	/* A7 tag chips (SPEC Chips: pill + border-strong; selected = accent-soft + accent border).
	   Hand-rolled because each chip carries the data-chip hook the suites address. */
	.tpl-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: var(--space-4);
	}
	.tpl-chip {
		height: var(--control-h-sm);
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-2);
		font: inherit;
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.tpl-chip:hover {
		background: var(--surface-hover);
	}
	.tpl-chip.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.tpl-chip-clear {
		border-color: transparent;
		color: var(--accent-text);
	}
	/* the module a game needs: warn ink when this device has not got it */
	.tpl-needs {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		height: 20px;
		padding: 0 8px;
		font-size: var(--fs-badge);
		font-weight: 600;
		color: var(--ink-warn);
		background: color-mix(in srgb, var(--ink-warn) 14%, transparent);
		border-radius: var(--radius-pill);
	}
	.tpl-needs-ok {
		color: var(--ink-good);
		background: color-mix(in srgb, var(--ink-good) 14%, transparent);
	}
	.tpl-card {
		cursor: pointer;
		transition: border-color 0.12s ease;
		min-height: 10rem;
		font: inherit;
		color: var(--text);
	}
	.tpl-card:hover,
	.tpl-card:focus-visible {
		border-color: var(--accent);
	}
	.tpl-card:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	/* 24-C3: the corner "save to Library" button. Always visible (touch has no hover). */
	.tpl-card-wrap {
		min-height: 10rem;
	}
	.tpl-save {
		position: absolute;
		top: 6px;
		right: 6px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--icon-button);
		height: var(--icon-button);
		color: var(--text);
		background: color-mix(in srgb, var(--surface-1) 80%, transparent);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-input);
		cursor: pointer;
	}
	.tpl-save:hover {
		border-color: var(--accent);
		background: var(--surface-1);
	}
	.tpl-heart {
		position: absolute;
		top: 6px;
		left: 6px;
	}
	.tpl-notice-line {
		font-size: var(--fs-badge);
		font-weight: 600;
		color: var(--ink-warn);
	}
	.tpl-save:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.tpl-blank {
		color: var(--text-2);
	}
	.tpl-blank:hover {
		color: var(--text);
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
		color: var(--accent-text);
		text-decoration: underline;
	}
	/* 28-A6: a submit BUTTON (a provider with an action) reads exactly like the link */
	button.tpl-link {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}
	/* 28-A6: the provider's notice row — one quiet line, never a banner */
	.tpl-notice {
		margin-bottom: var(--space-3);
		padding: var(--space-2) var(--space-3);
		font-size: var(--fs-desc);
		color: var(--text-2);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
	}
	.tpl-likes,
	.tpl-remix {
		white-space: nowrap;
	}
	.tpl-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.tpl-btn:hover {
		background: var(--surface-hover);
	}
	/* thumb onerror fallback: img hides itself, this reveals */
	.tpl-thumb-ph {
		display: none;
	}
</style>
