<script>
	// 103 H5 / H10 — Settings ▸ Shortcuts ▸ Keymap: the preset (a set of default bindings; your own
	// rebinds win) and the two fly prefs the presets lean on. Loaded lazily by ShortcutsSettings, so
	// the preset tables never reach the boot.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import { keymapPreset, setKeymapPreset } from '$lib/shortcuts';
	import { KEYMAP_PRESETS } from '$lib/keymapPresets';
	import { flyWithWasd, flyDirection } from '$lib/flyPrefs';

	/** @type {{ onchange?: () => void }} */
	let { onchange = () => {} } = $props();
</script>

<!-- 103 H5: the keymap preset (a set of default bindings; your own rebinds win) and the two fly
     prefs the presets lean on -->
<Section variant="card" label="Keymap">
	<SettingRow label="Keymap preset" description={KEYMAP_PRESETS.find((p) => p.id === $keymapPreset)?.hint ?? ''}>
		<select
			id="keymap-preset"
			class="settings-text"
			value={$keymapPreset}
			onchange={(e) => {
				setKeymapPreset(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
				onchange();
			}}
		>
			{#each KEYMAP_PRESETS as preset (preset.id)}
				<option value={preset.id}>{preset.label}</option>
			{/each}
		</select>
	</SettingRow>
	<SettingRow label="Fly with WASD" description="Only while holding the right mouse button frees W A S D Q E for commands (Blender's bare S, Unity's W / E / R).">
		<select
			id="fly-with-wasd"
			class="settings-text"
			value={$flyWithWasd}
			onchange={(e) => {
				flyWithWasd.set(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
				onchange();
			}}
		>
			<option value="always">Always</option>
			<option value="rmb">Only while holding the right mouse button</option>
		</select>
	</SettingRow>
	<SettingRow label="Fly direction" description="Where I look: W / S follow the view, so looking up and pressing W climbs. Q / E always move straight down / up.">
		<select id="fly-direction" class="settings-text" bind:value={$flyDirection}>
			<option value="level">Level</option>
			<option value="look">Where I look</option>
		</select>
	</SettingRow>
</Section>
