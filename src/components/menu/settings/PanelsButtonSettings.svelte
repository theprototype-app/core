<script>
	// dock-fixes item 8 (owner 2026-11-08) — Settings ▸ Interface ▸ Windows & chrome ▸ "Panels button". Its own
	// file so the settings page stays a one-line union. The round button beside the profile that shows / hides
	// both sidebars ($lib/panelsButton): Auto = on a touch screen with sidebars (the unfolded phone, a tablet),
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
	description="A button beside your profile that shows or hides both sidebars, keeping their tabs open. Auto: on touch screens wide enough for sidebars (an unfolded phone, a tablet)."
	badge="This device"
	keywords="panels sidebars sidebar toggle show hide button customize buttons tablet unfolded phone touch"
>
	<Segmented id="panels-button-mode" label="Panels button" options={OPTIONS} value={$panelsButtonMode} onchange={(/** @type {string} */ v) => panelsButtonMode.set(/** @type {any} */ (v))} />
</SettingRow>
