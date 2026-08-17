<script lang="ts">
	import { Accordion, AccordionItem, Modal, Button, Checkbox, Toggle } from 'flowbite-svelte';
	import { X } from '@lucide/svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SettingRow from './SettingRow.svelte';
	import { showGrid, vrOverride, vrMenuHand, vrSnapAngle, vrMirrorSnapTurn, vrTeleportEnabled, vrSleeveEnabled, vrVertexHold, vrFlying, vrPassthrough, vrMenuHold, vrTargetHz, peerHandStyle } from '../../stores/sceneStore.js';
	import { applyVRFrameRate } from '$lib/vrControls';
	import { settingsOpen, settingsSection, hidePanels, restorePanels, advancedMode, showEnvInList, objectSearchEnabled, showSimControls, showToast, showRoomsButton, toastsInDrawerOnly, mobileUndockAllowed, enableShiftAdd, noteDoubleClickToOpen } from '../../stores/appStore.js';
	import { trackpadMode, allowBrowserZoom, reversePan, panEnabled, pinchZoomEnabled } from '$lib/trackpadNav';
	import { drawerSlot, cloudPluginInfo } from '$lib/cloudHooks';
	import { versionString } from '$lib/version.js';
	const appVersionString = versionString();
	import { vrFaceCap, VR_FACE_CAP } from '$lib/faceEdit';
	import { doubleClickAction, DOUBLE_CLICK_ACTIONS } from '$lib/selectionPrefs';
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
	import { autosaveEnabled, autoRestoreEnabled, clearSavedSession } from '$lib/autosave';
	import { viewPrefs, setViewPrefs, resetViewPrefs, DEFAULT_VIEW_PREFS } from '$lib/viewPrefs';
	import { showWelcomeOnStart, showWhatsNewNotice, openWelcome, openWhatsNew } from '$lib/whatsNew';
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
		presetFor,
		normalizeBaseUrl
	} from '$lib/ai/providers';
	import { testConnection, listModels } from '$lib/ai/client';
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
	import { autofocusOk, typeToFocus } from '$lib/inputDevice';

	let shortcutGroups = [...new Set(shortcuts.map((s) => s.group))];
	let shortcutsExpanded = false;
	let aiExpanded = false;
	let sceneExpanded = false;
	let connectionExpanded = false;
	let aboutExpanded = false;
	let vrExpanded = false; // D7: edit-cap toasts deep-link here ('vr')
	let interfaceExpanded = false;
	let controlsExpanded = false;

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
	let aiFormStream = true;
	let aiFormPhysics = false;
	let aiFormTemp = '';
	let aiTesting = false;
	let aiTestResult: { ok: boolean; detail: string; modelOk?: boolean | null; model?: string } | null = null;
	// model picker: suggestions from the endpoint's GET /models (persisted on the
	// provider so Edit works after a reload); free text stays allowed — aliases and
	// unlisted/custom ids are legitimate
	let aiFormModels: string[] = [];
	let aiModelListOpen = false;
	let aiModelsFetching = false;
	// per-preset API-key entries while the form is OPEN (switching Grok→Gemini must
	// not carry the Grok key into the Gemini box); scoped to the form session — only
	// Save persists a key
	let aiFormKeys: Record<string, string> = {};
	let aiFormPresetPrev = 'grok';
	$: aiModelFiltered = (() => {
		const q = (aiFormModel || '').trim().toLowerCase();
		return q ? aiFormModels.filter((m) => m.toLowerCase().includes(q)) : aiFormModels;
	})();

	/** Silent best-effort refresh of the model suggestions. Fires on Edit open, on
	 * leaving the key/base-url fields, and on preset switch — so the picker fills
	 * without needing a Test connection click. Sequence guard: a slow response for
	 * a PREVIOUS endpoint must not populate the current one. */
	let aiFetchSeq = 0;
	async function aiRefreshModels() {
		const baseUrl = normalizeBaseUrl(aiFormBaseUrl);
		if (!baseUrl) return;
		const seq = ++aiFetchSeq;
		aiModelsFetching = true;
		const list = await listModels({ id: 'probe', preset: aiFormPreset, label: '', baseUrl, apiKey: aiFormKey.trim(), model: '' });
		if (seq !== aiFetchSeq) return;
		aiModelsFetching = false;
		if (list && list.length) aiFormModels = list;
	}

	/** Preset switch: stash the old preset's key, restore the new one's, reset
	 * endpoint-specific state, and refetch suggestions if a key is already there. */
	function aiPresetChanged() {
		aiFormKeys[aiFormPresetPrev] = aiFormKey;
		aiApplyPreset();
		aiFormKey = aiFormKeys[aiFormPreset] ?? '';
		aiFormModels = [];
		aiModelListOpen = false;
		aiTestResult = null;
		aiFormPresetPrev = aiFormPreset;
		if (aiFormKey.trim() || aiFormPreset === 'custom') aiRefreshModels();
	}

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
		aiFormStream = true;
		aiFormPhysics = false;
		aiFormTemp = '';
		aiTestResult = null;
		aiFormModels = [];
		aiModelListOpen = false;
		aiFormKeys = {};
		aiFormPresetPrev = aiFormPreset;
		aiFormOpen = true;
	}
	function aiStartEdit(p: any) {
		aiEditId = p.id;
		aiFormPreset = p.preset;
		aiFormLabel = p.label;
		aiFormBaseUrl = p.baseUrl;
		aiFormKey = p.apiKey;
		aiFormModel = p.model;
		aiFormStream = p.stream !== false;
		aiFormPhysics = p.physicsTools === true;
		aiFormTemp = typeof p.temperature === 'number' ? String(p.temperature) : '';
		aiTestResult = null;
		aiFormModels = Array.isArray(p.models) ? p.models : [];
		aiModelListOpen = false;
		aiFormKeys = { [p.preset]: p.apiKey };
		aiFormPresetPrev = p.preset;
		aiFormOpen = true;
		aiRefreshModels(); // silent; keeps the picker current without a Test click
	}
	function aiSaveProvider() {
		if (!aiFormBaseUrl.trim() || !aiFormModel.trim()) {
			showToast('Base URL and model are required');
			return;
		}
		const temp = parseFloat(aiFormTemp);
		const config = {
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: aiFormBaseUrl,
			apiKey: aiFormKey,
			model: aiFormModel,
			stream: aiFormStream,
			physicsTools: aiFormPhysics,
			temperature: Number.isFinite(temp) ? temp : undefined,
			models: aiFormModels
		};
		if (aiEditId) updateAiProvider(aiEditId, config);
		else addAiProvider(config);
		aiFormOpen = false;
		aiEditId = null;
	}
	async function aiTest() {
		if (!aiFormBaseUrl.trim()) {
			aiTestResult = { ok: false, detail: 'Enter a base URL first' };
			return;
		}
		aiTesting = true;
		aiTestResult = null;
		const result = await testConnection({
			id: 'test',
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: normalizeBaseUrl(aiFormBaseUrl),
			apiKey: aiFormKey.trim(),
			model: aiFormModel.trim()
		});
		if (result.models && result.models.length) aiFormModels = result.models;
		// pin the tested model into the result so later typing can't mislabel it
		aiTestResult = { ok: result.ok, detail: result.detail, modelOk: result.modelOk, model: aiFormModel.trim() };
		aiTesting = false;
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
	let meshFormAssetProxy = '';

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
		meshFormAssetProxy = '';
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
		meshFormAssetProxy = p.assetProxy ?? '';
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
			config.assetProxy = meshFormAssetProxy;
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
		interfaceExpanded = $settingsSection === 'interface';
		controlsExpanded = $settingsSection === 'controls';
	} else if ($settingsOpen === false) {
		restorePanels();
		$settingsSection = null;
	}

	// U-3: filter the (numerous) settings rows by a search query. A `use:` action
	// keeps it legacy-mode safe — it toggles each row's display without touching
	// the heterogeneous markup. Rows carry the `.setting-row` class; inner controls
	// live in <p>, so hiding a row never hides a control inside a shown row.
	let settingsQuery = '';
	let searchInput: any; // the search box, for refocus after the clear (X) button
	/**
	 * Searching must EXPAND every section first. flowbite-svelte 1.x renders an
	 * AccordionItem's body only while it is open, so with the sections collapsed
	 * there were literally zero `.setting-row` elements in the DOM and the filter had
	 * nothing to match — that is why search stopped working after the flowbite
	 * migration (the old Accordion kept its content mounted and merely hidden).
	 * The previous expansion is restored when the query clears.
	 */
	/** @type {any} */
	let savedExpansion: any = null;
	$: syncSearchExpansion(settingsQuery);
	/** @param {string} query */
	function syncSearchExpansion(query: string) {
		const searching = !!(query || '').trim();
		if (searching && !savedExpansion) {
			savedExpansion = {
				shortcutsExpanded,
				aiExpanded,
				sceneExpanded,
				interfaceExpanded,
				controlsExpanded,
				connectionExpanded,
				vrExpanded,
				aboutExpanded
			};
			shortcutsExpanded = true;
			aiExpanded = true;
			sceneExpanded = true;
			interfaceExpanded = true;
			controlsExpanded = true;
			connectionExpanded = true;
			vrExpanded = true;
			aboutExpanded = true;
		} else if (!searching && savedExpansion) {
			({
				shortcutsExpanded,
				aiExpanded,
				sceneExpanded,
				interfaceExpanded,
				controlsExpanded,
				connectionExpanded,
				vrExpanded,
				aboutExpanded
			} = savedExpansion);
			savedExpansion = null;
		}
	}
	/**
	 * Walk the SECTIONS, not the rows: flowbite mounts an item's body only after it
	 * opens, so a row-first pass sees a partial DOM — and a header hidden on that
	 * partial view could never be shown again (no rows left to walk back from).
	 * A MutationObserver re-applies as the bodies arrive, which beats guessing frames.
	 * @param {HTMLElement} node @param {string} query
	 */
	function filterSettings(node: HTMLElement, query: string) {
		let needle = (query || '').trim().toLowerCase();
		const apply = () => {
			// each section is an <h2> header followed by its body element
			node.querySelectorAll('h2').forEach((header) => {
				const body = header.nextElementSibling;
				if (!(body instanceof HTMLElement) || !(header instanceof HTMLElement)) return;
				const rows = [...body.querySelectorAll('.setting-row')];
				const sectionText = (header.textContent || '').toLowerCase();
				let visible = 0;
				let group = ''; // nearest `ui-section-label` above the row ("GRID", "SNAPPING"…)
				body.querySelectorAll('.ui-section-label, .setting-row').forEach((el) => {
					if (!el.classList.contains('setting-row')) {
						group = (el.textContent || '').toLowerCase();
						return;
					}
					// searching "grid" should find the whole Grid group and "vr" the VR
					// section, not only rows whose own label happens to contain the word
					const haystack = (el.textContent || '').toLowerCase() + ' ' + group + ' ' + sectionText;
					const show = !needle || haystack.includes(needle);
					(el as HTMLElement).style.display = show ? '' : 'none';
					if (show) visible++;
				});
				// hide a section only when we KNOW it has rows and none of them matched;
				// an unmounted body (0 rows) is unknown, and the observer will revisit it
				const hide = !!needle && rows.length > 0 && visible === 0;
				body.style.display = hide ? 'none' : '';
				header.style.display = hide ? 'none' : '';
			});
		};
		const observer = new MutationObserver(() => apply());
		// childList only: our own style writes are attribute changes, so re-entry
		// cannot loop
		observer.observe(node, { childList: true, subtree: true });
		apply();
		return {
			update(next: string) {
				needle = (next || '').trim().toLowerCase();
				apply();
			},
			destroy: () => observer.disconnect()
		};
	}

	/**
	 * flowbite's Modal focuses the first focusable child when it opens — on a phone
	 * that slides the on-screen keyboard over the settings the user just opened. Keep
	 * the autofocus on pointer devices (it is genuinely nice there), undo it on touch,
	 * and let a real keyboard opt in by typing (see inputDevice.typeToFocus).
	 * @param {HTMLInputElement} node
	 */
	function searchFocus(node: HTMLInputElement) {
		if (autofocusOk()) return;
		const stop = typeToFocus(() => node);
		// two frames is after the modal's own focus call and long before any tap
		const a = requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (document.activeElement === node) node.blur();
			})
		);
		return {
			destroy: () => {
				cancelAnimationFrame(a);
				stop();
			}
		};
	}
