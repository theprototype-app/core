<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// the old labels of the rows this redesign renamed (Decision C) + the words people search with
	const ROW_WORDS = {
		'show grid': ['grid', 'floor'],
		'light helper length': ['helper', 'light', 'directional', 'spot'],
		'show the simulation controls': ['simulation controls', 'physics', 'transport', 'sim'],
		'shadow quality': ['shadows', 'performance'],
		'reduce quality when the scene is heavy': ['performance', 'fps', 'lag', 'slow', 'governor'],
		'simplify distant models': ['lod', 'performance'],
		'draw repeated kit pieces together': ['instancing', 'performance', 'kit'],
		'sync animations': ['animation', 'clock', 'phase'],
		'spatial voice': ['voice', 'audio', 'pan', '3d sound'],
		'ping colour': ['ping color + sound', 'ping', 'colour', 'color'],
		'ping sound': ['ping color + sound', 'ping', 'chime', 'sound'],
		autosave: ['backup', 'recovery'],
		'auto-restore on load': ['crash', 'recovery', 'backup'],
		'when opening another scene': ['modules', 'scene switch', 'unload'],
		'double-click action': ['double click', 'selection', 'isolate', 'properties'],
		length: ['units', 'metres', 'meters', 'inches', 'feet'],
		angle: ['units', 'degrees', 'radians'],
		'carry animation clips': ['duplicate', 'copy'],
		'carry object flow': ['duplicate', 'copy', 'flow graph'],
		'carry shader graph': ['duplicate', 'copy', 'shader'],
		'share materials': ['duplicate', 'material', 'unlink'],
		'wireframe colour': ['wireframe color', 'wireframe'],
		'selection outline colour': ['selection outline color', 'outline', 'selection'],
		'edit mesh wireframe colour': ['edit mesh wireframe', 'mesh', 'edges'],
		'reset line colours': ['reset line colors', 'colors', 'colours']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Scene on the redesign kit (docs/settings-inventory.md §3.6): the
	// 35 rows in nine cards — Viewport, Performance, Collaboration, Saving & checkpoints, Editing,
	// Units, Duplicates, Colours, Loading placeholders. Same stores / keys as 1.25.0; "Show grid"
	// keeps its key-presence write ('false' only while hidden). Checkpoints, Loading and Water stay
	// in their own files (one-line sections) and render inside these cards.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import Icon from '../../ui/Icon.svelte';
	import CheckpointSettings from './CheckpointSettings.svelte';
	import LoadingSettings from './LoadingSettings.svelte';
	import PlacementSettings from './PlacementSettings.svelte'; // 39 P3
	import WaterSettings from '../../water/WaterSettings.svelte';
	import HdriSettings from '../../hdri/HdriSettings.svelte'; // 37-hdri
	import { showSimControls, duplicateCarriesAnimation, duplicateCarriesFlow, duplicateCarriesShader, showToast } from '../../../stores/appStore.js';
	import { showGrid } from '../../../stores/sceneStore.js';
	import { syncedAnimations } from '../../../stores/flowStore';
	import { safeStorage } from '$lib/safeStorage';
	import { lightHelperLength } from '$lib/lightHelpers';
	import { shadowQuality } from '$lib/lightParams';
	import { autoQuality } from '$lib/qualityGovernor';
	import { lodEnabled } from '$lib/lod';
	import { kitInstancingEnabled } from '$lib/kitInstancing';
	import { spatialVoice } from '$lib/voiceChat';
	import { pingColor, pingSound } from '$lib/ping';
	import { PING_SOUNDS, playPing } from '$lib/pingAudio';
	import { autosaveEnabled, autoRestoreEnabled } from '$lib/autosave';
	import { modulesOnOpen } from '$lib/sceneSwitch';
	import { doubleClickAction } from '$lib/selectionPrefs';
	import { lengthUnit, angleUnit, LENGTH_UNIT_KEYS } from '$lib/units';
	import { shareDuplicatedMaterials } from '$lib/materialSharing';
	import { viewPrefs, setViewPrefs, resetViewPrefs, DEFAULT_VIEW_PREFS } from '$lib/viewPrefs';

	/** "Show grid": the store, plus the key written only while the grid is HIDDEN (as 1.25.0's checkbox did) @param {boolean} on */
	function setShowGrid(on) {
		showGrid.set(on);
		if (on) safeStorage.removeItem('showGrid');
		else safeStorage.setItem('showGrid', 'false');
	}

	const SHADOWS = [
		{ value: 'off', label: 'Off' },
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' }
	];
	const ON_OPEN = [
		{ value: 'ask', label: 'Ask' },
		{ value: 'keep', label: 'Keep' },
		{ value: 'unload', label: 'Unload' }
	];
	const DOUBLE_CLICK = [
		{ value: 'properties', label: 'Properties', title: 'Open the object’s properties (default)' },
		{ value: 'meshedit', label: 'Edit mesh', title: 'Jump straight into vertex / edge / face editing' },
		{ value: 'isolate', label: 'Isolate', title: 'Frame it and hide everything else until Esc' },
		{ value: 'sametype', label: 'Same type', title: 'Select every object of the same kind' }
	];
	const ANGLES = [
		{ value: 'deg', label: 'Degrees' },
		{ value: 'rad', label: 'Radians' }
	];
	const EDIT_WIRE = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'custom', label: 'Custom' }
	];
	const editWireAuto = $derived($viewPrefs.editWireColor === 'auto');
