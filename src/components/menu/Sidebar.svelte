<script lang="ts">
	import '../../app.css';
	import '../../styles/menu.css';
	import { save, load, importFile } from '$lib/fileHandler.svelte';
	import {
		settingsOpen,
		inspectorClose,
		inspectorKind,
		closeSelectionInspector,
		libraryClose,
		showSidebar,
		closeMenu
	} from '../../stores/appStore.js';
	import { objectsGroup } from '../../stores/sceneStore';
	import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { modulesOpen, sessionsOpen, showToast } from '../../stores/appStore.js';
	import { sineIn } from 'svelte/easing';

	import {
		Sidebar,
		SidebarGroup,
		SidebarItem,
		SidebarWrapper,
		Radio,
		Dropdown,
		Drawer
	} from 'flowbite-svelte';

	let saveFormat = 'json';
	let spanClass = 'flex-1 ms-3 whitespace-nowrap';
	let sectionLabel = 'mb-1 mt-3 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400';
	let fileButton =
		'bg-white px-1 py-2 text-xs font-medium text-gray-900 hover:bg-gray-100 hover:text-blue-700\
		dark:bg-gray-800 dark:text-white dark:hover:bg-gray-700 dark:hover:text-white';
	let saveClass =
		'px-4 py-2 text-sm font-medium text-gray-900 border-gray-200 hover:bg-gray-100\
	hover:text-blue-700 focus:z-10 focus:ring-2 focus:ring-blue-700 focus:text-blue-700 dark:bg-gray-800\
	dark:text-gray-400 dark:border-gray-700 dark:text-white dark:hover:text-white dark:hover:bg-gray-700\
	dark:focus:ring-blue-500 dark:focus:text-white bg-white';

	// let  open  = $state(false);
	let rerenderInput = $state(false);

	let transitionParamsRight = {
		x: -320,
		duration: 200,
		easing: sineIn
	};
</script>

<!-- 94: the logo IS the menu button — the old squeeze hamburger overlapped it
     (and showed an X while the sidebar was closed). Open state = accent ring. -->
<button
	id="logo-menu"
	class="burger flex items-center justify-center rounded-lg border bg-gray-800/90 shadow-lg backdrop-blur transition-transform hover:scale-105 {$closeMenu
		? 'border-gray-700/60'
		: 'border-primary-500 ring-2 ring-primary-500/50'}"
	style="height: 48px; width: 48px; top: 8px; left: 8px;"
	title={$closeMenu ? 'Open menu' : 'Close menu'}
	on:click={() => closeMenu.update((value) => !value)}
>
	<img src="logo.svg" alt="menu" class="h-9 w-9" />