</script>

<Modal
	title="Settings"
	bind:open={$settingsOpen}
	modal={false} onkeydown={(e) => { if (e.key === 'Escape') settingsOpen.set(false); }}
	outsideclose
	size="xl"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div class="modal-content p-4">
		<div class="relative mb-3">
			<input
				id="settings-search"
				type="text"
				class="ui-input w-full pr-8"
				placeholder="Search settings…"
				bind:value={settingsQuery}
				bind:this={searchInput}
				use:searchFocus
			/>
			{#if settingsQuery}
				<button
					id="settings-search-clear"
					class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
					aria-label="Clear search"
					on:click={() => {
						settingsQuery = '';
						searchInput?.focus();
					}}
				>
					<X size={14} aria-hidden="true" />
				</button>
			{/if}
		</div>
		<div use:filterSettings={settingsQuery}>
		<!-- `multiple`: sections no longer close each other. Required for search — the
		     filter can only see rows flowbite has MOUNTED, and a single-selection
		     accordion keeps all but one body unmounted no matter what the open flags
		     say (it reads `multiple` untracked at init, so this cannot be per-query).
		     Several open sections is also the norm for a settings panel. -->
		<Accordion multiple>
				<AccordionItem bind:open={interfaceExpanded}>
					{#snippet header()}Interface{/snippet}
					<p class="ui-section-label">Appearance</p>
					<SettingRow name="Theme">
						<svelte:fragment slot="control">
							<ThemedSelect
								id="theme-select"
								items={[...THEMES, ...$customThemes].map((t) => ({ value: t.id, name: t.name }))}
								bind:value={$theme}
							/>
						</svelte:fragment>
						UI theme for THIS device (the 3D viewport follows the environment, not the theme)
					</SettingRow>
					<SettingRow name="Custom theme">
						<svelte:fragment slot="control">
							<span class="sr-stack">
								<button
									id="theme-export"
									class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
									on:click={() => exportActiveTheme()}>Export template</button
								>
								<button
									id="theme-browse"
									class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
									on:click={() => themeFileInput?.click()}>Browse…</button
								>
								<input
									type="file"
									accept=".json,application/json"
									bind:this={themeFileInput}
									style="display: none"
									on:change={onThemeFile}
								/>
							</span>
						</svelte:fragment>
						Export the active theme as an editable .theme.json, tweak the colors, then Browse to load it back
						{#if $customThemes.length}
							<span class="mt-1 flex flex-wrap gap-1">
								{#each $customThemes as ct (ct.id)}
									<span class="inline-flex items-center gap-1 rounded-sm bg-gray-800 px-1.5 py-0.5 text-[11px]">
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
					</SettingRow>
					<p class="ui-section-label">Notifications</p>
					<SettingRow name="Welcome on start">
						<svelte:fragment slot="control"><Toggle bind:checked={$showWelcomeOnStart} /></svelte:fragment>
						Show the welcome card every time the app opens. It normally appears only on your first
						visit — turn this on to keep its quick links handy, or
						<button class="underline" on:click={() => { settingsOpen.set(false); openWelcome(); }}>open it now</button>
					</SettingRow>
					<SettingRow name="Announce new versions">
						<svelte:fragment slot="control"><Toggle bind:checked={$showWhatsNewNotice} /></svelte:fragment>
						After an update, mark the logo menu with a dot and show one toast linking to the
						changelog. Off means updates arrive silently — What's new stays in the logo menu
					</SettingRow>
					<SettingRow name="Toasts in drawer only">
						<svelte:fragment slot="control"><Toggle bind:checked={$toastsInDrawerOnly} /></svelte:fragment>
						Hide ALL pop-up toasts in the viewport — including connection requests — so they appear only in the connection drawer's Toasts tab (the notification bell still keeps the full history). Pin the drawer to keep the Toasts tab handy
					</SettingRow>
					<p class="ui-section-label">Windows & chrome</p>
					{#if $drawerSlot}
						<SettingRow name="Show Rooms button">
							<svelte:fragment slot="control"><Toggle bind:checked={$showRoomsButton} /></svelte:fragment>
							Show the "Rooms" shortcut in the Connect bar. Off makes the bar cleaner — you can still open rooms from the connection info drawer (the chevron) ▸ Rooms tab
						</SettingRow>
					{/if}
					<SettingRow name="Window positions">
						<svelte:fragment slot="control">
							<button id="reset-windows" class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={() => { resetWindowLayout(); showToast('Window positions reset'); }}>Reset</button>
						</svelte:fragment>
						Bring back any floating window (object list, chat, Explorer, editors) that drifted off-screen or behind the UI
					</SettingRow>
					<SettingRow name="Allow undocking (touch)">
						<svelte:fragment slot="control"><Toggle bind:checked={$mobileUndockAllowed} /></svelte:fragment>
						On touch / small screens the Flow and Explorer panels stay docked and their "undock" buttons are hidden (floating windows are cramped on a phone). Turn this on to allow undocking them into floating windows anyway
					</SettingRow>
					<p class="ui-section-label">Lists & menus</p>
					<SettingRow name="Advanced mode">
						<svelte:fragment slot="control"><Checkbox bind:checked={$advancedMode} /></svelte:fragment>
						Show system objects (module content, environment rig) as a System filter in the object list
					</SettingRow>
					<SettingRow name="Environment in list">
						<svelte:fragment slot="control"><Checkbox bind:checked={$showEnvInList} /></svelte:fragment>
						Show the environment group as an Environment filter in the object list
					</SettingRow>
					<SettingRow name="Object search in menu">
						<svelte:fragment slot="control"><Checkbox bind:checked={$objectSearchEnabled} /></svelte:fragment>
						Add a "Search objects…" entry to the viewport right-click menu — find a scene object and fly the camera to it
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={controlsExpanded}>
					{#snippet header()}Controls{/snippet}
					<p class="ui-section-label">Keyboard & mouse</p>
					<SettingRow name="Shift+A quick add">
						<svelte:fragment slot="control"><Toggle bind:checked={$enableShiftAdd} /></svelte:fragment>
						Pressing Shift+A opens the Add menu at the cursor and spawns the picked object
						under it. Off by default — Shift also strafes the camera in fly mode
					</SettingRow>
					<SettingRow name="Double-click to open notes">
						<svelte:fragment slot="control"><Toggle bind:checked={$noteDoubleClickToOpen} /></svelte:fragment>
						A single click on a note marker — and the notes drawer's ‹ › group arrows — then only
						flies the camera to the note; the card opens on a double click. Handy for reviewing a
						scene full of notes without a card in the way
					</SettingRow>
					<p class="ui-section-label">Trackpad</p>
					<SettingRow name="Trackpad gestures">
						<svelte:fragment slot="control">
							<ThemedSelect
								id="trackpad-mode"
								items={[
									{ value: 'auto', name: 'Auto' },
									{ value: 'on', name: 'On' },
									{ value: 'off', name: 'Off' }
								]}
								bind:value={$trackpadMode}
							/>
						</svelte:fragment>
						Two-finger swipes on a laptop trackpad pan the camera; pinch zooms. Auto detects trackpads and leaves mouse wheels zooming as usual — pick On/Off if the detection guesses wrong on your hardware
					</SettingRow>
					<SettingRow name="Two-finger pan">
						<svelte:fragment slot="control"><Toggle bind:checked={$panEnabled} /></svelte:fragment>
						Two-finger swipes pan the camera. Off: swipes zoom like a mouse wheel, and panning stays available with a right-click drag
					</SettingRow>
					<SettingRow name="Reverse trackpad pan">
						<svelte:fragment slot="control"><Toggle bind:checked={$reversePan} /></svelte:fragment>
						Flip the two-finger pan direction (default: the scene follows your fingers, like touch scrolling)
					</SettingRow>
					<SettingRow name="Pinch zoom">
						<svelte:fragment slot="control"><Toggle bind:checked={$pinchZoomEnabled} /></svelte:fragment>
						Pinching in/out on the viewport zooms the camera. Off: pinch does nothing (the page still never zooms) and zooming stays on the mouse wheel
					</SettingRow>
					<SettingRow name="Allow browser pinch zoom">
						<svelte:fragment slot="control"><Toggle bind:checked={$allowBrowserZoom} /></svelte:fragment>
						Accessibility: let pinch / Ctrl+scroll zoom the whole PAGE again (off keeps pinch as an app gesture and stops accidental page zoom over panels, on desktop and mobile)
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={sceneExpanded}>
					{#snippet header()}Scene{/snippet}
					<SettingRow name="Show grid">
						<svelte:fragment slot="control">
							<Checkbox
								bind:checked={$showGrid}
								onclick={() => {
									if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
									else localStorage.setItem('showGrid', 'false');
								}} />
						</svelte:fragment>
						Display grid on floor
					</SettingRow>
					<SettingRow name="Shadow quality">
						<svelte:fragment slot="control">
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
						</svelte:fragment>
						Caps every light's shadow map size on THIS machine (Off disables shadows entirely; per-light sizes still replicate)
					</SettingRow>
					<SettingRow name="Simulation controls">
						<svelte:fragment slot="control"><Checkbox bind:checked={$showSimControls} /></svelte:fragment>
						Show the physics transport (play/pause/stop/reset) at bottom-right. Off by default to avoid confusion with the main play button; the P key still starts/stops the simulation
					</SettingRow>
					<SettingRow name="Sync animations">
						<svelte:fragment slot="control"><Checkbox bind:checked={$syncedAnimations} /></svelte:fragment>
						Node animations use wall-clock time so all peers see the same phase
					</SettingRow>
					<SettingRow name="Spatial voice">
						<svelte:fragment slot="control"><Checkbox bind:checked={$spatialVoice} /></svelte:fragment>
						Voices come from where each peer is (pan + distance falloff)
					</SettingRow>
					<SettingRow name="Ping color + sound">
						<svelte:fragment slot="control">
							<span class="sr-stack">
								<input
									type="color"
									id="ping-color"
									class="h-7 w-full cursor-pointer rounded-sm border border-gray-500 bg-transparent"
									value={$pingColor || '#4f83cc'}
									on:change={(e) => pingColor.set(e.currentTarget.value)}
								/>
								<ThemedSelect
									items={PING_SOUNDS.map((s) => ({ value: s.id, name: s.name }))}
									bind:value={$pingSound}
								/>
								<button
									id="ping-preview"
									class="rounded-sm bg-gray-600 px-1.5 py-1 text-white"
									title="Preview the ping chime"
									on:click={() => playPing($pingSound)}
								>
									▶ Preview
								</button>
							</span>
						</svelte:fragment>
						Your ping color + sound — peers see and hear YOUR pings this way (color empty = your peer color)
					</SettingRow>
					<SettingRow name="Autosave">
						<svelte:fragment slot="control"><Checkbox bind:checked={$autosaveEnabled} /></svelte:fragment>
						Keep a local session snapshot (restore offered after a crash/reload)
					</SettingRow>
					<SettingRow name="Auto-restore on load">
						<svelte:fragment slot="control">
							<Checkbox id="auto-restore" bind:checked={$autoRestoreEnabled} />
						</svelte:fragment>
						Restore that snapshot automatically at startup instead of asking. Only ever runs when the scene is still empty; a message tells you what was restored
					</SettingRow>
					<p class="ui-section-label">Selection</p>
					<SettingRow name="Double-click action">
						<svelte:fragment slot="control">
							<ThemedSelect
								id="double-click-action"
								items={DOUBLE_CLICK_ACTIONS.map((a) => ({ value: a.value, name: a.label }))}
								bind:value={$doubleClickAction}
							/>
						</svelte:fragment>
						What a double-click on an object does in the viewport. A single click always just selects it; <kbd>Ctrl</kbd>+<kbd>A</kbd> selects everything
					</SettingRow>
					<p class="ui-section-label">Wireframe &amp; outline</p>
					<SettingRow name="Wireframe color">
						<svelte:fragment slot="control">
							<input
								type="color"
								id="wire-color"
								class="h-7 w-full cursor-pointer rounded-sm border border-gray-500 bg-transparent"
								value={$viewPrefs.wireColor}
								on:input={(e) => setViewPrefs({ wireColor: e.currentTarget.value })}
							/>
						</svelte:fragment>
						Line color of the Wireframe view mode (Configure Scene ▸ View mode)
					</SettingRow>
					<SettingRow name="Selection outline color">
						<svelte:fragment slot="control">
							<input
								type="color"
								id="outline-color"
								class="h-7 w-full cursor-pointer rounded-sm border border-gray-500 bg-transparent"
								value={$viewPrefs.outlineColor}
								on:input={(e) => setViewPrefs({ outlineColor: e.currentTarget.value })}
							/>
						</svelte:fragment>
						Outline drawn around your selected objects (objects a peer has locked keep their own color)
					</SettingRow>
					<SettingRow name="Edit Mesh wireframe">
						<svelte:fragment slot="control">
							<span class="sr-stack">
								<label class="flex items-center gap-1.5 text-xs whitespace-nowrap">
									<Checkbox
										id="edit-wire-auto"
										checked={$viewPrefs.editWireColor === 'auto'}
										onchange={(e) =>
											setViewPrefs({
												editWireColor: e.currentTarget.checked ? 'auto' : '#2f81f7'
											})}
									/>
									Auto
								</label>
								<input
									type="color"
									id="edit-wire-color"
									class="h-7 w-full cursor-pointer rounded-sm border border-gray-500 bg-transparent disabled:opacity-40"
									disabled={$viewPrefs.editWireColor === 'auto'}
									value={$viewPrefs.editWireColor === 'auto' ? '#2f81f7' : $viewPrefs.editWireColor}
									on:input={(e) => setViewPrefs({ editWireColor: e.currentTarget.value })}
								/>
							</span>
						</svelte:fragment>
						Edge overlay while editing a mesh. Auto picks dark or light from the object's own color; turn it off to pin one color
					</SettingRow>
					<SettingRow name="Reset line colors">
						<svelte:fragment slot="control">
							<button
								id="reset-view-colors"
								class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
								on:click={() => { resetViewPrefs(); showToast('Line colors reset'); }}
							>Reset</button>
						</svelte:fragment>
						Back to the defaults ({DEFAULT_VIEW_PREFS.wireColor} / {DEFAULT_VIEW_PREFS.outlineColor} / auto). Per-device, never shared
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={vrExpanded}>
					{#snippet header()}VR{/snippet}
					<SettingRow name="VR override">
						<svelte:fragment slot="control">
							<Checkbox
								bind:checked={$vrOverride}
								onclick={() => {
									if (localStorage.getItem('vrOverride')) localStorage.removeItem('vrOverride');
									else localStorage.setItem('vrOverride', 'true');
								}} />
						</svelte:fragment>
						Forces normal play even if immersive-vr is enabled
					</SettingRow>
					<SettingRow name="VR flying">
						<svelte:fragment slot="control">
							<Checkbox
								checked={$vrFlying}
								onchange={(e) => {
									$vrFlying = e.target.checked;
									localStorage.setItem('vrFlying', String($vrFlying));
								}} />
						</svelte:fragment>
						Left-stick movement follows where the controller points (fly); off = stay level
					</SettingRow>
					<SettingRow name="Passthrough">
						<svelte:fragment slot="control">
							<!-- a red SWITCH (98): reads as an armed mode, not a plain option -->
							<Toggle
								id="passthrough-toggle"
								color="red"
								size="small"
								checked={$vrPassthrough}
								onchange={(e: any) => {
									$vrPassthrough = e.target.checked;
									localStorage.setItem('vrPassthrough', String($vrPassthrough));
									showToast('Passthrough ' + ($vrPassthrough ? 'on' : 'off') + ' — takes effect on the next VR entry');
								}} />
						</svelte:fragment>
						Mixed reality: the next VR entry composites the scene over your room (immersive-ar){arSupport === false ? ' — not supported on this device' : ''}
					</SettingRow>
					<SettingRow name="VR menu on left">
						<svelte:fragment slot="control">
							<Checkbox
								checked={$vrMenuHand === 'left'}
								onclick={() => {
									const next = $vrMenuHand === 'left' ? 'right' : 'left';
									$vrMenuHand = next;
									localStorage.setItem('vrMenuHand', next);
								}} />
						</svelte:fragment>
						Which controller opens the VR quick-menu (the other hand points)
					</SettingRow>
					<SettingRow name="Hold-to-menu">
						<svelte:fragment slot="control">
							<Checkbox
								id="vr-menu-hold"
								checked={$vrMenuHold}
								onchange={(e: any) => {
									$vrMenuHold = e.target.checked;
									localStorage.setItem('vrMenuHold', String($vrMenuHold));
								}} />
						</svelte:fragment>
						Hold B/Y to show the radial menu, release over a sector to pick it (off = press toggles)
					</SettingRow>
					<SettingRow name="Snap turn">
						<svelte:fragment slot="control">
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
						</svelte:fragment>
						VR thumbstick flick rotation angle (Off disables it)
					</SettingRow>
					<SettingRow name="Mirror snap turn">
						<svelte:fragment slot="control">
							<Checkbox
								id="vr-mirror-snap"
								checked={$vrMirrorSnapTurn}
								onchange={(e: any) => {
									$vrMirrorSnapTurn = e.target.checked;
									localStorage.setItem('vrMirrorSnapTurn', String($vrMirrorSnapTurn));
								}} />
						</svelte:fragment>
						Flip the flick direction — left turns right and vice-versa
					</SettingRow>
					<SettingRow name="Teleport">
						<svelte:fragment slot="control">
							<Checkbox
								id="vr-teleport"
								checked={$vrTeleportEnabled}
								onchange={(e: any) => {
									$vrTeleportEnabled = e.target.checked;
									localStorage.setItem('vrTeleportEnabled', String($vrTeleportEnabled));
								}} />
						</svelte:fragment>
						Right-stick-up teleport arc — off if you navigate only by stick/fly
					</SettingRow>
					<SettingRow name="VR sleeve palette">
						<svelte:fragment slot="control">
							<Checkbox
								id="vr-sleeve"
								checked={$vrSleeveEnabled}
								onchange={(e: any) => {
									$vrSleeveEnabled = e.target.checked;
									localStorage.setItem('vrSleeveEnabled', String($vrSleeveEnabled));
								}} />
						</svelte:fragment>
						Experimental — a strip of ghost primitives on your forearm: trigger-drag one out to place it (stick scales, wrist rotates). Grip-drop an object onto the strip to keep it as a personal slot
					</SettingRow>
					<SettingRow name="Hold to move vertex">
						<svelte:fragment slot="control">
							<Checkbox
								id="vr-vertex-hold"
								checked={$vrVertexHold}
								onchange={(e: any) => {
									$vrVertexHold = e.target.checked;
									localStorage.setItem('vrVertexHold', String($vrVertexHold));
								}} />
						</svelte:fragment>
						Hold the trigger to carry a vertex (release drops it); off = press to grab, press again to drop
					</SettingRow>
					<SettingRow name="Face edit limit">
						<svelte:fragment slot="control">
							<input
								id="vr-face-cap"
								type="number"
								min="10"
								step="50"
								class="w-20 rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={$vrFaceCap}
								on:change={(e: any) => setCap(vrFaceCap, e.target.value, VR_FACE_CAP)}
							/>
						</svelte:fragment>
						<span class="font-semibold">Mesh edit caps (D7)</span> — max triangles for VR face editing (default {VR_FACE_CAP}; denser meshes get a warning). Imported single meshes under the caps edit fine; Ungroup multi-mesh imports first
					</SettingRow>
					<SettingRow name="Vertex edit limit">
						<svelte:fragment slot="control">
							<input
								id="vr-vertex-cap"
								type="number"
								min="10"
								step="50"
								class="w-20 rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={$vrVertexCap}
								on:change={(e: any) => setCap(vrVertexCap, e.target.value, VR_VERTEX_CAP)}
							/>
						</svelte:fragment>
						Max vertices for VR vertex editing (default {VR_VERTEX_CAP}) — very dense handle clouds get unwieldy with controllers
					</SettingRow>
					<SettingRow name="Peer hand style">
						<svelte:fragment slot="control">
							<select
								id="peer-hand-style"
								class="rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={$peerHandStyle}
								on:change={(e: any) => peerHandStyle.set(e.target.value)}
							>
								<option value="model">Model</option>
								<option value="hands">Hands</option>
								<option value="spheres">Spheres</option>
							</select>
						</svelte:fragment>
						How hand-tracked peers render for you — rounded capsule hands, cuboid bones or joint spheres (local preference)
					</SettingRow>
					<SettingRow name="My hand model">
						<svelte:fragment slot="control">
							<select
								id="my-hand-model"
								class="rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={$myHandModel}
								on:change={(e: any) => setMyHandModel(e.target.value)}
							>
								<option value="">Default</option>
								{#each $explorerItems.filter((i: any) => i.kind === 'object') as item (item.id)}
									<option value={item.hash}>{item.name}</option>
								{/each}
							</select>
						</svelte:fragment>
						<span class="font-semibold">Custom hands (identity)</span> — a GLB from your Explorer library that OTHER peers see as your hands in VR (bytes push automatically; renders rigid at the wrist)
					</SettingRow>
					<SettingRow name="VR refresh rate">
						<svelte:fragment slot="control">
							<select
								id="vr-target-hz"
								class="rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={$vrTargetHz}
								on:change={(e: any) => {
									vrTargetHz.set(e.target.value);
									applyVRFrameRate();
								}}
							>
								<option value="auto">Max</option>
								<option value="90">90</option>
								<option value="120">120</option>
							</select>
						</svelte:fragment>
						Target headset Hz — Max picks the highest the device supports (120 needs the Quest 120Hz system setting); applies on VR entry
					</SettingRow>
					<SettingRow name="VR menu positions">
						<svelte:fragment slot="control">
							<button
								id="vr-reset-poses"
								class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
								on:click={() => {
									resetWindowPoses();
									showToast('VR menu positions reset');
								}}>Reset positions</button>
						</svelte:fragment>
						Grabbed VR menus/panels snap back to their default spots on the controllers (111: hold the other grip on one to re-place it)
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={aiExpanded}>
					{#snippet header()}AI{/snippet}
					<SettingRow name="Enable assistant">
						<svelte:fragment slot="control"><Toggle bind:checked={$aiEnabled} onchange={() => setAiEnabled($aiEnabled)} /></svelte:fragment>
						<span class="font-semibold">AI scene assistant</span> — build and edit the scene with prompts. Press
						<kbd class="rounded-sm border border-gray-500 px-1 text-[11px]">`</kbd> for the quick prompt bar, or open the AI Assistant window. Edits replicate to peers and undo as one step.
					</SettingRow>
					<SettingRow name="Providers" noControl>
						{#if $aiProviders.length}
							<span class="flex flex-col gap-1">
								{#each $aiProviders as p (p.id)}
									<span class="inline-flex items-center gap-2 rounded-sm bg-gray-800 px-2 py-1 text-[13px]">
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
							class="mt-1.5 self-start rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={aiStartAdd}>+ Add provider</button
						>
					</SettingRow>
					{#if aiFormOpen}
						<SettingRow name={aiEditId ? 'Edit provider' : 'New provider'} noControl>
							<span class="flex flex-col gap-1.5">
								<select class="ui-input" bind:value={aiFormPreset} on:change={aiPresetChanged}>
									{#each PROVIDER_PRESETS as preset}
										<option value={preset.preset}>{preset.label}</option>
									{/each}
								</select>
								<input class="ui-input" placeholder="Label" autocomplete="off" bind:value={aiFormLabel} />
								<!-- on:change (fires when leaving an edited field) auto-fetches the model list
								     so the picker fills without a Test connection click -->
								<input class="ui-input" placeholder="Base URL (…/v1)" autocomplete="off" bind:value={aiFormBaseUrl} on:change={aiRefreshModels} />
								<!-- new-password: keeps Chrome's password manager from saving base-url + key as a
								     login pair and autofilling them into unrelated text inputs (Connect peer id) -->
								<input class="ui-input" type="password" placeholder="API key / bearer token" autocomplete="new-password" bind:value={aiFormKey} on:change={aiRefreshModels} />
								<!-- model combobox: free text + suggestions from the endpoint's /models
								     (fetched on Test connection / Edit open, persisted on the provider).
								     Selection uses mousedown so it lands before the input's blur. -->
								<input
									id="ai-model-input"
									class="ui-input"
									placeholder={aiModelsFetching ? 'Model id — fetching list…' : aiFormModels.length ? 'Model id — ' + aiFormModels.length + ' available' : 'Model id'}
									autocomplete="off"
									bind:value={aiFormModel}
									on:focus={() => (aiModelListOpen = true)}
									on:input={() => (aiModelListOpen = true)}
									on:keydown={(e: any) => { if (e.key === 'Escape' || e.key === 'Enter') aiModelListOpen = false; }}
									on:blur={() => setTimeout(() => (aiModelListOpen = false), 150)}
								/>
								{#if aiModelListOpen && aiFormModels.length}
									<div id="ai-model-list" class="max-h-40 overflow-y-auto rounded-sm border border-gray-600 bg-gray-800">
										{#each aiModelFiltered as m (m)}
											<button
												class="block w-full px-2 py-1 text-left font-mono text-[12px] {m === aiFormModel.trim() ? 'bg-primary-700 text-white' : 'text-gray-200 hover:bg-gray-700'}"
												on:mousedown|preventDefault={() => { aiFormModel = m; aiModelListOpen = false; }}
											>{m}</button>
										{/each}
										{#if !aiModelFiltered.length}
											<div class="px-2 py-1 text-[12px] text-gray-400">no match — free text works too (aliases / custom ids)</div>
										{/if}
									</div>
								{/if}
								<label class="flex items-center gap-2 text-[13px] text-gray-300">
									<input type="checkbox" bind:checked={aiFormStream} />
									Stream responses
								</label>
								<label class="flex items-center gap-2 text-[13px] text-gray-300">
									<input id="ai-physics-tools" type="checkbox" bind:checked={aiFormPhysics} />
									Physics tools (advanced)
								</label>
								<span class="text-[11px] leading-snug text-gray-400">
									Lets the assistant set physics bodies, attach joints and start the simulation.
									Multi-step physics is hard for small local models (4B) — recommended for 14B+
									or hosted models.
									<button
										class="underline hover:text-gray-200"
										on:click={() => window.open('https://docs.theprototype.app/ai/local-models/', '_blank')}
									>Local &amp; small models guide</button>
								</span>
								<input class="ui-input" placeholder="Temperature (blank = server default)" bind:value={aiFormTemp} />
								<span class="text-[11px] leading-snug text-gray-400">
									Turn streaming OFF for a self-hosted server whose tool calls only work unstreamed —
									vLLM with a mismatched <span class="font-mono">--tool-call-parser</span> (e.g. hermes
									for a Qwen3.5 model, which needs qwen3_xml) mangles streamed tool calls. The
									assistant also detects that at runtime and falls back on its own.
								</span>
								<span class="flex gap-1.5">
									<button class="rounded-sm bg-primary-700 px-2 py-1 text-xs text-white hover:bg-primary-600" on:click={aiSaveProvider}>Save</button>
									<button class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50" disabled={aiTesting} on:click={aiTest}>{aiTesting ? 'Testing…' : 'Test connection'}</button>
									<button class="rounded-sm bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-600" on:click={() => { aiFormOpen = false; aiEditId = null; }}>Cancel</button>
								</span>
								{#if aiTestResult}
									<span id="ai-test-result" class="text-[12px] leading-snug">
										{#if aiTestResult.ok}
											<span class="text-emerald-400">✓ {aiTestResult.detail}</span>
											{#if !aiTestResult.model}
												<span class="text-red-400"> · no model selected</span>
											{:else if aiTestResult.modelOk}
												<span class="text-emerald-400"> · model <span class="font-mono">{aiTestResult.model}</span> — Configuration OK</span>
											{:else if aiTestResult.modelOk === false}
												<span class="text-red-400"> · model "{aiTestResult.model}" did not respond — pick one from the list</span>
											{/if}
										{:else}
											<span class="text-red-400">✗ {aiTestResult.detail}</span>
										{/if}
									</span>
								{/if}
							</span>
						</SettingRow>
					{/if}
					<SettingRow name="Mesh generation">
						<svelte:fragment slot="control"><Toggle bind:checked={$meshGenEnabled} onchange={() => setMeshGenEnabled($meshGenEnabled)} /></svelte:fragment>
						<span class="font-semibold">Text → 3D mesh</span> — generate custom models from prompts (Add menu → “✨ Generate 3D model”, or the assistant). Backends: a self-hosted <span class="font-mono">ComfyUI</span> running TRELLIS, or a hosted API (Meshy). See the Console/AI docs for setup.
					</SettingRow>
					<SettingRow name="Mesh providers" noControl>
						{#if $meshProviders.length}
							<span class="flex flex-col gap-1">
								{#each $meshProviders as p (p.id)}
									<span class="inline-flex items-center gap-2 rounded-sm bg-gray-800 px-2 py-1 text-[13px]">
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
						<button class="mt-1.5 self-start rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={meshStartAdd}>+ Add mesh provider</button>
					</SettingRow>
					{#if meshFormOpen}
						<SettingRow name={meshEditId ? 'Edit mesh provider' : 'New mesh provider'} noControl>
							<span class="flex flex-col gap-1.5">
								<select class="ui-input" bind:value={meshFormKind} on:change={meshApplyPreset}>
									{#each MESH_PRESETS as preset}
										<option value={preset.kind}>{preset.label}</option>
									{/each}
								</select>
								<input class="ui-input" placeholder="Label" autocomplete="off" bind:value={meshFormLabel} />
								<input class="ui-input" placeholder={meshFormKind === 'comfyui' ? 'ComfyUI URL (http://host:8188)' : 'API base (https://api.meshy.ai)'} autocomplete="off" bind:value={meshFormBaseUrl} />
								<!-- new-password: don't let Chrome save base-url + key as a login pair (it then
								     autofills them into unrelated text inputs like the Connect peer id) -->
								<input class="ui-input" type="password" placeholder={meshFormKind === 'comfyui' ? 'Bearer token (only if proxied; blank for LAN)' : 'API key'} autocomplete="new-password" bind:value={meshFormKey} />
								{#if meshFormKind === 'comfyui'}
									<textarea class="ui-input min-h-[80px] resize-y font-mono text-[11px]" placeholder={'Workflow JSON (API format). Put {{PROMPT}} in the text node and {{SEED}} in the sampler seed.'} bind:value={meshFormWorkflow}></textarea>
									<input class="ui-input" placeholder="Output node id (optional — auto-detects the SaveGLB node)" bind:value={meshFormOutputNode} />
								{:else}
									<select class="ui-input" bind:value={meshFormMode}>
										<option value="preview">preview (geometry only — faster, cheaper)</option>
										<option value="refine">refine (adds textures — more credits)</option>
									</select>
									<input class="ui-input" placeholder="Asset proxy URL (optional — blank uses the built-in default)" bind:value={meshFormAssetProxy} />
									<span class="text-[11px] leading-snug text-gray-400">
										Meshy's assets CDN sends no CORS headers, so the finished model can't be
										downloaded by the browser directly — downloads go through a proxy
										(e.g. <span class="font-mono">https://proxy.theprototype.app</span>; blank
										tries the built-in defaults, falling back automatically).
									</span>
								{/if}
								<span class="flex gap-1.5">
									<button class="rounded-sm bg-primary-700 px-2 py-1 text-xs text-white hover:bg-primary-600" on:click={meshSaveProvider}>Save</button>
									<button class="rounded-sm bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-600" on:click={() => { meshFormOpen = false; meshEditId = null; }}>Cancel</button>
								</span>
							</span>
						</SettingRow>
					{/if}
					<SettingRow name="Storage" noControl>
						API keys are stored <span class="font-semibold">unencrypted</span> in this browser's local storage (like all settings) and never leave your device except in requests to the provider you configure. "Reset settings" clears them.
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={connectionExpanded}>
					{#snippet header()}Connection{/snippet}
					<SettingRow name="Signaling server">
						<svelte:fragment slot="control">
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
						</svelte:fragment>
						Where peers discover each other.
						{#if HAS_SELF_HOSTED}Default uses <span class="font-mono">{SELF_HOSTED_HOST}</span> and falls back to the public PeerJS cloud if it's unreachable.{:else}Default is the public PeerJS cloud.{/if}
						Custom pins your own server (no fallback). Takes effect on reload.
					</SettingRow>
					{#if $peerServerConfig.mode === 'custom'}
						<SettingRow name="Server host">
							<svelte:fragment slot="control">
								<input
									class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
									placeholder="peer.example.com"
									value={$peerServerConfig.custom.host}
									on:change={(e: any) => setPeerCustom('host', e.target.value)}
								/>
							</svelte:fragment>
							Your PeerJS server host (no https://, no path)
						</SettingRow>
						<SettingRow name="Port + path">
							<svelte:fragment slot="control">
								<span class="sr-stack">
									<input
										class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
										placeholder="443"
										value={$peerServerConfig.custom.port}
										on:change={(e: any) => setPeerCustom('port', e.target.value)}
									/>
									<input
										class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
										placeholder="/peerjs"
										value={$peerServerConfig.custom.path}
										on:change={(e: any) => setPeerCustom('path', e.target.value)}
									/>
								</span>
							</svelte:fragment>
							Port + path (Caddy/TLS defaults: 443 and /peerjs) — each on its own line
						</SettingRow>
						<SettingRow name="Secure (wss)">
							<svelte:fragment slot="control">
								<Checkbox
									checked={$peerServerConfig.custom.secure}
									onchange={(e: any) => setPeerCustom('secure', e.target.checked)} />
							</svelte:fragment>
							Use TLS — leave on unless testing a plain-ws server
						</SettingRow>
						<SettingRow name="TURN URLs">
							<svelte:fragment slot="control">
								<input
									class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
									placeholder="turn:host:3478?transport=udp,…"
									value={$peerServerConfig.custom.turnUrls}
									on:change={(e: any) => setPeerCustom('turnUrls', e.target.value)}
								/>
							</svelte:fragment>
							TURN URLs (comma-separated) — the NAT relay; blank = STUN-only, direct connections only
						</SettingRow>
						<SettingRow name="TURN credentials">
							<svelte:fragment slot="control">
								<span class="sr-stack">
									<input
										class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
										placeholder="turn user"
										value={$peerServerConfig.custom.turnUsername}
										on:change={(e: any) => setPeerCustom('turnUsername', e.target.value)}
									/>
									<input
										class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
										placeholder="turn credential"
										value={$peerServerConfig.custom.turnCredential}
										on:change={(e: any) => setPeerCustom('turnCredential', e.target.value)}
									/>
								</span>
							</svelte:fragment>
							TURN username + credential — each on its own line
						</SettingRow>
						<SettingRow name="STUN URLs">
							<svelte:fragment slot="control">
								<input
									class="w-full rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
									placeholder="stun:host:3478"
									value={$peerServerConfig.custom.stunUrls}
									on:change={(e: any) => setPeerCustom('stunUrls', e.target.value)}
								/>
							</svelte:fragment>
							STUN URLs (comma-separated) — optional
						</SettingRow>
					{/if}
					<SettingRow name="Apply changes">
						<svelte:fragment slot="control">
							<button
								id="peer-server-reload"
								class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
								on:click={() => location.reload()}>Apply &amp; reload</button>
						</svelte:fragment>
						The peer connection is created at startup — reload to switch servers
					</SettingRow>
				</AccordionItem>
				<AccordionItem bind:open={shortcutsExpanded}>
					{#snippet header()}Shortcuts{/snippet}
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
				<AccordionItem bind:open={aboutExpanded}>
					{#snippet header()}About{/snippet}
					<SettingRow name="Version" noControl>{appVersionString}</SettingRow>
					{#if $cloudPluginInfo}
						<SettingRow name="Cloud plugin" noControl>{$cloudPluginInfo.name} {$cloudPluginInfo.version}</SettingRow>
					{/if}
					<SettingRow name="Dev Builds" noControl>
						<a href="https://alexz005.github.io/theprototype">https://alexz005.github.io/theprototype</a>
					</SettingRow>
					<SettingRow name="Source Code" noControl>
						<a href="https://github.com/theprototype-app/core" target="_blank">github.com/theprototype-app/core</a>
					</SettingRow>
					<SettingRow name="Modules" noControl>
						<a href="https://github.com/theprototype-app/modules" target="_blank">github.com/theprototype-app/modules</a>
					</SettingRow>
					<SettingRow name="Docs" noControl>
						<a href="https://github.com/theprototype-app/docs" target="_blank">github.com/theprototype-app/docs</a>
					</SettingRow>
				</AccordionItem>
			</Accordion>
		</div>
	</div>
	{#snippet footer()}
		<Button onclick={() => localStorage.clear()}>Reset settings</Button>
		<Button color="alternative" onclick={() => clearSavedSession()}>Clear saved session</Button>
		<Button id="about-whats-new" color="alternative" onclick={() => { settingsOpen.set(false); openWhatsNew(); }}>What's new</Button>
	{/snippet}
</Modal>

