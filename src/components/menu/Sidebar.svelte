<script lang="ts">
	import '../../app.css';
	import '../../styles/menu.css';
	import { save, load, importFile } from '$lib/fileHandler.svelte';
	import {
		settingsOpen,
		propertiesClose,
		lightPropertiesClose,
		showSidebar,
		closeMenu
	} from '../../stores/appStore.js';
	import { backgroundColor } from '../../stores/sceneStore';
	import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { sineIn } from 'svelte/easing';

	import {
		Sidebar,
		SidebarGroup,
		SidebarItem,
		SidebarWrapper,
		SidebarDropdownWrapper,
		SidebarDropdownItem,
		Radio,
		Dropdown,
		Drawer,
		Navbar,
		Card
	} from 'flowbite-svelte';
	import { Hamburger } from 'svelte-hamburgers';
	import invert from 'invert-color';

	let saveFormat = 'json';
	let spanClass = 'flex-1 ms-3 whitespace-nowrap';
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

<div
class="burger inline-flex rounded-md bg-primary-700 shadow-sm"
style="width: 120px; height: 55px; background-color: rgba(100, 123, 155, 1); top: 5px; left: 5px;"
>
<Navbar rounded color="form">

	<img src="logo.svg" alt="logo" class="h-10 w-10" />
		<div class="" style="position: absolute; top: 0; left: 50px;">
	<Hamburger
		bind:open={$closeMenu}
		--color={invert($backgroundColor)}
		
		type="none"
	/>
</div>

</Navbar>
</div>
{#if true}

<div class="hamburger" style="z-index: 49;">
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
			<SidebarDropdownWrapper label="Primitives">
				<svelte:fragment slot="arrowup">
					<svg
						style="transform: rotate(180deg);"
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="18 9 12 15 6 9"></polyline>
					</svg>
				</svelte:fragment>
				<svelte:fragment slot="arrowdown">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="18 9 12 15 6 9"></polyline>
					</svg>
				</svelte:fragment>
				<SidebarDropdownItem
				label="Cube"
				on:click={() => {
					showSidebar('properties');
					sceneCommand('/create Box 2 2 2');
				}}
			>
					<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
				<SidebarDropdownItem
					label="Cone"
					on:click={() => {
						showSidebar('properties');
						sceneCommand('/create Cone 1');
					}}
				>
					<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
				<SidebarDropdownItem
					label="Sphere"
					on:click={() => {
						showSidebar('properties');
						sceneCommand('/create Sphere 1');
					}}
				>
				<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
			</SidebarDropdownWrapper>

			<SidebarDropdownWrapper label="Lights">
				<svelte:fragment slot="arrowup">
					<svg
						style="transform: rotate(180deg);"
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="18 9 12 15 6 9"></polyline>
					</svg>
				</svelte:fragment>
				<svelte:fragment slot="arrowdown">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="18 9 12 15 6 9"></polyline>
					</svg>
				</svelte:fragment>
				
					<SidebarDropdownItem
					label="Ambient"
					on:click={() => {
						showSidebar('lightProperties');
						sceneCommand('/light ambient');
					}}
				>
					<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
				<SidebarDropdownItem
					label="Directional"
					on:click={() => {
						showSidebar('lightProperties');
						sceneCommand('/light directional');
					}}
				>
					<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
				<SidebarDropdownItem
					label="Hemisphere"
					on:click={() => {
						showSidebar('lightProperties');
						sceneCommand('/light hemisphere');
					}}
				>
					<svelte:fragment slot="icon"></svelte:fragment>
				</SidebarDropdownItem>
			</SidebarDropdownWrapper>
		
			<SidebarItem
				label="Create Group"
				
				on:click={() => {
					showSidebar('properties');
					sceneCommand('/group New');
				}}>
				
			</SidebarItem>
			<SidebarItem
				label="Library"
				
				on:click={() => {
					showSidebar('library');
				}}>
				
				</SidebarItem>
		</SidebarGroup>
		{#key rerenderInput}
			<input type="file" id="import-file" style="display: none" on:input={e => { importFile(e.target.files[0])}} accept=".gltf, .glb, .obj, .stl, .fbx" />
			<input type="file" id="load-file" style="display: none" on:input={e => load(e.target.files[0])} accept=".json, .gltf, .scene" />
		{/key}
		<SidebarGroup border>

			<div class="" role="group">
				<div class="inline-flex shadow-sm " role="group">
				<button type="button" class={saveClass + " border rounded-tr-lg rounded-tl-lg"}
				on:click={() => { 
					document.getElementById('import-file').click()
					// Toggle rerenderInput to refresh the input type file HTML elements
					// and we want to load same object even if it is selected twice
        			rerenderInput = rerenderInput ? false : true
				}
			}>
				  📩 Import&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
				</button>
				</div>
			<div class="inline-flex rounded-md shadow-sm">
        <div class="inline-flex rounded-md shadow-sm" role="group">
			<button type="button" class={saveClass + " border "}
			on:click={() => document.getElementById('load-file').click()}>
			  📁<br />Load
			</button>
			<button type="button" class={saveClass + " border-t border-b border-r"}
			on:click={() => save(saveFormat)}>
			  💾<br />Save
			</button>
			<button type="button" class="px-1 py-2 text-sm font-medium text-gray-900 bg-white border-t border-b border-r border-gray-200 hover:bg-gray-100 hover:text-blue-700 focus:z-10 focus:ring-2 focus:ring-blue-700 focus:text-blue-700 dark:bg-gray-800 dark:border-gray-700 dark:text-white dark:hover:text-white dark:hover:bg-gray-700 dark:focus:ring-blue-500 dark:focus:text-white"
			>
		   
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="18 9 12 15 6 9"></polyline>
			</svg>    
			
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
	</div>
	</div>
			<SidebarItem
				label="Configure Scene"
				{spanClass}
				on:click={() => {
					showSidebar('scene');
				}}
			></SidebarItem>
			<SidebarItem
				label="Clear Scene"
				{spanClass}
				on:click={() => {
					lightPropertiesClose.set(true);
					propertiesClose.set(true);
					sceneCommand('/clear all');
				}}
			></SidebarItem>

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
	<Card class="border-0"/>
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
