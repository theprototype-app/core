<script>
	import { Modal, Button, Toggle } from 'flowbite-svelte';
	import { modulesOpen } from '../../stores/appStore.js';
	import {
		moduleMenuItems,
		disabledModules,
		setModuleEnabled,
		isModuleLoaded,
		loadedModulesChanged
	} from '$lib/moduleSDK';
	import { coreModules } from '../../modules/index.js';

	let tab = 'core';

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

<Modal title="Modules" bind:open={$modulesOpen} size="lg" outsideclose>
	<div class="mb-3 flex gap-2">
		<Button size="xs" color={tab === 'core' ? 'primary' : 'alternative'} on:click={() => (tab = 'core')}>
			Core
		</Button>
		<Button size="xs" color={tab === 'user' ? 'primary' : 'alternative'} on:click={() => (tab = 'user')}>
			User
		</Button>
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
							{/if}
							<Button size="xs" color="alternative" on:click={() => downloadModule(mod)}>
								⬇ Download as example
							</Button>
						</div>
					</div>
				{/each}
			{/key}
		</div>
	{:else}
		<div id="user-modules-tab">
			<p class="text-sm text-gray-500 dark:text-gray-300">
				Install your own modules from a zip file or a repository link — coming right up
				(download a core module above as a starting point; see MODULES.md for the format).
			</p>
		</div>
	{/if}
</Modal>