</script>

<div class="settings-page-body" data-keywords="performance quality grid">
	<Section variant="card" label="Viewport">
		<SettingRow id="row-show-grid" label="Show grid" description="The grid on the floor.">
			<Toggle id="show-grid" label="Show grid" checked={$showGrid !== false} onchange={setShowGrid} />
		</SettingRow>
		<SettingRow id="row-light-helper" label="Light helper length" description="How far a directional or spot light’s helper line reaches. Display only.">
			<span class="settings-unit">
				<input
					id="light-helper-length"
					class="settings-num"
					type="number"
					min="0.2"
					max="50"
					step="0.5"
					aria-label="Light helper length, metres"
					value={$lightHelperLength}
					onchange={(e) => lightHelperLength.set(Math.max(0.2, Number(e.currentTarget.value) || 2))}
				/>m</span
			>
		</SettingRow>
		<SettingRow id="row-sim-controls" label="Show the simulation controls" description="The physics play / pause / stop / reset at the bottom right. P starts and stops it either way.">
			<Toggle id="show-sim-controls" label="Show the simulation controls" bind:checked={$showSimControls} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Performance" badge="This device">
		<SettingRow id="row-shadow-quality" label="Shadow quality" description="Caps every light’s shadow map size here; per-light sizes still travel with the scene." wide>
			<Segmented id="shadow-quality" label="Shadow quality" options={SHADOWS} value={$shadowQuality} onchange={(v) => shadowQuality.set(/** @type {any} */ (v))} />
		</SettingRow>
		<SettingRow id="row-auto-quality" label="Reduce quality when the scene is heavy" description="Below 30 frames a second, drops shadows, then resolution, then effects — and gives them back.">
			<Toggle id="auto-quality" label="Reduce quality when the scene is heavy" bind:checked={$autoQuality} />
		</SettingRow>
		<SettingRow id="row-lod" label="Simplify distant models" description="Draws a lighter version of a dense model when it is far away. The scene itself never changes.">
			<Toggle id="lod-enabled" label="Simplify distant models" bind:checked={$lodEnabled} />
		</SettingRow>
		<SettingRow id="row-kit-instancing" label="Draw repeated kit pieces together" description="Every copy of one pack piece is drawn in one go — what keeps a kit level inside a headset’s budget.">
			<Toggle id="kit-instancing" label="Draw repeated kit pieces together" bind:checked={$kitInstancingEnabled} />
		</SettingRow>
		<WaterSettings />
		<HdriSettings />
		<PlacementSettings />
	</Section>

	<Section variant="card" label="Collaboration">
		<SettingRow id="row-sync-animations" label="Sync animations" description="Node animations use the shared clock, so everyone sees the same moment.">
			<Toggle id="synced-animations" label="Sync animations" bind:checked={$syncedAnimations} />
		</SettingRow>
		<SettingRow id="row-spatial-voice" label="Spatial voice" description="Voices come from where each person is.">
			<Toggle id="spatial-voice" label="Spatial voice" bind:checked={$spatialVoice} />
		</SettingRow>
		<SettingRow id="row-ping-color" label="Ping colour" badge="Shared" description="What others see when you ping. Empty uses your peer colour.">
			<input
				type="color"
				id="ping-color"
				class="settings-color"
				aria-label="Ping colour"
				value={$pingColor || '#4f83cc' /* tokens-ok: the ping colour's default (user data, same as PingHighlights) */}
				onchange={(e) => pingColor.set(e.currentTarget.value)}
			/>
		</SettingRow>
		<SettingRow id="row-ping-sound" label="Ping sound" badge="Shared" description="What others hear when you ping.">
			<ThemedSelect id="ping-sound" items={PING_SOUNDS.map((s) => ({ value: s.id, name: s.name }))} bind:value={$pingSound} />
			<Button id="ping-preview" variant="icon" size="sm" icon="play" label="Preview the ping" title="Preview the ping" onclick={() => playPing($pingSound)} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Saving & checkpoints" badge="This device">
		<SettingRow id="row-autosave" label="Autosave" description="Keeps a copy of your work on this device, offered back after a crash or reload.">
			<Toggle id="autosave" label="Autosave" bind:checked={$autosaveEnabled} />
		</SettingRow>
		<SettingRow id="row-auto-restore" label="Auto-restore on load" description="Restores that copy at startup instead of asking — only into an empty scene.">
			<Toggle id="auto-restore" label="Auto-restore on load" bind:checked={$autoRestoreEnabled} />
		</SettingRow>
		<CheckpointSettings />
		<SettingRow id="row-modules-on-open" label="When opening another scene" description="What happens to the modules the scene you leave brought along. A new blank scene always unloads them." wide>
			<Segmented id="modules-on-open" label="When opening another scene" options={ON_OPEN} value={$modulesOnOpen} onchange={(v) => modulesOnOpen.set(/** @type {any} */ (v))} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Editing">
		<SettingRow id="row-double-click" label="Double-click action" description="What a double-click on an object does. A single click always selects; Ctrl+A selects all." wide>
			<Segmented id="double-click-action" label="Double-click action" options={DOUBLE_CLICK} value={$doubleClickAction} onchange={(v) => doubleClickAction.set(/** @type {any} */ (v))} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Units">
		<SettingRow id="row-length" label="Length" description="How distances show and are typed. The scene stays in metres; a typed 12cm or 4in converts.">
			<ThemedSelect id="length-unit" items={LENGTH_UNIT_KEYS.map((u) => ({ value: u, name: u }))} bind:value={$lengthUnit} />
		</SettingRow>
		<SettingRow id="row-angle" label="Angle" description="The same for rotations and angular snapping.">
			<Segmented id="angle-unit" label="Angle" options={ANGLES} value={$angleUnit} onchange={(v) => angleUnit.set(/** @type {any} */ (v))} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Duplicates">
		<SettingRow id="row-dup-anim" label="Carry animation clips" description="A copy gets its own clips and plays on its own.">
			<Toggle id="dup-carry-animation" label="Carry animation clips" bind:checked={$duplicateCarriesAnimation} />
		</SettingRow>
		<SettingRow id="row-dup-flow" label="Carry object flow" description="A copy gets its own flow graph, with fresh node ids.">
			<Toggle id="dup-carry-flow" label="Carry object flow" bind:checked={$duplicateCarriesFlow} />
		</SettingRow>
		<SettingRow id="row-dup-shader" label="Carry shader graph" description="A copy of a shader-driven object gets its own graph to edit.">
			<Toggle id="dup-carry-shader" label="Carry shader graph" bind:checked={$duplicateCarriesShader} />
		</SettingRow>
		<SettingRow id="row-share-materials" label="Share materials" badge="Shared" description="A copy and its original share one material, so an edit to either changes both — for everyone.">
			<Toggle id="share-materials" label="Share materials" bind:checked={$shareDuplicatedMaterials} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Colours" badge="This device">
		<SettingRow id="row-wire-color" label="Wireframe colour" description="Lines of the Wireframe view mode.">
			<input type="color" id="wire-color" class="settings-color" aria-label="Wireframe colour" value={$viewPrefs.wireColor} oninput={(e) => setViewPrefs({ wireColor: e.currentTarget.value })} />
		</SettingRow>
		<SettingRow id="row-outline-color" label="Selection outline colour" description="The outline around what you select. A peer’s lock keeps its own colour.">
			<input type="color" id="outline-color" class="settings-color" aria-label="Selection outline colour" value={$viewPrefs.outlineColor} oninput={(e) => setViewPrefs({ outlineColor: e.currentTarget.value })} />
		</SettingRow>
		<SettingRow id="row-edit-wire" label="Edit mesh wireframe colour" description="Edges while editing a mesh. Auto picks dark or light from the object’s own colour.">
			<Segmented
				id="edit-wire-mode"
				label="Edit mesh wireframe colour"
				options={EDIT_WIRE}
				value={editWireAuto ? 'auto' : 'custom'}
				onchange={(v) => setViewPrefs({ editWireColor: v === 'auto' ? 'auto' : '#2f81f7' }) /* tokens-ok: the edit-wire colour written into the view prefs (three.js data) */}
			/>
			{#if !editWireAuto}
				<input type="color" id="edit-wire-color" class="settings-color" aria-label="Edit mesh wireframe colour" value={$viewPrefs.editWireColor} oninput={(e) => setViewPrefs({ editWireColor: e.currentTarget.value })} />
			{/if}
		</SettingRow>
		<SettingRow id="row-reset-colors" label="Reset line colours" description={'Back to ' + DEFAULT_VIEW_PREFS.wireColor + ' / ' + DEFAULT_VIEW_PREFS.outlineColor + ' / auto.'}>
			<Button
				id="reset-view-colors"
				size="sm"
				variant="outline"
				onclick={() => {
					resetViewPrefs();
					showToast('Line colors reset');
				}}>Reset</Button
			>
		</SettingRow>
	</Section>

	<LoadingSettings />
</div>

<style>
	.settings-page-body {
		display: contents;
	}
</style>
