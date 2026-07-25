<script lang="ts">
	import { Accordion, AccordionItem, Modal, Button, Checkbox, Toggle } from 'flowbite-svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { showGrid, vrOverride, vrMenuHand, vrSnapAngle, vrMirrorSnapTurn, vrTeleportEnabled, vrVertexHold, vrFlying, vrPassthrough, vrMenuHold, vrTargetHz, peerHandStyle } from '../../stores/sceneStore.js';
	import { applyVRFrameRate } from '$lib/vrControls';
	import { settingsOpen, settingsSection, hidePanels, restorePanels, advancedMode, showEnvInList, objectSearchEnabled, showSimControls, showToast, showRoomsButton, toastsInDrawerOnly } from '../../stores/appStore.js';
	import { drawerSlot } from '$lib/cloudHooks';
	import { vrFaceCap, VR_FACE_CAP } from '$lib/faceEdit';
	import { vrVertexCap, VR_VERTEX_CAP } from '$lib/meshEdit';
	import { syncedAnimations } from '../../stores/flowStore';
	import { spatialVoice } from '$lib/voiceChat';
	import { shadowQuality } from '$lib/lightParams';
	import { myHandModel, setMyHandModel } from '$lib/handModels';
	import { explorerItems } from '$lib/explorer';
	import { pingColor, pingSound } from '$lib/ping';
	import { PING_SOUNDS, playPing } from '$lib/pingAudio';
	import {
		THEMES,
		theme,
		customThemes,
		exportActiveTheme,
		importThemeFile,
		removeCustomTheme
	} from '$lib/themes';
	import { autosaveEnabled, clearSavedSession } from '$lib/autosave';
	import { resetWindowPoses } from '$lib/vrWindowPoses';
	import { resetWindowLayout } from '$lib/dragWindow';
	import { shortcuts } from '$lib/shortcuts';
	import {
		aiEnabled,
		setAiEnabled,
		aiProviders,
		aiActiveProvider,
		setAiActiveProvider,
		addAiProvider,
		updateAiProvider,
		removeAiProvider,
		PROVIDER_PRESETS,
		presetFor
	} from '$lib/ai/providers';
	import { testConnection } from '$lib/ai/client';
	import {
		meshGenEnabled,
		setMeshGenEnabled,
		meshProviders,
		meshActiveProvider,
		setMeshActiveProvider,
		addMeshProvider,
		updateMeshProvider,
		removeMeshProvider,
		MESH_PRESETS,
		meshPresetFor
	} from '$lib/ai/meshProviders';
	import { peerServerConfig, HAS_SELF_HOSTED, SELF_HOSTED_HOST } from '$lib/peerServer';

	let shortcutGroups = [...new Set(shortcuts.map((s) => s.group))];
	let shortcutsExpanded = false;
	let aiExpanded = false;
	let sceneExpanded = false;
	let connectionExpanded = false;
	let vrExpanded = false; // D7: edit-cap toasts deep-link here ('vr')

	// D7: sanitize a cap edit — an empty/garbage field falls back to the default
	function setCap(store: any, raw: string, fallback: number) {
		const value = parseInt(raw);
		store.set(Number.isFinite(value) && value >= 10 ? value : fallback);
	}

	// AI provider add/edit form state (roadmap #10). Legacy-mode file — plain lets.
	let aiFormOpen = false;
	let aiEditId: string | null = null;
	let aiFormPreset = 'grok';
	let aiFormLabel = '';
	let aiFormBaseUrl = '';
	let aiFormKey = '';
	let aiFormModel = '';
	let aiTesting = false;

	function aiApplyPreset() {
		const preset = presetFor(aiFormPreset);
		aiFormLabel = preset.label;
		aiFormBaseUrl = preset.baseUrl;
		aiFormModel = preset.defaultModel;
	}
	function aiStartAdd() {
		aiEditId = null;
		aiFormPreset = 'grok';
		aiApplyPreset();
		aiFormKey = '';
		aiFormOpen = true;
	}
	function aiStartEdit(p: any) {
		aiEditId = p.id;
		aiFormPreset = p.preset;
		aiFormLabel = p.label;
		aiFormBaseUrl = p.baseUrl;
		aiFormKey = p.apiKey;
		aiFormModel = p.model;
		aiFormOpen = true;
	}
	function aiSaveProvider() {
		if (!aiFormBaseUrl.trim() || !aiFormModel.trim()) {
			showToast('Base URL and model are required');
			return;
		}
		const config = {
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: aiFormBaseUrl,
			apiKey: aiFormKey,
			model: aiFormModel
		};
		if (aiEditId) updateAiProvider(aiEditId, config);
		else addAiProvider(config);
		aiFormOpen = false;
		aiEditId = null;
	}
	async function aiTest() {
		if (!aiFormBaseUrl.trim() || !aiFormModel.trim()) {
			showToast('Enter a base URL and model first');
			return;
		}
		aiTesting = true;
		const result = await testConnection({
			id: 'test',
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: aiFormBaseUrl.trim().replace(/\/+$/, ''),
			apiKey: aiFormKey.trim(),
			model: aiFormModel.trim()
		});
		aiTesting = false;
		showToast(result.ok ? '✓ ' + result.detail : '✗ ' + result.detail);
	}

	// Mesh-generation provider add/edit form (roadmap #11)
	let meshFormOpen = false;
	let meshEditId: string | null = null;
	let meshFormKind = 'comfyui';
	let meshFormLabel = '';
	let meshFormBaseUrl = '';
	let meshFormKey = '';
	let meshFormWorkflow = '';
	let meshFormOutputNode = '';
	let meshFormMode = 'preview';

	function meshApplyPreset() {
		const preset = meshPresetFor(meshFormKind);
		meshFormLabel = preset.label;
		meshFormBaseUrl = preset.baseUrl;
	}
	function meshStartAdd() {
		meshEditId = null;
		meshFormKind = 'comfyui';
		meshApplyPreset();
		meshFormKey = '';
		meshFormWorkflow = '';
		meshFormOutputNode = '';
		meshFormMode = 'preview';
		meshFormOpen = true;
	}
	function meshStartEdit(p: any) {
		meshEditId = p.id;
		meshFormKind = p.kind;
		meshFormLabel = p.label;
		meshFormBaseUrl = p.baseUrl;
		meshFormKey = p.apiKey ?? '';
		meshFormWorkflow = p.workflowJson ?? '';
		meshFormOutputNode = p.outputNodeId ?? '';
		meshFormMode = p.mode ?? 'preview';
		meshFormOpen = true;
	}
	function meshSaveProvider() {
		if (!meshFormBaseUrl.trim()) {
			showToast('A base URL is required');
			return;
		}
		if (meshFormKind === 'comfyui' && meshFormWorkflow.trim()) {
			try {
				JSON.parse(meshFormWorkflow);
			} catch {
				showToast('The ComfyUI workflow is not valid JSON — re-export it in API format');
				return;
			}
		}
		const config: any = {
			kind: meshFormKind,
			label: meshFormLabel,
			baseUrl: meshFormBaseUrl,
			apiKey: meshFormKey
		};
		if (meshFormKind === 'comfyui') {
			config.workflowJson = meshFormWorkflow;
			config.outputNodeId = meshFormOutputNode;
		} else {
			config.mode = meshFormMode;
		}
		if (meshEditId) updateMeshProvider(meshEditId, config);
		else addMeshProvider(config);
		meshFormOpen = false;
		meshEditId = null;
	}

	// Peer signaling-server selection (default self-hosted+fallback / public / custom)
	function setPeerMode(v: any) {
		peerServerConfig.update((c) => ({ ...c, mode: v }));
	}
	function setPeerCustom(k: string, v: any) {
		peerServerConfig.update((c) => ({ ...c, custom: { ...c.custom, [k]: v } }));
	}

	// custom theme import (149): a hidden file input + a validating handler
	let themeFileInput: any;
	async function onThemeFile(e: any) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!file) return;
		const id = await importThemeFile(file);
		showToast(id ? 'Theme imported' : 'Not a valid .theme.json file');
	}

	// passthrough capability probe (90): the setting stays visible with a hint
	let arSupport: boolean | null = null;
	if (typeof navigator !== 'undefined') {
		(navigator as any).xr
			?.isSessionSupported?.('immersive-ar')
			.then((ok: boolean) => (arSupport = ok))
			.catch(() => (arSupport = false));
	}

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
		aiExpanded = $settingsSection === 'ai';
		sceneExpanded = $settingsSection === 'scene';
		connectionExpanded = $settingsSection === 'connection';
		vrExpanded = $settingsSection === 'vr';
	} else if ($settingsOpen === false) {
		restorePanels();
		$settingsSection = null;
	}

	// U-3: filter the (numerous) settings rows by a search query. A `use:` action
	// keeps it legacy-mode safe — it toggles each row's display without touching
	// the heterogeneous markup. Rows carry the `.setting-row` class; inner controls
	// live in <p>, so hiding a row never hides a control inside a shown row.
	let settingsQuery = '';
	/** @param {HTMLElement} node @param {string} query */
	function filterSettings(node: HTMLElement, query: string) {
		const apply = (q: string) => {
			const needle = (q || '').trim().toLowerCase();
			node.querySelectorAll('.setting-row').forEach((row) => {
				const text = (row.textContent || '').toLowerCase();
				(row as HTMLElement).style.display = !needle || text.includes(needle) ? '' : 'none';
			});
		};
		apply(query);
		return { update: apply };
	}
