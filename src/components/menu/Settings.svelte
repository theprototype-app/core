<script lang="ts">
	import { Accordion, AccordionItem, Modal, Button, Checkbox } from 'flowbite-svelte';
	import { showGrid, vrOverride } from '../../stores/sceneStore.js';
	import { settingsOpen, hidePanels, restorePanels } from '../../stores/appStore.js';

	//Rounded corners for options
	let coverClass =
		'z-10 inline-flex items-center py-2.5 text-sm font-medium text-center text-gray-500 bg-gray-100 border border-gray-300 dark:bg-gray-700 dark:text-white dark:border-gray-600';
	let topcoverName =
		'w-40 flex-shrink-0 px-4 rounded-tl-lg hover:bg-gray-200 focus:ring-4 focus:outline-none focus:ring-gray-100 dark:hover:bg-gray-600 dark:focus:ring-gray-700 ' +
		coverClass;
	let middlecoverName =
		'w-40 flex-shrink-0 px-4 hover:bg-gray-200 focus:ring-4 focus:outline-none focus:ring-gray-100 dark:hover:bg-gray-600 dark:focus:ring-gray-700 ' +
		coverClass;
	let topcoverDescription = 'w-full px-5 rounded-tr-lg ' + coverClass;
	let middlecoverDescription = 'w-full px-5 ' + coverClass;
	let bottomCoverName =
		'w-40 flex-shrink-0 px-4 rounded-bl-lg hover:bg-gray-200 focus:ring-4 focus:outline-none focus:ring-gray-100 dark:hover:bg-gray-600 dark:focus:ring-gray-700 ' +
		coverClass;
	let bottomCoverDescription = 'w-full px-5 rounded-br-lg ' + coverClass;

	// Hide open panels while settings is shown, restore them after (initial value is null,
	// so nothing happens until the modal is opened the first time)
	$: if ($settingsOpen) hidePanels();
	else if ($settingsOpen === false) restorePanels();
</script>

<Modal
	title="Settings"
	bind:open={$settingsOpen}
	outsideclose
>
	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<Accordion>
			<AccordionItem>
				<svelte:fragment slot="header">Scene</svelte:fragment>
				<div class="flex">
					<p class={topcoverName}>
						<Checkbox
							bind:checked={$vrOverride}
							onclick={() => {
								if (localStorage.getItem('vrOverride')) localStorage.removeItem('vrOverride');
								else localStorage.setItem('vrOverride', 'true');
							}}>&nbsp;VR override</Checkbox
						>
					</p>
					<p class={topcoverDescription}>Forces normal play even if immersive-vr is enabled</p>
				</div>
				<div class="flex">
					<p class={bottomCoverName}>
						<Checkbox
							bind:checked={$showGrid}
							onclick={() => {
								if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
								else localStorage.setItem('showGrid', 'false');
							}}>&nbsp;Show grid</Checkbox
						>
					</p>
					<p class={bottomCoverDescription}>Display grid on floor</p>
				</div>
			</AccordionItem>
			<AccordionItem>
				<svelte:fragment slot="header">About</svelte:fragment>
				<div class="flex">
					<p class={topcoverName}>
						Version
					</p>
					<p class={topcoverDescription}>alpha</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						Dev Builds
					</p>
					<p class={middlecoverDescription}><a href="https://alexz005.github.io/theprototype">https://alexz005.github.io/theprototype</a></p>
				</div>
				<div class="flex">
					<p class={bottomCoverName}>
						Source Code
					</p>
					<p class={bottomCoverDescription}><a href="https://github.com/AlexZ005/theprototype.app" target="_blank">https://github.com/AlexZ005/theprototype.app</a></p>
				</div>

			</AccordionItem>
		</Accordion>
	</div>
	<svelte:fragment slot="footer">
		<Button onclick={() => localStorage.clear()}>Reset settings</Button>
	</svelte:fragment>
</Modal>
