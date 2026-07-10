<script lang="ts">
	import { Accordion, AccordionItem, Modal, Button, Checkbox, Select } from 'flowbite-svelte';
	import { showGrid, vrOverride, vrMenuHand, vrSnapAngle, vrFlying } from '../../stores/sceneStore.js';
	import { settingsOpen, settingsSection, hidePanels, restorePanels, advancedMode } from '../../stores/appStore.js';
	import { syncedAnimations } from '../../stores/flowStore';
	import { spatialVoice } from '$lib/voiceChat';
	import { autosaveEnabled, clearSavedSession } from '$lib/autosave';
	import { shortcuts } from '$lib/shortcuts';

	let shortcutGroups = [...new Set(shortcuts.map((s) => s.group))];
	let shortcutsExpanded = false;

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
	$: if ($settingsOpen) {
		hidePanels();
		// refresh the group list — later phases register more shortcuts at runtime
		shortcutGroups = [...new Set(shortcuts.map((s) => s.group))];
		shortcutsExpanded = $settingsSection === 'shortcuts';
	} else if ($settingsOpen === false) {
		restorePanels();
		$settingsSection = null;
	}
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
					<p class={middlecoverName}>
						<Checkbox
							bind:checked={$showGrid}
							onclick={() => {
								if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
								else localStorage.setItem('showGrid', 'false');
							}}>&nbsp;Show grid</Checkbox
						>
					</p>
					<p class={middlecoverDescription}>Display grid on floor</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$syncedAnimations}>&nbsp;Sync animations</Checkbox>
					</p>
					<p class={middlecoverDescription}>Node animations use wall-clock time so all peers see the same phase</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$spatialVoice}>&nbsp;Spatial voice</Checkbox>
					</p>
					<p class={middlecoverDescription}>Voices come from where each peer is (pan + distance falloff)</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$advancedMode}>&nbsp;Advanced mode</Checkbox>
					</p>
					<p class={middlecoverDescription}>Show system objects (module content, environment rig) as a System filter in the object list</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox
							checked={$vrFlying}
							on:change={(e) => {
								$vrFlying = e.target.checked;
								localStorage.setItem('vrFlying', String($vrFlying));
							}}>&nbsp;VR flying</Checkbox>
					</p>
					<p class={middlecoverDescription}>Left-stick movement follows where the controller points (fly); off = stay level</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$autosaveEnabled}>&nbsp;Autosave</Checkbox>
					</p>
					<p class={middlecoverDescription}>Keep a local session snapshot (restore offered after a crash/reload)</p>
				</div>
				<div class="flex">
					<p class={middlecoverName}>
						<Checkbox
							checked={$vrMenuHand === 'left'}
							onclick={() => {
								const next = $vrMenuHand === 'left' ? 'right' : 'left';
								$vrMenuHand = next;
								localStorage.setItem('vrMenuHand', next);
							}}>&nbsp;VR menu on left</Checkbox
						>
					</p>
					<p class={middlecoverDescription}>Which controller opens the VR quick-menu (the other hand points)</p>
				</div>
				<div class="flex">
					<p class={bottomCoverName}>
						<Select
							class="border-0 bg-transparent p-0 text-sm dark:bg-transparent"
							items={[
								{ value: 15, name: 'Snap turn 15°' },
								{ value: 30, name: 'Snap turn 30°' },
								{ value: 45, name: 'Snap turn 45°' }
							]}
							value={$vrSnapAngle}
							on:change={(e) => {
								$vrSnapAngle = parseInt(e.srcElement.value);
								localStorage.setItem('vrSnapAngle', String($vrSnapAngle));
							}}
						/>
					</p>
					<p class={bottomCoverDescription}>VR thumbstick flick rotation angle</p>
				</div>
			</AccordionItem>
			<AccordionItem bind:open={shortcutsExpanded}>
				<svelte:fragment slot="header">Shortcuts</svelte:fragment>
				{#each shortcutGroups as group, groupIndex}
					<p class="mb-1 mt-3 text-xs font-semibold uppercase text-gray-400">{group}</p>
					{#each shortcuts.filter((s) => s.group === group) as shortcut}
						<div class="flex items-center gap-3 py-1">
							<kbd
								class="min-w-16 rounded-lg border border-gray-200 bg-gray-100 px-2 py-1 text-center text-xs font-semibold text-gray-800 dark:border-gray-500 dark:bg-gray-600 dark:text-gray-100"
								>{shortcut.keys}</kbd
							>
							<span class="text-sm text-gray-600 dark:text-gray-300">{shortcut.label}</span>
						</div>
					{/each}
				{/each}
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
		<Button color="alternative" onclick={() => clearSavedSession()}>Clear saved session</Button>
	</svelte:fragment>
</Modal>
