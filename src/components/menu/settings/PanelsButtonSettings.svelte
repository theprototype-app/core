<script>
	// dock-fixes item 8 (owner 2026-11-08) — Settings ▸ Interface ▸ Windows & chrome ▸ "Panels button". Its own
	// file so the settings page stays a one-line union. The round button beside the profile that shows / hides
	// both sidebars ($lib/panelsButton): Auto = the unfolded phone with the handles off (showhide-v8 device table),
	// On = everywhere sidebars exist, Off = never. LOCAL (this device), persisted.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import { panelsButtonMode } from '$lib/panelsButton';

	const OPTIONS = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];
</script>

<SettingRow
	id="row-panels-button"
	label="Panels button"
	description="A button beside your profile for the sidebars: a press opens the left one, the next the right one, the next hides both (a side with no tabs is skipped; tabs stay open). Auto: on an unfolded phone, unless the sidebar handles are on."
	badge="This device"
	keywords="panels sidebars sidebar toggle show hide button customize buttons tablet unfolded phone touch"
>
	<Segmented id="panels-button-mode" label="Panels button" options={OPTIONS} value={$panelsButtonMode} onchange={(/** @type {string} */ v) => panelsButtonMode.set(/** @type {any} */ (v))} />
</SettingRow>