</button>
{#if true}

<div class="hamburger">
<div>
<Drawer
	hidden={$closeMenu}
	activateClickOutside={false}
	backdrop={false}
	placement="left"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 top-16 h-full"
	topOffset="top-16"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	class="rounded-tr-lg"
	id="sidebar70"
>
<Sidebar>
	<SidebarWrapper>
		<SidebarGroup>
			<!-- Create moved to the viewport right-click Add menu (phase 77) -->
			<p class={sectionLabel}>Assets</p>
			<SidebarItem
				label={($libraryClose ? '' : '● ') + 'Library'}
				on:click={() => {
					showSidebar('library');
				}}>
				<svelte:fragment slot="icon">📚</svelte:fragment>
			</SidebarItem>
			<div id="open-modules-manager">
				<SidebarItem
					label="Modules"
					on:click={() => {
						modulesOpen.set(true);
					}}>
					<svelte:fragment slot="icon">🧩</svelte:fragment>
				</SidebarItem>
			</div>
		</SidebarGroup>
		{#key rerenderInput}
			<input type="file" id="import-file" style="display: none" on:input={e => { importFile(e.target.files[0])}} accept=".gltf, .glb, .obj, .stl, .fbx" />
			<input type="file" id="load-file" style="display: none" on:input={e => load(e.target.files[0])} accept=".json, .gltf, .scene" />
		{/key}
		<SidebarGroup border>

			<p class={sectionLabel}>Files</p>
			<div
				class="grid grid-cols-4 overflow-hidden rounded-lg border border-gray-200 shadow-sm dark:border-gray-700"
				role="group"
			>
				<button type="button" class={fileButton}
				on:click={() => {
					document.getElementById('import-file').click()
					// Toggle rerenderInput to refresh the input type file HTML elements
					// and we want to load same object even if it is selected twice
        			rerenderInput = rerenderInput ? false : true
				}}>
					📩<br />Import
				</button>
				<button type="button" class={fileButton + ' border-l border-gray-200 dark:border-gray-700'}
				on:click={() => document.getElementById('load-file').click()}>
					📁<br />Load
				</button>
				<button type="button" class={fileButton + ' border-l border-gray-200 dark:border-gray-700'}
				on:click={() => save(saveFormat)}>
					💾<br />Save
				</button>
				<button
					type="button"
					title="Save format"
					class={fileButton + ' border-l border-gray-200 dark:border-gray-700'}
				>
					<span class="text-[9px] uppercase text-gray-400">{saveFormat}</span><br />▾
				</button>
				<Dropdown placement='bottom' class="w-44 p-3 space-y-3 text-sm">
				  <li>
					<Radio name="group1" bind:group={saveFormat} value={'scene'} disabled>Scene</Radio>
				  </li>
				  <li>
					<Radio name="group1" bind:group={saveFormat} value={'json'}>JSON</Radio>
				  </li>
				  <li>
					<Radio name="group1" bind:group={saveFormat} value={'gltf'}>GLTF</Radio>
				  </li>
				</Dropdown>
			</div>

			<p class={sectionLabel}>Scene</p>
			<SidebarItem
				label={(!$inspectorClose && $inspectorKind === 'scene' ? '● ' : '') + 'Configure Scene'}
				{spanClass}
				on:click={() => {
					showSidebar('scene');
				}}
			>
				<svelte:fragment slot="icon">🎛️</svelte:fragment>
			</SidebarItem>
			<div id="open-sessions-manager">
				<SidebarItem
					label="Sessions"
					{spanClass}
					on:click={() => {
						sessionsOpen.set(true);
					}}
				>
					<svelte:fragment slot="icon">🗂️</svelte:fragment>
				</SidebarItem>
			</div>
			<SidebarItem
				label="Clear Scene"
				{spanClass}
				on:click={() => {
					const count = $objectsGroup?.children.length ?? 0;
					if (count === 0) {
						sceneCommand('/clear all'); // still clears module content
						return;
					}
					showToast('Clear the scene for everyone? ' + count + ' object' + (count === 1 ? '' : 's') + ' will be removed.', [
						{
							label: 'Clear',
							action: () => {
								closeSelectionInspector();
								sceneCommand('/clear all');
							}
						},
						{ label: 'Cancel', action: () => {} }
					]);
				}}
			>
				<svelte:fragment slot="icon">🗑️</svelte:fragment>
			</SidebarItem>

			<p class={sectionLabel}>App</p>
			<SidebarItem
				label="Settings"
				{spanClass}
				style="padding-right: 40px"
				on:click={() => settingsOpen.set(!$settingsOpen)}
			>
				<svelte:fragment slot="icon">⚙️</svelte:fragment>
			</SidebarItem>

			<SidebarItem
				label="Docs"
				{spanClass}
				style="padding-right: 40px"
				on:click={() => { window.open('https://github.com/AlexZ005/theprototype.app/wiki', '_blank') } }
			>
				<svelte:fragment slot="icon">📖</svelte:fragment>
			</SidebarItem>
		</SidebarGroup>
	</SidebarWrapper>
</Sidebar>
</Drawer>


</div>
</div>
{/if}


<style>
	:global(.switchMenu) {
		display: flex;
	}
	.burger {
		background-color: var(--color-form);
	}
</style>
