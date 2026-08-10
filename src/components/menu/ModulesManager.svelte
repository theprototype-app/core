<script>
	import { Download } from '@lucide/svelte';
	import { Modal, Button, Toggle } from 'flowbite-svelte';
	import { modulesOpen, hidePanels, restorePanels, showToast } from '../../stores/appStore.js';
	import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { modulePrimitiveGroups } from '$lib/moduleSDK';

	// like Settings: side panels hide while the manager is open, restore after
	$: if ($modulesOpen) {
		hidePanels();
	} else if ($modulesOpen === false) {
		restorePanels();
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
		devPolling
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
		<button class="mod-tab" class:active={tab === 'user'} role="tab" aria-selected={tab === 'user'} on:click={() => (tab = 'user')}>
			User
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
				{#each $galleryModules as entry (entry.id)}
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
			<div class="flex items-center gap-2">
				<input
					id="install-module-url"
					class="flex-1 rounded-sm border border-gray-600 bg-transparent px-2 py-1 text-sm dark:text-white"
					placeholder="Module URL — https://raw.githubusercontent.com/user/repo/main/mymodule (or a github.com/…/tree/… link)"
					bind:value={installUrlValue}
					on:keydown={async (e) => {
						if (e.key !== 'Enter' || !installUrlValue.trim()) return;
						await installUrl(installUrlValue);
						installUrlValue = '';
					}}
				/>
				<Button
					size="xs"
					disabled={!installUrlValue.trim()}
					onclick={async () => {
						await installUrl(installUrlValue);
						installUrlValue = '';
					}}
				>
					Install
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
						const file = e.currentTarget.files?.[0];
						if (file) await installZip(file);
						e.currentTarget.value = '';
					}}
				/>
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
							<div class="shrink-0" title="Poll the dev URL (~2s) and reload when the code changes">
								<Toggle
									size="small"
									id={'dev-poll-' + record.id}
									checked={$devPolling.includes(record.id)}
									onchange={(e) => setDevPoll(record, e.currentTarget.checked)}
								>
									<span class="text-xs text-gray-400">Auto</span>
								</Toggle>
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
	/* Core / User read as real tabs (underline the active one) instead of two buttons. */
	.mod-tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 0.85rem;
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
</style>