</script>

<Modal
	title="Settings"
	bind:open={$settingsOpen}
	outsideclose
	size="xl"
>
	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<input
			id="settings-search"
			type="text"
			class="ui-input mb-3 w-full"
			placeholder="Search settings…"
			bind:value={settingsQuery}
		/>
		<div use:filterSettings={settingsQuery}>
		<Accordion>
			<AccordionItem bind:open={vrExpanded}>
				<svelte:fragment slot="header">VR</svelte:fragment>
				<div class="flex setting-row">
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
				<div class="flex setting-row">
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
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<!-- a red SWITCH (98): reads as an armed mode, not a plain option -->
						<Toggle
							id="passthrough-toggle"
							color="red"
							size="small"
							checked={$vrPassthrough}
							on:change={(e: any) => {
								$vrPassthrough = e.target.checked;
								localStorage.setItem('vrPassthrough', String($vrPassthrough));
								showToast('Passthrough ' + ($vrPassthrough ? 'on' : 'off') + ' — takes effect on the next VR entry');
							}}>Passthrough</Toggle>
					</p>
					<p class={middlecoverDescription}>Mixed reality: the next VR entry composites the scene over your room (immersive-ar){arSupport === false ? ' — not supported on this device' : ''}</p>
				</div>
				<div class="flex setting-row">
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
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox
							id="vr-menu-hold"
							checked={$vrMenuHold}
							on:change={(e: any) => {
								$vrMenuHold = e.target.checked;
								localStorage.setItem('vrMenuHold', String($vrMenuHold));
							}}>&nbsp;Hold-to-menu</Checkbox>
					</p>
					<p class={middlecoverDescription}>Hold B/Y to show the radial menu, release over a sector to pick it (off = press toggles)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<ThemedSelect
							items={[
								{ value: 0, name: 'Off' },
								{ value: 15, name: '15°' },
								{ value: 30, name: '30°' },
								{ value: 45, name: '45°' }
							]}
							value={$vrSnapAngle}
							onchange={(v) => {
								$vrSnapAngle = parseInt(v);
								localStorage.setItem('vrSnapAngle', String($vrSnapAngle));
							}}
						/>
					</p>
					<p class={middlecoverDescription}><span class="font-semibold">Snap turn</span> — VR thumbstick flick rotation angle (Off disables it)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox
							id="vr-mirror-snap"
							checked={$vrMirrorSnapTurn}
							on:change={(e: any) => {
								$vrMirrorSnapTurn = e.target.checked;
								localStorage.setItem('vrMirrorSnapTurn', String($vrMirrorSnapTurn));
							}}>&nbsp;Mirror snap turn</Checkbox>
					</p>
					<p class={middlecoverDescription}>Flip the flick direction — left turns right and vice-versa</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox
							id="vr-teleport"
							checked={$vrTeleportEnabled}
							on:change={(e: any) => {
								$vrTeleportEnabled = e.target.checked;
								localStorage.setItem('vrTeleportEnabled', String($vrTeleportEnabled));
							}}>&nbsp;Teleport</Checkbox>
					</p>
					<p class={middlecoverDescription}>Right-stick-up teleport arc — off if you navigate only by stick/fly</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox
							id="vr-vertex-hold"
							checked={$vrVertexHold}
							on:change={(e: any) => {
								$vrVertexHold = e.target.checked;
								localStorage.setItem('vrVertexHold', String($vrVertexHold));
							}}>&nbsp;Hold to move vertex</Checkbox>
					</p>
					<p class={middlecoverDescription}>Hold the trigger to carry a vertex (release drops it); off = press to grab, press again to drop</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<input
							id="vr-face-cap"
							type="number"
							min="10"
							step="50"
							class="w-20 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
							value={$vrFaceCap}
							on:change={(e: any) => setCap(vrFaceCap, e.target.value, VR_FACE_CAP)}
						/>&nbsp;Face edit limit
					</p>
					<p class={middlecoverDescription}><span class="font-semibold">Mesh edit caps (D7)</span> — max triangles for VR face editing (default {VR_FACE_CAP}; denser meshes get a warning). Imported single meshes under the caps edit fine; Ungroup multi-mesh imports first</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<input
							id="vr-vertex-cap"
							type="number"
							min="10"
							step="50"
							class="w-20 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
							value={$vrVertexCap}
							on:change={(e: any) => setCap(vrVertexCap, e.target.value, VR_VERTEX_CAP)}
						/>&nbsp;Vertex edit limit
					</p>
					<p class={middlecoverDescription}>Max vertices for VR vertex editing (default {VR_VERTEX_CAP}) — very dense handle clouds get unwieldy with controllers</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<select
							id="peer-hand-style"
							class="rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
							value={$peerHandStyle}
							on:change={(e: any) => peerHandStyle.set(e.target.value)}
						>
							<option value="model">Model</option>
							<option value="hands">Hands</option>
							<option value="spheres">Spheres</option>
						</select>&nbsp;Peer hand style
					</p>
					<p class={middlecoverDescription}>How hand-tracked peers render for you — rounded capsule hands, cuboid bones or joint spheres (local preference)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<select
							id="my-hand-model"
							class="rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
							value={$myHandModel}
							on:change={(e: any) => setMyHandModel(e.target.value)}
						>
							<option value="">Default</option>
							{#each $explorerItems.filter((i: any) => i.kind === 'object') as item (item.id)}
								<option value={item.hash}>{item.name}</option>
							{/each}
						</select>&nbsp;My hand model
					</p>
					<p class={middlecoverDescription}><span class="font-semibold">Custom hands (identity)</span> — a GLB from your Explorer library that OTHER peers see as your hands in VR (bytes push automatically; renders rigid at the wrist)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<select
							id="vr-target-hz"
							class="rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
							value={$vrTargetHz}
							on:change={(e: any) => {
								vrTargetHz.set(e.target.value);
								applyVRFrameRate();
							}}
						>
							<option value="auto">Max</option>
							<option value="90">90</option>
							<option value="120">120</option>
						</select>&nbsp;VR refresh rate
					</p>
					<p class={middlecoverDescription}>Target headset Hz — Max picks the highest the device supports (120 needs the Quest 120Hz system setting); applies on VR entry</p>
				</div>
				<div class="flex setting-row">
					<p class={bottomCoverName}>
						<button
							id="vr-reset-poses"
							class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={() => {
								resetWindowPoses();
								showToast('VR menu positions reset');
							}}>Reset positions</button>
					</p>
					<p class={bottomCoverDescription}>Grabbed VR menus/panels snap back to their default spots on the controllers (111: hold the other grip on one to re-place it)</p>
				</div>
			</AccordionItem>
			<AccordionItem bind:open={sceneExpanded}>
				<svelte:fragment slot="header">Scene</svelte:fragment>
				<div class="flex setting-row">
					<p class={topcoverName}>
						<ThemedSelect
							id="theme-select"
							items={[...THEMES, ...$customThemes].map((t) => ({ value: t.id, name: t.name }))}
							bind:value={$theme}
						/>
					</p>
					<p class={topcoverDescription}><span class="font-semibold">Theme</span> — UI theme for THIS device (the 3D viewport follows the environment, not the theme)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName + ' gap-2'}>
						<button
							id="theme-export"
							class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={() => exportActiveTheme()}>Export template</button
						>
						<button
							id="theme-browse"
							class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={() => themeFileInput?.click()}>Browse…</button
						>
						<input
							type="file"
							accept=".json,application/json"
							bind:this={themeFileInput}
							style="display: none"
							on:change={onThemeFile}
						/>
					</p>
					<p class={middlecoverDescription}>
						Export the active theme as an editable .theme.json, tweak the colors, then Browse to load it back
						{#if $customThemes.length}
							<span class="mt-1 flex flex-wrap gap-1">
								{#each $customThemes as ct (ct.id)}
									<span class="inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px]">
										{ct.name}
										<button
											class="text-gray-400 hover:text-red-400"
											title="Remove theme"
											on:click={() => removeCustomTheme(ct.id)}>✕</button
										>
									</span>
								{/each}
							</span>
						{/if}
					</p>
				</div>
				<div class="flex setting-row">
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
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$showSimControls}>&nbsp;Show simulation controls</Checkbox>
					</p>
					<p class={middlecoverDescription}>Show the physics transport (play/pause/stop/reset) at bottom-right. Off by default to avoid confusion with the main play button; the P key still starts/stops the simulation</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$syncedAnimations}>&nbsp;Sync animations</Checkbox>
					</p>
					<p class={middlecoverDescription}>Node animations use wall-clock time so all peers see the same phase</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$spatialVoice}>&nbsp;Spatial voice</Checkbox>
					</p>
					<p class={middlecoverDescription}>Voices come from where each peer is (pan + distance falloff)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$advancedMode}>&nbsp;Advanced mode</Checkbox>
					</p>
					<p class={middlecoverDescription}>Show system objects (module content, environment rig) as a System filter in the object list</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$showEnvInList}>&nbsp;Environment in list</Checkbox>
					</p>
					<p class={middlecoverDescription}>Show the environment group as an Environment filter in the object list</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Checkbox bind:checked={$objectSearchEnabled}>&nbsp;Object search in menu</Checkbox>
					</p>
					<p class={middlecoverDescription}>Add a "Search objects…" entry to the viewport right-click menu — find a scene object and fly the camera to it</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Toggle bind:checked={$toastsInDrawerOnly}>&nbsp;Toasts in drawer only</Toggle>
					</p>
					<p class={middlecoverDescription}>Hide ALL pop-up toasts in the viewport — including connection requests — so they appear only in the connection drawer's Toasts tab (the notification bell still keeps the full history). Pin the drawer to keep the Toasts tab handy</p>
				</div>
				{#if $drawerSlot}
					<div class="flex setting-row">
						<p class={middlecoverName}>
							<Toggle bind:checked={$showRoomsButton}>&nbsp;Show Rooms button</Toggle>
						</p>
						<p class={middlecoverDescription}>Show the "🌐 Rooms" shortcut in the Connect bar. Off makes the bar cleaner — you can still open rooms from the connection info drawer (the chevron) ▸ Rooms tab</p>
					</div>
				{/if}
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<ThemedSelect
							id="shadow-quality"
							items={[
								{ value: 'off', name: 'Off' },
								{ value: 'low', name: 'Low' },
								{ value: 'medium', name: 'Medium' },
								{ value: 'high', name: 'High' }
							]}
							bind:value={$shadowQuality}
						/>
					</p>
					<p class={middlecoverDescription}><span class="font-semibold">Shadow quality</span> — caps every light's shadow map size on THIS machine (Off disables shadows entirely; per-light sizes still replicate)</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName + ' gap-1'}>
						<input
							type="color"
							id="ping-color"
							class="h-6 w-8 cursor-pointer rounded border border-gray-500 bg-transparent"
							value={$pingColor || '#4f83cc'}
							on:change={(e) => pingColor.set(e.currentTarget.value)}
						/>
						<ThemedSelect
							class="min-w-28"
							items={PING_SOUNDS.map((s) => ({ value: s.id, name: s.name }))}
							bind:value={$pingSound}
						/>
						<button
							id="ping-preview"
							class="rounded bg-gray-600 px-1.5 text-white"
							title="Preview the ping chime"
							on:click={() => playPing($pingSound)}
						>
							▶
						</button>
					</p>
					<p class={middlecoverDescription}>Your ping color + sound — peers see and hear YOUR pings this way (color empty = your peer color)</p>
				</div>
				<div class="flex setting-row">
					<p class={bottomCoverName}>
						<Checkbox bind:checked={$autosaveEnabled}>&nbsp;Autosave</Checkbox>
					</p>
					<p class={bottomCoverDescription}>Keep a local session snapshot (restore offered after a crash/reload)</p>
				</div>
				<div class="flex setting-row">
					<p class={bottomCoverName}>
						<button id="reset-windows" class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={() => { resetWindowLayout(); showToast('Window positions reset'); }}>Reset window positions</button>
					</p>
					<p class={bottomCoverDescription}>Bring back any floating window (object list, chat, Explorer, editors) that drifted off-screen or behind the UI</p>
				</div>
			</AccordionItem>
			<AccordionItem bind:open={aiExpanded}>
				<svelte:fragment slot="header">AI</svelte:fragment>
				<div class="flex setting-row">
					<p class={topcoverName}>
						<Toggle bind:checked={$aiEnabled} on:change={() => setAiEnabled($aiEnabled)}>&nbsp;Enable assistant</Toggle>
					</p>
					<p class={topcoverDescription}>
						<span class="font-semibold">AI scene assistant</span> — build and edit the scene with prompts. Press
						<kbd class="rounded border border-gray-500 px-1 text-[11px]">`</kbd> for the quick prompt bar, or open the AI Assistant window. Edits replicate to peers and undo as one step.
					</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>Providers</p>
					<p class={middlecoverDescription}>
						{#if $aiProviders.length}
							<span class="flex flex-col gap-1">
								{#each $aiProviders as p (p.id)}
									<span class="inline-flex items-center gap-2 rounded bg-gray-800 px-2 py-1 text-[13px]">
										<input
											type="radio"
											name="ai-active"
											checked={$aiActiveProvider === p.id}
											on:change={() => setAiActiveProvider(p.id)}
											title="Use this provider"
										/>
										<span class="font-semibold">{p.label}</span>
										<span class="text-gray-400">{p.model}</span>
										<span class="flex-1"></span>
										<button class="text-gray-300 hover:text-white" on:click={() => aiStartEdit(p)}>Edit</button>
										<button class="text-gray-400 hover:text-red-400" title="Remove" on:click={() => removeAiProvider(p.id)}>✕</button>
									</span>
								{/each}
							</span>
						{:else}
							<span class="text-gray-400">No providers yet.</span>
						{/if}
						<button
							class="mt-1.5 rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={aiStartAdd}>+ Add provider</button
						>
					</p>
				</div>
				{#if aiFormOpen}
					<div class="flex setting-row">
						<p class={middlecoverName}>{aiEditId ? 'Edit' : 'New'} provider</p>
						<p class={middlecoverDescription}>
							<span class="flex flex-col gap-1.5">
								<select class="ui-input" bind:value={aiFormPreset} on:change={aiApplyPreset}>
									{#each PROVIDER_PRESETS as preset}
										<option value={preset.preset}>{preset.label}</option>
									{/each}
								</select>
								<input class="ui-input" placeholder="Label" bind:value={aiFormLabel} />
								<input class="ui-input" placeholder="Base URL (…/v1)" bind:value={aiFormBaseUrl} />
								<input class="ui-input" type="password" placeholder="API key / bearer token" bind:value={aiFormKey} />
								<input class="ui-input" placeholder="Model id" bind:value={aiFormModel} />
								<span class="flex gap-1.5">
									<button class="rounded bg-primary-700 px-2 py-1 text-xs text-white hover:bg-primary-600" on:click={aiSaveProvider}>Save</button>
									<button class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50" disabled={aiTesting} on:click={aiTest}>{aiTesting ? 'Testing…' : 'Test connection'}</button>
									<button class="rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-600" on:click={() => { aiFormOpen = false; aiEditId = null; }}>Cancel</button>
								</span>
							</span>
						</p>
					</div>
				{/if}
				<div class="flex setting-row">
					<p class={middlecoverName}>
						<Toggle bind:checked={$meshGenEnabled} on:change={() => setMeshGenEnabled($meshGenEnabled)}>&nbsp;Mesh generation</Toggle>
					</p>
					<p class={middlecoverDescription}>
						<span class="font-semibold">Text → 3D mesh</span> — generate custom models from prompts (Add menu → “✨ Generate 3D model”, or the assistant). Backends: a self-hosted <span class="font-mono">ComfyUI</span> running TRELLIS, or a hosted API (Meshy). See the Console/AI docs for setup.
					</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>Mesh providers</p>
					<p class={middlecoverDescription}>
						{#if $meshProviders.length}
							<span class="flex flex-col gap-1">
								{#each $meshProviders as p (p.id)}
									<span class="inline-flex items-center gap-2 rounded bg-gray-800 px-2 py-1 text-[13px]">
										<input type="radio" name="mesh-active" checked={$meshActiveProvider === p.id} on:change={() => setMeshActiveProvider(p.id)} title="Use this provider" />
										<span class="font-semibold">{p.label}</span>
										<span class="text-gray-400">{p.kind}</span>
										<span class="flex-1"></span>
										<button class="text-gray-300 hover:text-white" on:click={() => meshStartEdit(p)}>Edit</button>
										<button class="text-gray-400 hover:text-red-400" title="Remove" on:click={() => removeMeshProvider(p.id)}>✕</button>
									</span>
								{/each}
							</span>
						{:else}
							<span class="text-gray-400">No mesh providers yet.</span>
						{/if}
						<button class="mt-1.5 rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={meshStartAdd}>+ Add mesh provider</button>
					</p>
				</div>
				{#if meshFormOpen}
					<div class="flex setting-row">
						<p class={middlecoverName}>{meshEditId ? 'Edit' : 'New'} mesh provider</p>
						<p class={middlecoverDescription}>
							<span class="flex flex-col gap-1.5">
								<select class="ui-input" bind:value={meshFormKind} on:change={meshApplyPreset}>
									{#each MESH_PRESETS as preset}
										<option value={preset.kind}>{preset.label}</option>
									{/each}
								</select>
								<input class="ui-input" placeholder="Label" bind:value={meshFormLabel} />
								<input class="ui-input" placeholder={meshFormKind === 'comfyui' ? 'ComfyUI URL (http://host:8188)' : 'API base (https://api.meshy.ai)'} bind:value={meshFormBaseUrl} />
								<input class="ui-input" type="password" placeholder={meshFormKind === 'comfyui' ? 'Bearer token (only if proxied; blank for LAN)' : 'API key'} bind:value={meshFormKey} />
								{#if meshFormKind === 'comfyui'}
									<textarea class="ui-input min-h-[80px] resize-y font-mono text-[11px]" placeholder={'Workflow JSON (API format). Put {{PROMPT}} in the text node and {{SEED}} in the sampler seed.'} bind:value={meshFormWorkflow}></textarea>
									<input class="ui-input" placeholder="Output node id (optional — auto-detects the SaveGLB node)" bind:value={meshFormOutputNode} />
								{:else}
									<select class="ui-input" bind:value={meshFormMode}>
										<option value="preview">preview (geometry only — faster, cheaper)</option>
										<option value="refine">refine (adds textures — more credits)</option>
									</select>
								{/if}
								<span class="flex gap-1.5">
									<button class="rounded bg-primary-700 px-2 py-1 text-xs text-white hover:bg-primary-600" on:click={meshSaveProvider}>Save</button>
									<button class="rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-600" on:click={() => { meshFormOpen = false; meshEditId = null; }}>Cancel</button>
								</span>
							</span>
						</p>
					</div>
				{/if}
				<div class="flex setting-row">
					<p class={bottomCoverName}>Storage</p>
					<p class={bottomCoverDescription}>
						API keys are stored <span class="font-semibold">unencrypted</span> in this browser's local storage (like all settings) and never leave your device except in requests to the provider you configure. "Reset settings" clears them.
					</p>
				</div>
			</AccordionItem>
			<AccordionItem bind:open={connectionExpanded}>
				<svelte:fragment slot="header">Connection</svelte:fragment>
				<div class="flex setting-row">
					<p class={topcoverName}>
						<ThemedSelect
							id="peer-server-mode"
							items={[
								{ value: 'default', name: HAS_SELF_HOSTED ? 'Default (self-hosted + fallback)' : 'Default (public cloud)' },
								{ value: 'public', name: 'Public PeerJS cloud' },
								{ value: 'custom', name: 'Custom server' }
							]}
							value={$peerServerConfig.mode}
							onchange={(v) => setPeerMode(v)}
						/>
					</p>
					<p class={topcoverDescription}>
						<span class="font-semibold">Signaling server</span> — where peers discover each other.
						{#if HAS_SELF_HOSTED}Default uses <span class="font-mono">{SELF_HOSTED_HOST}</span> and falls back to the public PeerJS cloud if it's unreachable.{:else}Default is the public PeerJS cloud.{/if}
						Custom pins your own server (no fallback). Takes effect on reload.
					</p>
				</div>
				{#if $peerServerConfig.mode === 'custom'}
					<div class="flex setting-row">
						<p class={middlecoverName}>
							<input
								class="w-full rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="peer.example.com"
								value={$peerServerConfig.custom.host}
								on:change={(e: any) => setPeerCustom('host', e.target.value)}
							/>
						</p>
						<p class={middlecoverDescription}>Your PeerJS server host (no https://, no path)</p>
					</div>
					<div class="flex setting-row">
						<p class={middlecoverName + ' gap-1'}>
							<input
								class="w-16 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="443"
								value={$peerServerConfig.custom.port}
								on:change={(e: any) => setPeerCustom('port', e.target.value)}
							/>
							<input
								class="min-w-0 flex-1 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="/peerjs"
								value={$peerServerConfig.custom.path}
								on:change={(e: any) => setPeerCustom('path', e.target.value)}
							/>
						</p>
						<p class={middlecoverDescription}>Port + path (Caddy/TLS defaults: 443 and /peerjs)</p>
					</div>
					<div class="flex setting-row">
						<p class={middlecoverName}>
							<Checkbox
								checked={$peerServerConfig.custom.secure}
								on:change={(e: any) => setPeerCustom('secure', e.target.checked)}>&nbsp;Secure (wss)</Checkbox>
						</p>
						<p class={middlecoverDescription}>Use TLS — leave on unless testing a plain-ws server</p>
					</div>
					<div class="flex setting-row">
						<p class={middlecoverName}>
							<input
								class="w-full rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="turn:host:3478?transport=udp,turn:host:3478?transport=tcp"
								value={$peerServerConfig.custom.turnUrls}
								on:change={(e: any) => setPeerCustom('turnUrls', e.target.value)}
							/>
						</p>
						<p class={middlecoverDescription}>TURN URLs (comma-separated) — the NAT relay; blank = STUN-only, direct connections only</p>
					</div>
					<div class="flex setting-row">
						<p class={middlecoverName + ' gap-1'}>
							<input
								class="min-w-0 flex-1 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="turn user"
								value={$peerServerConfig.custom.turnUsername}
								on:change={(e: any) => setPeerCustom('turnUsername', e.target.value)}
							/>
							<input
								class="min-w-0 flex-1 rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="turn credential"
								value={$peerServerConfig.custom.turnCredential}
								on:change={(e: any) => setPeerCustom('turnCredential', e.target.value)}
							/>
						</p>
						<p class={middlecoverDescription}>TURN username + credential</p>
					</div>
					<div class="flex setting-row">
						<p class={middlecoverName}>
							<input
								class="w-full rounded bg-gray-700 px-1 py-0.5 text-xs text-white"
								placeholder="stun:host:3478"
								value={$peerServerConfig.custom.stunUrls}
								on:change={(e: any) => setPeerCustom('stunUrls', e.target.value)}
							/>
						</p>
						<p class={middlecoverDescription}>STUN URLs (comma-separated) — optional</p>
					</div>
				{/if}
				<div class="flex setting-row">
					<p class={bottomCoverName}>
						<button
							id="peer-server-reload"
							class="rounded bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={() => location.reload()}>Apply &amp; reload</button>
					</p>
					<p class={bottomCoverDescription}>The peer connection is created at startup — reload to switch servers</p>
				</div>
			</AccordionItem>
			<AccordionItem bind:open={shortcutsExpanded}>
				<svelte:fragment slot="header">Shortcuts</svelte:fragment>
				<!-- 131: borderless multi-column grid; group headers span all columns -->
				<div id="shortcut-grid" class="grid grid-cols-1 gap-x-8 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
					{#each shortcutGroups as group}
						<p class="col-span-full mb-1 mt-3 text-xs font-semibold uppercase text-gray-400">{group}</p>
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
				</div>
			</AccordionItem>
			<AccordionItem>
				<svelte:fragment slot="header">About</svelte:fragment>
				<div class="flex setting-row">
					<p class={topcoverName}>
						Version
					</p>
					<p class={topcoverDescription}>alpha</p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						Dev Builds
					</p>
					<p class={middlecoverDescription}><a href="https://alexz005.github.io/theprototype">https://alexz005.github.io/theprototype</a></p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						Source Code
					</p>
					<p class={middlecoverDescription}><a href="https://github.com/theprototype-app/core" target="_blank">github.com/theprototype-app/core</a></p>
				</div>
				<div class="flex setting-row">
					<p class={middlecoverName}>
						Modules
					</p>
					<p class={middlecoverDescription}><a href="https://github.com/theprototype-app/modules" target="_blank">github.com/theprototype-app/modules</a></p>
				</div>
				<div class="flex setting-row">
					<p class={bottomCoverName}>
						Docs
					</p>
					<p class={bottomCoverDescription}><a href="https://github.com/theprototype-app/docs" target="_blank">github.com/theprototype-app/docs</a></p>
				</div>

			</AccordionItem>
		</Accordion>
		</div>
	</div>
	<svelte:fragment slot="footer">
		<Button onclick={() => localStorage.clear()}>Reset settings</Button>
		<Button color="alternative" onclick={() => clearSavedSession()}>Clear saved session</Button>
	</svelte:fragment>
</Modal>
