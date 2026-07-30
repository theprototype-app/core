<script>
	import { Download, Save, Search, Sparkles, SquarePen, Trash2, Upload } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	// Unified inspector (phase 64): one drawer serves every target — mesh, group,
	// light (from the selection) and the scene itself ($inspectorKind = 'scene').
	// Replication messages are byte-identical to the old three panels.
	import * as THREE from 'three';
	import { Drawer, Checkbox, Button, Tooltip } from 'flowbite-svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import PanelHeader from '../ui/PanelHeader.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
	import CustomWrapper from '$lib/ColorWrapper.svelte';
	import { sineIn } from 'svelte/easing';
	import { applyExplorerImage } from '$lib/explorerDrop';
	import { explorerItems, explorerFolders, inspectedFile, itemBlob, renameItem, deleteItem, updateItemBytes } from '$lib/explorer';
	import { openTextEditor, openImagePreview } from '$lib/fileWindows';
	import {
		setObjectTexture,
		removeObjectTexture,
		setMaterialParam,
		switchMaterialType,
		recordMaterialChange
	} from '$lib/materialsHandler';
	import { recordEntry } from '$lib/history';
	import { bottomInset } from '$lib/bottomDock';
	import { geometryParamsOf, applyGeometry } from '$lib/geometryEdit';
	import { nameOf } from '$lib/lockControl';
	import { geometrySpec } from '$lib/geometryParams';
	import { LIGHT_PARAMS, SHADOW_TYPES, SHADOW_SIZES, setShadowMapSize, cappedShadowSize } from '$lib/lightParams';
	import { animatedObjects, setAnimationState } from '$lib/animatedImports';
	import { moveObjectToGroup, selectObject } from '$lib/objectActions';
	import { listPhysicsObjects, enablePhysicsOnSelection } from '$lib/physics';
	import { addParticlesPreset, updateObjectParticles, removeObjectParticles, burstObjectParticles } from '$lib/particleActions';
	import { PARTICLE_PRESETS } from '$lib/particlePresets';
	import { flowGraphs } from '../../stores/flowStore';
	import { showLightHelpers } from '$lib/lightHelpers';
	import { cameraNear, cameraFar, setCameraNear, setCameraFar } from '$lib/cameraClip';
	import {
		music,
		musicLocalVolume,
		musicMuted,
		musicBlocked,
		setMusicTrack,
		setMusicPlaying,
		setMusicVolume
	} from '$lib/sceneMusic';
	import {
		environment,
		ENVIRONMENT_PRESETS,
		setEnvironment,
		envPresets,
		peerEnvPresets,
		presetPayload,
		editRigComponent,
		addEnvLight,
		updateEnvLight,
		removeEnvLight,
		convertToEnvironment,
		convertFromEnvironment,
		snapshotPreset,
		saveEnvPreset,
		deleteEnvPreset,
		exportEnvPreset,
		importEnvPreset,
		applyCustomPreset
	} from '$lib/environment';
	import {
		globalScene,
		objectsGroup,
		selectedObject,
		backgroundColor,
		globalCamera,
		viewMode
	} from '../../stores/sceneStore';
	import { peers, inspectorClose, inspectorKind, showToast, inspectorFilter, notesDrawerOpen } from '../../stores/appStore.js';

	const hexColor = /^#[0-9A-F]{6}$/i;
	const RAD_SNAP = Math.PI / 12; // Ctrl-snap rotations to 15°

	// B3 (roadmap #13): camera lens presets. Labels use the familiar full-frame
	// focal-length vocabulary; the value set is three's VERTICAL fov in degrees
	// (vfov = 2·atan(12mm / focal)). Default camera fov is 40° (~33mm) — a natural,
	// low-distortion product-viz look, just wider than a classic 35mm.
	const LENS_PRESETS = [
		{ label: 'Wide', mm: 24, fov: 53 },
		{ label: 'Classic', mm: 35, fov: 38 },
		{ label: 'Natural', mm: 50, fov: 27 },
		{ label: 'Portrait', mm: 85, fov: 16 }
	];

	let transitionParamsRight = { x: 320, duration: 200, easing: sineIn };

	// side drawers live on the --z-drawer tier (68); chat floats on its own now.
	// bottom rises above the docked Flow/Explorer height (105) AND the Controls pill/
	// HUD footprint on narrow screens (--controls-inset) so neither covers the drawer.
	// z sits just above the bottom HUD buttons (mic/chat/+ are at --z-drawer=30) so the
	// settings drawer is never covered by the mic on the bottom-right, but stays BELOW
	// the dock (--z-bottom=35) and floating windows.
	const drawerStyle =
		'bottom: max(var(--bottom-inset, 0px), var(--controls-inset, 0px)); z-index: calc(var(--z-bottom) - 1); height: auto';

	// Round the drawer's bottom-LEFT corner when it floats ABOVE the bottom (a docked
	// Flow/Explorer, or the narrow Controls inset, leave a gap below it). When it sits
	// flush on the viewport bottom it stays square there.
	let narrowDrawer = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(pointer: coarse), (max-width: 820px)');
		narrowDrawer = mq.matches;
		const on = () => (narrowDrawer = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	const bottomRounded = $derived($bottomInset > 0 || narrowDrawer);
	// SHEET mode = the actual bottom-sheet layout (max-width:640, matching the CSS). This
	// is separate from narrowDrawer (<=820) so the 641-820 side-drawer still slides in
	// horizontally, not up.
	let sheetMode = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(max-width: 640px)');
		sheetMode = mq.matches;
		const on = () => (sheetMode = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	// One bottom sheet at a time: opening the settings sheet closes scene notes.
	$effect(() => {
		if (!$inspectorClose && sheetMode) notesDrawerOpen.set(false);
	});
	// SHEET = slide UP from below; side drawer = fly in from the right (horizontal).
	const insTransition = $derived(
		sheetMode ? { y: 500, duration: 240, easing: sineIn } : transitionParamsRight
	);

	// On a narrow/folded screen this drawer is a bottom SHEET (see #inspector in ui.css)
	// with a top drag handle to adjust height — mirrors the scene-notes sheet. Persisted.
	let inspectorH = $state(0);
	$effect(() => {
		if (inspectorH || typeof window === 'undefined') return;
		const saved = parseInt(localStorage.getItem('inspectorSheetH') || '');
		inspectorH = !saved || Number.isNaN(saved) ? Math.round(window.innerHeight * 0.45) : saved;
	});
	let insResizing = $state(false);
	/** @param {PointerEvent} e */
	function insStartResize(e) {
		insResizing = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function insDoResize(e) {
		if (!insResizing) return;
		// sheet is bottom:0, so height = viewport height - finger y; cap the top below
		// the Connect bar + top-right chrome (same limit as the Flow/Explorer dock)
		const cb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--connect-bottom')) || 54;
		const maxH = Math.max(200, window.innerHeight - cb - 56);
		inspectorH = Math.min(Math.max(160, window.innerHeight - e.clientY), maxH);
	}
	/** @param {PointerEvent} e */
	function insEndResize(e) {
		if (!insResizing) return;
		insResizing = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
		try {
			localStorage.setItem('inspectorSheetH', String(inspectorH));
		} catch {}
	}

	// C1 (roadmap #13): scene-mode physics-objects list. Recomputes on scene/graph
	// changes AND selection updates (setPhysics only pokes selectedObject).
	// H1: depends on flowGraphs so physics nodes in ANY graph document retrigger it.
	const physicsRows = $derived.by(() => {
		$objectsGroup;
		$flowGraphs;
		$selectedObject;
		return listPhysicsObjects();
	});

	const isLight = $derived($selectedObject?.type?.endsWith?.('Light') ?? false);
	const isGroup = $derived($selectedObject?.type === 'Group');
	// live geometry params (78): registry-driven rows; geoTick refreshes after edits
	let geoTick = $state(0);
	const geoParams = $derived.by(() => {
		geoTick;
		return !isLight && !isGroup && $selectedObject ? geometryParamsOf($selectedObject) : null;
	});
	const geoSpec = $derived(geoParams ? geometrySpec(geoParams.gtype) : null);

	/** @param {string} key @param {any} value */
	function editGeometry(key, value) {
		const run = () => {
			applyGeometry($selectedObject.uuid, { [key]: value });
			geoTick++;
		};
		if ($selectedObject.userData?.vertexEdited) {
			showToast('This mesh has vertex edits — rebuilding the geometry discards them.', [
				{ label: 'Rebuild', action: run },
				{ label: 'Keep edits', action: () => geoTick++ }
			]);
			return;
		}
		run();
	}
	const material = $derived(
		!isLight && !isGroup && $selectedObject?.material && !Array.isArray($selectedObject.material)
			? $selectedObject.material
			: null
	);

	let materials = [
		{ value: 'MeshBasicMaterial', name: 'Basic' },
		{ value: 'MeshStandardMaterial', name: 'Standard' },
		{ value: 'MeshPhysicalMaterial', name: 'Physical' },
		{ value: 'MeshPhongMaterial', name: 'Phong' },
		{ value: 'MeshLambertMaterial', name: 'Lambert' },
		{ value: 'MeshToonMaterial', name: 'Toon' },
		{ value: 'MeshMatcapMaterial', name: 'Matcap' },
		{ value: 'MeshNormalMaterial', name: 'Normal' },
		{ value: 'MeshDepthMaterial', name: 'Depth' },
		{ value: 'ShadowMaterial', name: 'Shadow' }
	];

	// Explorer image hovering the texture drop zone (96)
	let textureDropActive = $state(false);

	// Explorer file properties (107)
	const inspectedItem = $derived(
		$inspectorKind === 'file' ? $explorerItems.find((item) => item.id === $inspectedFile) ?? null : null
	);
	const fileFolderPath = $derived.by(() => {
		if (!inspectedItem) return '';
		const parts = [];
		let parent = inspectedItem.folderId ?? null;
		while (parent) {
			const folder = $explorerFolders.find((f) => f.id === parent);
			if (!folder) break;
			parts.unshift(folder.name);
			parent = folder.parentId ?? null;
		}
		return 'Library' + (parts.length ? ' / ' + parts.join(' / ') : '');
	});
	let fileDetails = $state('');
	$effect(() => {
		const item = inspectedItem;
		fileDetails = '';
		if (!item) return;
		itemBlob(item.id).then(async (blob) => {
			if (!blob || inspectedItem?.id !== item.id) return;
			try {
				if (item.kind === 'image') {
					const bitmap = await createImageBitmap(blob);
					fileDetails = bitmap.width + ' × ' + bitmap.height + ' px';
				} else if (item.kind === 'text') {
					fileDetails = (await blob.text()).split('\n').length + ' lines';
				} else if (item.kind === 'audio') {
					const ctx = new AudioContext();
					const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
					fileDetails = decoded.duration.toFixed(2) + ' s · ' + decoded.numberOfChannels + ' ch';
					ctx.close();
				}
			} catch {}
		});
	});
	async function openInspectedItem() {
		const item = inspectedItem;
		if (!item) return;
		const blob = await itemBlob(item.id);
		if (!blob) return;
		if (item.kind === 'text')
			openTextEditor({ title: item.name, code: await blob.text(), onSave: (code) => updateItemBytes(item.id, code) });
		else if (item.kind === 'image') openImagePreview({ title: item.name, url: URL.createObjectURL(blob) });
	}

	// color swatches mirror the target when the selection changes
	/** @type {any} */
	let color = $state('#ffffff');
	/** @type {any} */
	let groundColor = $state('#ffffff');
	$effect(() => {
		const obj = $selectedObject;
		if (!obj) return;
		if (obj.material?.color && !Array.isArray(obj.material))
			color = '#' + obj.material.color.getHexString();
		else if (obj.color?.getHexString) color = '#' + obj.color.getHexString();
		if (obj.groundColor?.getHexString) groundColor = '#' + obj.groundColor.getHexString();
	});

	// one undo entry per color-drag gesture: remember where it started,
	// record 600ms after the last input
	/** @type {any} */
	let colorGestureStart = null;
	/** @type {any} */
	let colorGestureTimer;
	/** @param {string} uuid @param {any} hex */
	function trackColorGesture(uuid, hex) {
		if (colorGestureStart == null)
			colorGestureStart = '#' + $selectedObject.material.color.getHexString();
		clearTimeout(colorGestureTimer);
		colorGestureTimer = setTimeout(() => {
			recordMaterialChange(uuid, 'color', null, colorGestureStart, hex);
			colorGestureStart = null;
		}, 600);
	}

	// ---- replication (identical messages to the retired panels) -------------
	function sendMove() {
		const obj = $selectedObject;
		if (!obj?.uuid) return;
		$peers.send({
			type: 'move',
			uuid: obj.uuid,
			pos: obj.position.toArray(),
			rot: obj.rotation.toArray(),
			scale: obj.scale.toArray()
		});
	}

	/** @param {'position'|'rotation'|'scale'} field @param {'x'|'y'|'z'} axis @param {number} next */
	function setTransform(field, axis, next) {
		$selectedObject[field][axis] = next;
		selectedObject.update((v) => v); // refresh rows + object list
		sendMove();
	}

	/** lights resend their whole object — same as the old light panel */
	function sendLightUpdate() {
		$peers.send({ type: 'object', element: $selectedObject.toJSON(), override: true });
	}

	/** @param {string} parameter */
	function sendParam(parameter) {
		$peers.send({
			type: 'objectParameters',
			parameter,
			uuid: $selectedObject.uuid,
			[parameter]: $selectedObject[parameter]
		});
	}

	// Cast toggle also stamps userData.shadow so the opt-out survives GLTF sync
	// (the bare castShadow flag does not round-trip through GLTFExporter) — V-1
	function setCastShadow() {
		$selectedObject.userData.shadow = $selectedObject.castShadow ? undefined : false;
		sendParam('castShadow');
	}

	// P-A: physics body params live on userData.physics (replicates free via
	// object sync / GLTF extras / sessions); flow nodes override at sim start.
	// Each edit replicates via objectParameters and records a props undo entry.
	// PFX-A: particle emitter config lives on userData.particles (replicates
	// free via object sync / GLTF extras / sessions); particleActions records
	// the props undo entry and replicates each edit via objectParameters.
	/** @param {any} patch */
	function setParticles(patch) {
		updateObjectParticles($selectedObject.uuid, patch);
	}

	/** @param {any} patch */
	function setPhysics(patch) {
		const before = $selectedObject.userData.physics ? { ...$selectedObject.userData.physics } : null;
		const next = { mode: 'auto', ...($selectedObject.userData.physics ?? {}), ...patch };
		$selectedObject.userData.physics = next;
		recordEntry({ kind: 'props', uuid: $selectedObject.uuid, before: { physics: before }, after: { physics: next } });
		$peers.send({ type: 'objectParameters', parameter: 'physics', uuid: $selectedObject.uuid, physics: next });
		selectedObject.update((v) => v);
	}

	function sendName() {
		objectsGroup.update((value) => value); // refresh the object list
		$peers.send({ type: 'name', name: $selectedObject.name, uuid: $selectedObject.uuid });
	}

	/** Object-level property (renderOrder/frustumCulled): local apply + replicate (147) @param {string} parameter @param {any} value */
	function setObjectParam(parameter, value) {
		$selectedObject[parameter] = value;
		selectedObject.update((v) => v);
		sendParam(parameter);
	}

	// ---- move to group (shared by mesh and light targets) -------------------
	let groups = $state([{ value: 'none', name: 'None' }]);
	let rerenderSelectGroup = $state(false);
	function refreshGroups() {
		groups = $selectedObject.parent.children
			.map((/** @type {any} */ item) =>
				item.type === 'Group' ? { name: item.name, value: item.uuid } : null
			)
			.filter(Boolean);
		if ($selectedObject.parent.parent.parent !== null)
			groups.push({ name: 'Level Up', value: $selectedObject.parent.parent.uuid });
		groups = groups.filter((/** @type {any} */ item) => item.value !== $selectedObject.uuid);
	}

	/** total objects in a subtree (group summary) @param {any} obj @returns {number} */
	function countTree(obj) {
		return obj.children.reduce(
			(/** @type {number} */ sum, /** @type {any} */ child) => sum + 1 + countTree(child),
			0
		);
	}

	// ---- scene target (fog state is local, like the old scene panel) --------
	/** @type {any} */
	let fogColor = $state();
	/** @type {any} */
	let fogNear = $state(0);
	/** @type {any} */
	let fogFar = $state(50);

	// ---- environment v2 (70) -------------------------------------------------
	const envPayload = $derived(presetPayload($environment));
	const selectedIsSceneLight = $derived(
		!!$selectedObject?.isLight &&
			!!$objectsGroup?.getObjectByProperty?.('uuid', $selectedObject.uuid)
	);

	function savePresetPrompt() {
		const name = prompt('Preset name', $environment.customPreset?.label ?? 'My preset');
		if (name) saveEnvPreset(name);
	}
	function exportCurrentPreset() {
		const payload = snapshotPreset($environment.customPreset?.label ?? envPayload.label ?? 'environment');
		const blob = new Blob([exportEnvPreset(payload)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = String(payload.label).replace(/[^\w-]+/g, '_') + '.envpreset.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}
	/** @param {any} event */
	async function onImportPreset(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			await importEnvPreset(await file.text());
		} catch {
			showToast('That file is not an environment preset');
		}
		event.target.value = '';
	}
	function sendBackgroundColor() {
		$peers.send({ type: 'color', uuid: 'background', color: $backgroundColor });
	}
	function sendFogColor() {
		$peers.send({ type: 'color', uuid: 'fog', color: fogColor, near: fogNear, far: fogFar });
	}
	function applyFog() {
		$globalScene.fog = new THREE.Fog(fogColor ?? '#ffffff', fogNear, fogFar);
		sendFogColor();
	}
</script>

<Drawer
	style={drawerStyle + '; --inspector-h: ' + inspectorH + 'px'}
	activateClickOutside={false}
	backdrop={false}
	placement="right"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 "
	topOffset="top-16"
	transitionType="fly"
	transitionParams={insTransition}
	bind:hidden={$inspectorClose}
	class={'rounded-tl-lg pt-0' + (bottomRounded ? ' rounded-bl-lg' : '')}
	id="inspector"
>
	<!-- bottom-sheet drag handle (shown only in the narrow bottom-sheet layout) -->
	<div
		class="ins-resize"
		title="Drag to resize"
		onpointerdown={insStartResize}
		onpointermove={insDoResize}
		onpointerup={insEndResize}
	>
		<span class="ins-grabber"></span>
	</div>
	{#if $inspectorKind === 'file'}
		<!-- Explorer file properties (107) -->
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader title={inspectedItem?.name ?? 'File'} badge="File" onclose={() => inspectorClose.set(true)} />
		</div>
		{#if inspectedItem}
			<div id="file-properties" class="flex flex-col gap-3">
				<div class="flex justify-center">
					{#if inspectedItem.thumbnail}
						<img src={inspectedItem.thumbnail} alt={inspectedItem.name} class="h-24 w-24 rounded border border-gray-600 object-cover" />
					{:else}
						<span class="flex h-24 w-24 items-center justify-center rounded border border-gray-600 bg-gray-700 text-4xl text-gray-400">
							<Icon name={inspectedItem.kind === 'audio' ? 'music' : inspectedItem.kind === 'text' ? 'file-text' : 'package'} size={36} class={inspectedItem.kind === 'audio' ? 'ico-audio' : inspectedItem.kind === 'text' ? 'ico-doc' : ''} />
						</span>
					{/if}
				</div>
				<Section label="File">
					<div class="ui-row">
						<span class="w-16 text-gray-400">Name</span>
						<input
							id="file-name"
							class="ui-input flex-1"
							value={inspectedItem.name}
							onchange={(e) => renameItem(inspectedItem.id, e.currentTarget.value)}
						/>
					</div>
					<div class="ui-row"><span class="w-16 text-gray-400">Kind</span><span class="ui-badge-type">{inspectedItem.kind}</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Size</span><span>{(inspectedItem.size / 1024).toFixed(1)} KB</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Folder</span><span class="truncate">{fileFolderPath}</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Added</span><span>{new Date(inspectedItem.createdAt).toLocaleString()}</span></div>
					<div class="ui-row">
						<span class="w-16 text-gray-400">Hash</span>
						<span class="truncate font-mono text-[10px]" title={inspectedItem.hash}>{inspectedItem.hash.slice(0, 16)}…</span>
						<button class="ui-button-quiet" title="Copy the full hash" onclick={() => navigator.clipboard?.writeText(inspectedItem.hash)}>⧉</button>
					</div>
					{#if fileDetails}
						<div class="ui-row"><span class="w-16 text-gray-400">Details</span><span>{fileDetails}</span></div>
					{/if}
				</Section>
				<Section label="Actions">
					<div class="flex flex-wrap gap-2">
						{#if inspectedItem.kind === 'text' || inspectedItem.kind === 'image'}
							<Button size="xs" color="alternative" onclick={() => openInspectedItem()}>
								{#if inspectedItem.kind === 'text'}<SquarePen size={14} class="mr-1" aria-hidden="true" />{:else}<Search size={14} class="mr-1" aria-hidden="true" />{/if}{inspectedItem.kind === 'text' ? 'Edit' : 'Preview'}
							</Button>
						{/if}
						<Button
							size="xs"
							color="alternative"
							onclick={() => {
								deleteItem(inspectedItem.id);
								inspectorClose.set(true);
							}}><Trash2 size={16} class="ico-danger mr-1" aria-hidden="true" />Delete</Button
						>
					</div>
				</Section>
			</div>
		{:else}
			<p class="p-3 text-sm italic text-gray-400">The file was removed.</p>
		{/if}
	{:else if $inspectorKind === 'scene'}
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader title="Scene" badge="Scene" onclose={() => inspectorClose.set(true)} />
			<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
			<input
				id="inspector-search"
				type="search"
				class="ui-input mb-2 w-full"
				placeholder="Filter properties…"
				value={$inspectorFilter}
				oninput={(/** @type {any} */ e) => inspectorFilter.set(e.currentTarget.value)}
				onkeydown={(/** @type {any} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
			/>
		</div>

		<div class="flex flex-col gap-3">
			<Section label="Environment">
				<div id="environment-presets" class="flex flex-wrap gap-1">
					{#each Object.entries(ENVIRONMENT_PRESETS) as [key, preset]}
						<button
							class={'ui-chip ' +
								($environment.preset === key
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => setEnvironment(key)}
						>
							{preset.label}
						</button>
					{/each}
					{#if $environment.customPreset}
						<button
							class={'ui-chip ' +
								($environment.preset === 'custom'
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => applyCustomPreset($environment.customPreset)}
						>
							{$environment.customPreset.label ?? 'Custom'}
						</button>
					{/if}
				</div>
				<SliderRow
					label="Exposure"
					min={0.4}
					max={2}
					step={0.05}
					value={$environment.exposure}
					onchange={(v) => setEnvironment($environment.preset, v)}
				/>

				{#if $envPresets.length}
					<p class="ui-section-label">Saved presets</p>
					<div class="flex flex-wrap gap-1">
						{#each $envPresets as saved (saved.name)}
							<span class="inline-flex items-center overflow-hidden rounded-full bg-gray-600">
								<button
									class="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-200 hover:bg-gray-500"
									title="Apply this preset (replicates to peers)"
									onclick={() => applyCustomPreset(saved.payload)}
								>
									{saved.name}
								</button>
								<button
									class="px-1 text-[10px] text-gray-300 hover:bg-red-700 hover:text-white"
									title="Delete saved preset"
									onclick={() => deleteEnvPreset(saved.name)}>✕</button>
							</span>
						{/each}
					</div>
				{/if}
				{#each Object.entries($peerEnvPresets).filter(([, list]) => list.length) as [peerId, list] (peerId)}
					<p class="ui-section-label">{nameOf(peerId)}'s presets</p>
					<div class="flex flex-wrap gap-1">
						{#each list as saved (saved.name)}
							<button
								class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
								title="Apply this peer preset (replicates to everyone)"
								onclick={() => applyCustomPreset(saved.payload)}
							>
								{saved.name}
							</button>
						{/each}
					</div>
				{/each}
				<div class="flex flex-wrap gap-1">
					<button id="env-save-preset" class="ui-button-quiet" title="Save the current environment as a named preset" onclick={savePresetPrompt}>
						<Save size={16} class="mr-1" aria-hidden="true" />Save preset
					</button>
					<button class="ui-button-quiet" title="Download the current environment as JSON" onclick={exportCurrentPreset}><Download size={16} class="mr-1" aria-hidden="true" />Export</button>
					<button class="ui-button-quiet" title="Import a .envpreset.json file" onclick={() => document.getElementById('env-import-file')?.click()}>
						<Upload size={16} class="mr-1" aria-hidden="true" />Import
					</button>
					<input type="file" id="env-import-file" style="display: none" accept=".json" onchange={onImportPreset} />
				</div>

				<p class="ui-section-label">Components</p>
				{#if envPayload.hemi}
					<SliderRow label="Sky light" min={0} max={4} step={0.05} value={envPayload.hemi.intensity}
						onchange={(v) => editRigComponent('hemi', { intensity: v })} />
					<div class="ui-row">
						<span class="w-20 shrink-0 text-xs text-gray-400">Sky / ground</span>
						<input type="color" class="h-6 w-8 cursor-pointer rounded border border-gray-600 bg-transparent" value={envPayload.hemi.sky}
							onchange={(e) => editRigComponent('hemi', { sky: e.currentTarget.value })} />
						<input type="color" class="h-6 w-8 cursor-pointer rounded border border-gray-600 bg-transparent" value={envPayload.hemi.ground}
							onchange={(e) => editRigComponent('hemi', { ground: e.currentTarget.value })} />
					</div>
				{/if}
				{#if envPayload.sun}
					<SliderRow label="Sun" min={0} max={4} step={0.05} value={envPayload.sun.intensity}
						onchange={(v) => editRigComponent('sun', { intensity: v })} />
					<div class="ui-row">
						<span class="w-20 shrink-0 text-xs text-gray-400">Sun color</span>
						<input type="color" class="h-6 w-8 cursor-pointer rounded border border-gray-600 bg-transparent" value={envPayload.sun.color}
							onchange={(e) => editRigComponent('sun', { color: e.currentTarget.value })} />
					</div>
				{/if}

				{#each $environment.lights ?? [] as def (def.id)}
					<div class="env-light rounded-lg border border-gray-700/60 p-1.5">
						<div class="flex items-center gap-1.5">
							<span class="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{def.kind}</span>
							<input type="color" class="h-5 w-7 cursor-pointer rounded border border-gray-600 bg-transparent" value={def.color}
								onchange={(e) => updateEnvLight(def.id, { color: e.currentTarget.value })} />
							{#if def.kind === 'hemisphere'}
								<input type="color" class="h-5 w-7 cursor-pointer rounded border border-gray-600 bg-transparent" value={def.groundColor}
									onchange={(e) => updateEnvLight(def.id, { groundColor: e.currentTarget.value })} />
							{/if}
							<span class="flex-1"></span>
							<button class="ui-button-quiet" title="Convert back into a normal scene object"
								onclick={() => convertFromEnvironment(def.id)}>⇱ object</button>
							<button class="ui-button-quiet hover:bg-red-700" title="Remove"
								onclick={() => removeEnvLight(def.id)}>✕</button>
						</div>
						<SliderRow label="Intensity" min={0} max={4} step={0.05} value={def.intensity}
							onchange={(v) => updateEnvLight(def.id, { intensity: v })} />
					</div>
				{/each}
				<div class="flex flex-wrap gap-1">
					<button id="env-add-hemisphere" class="ui-button-quiet" onclick={() => addEnvLight('hemisphere')}>+ Hemisphere</button>
					<button id="env-add-directional" class="ui-button-quiet" onclick={() => addEnvLight('directional')}>+ Directional</button>
					<button id="env-add-point" class="ui-button-quiet" onclick={() => addEnvLight('point')}>+ Point</button>
				</div>
				<button
					id="env-adopt"
					class="ui-button-quiet disabled:cursor-not-allowed disabled:opacity-40"
					disabled={!selectedIsSceneLight}
					title={selectedIsSceneLight
						? 'Move the selected light out of the scene objects into the environment'
						: 'Select a scene light first'}
					onclick={() => convertToEnvironment($selectedObject.uuid)}
				>
					⇲ Adopt selected light into environment
				</button>

				<p class="text-[10px] italic text-gray-400">
					Everything here replicates to peers; your own lights automatically dim the default rig.
				</p>
			</Section>

			<Section label="Music">
				<p class="ui-section-label">Scene track (shared)</p>
				<select
					class="ui-input w-full"
					value={$music.hash ?? ''}
					onchange={(e) => {
						const hash = e.currentTarget.value || null;
						const item = $explorerItems.find((entry) => entry.hash === hash);
						setMusicTrack(hash, item?.name ?? '');
					}}
				>
					<option value="">— no music —</option>
					{#each $explorerItems.filter((item) => item.kind === 'audio') as item (item.id)}
						<option value={item.hash}>{item.name}</option>
					{/each}
					{#if $music.hash && !$explorerItems.some((item) => item.hash === $music.hash)}
						<option value={$music.hash}>{$music.name || 'shared track'} (fetching…)</option>
					{/if}
				</select>
				<div class="mt-1 flex items-center gap-2">
					<button
						class="ui-chip {$music.playing ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500'}"
						disabled={!$music.hash}
						onclick={() => setMusicPlaying(!$music.playing)}
					>
						{$music.playing ? '■ Stop' : '▶ Play'}
					</button>
					{#if $musicBlocked && $music.playing}
						<span class="text-xs text-amber-400">click anywhere to enable audio</span>
					{/if}
				</div>
				<SliderRow label="Shared volume" min={0} max={1} step={0.05} value={$music.volume} onchange={(v) => setMusicVolume(v)} />
				<p class="ui-section-label">This device</p>
				<SliderRow label="Local volume" min={0} max={1} step={0.05} value={$musicLocalVolume} onchange={(v) => musicLocalVolume.set(v)} />
				<Checkbox bind:checked={$musicMuted}>Mute music on this device</Checkbox>
				<p class="mt-1 text-xs text-gray-400">
					One background track for everyone, synced to the same moment. Volume is shared; the local trim + mute affect only you.
				</p>
			</Section>

			<Section label="View">
				<p class="ui-section-label">Viewport — this device</p>
				<div id="view-mode-switch" class="flex flex-wrap gap-1">
					{#each [['shaded', 'Shaded'], ['shaded-ao', 'Shaded + AO'], ['wireframe', 'Wireframe']] as [mode, label] (mode)}
						<button
							class={'ui-chip ' +
								($viewMode === mode ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => viewMode.set(mode)}
						>
							{label}
						</button>
					{/each}
				</div>
				<p class="mb-1 text-xs text-gray-400">
					Local render mode (ambient occlusion + wireframe are desktop-only; not shown to peers).
				</p>
				<Checkbox bind:checked={$showLightHelpers}>Show light helpers</Checkbox>
				<p class="ui-section-label">Camera lens</p>
				<div id="lens-presets" class="flex flex-wrap gap-1">
					{#each LENS_PRESETS as p (p.label)}
						<button
							class={'ui-chip ' +
								(Math.round($globalCamera?.fov ?? 0) === p.fov
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title={p.mm + 'mm equivalent · ' + p.fov + '° vertical FOV'}
							onclick={() => {
								if ($globalCamera) {
									$globalCamera.fov = p.fov;
									$globalCamera.updateProjectionMatrix();
								}
							}}
						>
							{p.label}
						</button>
					{/each}
				</div>
				<SliderRow
					label="Camera FOV"
					min={15}
					max={120}
					step={1}
					decimals={0}
					value={$globalCamera?.fov ?? 60}
					onchange={(v) => {
						$globalCamera.fov = v;
						$globalCamera.updateProjectionMatrix();
					}}
				/>
				<!-- 123: local per-device clip planes; far pairs with orbit zoom -->
				<SliderRow
					label="Near clip"
					min={0.01}
					max={2}
					step={0.01}
					decimals={2}
					value={$cameraNear}
					onchange={(v) => setCameraNear(v)}
				/>
				<div class="ui-row">
					<span class="w-20 shrink-0 text-xs text-gray-400">Far clip</span>
					<input
						id="camera-far"
						type="number"
						min="10"
						step="500"
						class="ui-input w-24"
						value={$cameraFar}
						onchange={(e) => setCameraFar(parseFloat(e.currentTarget.value))}
					/>
					<span class="text-[10px] text-gray-500">grows to fit the scene</span>
				</div>
				<p class="text-[10px] italic text-gray-400">Clip planes are per-device (not shared).</p>
			</Section>

			<Section label="Physics">
				<!-- C1: every object that gets a body at sim start; click = select -->
				{#if physicsRows.length === 0}
					<p class="text-xs text-gray-400">
						No objects have physics yet. Select an object and set its Physics mode to
						Dynamic (or wire a Mass node to an Object Selector in the node editor),
						then press ▶ / P to simulate.
					</p>
				{:else}
					<div id="physics-objects" class="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
						{#each physicsRows as row (row.uuid)}
							<button
								class={'flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors ' +
									($selectedObject?.uuid === row.uuid
										? 'bg-primary-600 text-white'
										: 'bg-gray-700 text-gray-200 hover:bg-gray-600')}
								title="Click to select"
								onclick={() => selectObject(row.uuid)}
							>
								<span class="truncate">{row.name}</span>
								<span class="shrink-0 text-[10px] opacity-75">
									{row.mode === 'dynamic'
										? 'dynamic · ' + row.mass + ' kg'
										: row.mode === 'static'
											? 'static'
											: 'collider only'}{row.flow ? ' · flow' : ''}
								</span>
							</button>
						{/each}
					</div>
				{/if}
				<button
					id="physics-enable-selection"
					class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
					onclick={() => enablePhysicsOnSelection()}
				>
					Enable physics on selection
				</button>
				<p class="text-[10px] italic text-gray-400">
					Dynamic objects fall and collide while a simulation runs (▶ or P).
				</p>
			</Section>

			<Section label="Background">
				<ColorPicker
					isAlpha={false}
					isTextInput={false}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					bind:hex={$backgroundColor}
					on:input={(event) => {
						$backgroundColor = event.detail.hex;
						$globalScene.background = new THREE.Color($backgroundColor);
						sendBackgroundColor();
					}}
				/>
				<input
					type="text"
					class="ui-input w-full"
					value={$backgroundColor}
					onchange={(e) => {
						if (hexColor.test(e.currentTarget.value)) {
							$backgroundColor = e.currentTarget.value;
							$globalScene.background = new THREE.Color($backgroundColor);
							sendBackgroundColor();
						}
					}}
				/>
			</Section>

			<Section label="Fog">
				<ColorPicker
					isAlpha={false}
					isTextInput={false}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					bind:hex={fogColor}
					on:input={(event) => {
						fogColor = event.detail.hex;
						applyFog();
					}}
				/>
				<input
					type="text"
					class="ui-input w-full"
					value={fogColor ?? ''}
					onchange={(e) => {
						if (hexColor.test(e.currentTarget.value)) {
							fogColor = e.currentTarget.value;
							applyFog();
						}
					}}
				/>
				<SliderRow label="Near" min={0} max={10} step={0.1} decimals={1} value={fogNear ?? 0}
					onchange={(v) => { fogNear = v; applyFog(); }} />
				<SliderRow label="Far" min={0} max={100} step={0.1} decimals={1} value={fogFar ?? 0}
					onchange={(v) => { fogFar = v; applyFog(); }} />
				<Button
					size="xs"
					color="alternative"
					on:click={() => {
						$globalScene.fog = null;
						fogNear = null;
						fogFar = null;
						sendFogColor();
					}}>Remove Fog</Button
				>
			</Section>
		</div>
	{:else if $selectedObject?.name !== undefined}
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader
				title="Properties"
				badge={$selectedObject.type}
				onclose={() => inspectorClose.set(true)}
			/>
			<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
			<input
				id="inspector-search"
				type="search"
				class="ui-input mb-2 w-full"
				placeholder="Filter properties…"
				value={$inspectorFilter}
				oninput={(/** @type {any} */ e) => inspectorFilter.set(e.currentTarget.value)}
				onkeydown={(/** @type {any} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
			/>
		</div>

		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<input
					id="name"
					type="text"
					class="ui-input w-full"
					value={$selectedObject.name}
					onchange={(e) => {
						$selectedObject.name = e.currentTarget.value;
						sendName();
					}}
				/>
				<Tooltip placement="top" arrow={false} triggeredBy="#name">Name</Tooltip>
				<p id="uuid" class="truncate px-1 text-[10px] text-gray-500" title={$selectedObject.uuid}>
					{$selectedObject.uuid}
				</p>
				<div onclick={refreshGroups} role="presentation">
					{#key rerenderSelectGroup}
						<ThemedSelect
							id="select-group"
							items={groups}
							placeholder="Move to group"
							onchange={(/** @type {any} */ val) => {
								const selected = groups.find((item) => item.value === val);
								moveObjectToGroup(
									$selectedObject.uuid,
									selected?.name === 'Level Up' ? 'up' : val
								);
								objectsGroup.update((v) => v);
								rerenderSelectGroup = !rerenderSelectGroup;
							}}
						/>
					{/key}
				</div>
			</div>

			{#if $animatedObjects[$selectedObject.uuid]}
				{@const anim = $animatedObjects[$selectedObject.uuid]}
				<Section label="Animation">
					<div id="animation-controls">
						<ThemedSelect
							class="mb-1"
							value={anim.clip}
							items={anim.clips.map((clip) => ({ value: clip, name: clip }))}
							onchange={(/** @type {any} */ val) =>
								setAnimationState($selectedObject.uuid, { clip: val })}
						/>
						<div class="flex items-center gap-2">
							<button
								class="rounded bg-primary-700 px-2 py-0.5 text-sm text-white"
								onclick={() => setAnimationState($selectedObject.uuid, { playing: !anim.playing })}
							>
								{anim.playing ? '⏸ Pause' : '▶ Play'}
							</button>
							<span class="text-xs text-gray-400">speed {anim.speed.toFixed(1)}×</span>
							<input
								type="range"
								class="flex-1 accent-primary-600"
								min="0.1"
								max="3"
								step="0.1"
								value={anim.speed}
								oninput={(e) => setAnimationState($selectedObject.uuid, { speed: +e.currentTarget.value })}
							/>
						</div>
						<p class="pt-1 text-[10px] italic text-gray-400">
							Clips run on the synced clock — peers see the same pose.
						</p>
					</div>
				</Section>
			{/if}

			<Section label="Transform">
				<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
					<span class="text-[11px] text-gray-400">Position</span>
					<div id="inspector-position" class="grid grid-cols-3 gap-1">
						<DragRow label="X" accent="text-red-400" step={0.02} value={$selectedObject.position.x}
							onchange={(v) => setTransform('position', 'x', v)} />
						<DragRow label="Y" accent="text-green-400" step={0.02} value={$selectedObject.position.y}
							onchange={(v) => setTransform('position', 'y', v)} />
						<DragRow label="Z" accent="text-blue-400" step={0.02} value={$selectedObject.position.z}
							onchange={(v) => setTransform('position', 'z', v)} />
					</div>
					{#if !isLight}
						<span class="text-[11px] text-gray-400">Rotation</span>
						<div id="inspector-rotation" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.x}
								onchange={(v) => setTransform('rotation', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.y}
								onchange={(v) => setTransform('rotation', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.z}
								onchange={(v) => setTransform('rotation', 'z', v)} />
						</div>
						<span class="text-[11px] text-gray-400">Scale</span>
						<div id="inspector-scale" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={0.1} value={$selectedObject.scale.x}
								onchange={(v) => setTransform('scale', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={0.1} value={$selectedObject.scale.y}
								onchange={(v) => setTransform('scale', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={0.1} value={$selectedObject.scale.z}
								onchange={(v) => setTransform('scale', 'z', v)} />
						</div>
					{/if}
				</div>
				<p class="text-[10px] text-gray-500">Drag to scrub — Shift fine, Ctrl snap, click to type.</p>
			</Section>

			{#if !isLight}
				<Section label="Object">
					<div class="ui-row items-center gap-2">
						<span class="w-24 shrink-0 text-xs text-gray-400">Render order</span>
						<input
							id="inspector-render-order"
							type="number"
							step="1"
							class="ui-input w-20 text-right"
							value={$selectedObject.renderOrder}
							onchange={(/** @type {any} */ e) => setObjectParam('renderOrder', +e.currentTarget.value || 0)}
						/>
					</div>
					<Checkbox
						checked={$selectedObject.frustumCulled}
						onchange={(/** @type {any} */ e) => setObjectParam('frustumCulled', e.target.checked)}
					>
						Frustum culled
					</Checkbox>
					<p class="text-[10px] text-gray-500">Higher render order draws later (over other objects). Disable culling for objects that vanish at screen edges.</p>
				</Section>
			{/if}

			{#if geoParams && geoSpec}
				<Section label="Geometry">
					<p class="px-1 text-[10px] uppercase tracking-wider text-gray-500">{geoParams.gtype}</p>
					{#if $selectedObject.userData?.vertexEdited || $selectedObject.userData?.faceEdited}
						<!-- 164: once the mesh is edited, the parametric controls are LOCKED
						     (changing one rebuilds the primitive + discards the edits) -->
						<p id="geometry-locked" class="rounded bg-yellow-900/40 px-2 py-1 text-[10px] text-yellow-200">
							Mesh edited — geometry parameters are locked (changing them would rebuild the shape and discard your edits).
						</p>
					{:else}
						<div id="inspector-geometry" class="flex flex-col gap-1">
							{#each geoSpec.params as spec (spec.key)}
								{#if spec.kind === 'bool'}
									<Checkbox
										checked={!!geoParams.params[spec.key]}
										onchange={(/** @type {any} */ e) => editGeometry(spec.key, e.target.checked)}
									>
										{spec.label}
									</Checkbox>
								{:else}
									<SliderRow
										label={spec.label}
										min={spec.min ?? 0}
										max={spec.max ?? 10}
										step={spec.kind === 'int' ? 1 : spec.step ?? 0.05}
										decimals={spec.kind === 'int' ? 0 : 2}
										value={Number(geoParams.params[spec.key] ?? spec.def)}
										onchange={(v) => editGeometry(spec.key, spec.kind === 'int' ? Math.round(v) : v)}
									/>
								{/if}
							{/each}
						</div>
					{/if}
				</Section>
			{/if}

			{#if isGroup}
				<Section label="Group">
					<p class="px-1 text-xs text-gray-400">
						{$selectedObject.children.length} direct child{$selectedObject.children.length === 1 ? '' : 'ren'},
						{countTree($selectedObject)} object{countTree($selectedObject) === 1 ? '' : 's'} in total.
					</p>
				</Section>
			{/if}

			{#if isLight}
				<Section label="Light">
					<ColorPicker
						isAlpha={false}
						isTextInput={false}
						isDialog={false}
						components={{ ...ChromeVariant, wrapper: CustomWrapper }}
						isOpen={true}
						sliderDirection="horizontal"
						--picker-indicator-size="20px"
						--cp-bg-color="#1f2937"
						--cp-border-color="#353f4e"
						--picker-height="70px"
						--picker-width="50px"
						--slider-width="10px"
						bind:hex={color}
						on:input={(event) => {
							$selectedObject.color.set(event.detail.hex);
							color = event.detail.hex;
							sendLightUpdate();
						}}
					/>
					<input
						type="text"
						class="ui-input w-full"
						value={color}
						oninput={(e) => {
							if (hexColor.test(e.currentTarget.value)) {
								color = e.currentTarget.value;
								$selectedObject.color.set(color);
								sendLightUpdate();
							}
						}}
					/>
					{#if $selectedObject.type === 'HemisphereLight'}
						<p class="ui-section-label">Ground color</p>
						<ColorPicker
							isAlpha={false}
							isTextInput={false}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							bind:hex={groundColor}
							on:input={(event) => {
								$selectedObject.groundColor.set(event.detail.hex);
								groundColor = event.detail.hex;
								sendLightUpdate();
							}}
						/>
					{/if}
					<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
						<span class="text-[11px] text-gray-400">Intensity</span>
						<div id="inspector-intensity">
							<DragRow label="I" accent="text-yellow-300" step={0.02} min={0} snap={0.5}
								value={$selectedObject.intensity}
								onchange={(v) => {
									$selectedObject.intensity = v;
									selectedObject.update((s) => s);
									sendLightUpdate();
								}} />
						</div>
					</div>
					{#each LIGHT_PARAMS[$selectedObject.type] ?? [] as spec (spec.key)}
						<SliderRow
							label={spec.label}
							min={spec.min ?? 0}
							max={spec.max ?? 10}
							step={spec.step ?? 0.05}
							value={Number($selectedObject[spec.key] ?? 0)}
							onchange={(v) => {
								$selectedObject[spec.key] = v;
								selectedObject.update((s) => s);
								sendLightUpdate();
							}} />
					{/each}

					{#if $selectedObject.type === 'SpotLight'}
						<p class="ui-section-label">Aim at</p>
						<div id="inspector-spot-target" class="grid grid-cols-3 gap-1">
							{#each ['X', 'Y', 'Z'] as axis, index (axis)}
								<DragRow
									label={axis}
									accent={['text-red-400', 'text-green-400', 'text-blue-400'][index]}
									step={0.05}
									value={($selectedObject.userData.spotTarget ?? [0, 0, 0])[index]}
									onchange={(v) => {
										const target = [...($selectedObject.userData.spotTarget ?? [0, 0, 0])];
										target[index] = v;
										$selectedObject.userData.spotTarget = target;
										selectedObject.update((s) => s);
										$peers.send({ type: 'lighttarget', uuid: $selectedObject.uuid, pos: target });
										sendLightUpdate(); // userData rides along for late joiners
									}} />
							{/each}
						</div>
					{/if}

					{#if SHADOW_TYPES.includes($selectedObject.type)}
						<p class="ui-section-label">Shadow</p>
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => sendLightUpdate()}>
							Cast Shadow
						</Checkbox>
						<div class="ui-row">
							<span class="w-20 shrink-0 text-xs text-gray-400">Map size</span>
							<ThemedSelect
								class="flex-1"
								items={SHADOW_SIZES.map((size) => ({ value: size, name: size + ' px' }))}
								value={$selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x}
								onchange={(/** @type {any} */ val) => {
									setShadowMapSize($selectedObject, +val);
									selectedObject.update((s) => s);
									sendLightUpdate();
								}}
							/>
						</div>
						{#if cappedShadowSize($selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x) < ($selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x)}
							<p class="text-[10px] italic text-gray-400">Capped by Settings ▸ Shadow quality on this machine.</p>
						{/if}
						<SliderRow label="Bias" min={-0.01} max={0.01} step={0.0005} decimals={4}
							value={$selectedObject.shadow.bias}
							onchange={(v) => {
								$selectedObject.shadow.bias = v;
								sendLightUpdate();
							}} />
						<SliderRow label="Softness" min={0} max={10} step={0.1} decimals={1}
							value={$selectedObject.shadow.radius}
							onchange={(v) => {
								$selectedObject.shadow.radius = v;
								sendLightUpdate();
							}} />
					{/if}
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendLightUpdate()}>
						Visible
					</Checkbox>
					{#if $selectedObject.type === 'RectAreaLight'}
						<p class="text-[10px] italic text-gray-400">
							Rect area lights only affect Standard/Physical materials and cast no shadows.
						</p>
					{/if}
				</Section>
			{/if}

			{#if material}
				<Section label="Material">
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendParam('visible')}>
						Visible
					</Checkbox>
					<ThemedSelect
						id="select-material"
						items={materials}
						value={material.type}
						onchange={(/** @type {any} */ val) => {
							// switches type but keeps color/texture/opacity, locally and on peers
							switchMaterialType($selectedObject.uuid, val);
							selectedObject.update((s) => s);
						}}
					/>

					{#if material.color && material.type !== 'MeshNormalMaterial'}
						<ColorPicker
							isAlpha={false}
							isTextInput={false}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							bind:hex={color}
							on:input={(event) => {
								trackColorGesture($selectedObject.uuid, event.detail.hex);
								$selectedObject.material.color.set(event.detail.hex);
								$peers.send({ type: 'color', uuid: $selectedObject.uuid, color: event.detail.hex });
							}}
						/>
						<input
							type="text"
							class="ui-input w-full"
							value={color}
							onchange={(e) => {
								if (hexColor.test(e.currentTarget.value)) {
									color = e.currentTarget.value;
									$selectedObject.material.color.set(color);
									$peers.send({ type: 'color', uuid: $selectedObject.uuid, color });
								}
							}}
						/>
					{/if}

					<!-- materials supporting textures initialize map to null; ShadowMaterial has no map at all -->
					{#if typeof material.map !== 'undefined'}
						<p class="ui-section-label">Texture</p>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							id="texture-drop"
							class="rounded border border-dashed {textureDropActive ? 'border-primary-500 bg-primary-500/10' : 'border-transparent'}"
							ondragover={(e) => {
								if (e.dataTransfer?.types.includes('application/x-explorer-item')) {
									e.preventDefault();
									textureDropActive = true;
								}
							}}
							ondragleave={() => (textureDropActive = false)}
							ondrop={async (e) => {
								const raw = e.dataTransfer?.getData('application/x-explorer-item');
								textureDropActive = false;
								if (!raw) return;
								e.preventDefault();
								e.stopPropagation();
								const ok = await applyExplorerImage($selectedObject.uuid, JSON.parse(raw));
								if (ok) selectedObject.update((s) => s);
							}}
						>
						<input
							type="file"
							id="texture-file"
							accept="image/png, image/jpeg, image/webp"
							style="display: none"
							onchange={(e) => {
								const file = e.currentTarget.files?.[0];
								if (file)
									setObjectTexture($selectedObject.uuid, file).then(() =>
										selectedObject.update((s) => s)
									);
								e.currentTarget.value = '';
							}}
						/>
						<div class="flex items-center gap-3">
							{#if material.userData?.mapDataUrl}
								<img
									src={material.userData.mapDataUrl}
									alt="texture"
									class="h-10 w-10 cursor-pointer rounded border border-gray-500 object-cover"
									role="presentation"
									onclick={() => document.getElementById('texture-file')?.click()}
								/>
								<Button
									size="xs"
									color="alternative"
									onclick={() => {
										removeObjectTexture($selectedObject.uuid);
										selectedObject.update((s) => s);
									}}>Remove</Button
								>
							{:else}
								<Button
									size="xs"
									color="alternative"
									onclick={() => document.getElementById('texture-file')?.click()}
								>
									Set texture...
								</Button>
								<span class="text-[10px] text-gray-500">or drop an Explorer image</span>
							{/if}
						</div>
						</div>
					{/if}

					{#if material.type === 'MeshStandardMaterial' || material.type === 'MeshPhysicalMaterial'}
						<SliderRow label="Roughness" min={0} max={1} step={0.05} value={material.roughness}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'roughness', v)} />
						<SliderRow label="Metalness" min={0} max={1} step={0.05} value={material.metalness}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'metalness', v)} />
					{/if}
					{#if material.type === 'MeshPhysicalMaterial'}
						<SliderRow label="Clearcoat" min={0} max={1} step={0.05} value={material.clearcoat}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'clearcoat', v)} />
						<SliderRow label="Clearcoat rough" min={0} max={1} step={0.05} value={material.clearcoatRoughness}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'clearcoatRoughness', v)} />
						<SliderRow label="Transmission" min={0} max={1} step={0.05} value={material.transmission}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'transmission', v)} />
						<SliderRow label="IOR" min={1} max={2.333} step={0.01} decimals={2} value={material.ior}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'ior', v)} />
					{/if}
					{#if material.type === 'MeshPhongMaterial'}
						<SliderRow label="Shininess" min={0} max={100} step={1} decimals={0} value={material.shininess}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'shininess', v)} />
					{/if}
					{#if material.type === 'MeshNormalMaterial' || material.type === 'MeshDepthMaterial'}
						<p class="text-[11px] italic text-gray-400">
							This material type derives its look from geometry — no color or surface parameters.
						</p>
					{/if}
					{#if typeof material.opacity !== 'undefined' && material.type !== 'ShadowMaterial'}
						<SliderRow label="Opacity" min={0} max={1} step={0.05} value={material.opacity}
							onchange={(v) => {
								setMaterialParam($selectedObject.uuid, 'transparent', v < 1);
								setMaterialParam($selectedObject.uuid, 'opacity', v);
							}} />
					{/if}
					{#if typeof material.wireframe !== 'undefined'}
						<Checkbox
							checked={material.wireframe}
							onchange={(/** @type {any} */ e) =>
								setMaterialParam($selectedObject.uuid, 'wireframe', e.target.checked)}
						>
							Wireframe
						</Checkbox>
					{/if}
					{#if 'flatShading' in material}
						<Checkbox
							checked={material.flatShading}
							onchange={(/** @type {any} */ e) =>
								setMaterialParam($selectedObject.uuid, 'flatShading', e.target.checked)}
						>
							Flat shading
						</Checkbox>
					{/if}
					{#if typeof material.side !== 'undefined'}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Side</span>
							<ThemedSelect
								class="flex-1"
								items={[
									{ value: 0, name: 'Front' },
									{ value: 1, name: 'Back' },
									{ value: 2, name: 'Double' }
								]}
								value={material.side}
								onchange={(/** @type {any} */ v) => setMaterialParam($selectedObject.uuid, 'side', +v)}
							/>
						</div>
					{/if}
					{#if material.emissive}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Emissive</span>
							<input
								type="color"
								class="h-6 w-8 cursor-pointer rounded border border-gray-500 bg-transparent"
								value={'#' + material.emissive.getHexString()}
								oninput={(/** @type {any} */ e) =>
									setMaterialParam($selectedObject.uuid, 'emissive', e.currentTarget.value)}
							/>
						</div>
						<SliderRow label="Emissive int." min={0} max={4} step={0.05} value={material.emissiveIntensity}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'emissiveIntensity', v)} />
					{/if}

					<p class="ui-section-label">Shadow</p>
					<div class="flex gap-4 px-1">
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => setCastShadow()}>
							Cast
						</Checkbox>
						<Checkbox
							bind:checked={$selectedObject.receiveShadow}
							onchange={() => sendParam('receiveShadow')}
						>
							Receive
						</Checkbox>
					</div>
				</Section>
			{/if}

			{#if !$selectedObject.isLight}
				<Section label="Physics">
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Body</span>
						<ThemedSelect
							id="physics-mode"
							items={[
								{ value: 'auto', name: 'Auto (scenery)' },
								{ value: 'static', name: 'Static' },
								{ value: 'dynamic', name: 'Dynamic' }
							]}
							value={$selectedObject.userData.physics?.mode ?? 'auto'}
							onchange={(/** @type {any} */ v) => setPhysics({ mode: v })}
						/>
					</div>
					{#if ($selectedObject.userData.physics?.mode ?? 'auto') === 'dynamic'}
						<SliderRow label="Mass" min={0.1} max={100} step={0.1} value={$selectedObject.userData.physics?.mass ?? 1}
							onchange={(v) => setPhysics({ mass: v })} />
					{/if}
					<SliderRow label="Bounciness" min={0} max={1} step={0.05} value={$selectedObject.userData.physics?.restitution ?? 0.3}
						onchange={(v) => setPhysics({ restitution: v })} />
					<SliderRow label="Friction" min={0} max={2} step={0.05} value={$selectedObject.userData.physics?.friction ?? 0.5}
						onchange={(v) => setPhysics({ friction: v })} />
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Collider</span>
						<ThemedSelect
							id="physics-collider"
							items={[
								{ value: 'box', name: 'Box' },
								{ value: 'sphere', name: 'Sphere' },
								{ value: 'capsule', name: 'Capsule' },
								{ value: 'cylinder', name: 'Cylinder' },
								{ value: 'hull', name: 'Convex hull' }
							]}
							value={$selectedObject.userData.physics?.collider ?? 'box'}
							onchange={(/** @type {any} */ v) => setPhysics({ collider: v })}
						/>
					</div>
					<p class="mt-1 text-xs text-gray-400">
						Dynamic bodies fall and collide when a simulation runs; flow Mass/Bounciness/Friction nodes override these.
					</p>
				</Section>

				<!-- PFX-A: particle emitter — config on userData.particles, every edit
				     replicates + records a props undo entry (setParticles) -->
				<Section label="Particles">
					{#if !$selectedObject.userData.particles}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Emitter</span>
							<ThemedSelect
								id="particles-add"
								items={[
									{ value: 'none', name: 'Add emitter…' },
									...PARTICLE_PRESETS.map((p) => ({ value: p.key, name: p.name }))
								]}
								value={'none'}
								onchange={(/** @type {any} */ v) => {
									if (v !== 'none') addParticlesPreset($selectedObject.uuid, v);
								}}
							/>
						</div>
					{:else}
						{@const p = $selectedObject.userData.particles}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Preset</span>
							<ThemedSelect
								id="particles-preset"
								items={PARTICLE_PRESETS.map((item) => ({ value: item.key, name: item.name }))}
								value={p.preset ?? 'sparkles'}
								onchange={(/** @type {any} */ v) => addParticlesPreset($selectedObject.uuid, v)}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Emission</span>
							<ThemedSelect
								id="particles-mode"
								items={[
									{ value: 'continuous', name: 'Continuous' },
									{ value: 'burst', name: 'Burst (triggered)' },
									{ value: 'impact', name: 'On impact (physics)' }
								]}
								value={p.mode ?? 'continuous'}
								onchange={(/** @type {any} */ v) => setParticles({ mode: v })}
							/>
						</div>
						{#if (p.mode ?? 'continuous') === 'impact'}
							<p class="text-xs text-gray-400">
								Fires when a physics simulation lands this object on the ground or another object (needs a Dynamic body + a running sim).
							</p>
						{/if}
						{#if (p.mode ?? 'continuous') !== 'continuous'}
							<div class="ui-row items-center gap-2">
								<Button size="xs" color="alternative" onclick={() => burstObjectParticles($selectedObject.uuid)}>
									<Sparkles size={16} class="mr-1" aria-hidden="true" />Burst now
								</Button>
								<span class="text-xs text-gray-400">fires for every peer</span>
							</div>
						{/if}
						<SliderRow label="Count" min={1} max={500} step={1} value={p.count ?? 80}
							onchange={(v) => setParticles({ count: v })} />
						<SliderRow label="Lifetime" min={0.1} max={6} step={0.1} value={p.lifetime ?? 1.5}
							onchange={(v) => setParticles({ lifetime: v })} />
						<SliderRow label="Speed" min={0} max={8} step={0.1} value={p.speed ?? 1}
							onchange={(v) => setParticles({ speed: v })} />
						<SliderRow label="Gravity" min={-10} max={10} step={0.1} value={p.gravity ?? 0}
							onchange={(v) => setParticles({ gravity: v })} />
						<SliderRow label="Turbulence" min={0} max={1} step={0.05} value={p.turbulence ?? 0.2}
							onchange={(v) => setParticles({ turbulence: v })} />
						<SliderRow label="Size start" min={0.01} max={1} step={0.01} value={p.sizeStart ?? 0.1}
							onchange={(v) => setParticles({ sizeStart: v })} />
						<SliderRow label="Size end" min={0} max={1} step={0.01} value={p.sizeEnd ?? 0.03}
							onchange={(v) => setParticles({ sizeEnd: v })} />
						<SliderRow label="Opacity" min={0} max={1} step={0.05} value={p.opacity ?? 0.9}
							onchange={(v) => setParticles({ opacity: v })} />
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400" title="Where particles spawn, relative to the object center (local axes)">Emit from</span>
							{#each ['x', 'y', 'z'] as axis, i}
								<input
									type="number"
									step="0.1"
									aria-label={'Emit offset ' + axis}
									class="w-14 rounded border border-gray-500 bg-transparent px-1 py-0.5 text-xs"
									value={(p.offset ?? [0, 0, 0])[i] ?? 0}
									oninput={(/** @type {any} */ e) => {
										const off = [...(p.offset ?? [0, 0, 0])];
										off[i] = +e.currentTarget.value;
										setParticles({ offset: off });
									}}
								/>
							{/each}
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Color</span>
							<input
								type="color"
								aria-label="Particle start color"
								class="h-6 w-8 cursor-pointer rounded border border-gray-500 bg-transparent"
								value={p.colorStart ?? '#ffffff'}
								oninput={(/** @type {any} */ e) => setParticles({ colorStart: e.currentTarget.value })}
							/>
							<span class="text-xs text-gray-400">→</span>
							<input
								type="color"
								aria-label="Particle end color"
								class="h-6 w-8 cursor-pointer rounded border border-gray-500 bg-transparent"
								value={p.colorEnd ?? '#8899aa'}
								oninput={(/** @type {any} */ e) => setParticles({ colorEnd: e.currentTarget.value })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Sprite</span>
							<ThemedSelect
								id="particles-sprite"
								items={[
									{ value: 'dot', name: 'Soft dot' },
									{ value: 'streak', name: 'Spark streak' },
									{ value: 'puff', name: 'Smoke puff' },
									{ value: 'star', name: 'Star' },
									{ value: 'square', name: 'Confetti' }
								]}
								value={p.sprite ?? 'dot'}
								onchange={(/** @type {any} */ v) => setParticles({ sprite: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Blending</span>
							<ThemedSelect
								id="particles-blending"
								items={[
									{ value: 'additive', name: 'Additive (glow)' },
									{ value: 'normal', name: 'Normal' }
								]}
								value={p.blending ?? 'additive'}
								onchange={(/** @type {any} */ v) => setParticles({ blending: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Space</span>
							<ThemedSelect
								id="particles-space"
								items={[
									{ value: 'local', name: 'Local (rides object)' },
									{ value: 'world', name: 'World (trails behind)' }
								]}
								value={p.space ?? 'local'}
								onchange={(/** @type {any} */ v) => setParticles({ space: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<Button size="xs" color="red" onclick={() => removeObjectParticles($selectedObject.uuid)}>
								Remove emitter
							</Button>
						</div>
					{/if}
				</Section>
			{/if}
		</div>
	{/if}
</Drawer>
