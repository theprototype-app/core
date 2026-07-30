<script>
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
		removeUserModule
	} from '$lib/userModules';
	let tab = 'core';
	let installUrlValue = '';

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
	size="lg"
	outsideclose
	class="tp-modal-frame"
	dialogClass="tp-modal-dialog fixed top-0 start-0 end-0 h-modal md:inset-0 md:h-full z-50 w-full p-4 flex"
	bodyClass="tp-modal-body flex-1 overflow-y-auto overscroll-contain"
	backdropClass="tp-modal-backdrop fixed inset-0 z-40 bg-gray-900 bg-opacity-50 dark:bg-opacity-80"
	headerClass="tp-modal-header flex justify-between items-center p-4 md:p-5 rounded-t-lg"
>
	<div class="mod-tabs" role="tablist">
		<button class="mod-tab" class:active={tab === 'core'} role="tab" aria-selected={tab === 'core'} on:click={() => (tab = 'core')}>
			Core
		</button>
		<button class="mod-tab" class:active={tab === 'user'} role="tab" aria-selected={tab === 'user'} on:click={() => (tab = 'user')}>
			User
		</button>
	</div>

	{#if tab === 'core'}
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
								on:change={(e) => setModuleEnabled(mod, e.target.checked)}
							/>
						</div>
						<p class="pt-1 text-sm text-gray-500 dark:text-gray-300">{mod.description ?? ''}</p>
						<div class="flex flex-wrap items-center gap-2 pt-2">
							{#if isModuleLoaded(mod.id) && !$disabledModules.includes(mod.id)}
								{#each $moduleMenuItems.filter((item) => item.moduleId === mod.id) as item}
									<Button size="xs" on:click={item.action}>{item.label}</Button>
								{/each}
								{#each primitivesByModule[mod.id] ?? [] as primitive}
									<Button
										size="xs"
										color="green"
										title={primitive.command}
										on:click={() => sceneCommand(primitive.command)}
									>
										+ {primitive.label}
									</Button>
								{/each}
							{/if}
							<Button size="xs" color="alternative" on:click={() => downloadModule(mod)}>
								<i class="fa-solid fa-download mr-1"></i>Download as example
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
			<div class="flex items-center gap-2">
				<Button size="xs" on:click={() => document.getElementById('install-module-zip').click()}>
					Install zip
				</Button>
				<input
					type="file"
					id="install-module-zip"
					style="display: none"
					accept=".zip"
					on:change={async (e) => {
						const file = e.target.files?.[0];
						if (file) await installZip(file);
						e.target.value = '';
					}}
				/>
				<input
					id="install-module-url"
					class="flex-1 rounded border border-gray-600 bg-transparent px-2 py-1 text-sm dark:text-white"
					placeholder="https://raw.githubusercontent.com/user/repo/main/mymodule (or github.com/…/tree/…)"
					bind:value={installUrlValue}
				/>
				<Button
					size="xs"
					color="alternative"
					disabled={!installUrlValue.trim()}
					on:click={async () => {
						await installUrl(installUrlValue);
						installUrlValue = '';
					}}
				>
					Install URL
				</Button>
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
								checked={!$disabledModules.includes(record.id)}
								on:change={async (e) => {
									if (e.target.checked) {
										$disabledModules = $disabledModules.filter((id) => id !== record.id);
										await activateUserModule(record);
									} else {
										$disabledModules = [...new Set([...$disabledModules, record.id])];
										if (isModuleLoaded(record.id)) showToast('"' + record.name + '" disabled — reload to apply');
									}
								}}
							/>
						</div>
						<p class="pt-1 text-sm text-gray-500 dark:text-gray-300">{record.description}</p>
						<div class="flex flex-wrap items-center gap-2 pt-2">
							{#if isModuleLoaded(record.id) && !$disabledModules.includes(record.id)}
								{#each $moduleMenuItems.filter((item) => item.moduleId === record.id) as item}
									<Button size="xs" on:click={item.action}>{item.label}</Button>
								{/each}
							{/if}
							{#if record.source !== 'zip'}
								<Button size="xs" color="alternative" on:click={() => updateUserModule(record)}>Update</Button>
							{/if}
							<Button size="xs" color="red" on:click={() => removeUserModule(record.id)}>Remove</Button>
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
