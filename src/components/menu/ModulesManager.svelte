<script>
	import { Download } from '@lucide/svelte';
	import { Modal, Button, Toggle, Checkbox } from 'flowbite-svelte';
	import { modulesOpen, hidePanels, restorePanels, showToast } from '../../stores/appStore.js';
	import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { modulePrimitiveGroups } from '$lib/moduleSDK';
	import { MODULE_CATEGORIES } from '$lib/moduleGallery';
	import { tagUnion, matchesTags } from '$lib/sceneTemplates';

	// like Settings: side panels hide while the manager is open, restore after
	$: if ($modulesOpen) {
		hidePanels();
	} else if ($modulesOpen === false) {
		restorePanels();
	}

	// C5.1: Browse filters. LEGACY-mode file, so these are `let` + `$:`, never runes —
	// one $state here would flip the whole component and break the build.
	let galleryCategory = 'all';
	/** @type {string[]} */
	let galleryTags = [];
	$: galleryByCategory =
		galleryCategory === 'all'
			? $galleryModules
			: $galleryModules.filter((/** @type {any} */ e) => (e.category ?? 'tool') === galleryCategory);
	// chips come from the entries the category left, so they can never offer a tag that
	// filters to nothing; ONE chip component's behaviour, shared with the Templates modal
	$: galleryChips = tagUnion(galleryByCategory);
	$: galleryShown = galleryByCategory.filter((/** @type {any} */ e) => matchesTags(e, galleryTags));
	// a category that no longer contains the picked tags would show an empty list with
	// no way back, so switching category drops them (the Templates-modal tab rule)
	/** @param {string} next */
	function pickGalleryCategory(next) {
		galleryCategory = next;
		galleryTags = [];
	}
	/** @param {string} tag */
	function toggleGalleryTag(tag) {
		galleryTags = galleryTags.includes(tag) ? galleryTags.filter((t) => t !== tag) : [...galleryTags, tag];
	}

	// primitives registered by a module spawn from its card (not the sidebar)
	$: primitivesByModule = $modulePrimitiveGroups
		.flatMap((group) => group.items)
		.reduce((map, item) => {
			(map[item.moduleId] ??= []).push(item);
			return map;
		}, {});
	import {
		moduleMenuItems,
		disabledModules,
		setModuleEnabled,
		isModuleLoaded,
		loadedModulesChanged
	} from '$lib/moduleSDK';
	import { coreModules } from '../../modules/index.js';
	import {
		userModules,
		installZip,
		installUrl,
		activateUserModule,
		updateUserModule,
		removeUserModule,
		reloadUserModule,
		setDevUrl,
		setDevPoll,
		devSourceOf,
		devPolling,
		installStatus,
		clearInstallStatus,
		normalizeRepoUrl,
		lastInstalled
	} from '$lib/userModules';
	import { deactivateModule } from '$lib/moduleSDK';
	import {
		galleryModules,
		galleryState,
		galleryInstallUrl,
		loadModuleGallery,
		versionNewer
	} from '$lib/moduleGallery';
	let tab = 'core';
	let installUrlValue = '';
	let galleryBusy = '';
	let installBusy = false;

	async function runUrlInstall() {
		if (installBusy) return;
		if (!installUrlValue.trim()) {
			// the button is never disabled (see the markup), so say why nothing
			// happened — in the same place every other install outcome appears
			installStatus.set({ kind: 'error', text: 'Paste a module URL first', detail: 'Or use Choose .zip… to install a packaged module.' });
			document.getElementById('install-module-url')?.focus();
			return;
		}
		installBusy = true;
		const ok = await installUrl(installUrlValue);
		installBusy = false;
		if (ok) installUrlValue = ''; // keep a failed URL so it can be corrected
	}

	// Installing from Browse leaves you on Browse (so you can install several);
	// the User tab's count badge is what says "it went over there", and opening
	// that tab scrolls to the new card and flashes it.
	let prevUserCount = -1;
	let userTabPulse = false;
	$: pulseIfGrown($userModules.length);
	/** @param {number} count */
	function pulseIfGrown(count) {
		if (prevUserCount >= 0 && count > prevUserCount) {
			userTabPulse = true;
			setTimeout(() => (userTabPulse = false), 1600);
		}
		prevUserCount = count;
	}

	$: revealInstalled(tab, $lastInstalled);
	/** @param {string} activeTab @param {string | null} id */
	function revealInstalled(activeTab, id) {
		if (activeTab !== 'user' || !id || typeof document === 'undefined') return;
		// one frame for the card to render before scrolling to it
		setTimeout(() => {
			const card = document.getElementById('user-module-card-' + id);
			if (!card) return;
			card.scrollIntoView({ block: 'center', behavior: 'smooth' });
			card.classList.add('just-installed');
			setTimeout(() => card.classList.remove('just-installed'), 2200);
			lastInstalled.set(null);
		}, 60);
	}

	// as-you-type: is this URL already an installed module? (installing updates it)
	$: typedBase = installUrlValue.trim() ? normalizeRepoUrl(installUrlValue) : '';
	$: alreadyInstalled = typedBase
		? $userModules.find((record) => record.source === typedBase)
		: null;

	// 17-A3: installed lookup for gallery card state (dim + Update)
	$: installedById = $userModules.reduce((map, record) => {
		map[record.id] = record;
		return map;
	}, {});

	/** @param {any} entry */
	async function installFromGallery(entry) {
		galleryBusy = entry.id;
		await installUrl(galleryInstallUrl(entry));
		galleryBusy = '';
	}

	// raw sources of every core module, bundled so users can download examples
	const sources = import.meta.glob('../../modules/*/*', { query: '?raw', import: 'default' });

	async function downloadModule(mod) {
		const { zipSync, strToU8 } = await import('fflate');
		/** @type {Record<string, Uint8Array>} */
		const files = {
			'manifest.json': strToU8(
				JSON.stringify(
					{ id: mod.id, name: mod.name, version: mod.version, description: mod.description ?? '', entry: 'module.js' },
					null,
					2
				)
			)
		};
		for (const [path, loader] of Object.entries(sources)) {
			const match = path.match(/modules\/([^/]+)\/(.+)$/);
			if (!match || match[1] !== mod.id) continue;
			files[match[2]] = strToU8(String(await loader()));
		}
		const blob = new Blob([zipSync(files)], { type: 'application/zip' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = mod.id + '.module.zip';
		link.click();
		URL.revokeObjectURL(link.href);
	}
</script>

<Modal
	title="Modules"
	bind:open={$modulesOpen}
	modal={false} onkeydown={(e) => { if (e.key === 'Escape') modulesOpen.set(false); }}
	size="lg"
	outsideclose
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div class="mod-tabs" role="tablist">
		<button class="mod-tab" class:active={tab === 'core'} role="tab" aria-selected={tab === 'core'} on:click={() => (tab = 'core')}>
			Core
		</button>
		<button
			class="mod-tab"
			class:active={tab === 'user'}
			class:pulse={userTabPulse}
			role="tab"
			aria-selected={tab === 'user'}
			on:click={() => (tab = 'user')}
		>
			User{$userModules.length ? ' (' + $userModules.length + ')' : ''}
		</button>
		<button
			class="mod-tab"
			class:active={tab === 'browse'}
			role="tab"
			aria-selected={tab === 'browse'}
			on:click={() => {
				tab = 'browse';
				loadModuleGallery();
			}}
		>
			Browse
		</button>
	</div>

	{#if tab === 'browse'}
		<div id="module-gallery-tab" class="flex flex-col gap-3">
			<p class="text-xs text-yellow-500">
				⚠ Modules run unsandboxed in your session — install only sources you trust.
				This list comes from github.com/theprototype-app/modules.
			</p>
			{#if $galleryState === 'loading'}
				<p class="text-sm italic text-gray-500 dark:text-gray-400">Loading the module list…</p>
			{:else if $galleryModules.length === 0}
				<p class="text-sm italic text-gray-500 dark:text-gray-400">
					The gallery is unavailable right now (offline?) — installs by zip or URL in the
					User tab still work.
				</p>
			{:else}
				<!-- C5.1: category filter + tag chips. A game and a tool are different
				     things to go looking for, and the list is long enough now that
				     "which of these is a game" was guesswork. -->
				<div id="gallery-filters" class="flex flex-wrap items-center gap-1.5">
					<button
						class="gal-chip"
						class:active={galleryCategory === 'all'}
						data-gal-cat="all"
						aria-pressed={galleryCategory === 'all'}
						on:click={() => pickGalleryCategory('all')}>All</button
					>
					{#each MODULE_CATEGORIES as cat (cat)}
						<button
							class="gal-chip"
							class:active={galleryCategory === cat}
							data-gal-cat={cat}
							aria-pressed={galleryCategory === cat}
							on:click={() => pickGalleryCategory(cat)}>{cat}s</button
						>
					{/each}
					{#if galleryChips.length}
						<span class="px-1 text-gray-600">|</span>
						{#each galleryChips as tag (tag)}
							<button
								class="gal-chip gal-chip-tag"
								class:active={galleryTags.includes(tag)}
								data-gal-tag={tag}
								aria-pressed={galleryTags.includes(tag)}
								on:click={() => toggleGalleryTag(tag)}>{tag}</button
							>
						{/each}
					{/if}
				</div>
				{#if galleryShown.length === 0}
					<p id="gallery-filtered-empty" class="text-sm italic text-gray-500 dark:text-gray-400">
						Nothing matches that filter.
					</p>
				{/if}
				{#each galleryShown as entry (entry.id)}
					{@const installed = installedById[entry.id]}
					<div
						id={'gallery-card-' + entry.id}
						class="rounded-lg border border-gray-600 p-3"
						class:opacity-60={installed && !versionNewer(entry.version, installed.version)}
					>
						<div class="flex items-center justify-between">
							<div>
								<span class="font-semibold text-gray-900 dark:text-white">{entry.name}</span>
								<span class="pl-2 text-xs text-gray-400">v{entry.version}</span>
								{#if entry.author}
									<span class="pl-2 text-xs text-gray-500">by {entry.author}</span>
								{/if}
							</div>
							{#if !installed}
								<Button
									size="xs"
									disabled={galleryBusy === entry.id || !entry.source}
									onclick={() => installFromGallery(entry)}
								>
									{galleryBusy === entry.id ? 'Installing…' : 'Install'}
								</Button>
							{:else if versionNewer(entry.version, installed.version)}
								<Button
									size="xs"
									color="alternative"
									disabled={galleryBusy === entry.id}
									onclick={() => installFromGallery(entry)}
								>
									{galleryBusy === entry.id ? 'Updating…' : 'Update to v' + entry.version}
								</Button>
							{:else}
								<span class="text-xs text-green-500">Installed</span>
							{/if}
						</div>
						<p class="pt-1 text-sm text-gray-500 dark:text-gray-300">{entry.description}</p>
						{#if entry.category === 'game' || entry.tags?.length}
							<div class="flex flex-wrap items-center gap-1 pt-1.5">
								{#if entry.category === 'game'}
									<span class="gal-badge gal-badge-game" data-gal-badge={entry.id}>game</span>
								{/if}
								{#each entry.tags ?? [] as tag (tag)}
									<span class="gal-badge">{tag}</span>
								{/each}
								{#if entry.template}
									<!-- a game ships a scene too: point at it rather than leaving the
									     player to guess which template goes with the module -->
									<span class="gal-badge gal-badge-scene" title={'Scene: ' + entry.template}>
										+ scene
									</span>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{:else if tab === 'core'}
		<div class="flex flex-col gap-3">
			{#key $loadedModulesChanged}
				{#each coreModules as mod (mod.id)}
					<div id={'module-card-' + mod.id} class="rounded-lg border border-gray-600 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-semibold text-gray-900 dark:text-white">{mod.name}</span>
								<span class="pl-2 text-xs text-gray-400">v{mod.version}</span>
								{#if $disabledModules.includes(mod.id) && isModuleLoaded(mod.id)}
									<span class="pl-2 text-xs text-yellow-400">reload to disable</span>
								{/if}
							</div>
							<Toggle
								size="small"
								checked={!$disabledModules.includes(mod.id)}
								onchange={(e) => setModuleEnabled(mod, e.target.checked)}
							/>
						</div>
						<p class="pt-1 text-sm text-gray-500 dark:text-gray-300">{mod.description ?? ''}</p>
						<div class="flex flex-wrap items-center gap-2 pt-2">
							{#if isModuleLoaded(mod.id) && !$disabledModules.includes(mod.id)}
								{#each $moduleMenuItems.filter((item) => item.moduleId === mod.id) as item}
									<Button size="xs" onclick={item.action}>{item.label}</Button>
								{/each}
								{#each primitivesByModule[mod.id] ?? [] as primitive}
									<Button
										size="xs"
										color="green"
										title={primitive.command}
										onclick={() => sceneCommand(primitive.command)}
									>
										+ {primitive.label}
									</Button>
								{/each}
							{/if}
							<Button size="xs" color="alternative" onclick={() => downloadModule(mod)}>
								<Download size={16} class="mr-1" aria-hidden="true" />Download as example
							</Button>
						</div>
					</div>
				{/each}
			{/key}
		</div>
	{:else}
		<div id="user-modules-tab" class="flex flex-col gap-3">
			<p class="text-xs text-yellow-500">
				⚠ Modules run code inside your session — install only from sources you trust.
				Every peer needs the same modules for shared behavior to match.
			</p>
			<!-- ONE install control: paste a URL and press Install, or pick a .zip.
			     (The old row had a blue "Install zip" next to a permanently grey
			     `color="alternative"` "Install URL" — the URL button read as
			     disabled even though it worked.) -->
			<!-- wraps: the field keeps the whole first line and the buttons drop to
			     the next row when there is not enough width -->
			<div class="flex flex-wrap items-center gap-2">
				<input
					id="install-module-url"
					class="min-w-0 flex-1 basis-full rounded-sm border border-gray-600 bg-transparent px-2 py-1 text-sm sm:min-w-[20rem] sm:basis-auto dark:text-white"
					placeholder="Module URL — https://raw.githubusercontent.com/user/repo/main/mymodule (or a github.com/…/tree/… link)"
					bind:value={installUrlValue}
					on:input={() => clearInstallStatus()}
					on:keydown={(e) => {
						if (e.key === 'Enter') runUrlInstall();
					}}
				/>
				<!-- NO `disabled` binding here. Reported three times as "blocked cursor
				     even with a URL typed, fixed by reopening the modal" — i.e. the
				     styling was stale until the Button remounted — and it could never be
				     reproduced headlessly. The empty-field case is explained by the
				     status line below, so the prop buys nothing and costs a confusing
				     dead-looking control. `busy` still guards double-submits. -->
				<Button size="xs" onclick={runUrlInstall}>
					{installBusy ? 'Installing…' : 'Install'}
				</Button>
				<span class="text-xs text-gray-500">or</span>
				<Button
					size="xs"
					color="alternative"
					onclick={() => document.getElementById('install-module-zip').click()}
				>
					Choose .zip…
				</Button>
				<input
					type="file"
					id="install-module-zip"
					style="display: none"
					accept=".zip"
					on:change={async (e) => {
						// capture the input BEFORE awaiting: `currentTarget` is only valid
						// during dispatch and is null once the handler resumes
						const input = e.currentTarget;
						const file = input.files?.[0];
						if (file) await installZip(file);
						input.value = '';
					}}
				/>
			</div>

			<!-- ONE status line for both install paths: progress, what landed
			     (name, version, file count, size) or WHY it failed, with the URL
			     still in the field so it can be corrected. aria-live so a screen
			     reader hears the outcome. -->
			<div id="install-status" class="-mt-1 min-h-[1.25rem] text-xs" aria-live="polite">
				{#if $installStatus.kind !== 'idle'}
					<span
						class:text-gray-400={$installStatus.kind === 'busy'}
						class:text-green-500={$installStatus.kind === 'ok'}
						class:text-red-400={$installStatus.kind === 'error'}
					>
						{$installStatus.kind === 'busy' ? '⏳' : $installStatus.kind === 'ok' ? '✓' : '⚠'}
						{$installStatus.text}
					</span>
					{#if $installStatus.detail}
						<span class="block break-all pl-4 text-gray-500">{$installStatus.detail}</span>
					{/if}
				{:else if alreadyInstalled}
					<span class="text-gray-400">
						Already installed: {alreadyInstalled.name} v{alreadyInstalled.version} — Install will update it
					</span>
				{:else if installUrlValue.trim()}
					<span class="text-gray-500">Will fetch {typedBase}/manifest.json</span>
				{/if}
			</div>

			{#key $loadedModulesChanged}
				{#each $userModules as record (record.id)}
					<div id={'user-module-card-' + record.id} class="rounded-lg border border-gray-600 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-semibold text-gray-900 dark:text-white">{record.name}</span>
								<span class="pl-2 text-xs text-gray-400">v{record.version}</span>
								<span class="pl-2 text-xs text-gray-500">{record.source === 'zip' ? 'zip' : 'URL'}</span>
								{#if $disabledModules.includes(record.id) && isModuleLoaded(record.id)}
									<span class="pl-2 text-xs text-yellow-400">reload to disable</span>
								{/if}
							</div>
							<Toggle
								size="small"
								id={'enable-user-module-' + record.id}
								checked={!$disabledModules.includes(record.id)}
								onchange={async (e) => {
									if (e.target.checked) {
										$disabledModules = $disabledModules.filter((id) => id !== record.id);
										await activateUserModule(record);
									} else {
										$disabledModules = [...new Set([...$disabledModules, record.id])];
										if (isModuleLoaded(record.id)) {
											deactivateModule(record.id);
											showToast('"' + record.name + '" disabled');
										}
									}
								}}
							/>
						</div>
						<p class="pt-1 text-sm text-gray-500 dark:text-gray-300">{record.description}</p>
						<div class="flex flex-wrap items-center gap-2 pt-2">
							{#if isModuleLoaded(record.id) && !$disabledModules.includes(record.id)}
								{#each $moduleMenuItems.filter((item) => item.moduleId === record.id) as item}
									<Button size="xs" onclick={item.action}>{item.label}</Button>
								{/each}
							{/if}
							{#if record.source !== 'zip'}
								<Button size="xs" color="alternative" onclick={() => updateUserModule(record)}>Update</Button>
							{/if}
							<Button size="xs" color="red" onclick={() => removeUserModule(record.id)}>Remove</Button>
						</div>
						<!-- A2 dev mode: reload fresh code from a URL without a page reload -->
						<div class="flex items-center gap-2 pt-2">
							<input
								id={'dev-url-' + record.id}
								class="flex-1 rounded-sm border border-gray-700 bg-transparent px-2 py-1 text-xs dark:text-gray-300"
								placeholder="Dev URL (serves manifest.json — defaults to the install URL)"
								value={record.devUrl ?? (record.source !== 'zip' ? record.source : '')}
								on:change={(e) => setDevUrl(record.id, e.currentTarget.value)}
							/>
							<Button
								size="xs"
								color="alternative"
								id={'dev-reload-' + record.id}
								disabled={!devSourceOf(record)}
								onclick={() => reloadUserModule(record)}
							>
								Reload
							</Button>
							<!-- a CHECKBOX, not a Toggle: the card's other switch enables/disables
							     the module, and two toggles side by side read as the same kind of
							     control -->
							<div class="shrink-0" title="Poll the dev URL (~2s) and reload when the code changes">
								<Checkbox
									id={'dev-poll-' + record.id}
									checked={$devPolling.includes(record.id)}
									onchange={(e) => setDevPoll(record, e.currentTarget.checked)}
								>
									<span class="text-xs text-gray-400">Auto</span>
								</Checkbox>
							</div>
						</div>
					</div>
				{/each}
			{/key}
			{#if $userModules.length === 0}
				<p class="text-sm italic text-gray-500 dark:text-gray-400">
					Nothing installed yet — download a core module above as a starting point
					(the entry must be self-contained: no import statements, use api.THREE and
					api.assetUrl; see the SDK docs).
				</p>
			{/if}
		</div>
	{/if}
</Modal>

<style>
	/* C5.1 Browse filter chips. Every colour ends in a LITERAL fallback — no theme
	   defines every token, and a bare var() leaves an unstyled control. */
	.gal-chip {
		padding: 0.1rem 0.55rem;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: capitalize;
		color: rgb(156 163 175);
		background: rgb(55 65 81 / 0.5);
		border: 1px solid rgb(75 85 99 / 0.6);
		border-radius: 999px;
		cursor: pointer;
	}
	.gal-chip:hover {
		color: rgb(229 231 235);
		border-color: var(--color-primary-600, #2563eb);
	}
	.gal-chip.active {
		color: #fff;
		background: var(--color-primary-600, #2563eb);
		border-color: var(--color-primary-600, #2563eb);
	}
	.gal-chip-tag {
		text-transform: none;
	}
	.gal-badge {
		padding: 0.02rem 0.4rem;
		font-size: 0.62rem;
		font-weight: 600;
		color: rgb(156 163 175);
		background: rgb(55 65 81 / 0.45);
		border-radius: 999px;
	}
	.gal-badge-game {
		color: rgb(196 181 253);
		background: rgb(76 29 149 / 0.35);
	}
	.gal-badge-scene {
		color: rgb(147 197 253);
		background: rgb(30 58 138 / 0.35);
	}

	/* Core / User / Browse read as real tabs (underline the active one) instead
	   of buttons. STICKY: the modal body is the scroller, so the tab bar stays
	   put while a long module list scrolls under it — it needs an opaque
	   background of its own or the cards show through. */
	.mod-tabs {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		gap: 0.25rem;
		margin-bottom: 0.85rem;
		padding-top: 0.25rem;
		background: var(--surface, #1f2937);
		border-bottom: 1px solid rgb(75 85 99 / 0.6);
	}
	.mod-tab {
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
	.mod-tab:hover {
		color: rgb(229 231 235);
	}
	.mod-tab.active {
		color: #fff;
		border-bottom-color: var(--color-primary-600, #2563eb);
	}
	/* the count badge just grew — a short pulse says "your module landed here" */
	.mod-tab.pulse {
		animation: mod-tab-pulse 0.5s ease-in-out 3;
	}
	@keyframes mod-tab-pulse {
		50% {
			color: #fff;
			transform: scale(1.06);
		}
	}
	/* added imperatively by revealInstalled(), so it must be :global */
	:global(.just-installed) {
		outline: 2px solid var(--color-primary-600, #2563eb);
		outline-offset: 2px;
		transition: outline-color 0.4s ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		.mod-tab.pulse {
			animation: none;
		}
	}
</style>
