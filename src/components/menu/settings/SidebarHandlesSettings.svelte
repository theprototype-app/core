<script>
	// showhide-v8 (owner 2026-11-09, R3) — Settings ▸ Interface ▸ "Show viewport sidebar handles", the setting that
	// replaced the proposed Icons | Arrows one. Its own file so the settings page stays a one-line union. Auto follows
	// the owner's device table ($lib/sidebarHandles): on with a mouse (only while a column is closed), off on an
	// unfolded phone, on on a tablet. LOCAL (this device), persisted.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { sidebarHandlesMode, sidebarHandlesDim } from '$lib/sidebarHandles';

	const OPTIONS = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];
</script>

<SettingRow
	id="row-sidebar-handles"
	label="Show viewport sidebar handles"
	description="A slim tab on each screen edge that opens or closes that side's sidebar. Auto: on with a mouse (shown only while a sidebar is closed) and on tablets, off on an unfolded phone (the Panels button is there). Right-click or long-press a handle to move it, dim it or hide it."
	badge="This device"
	keywords="sidebar handles handle edge tab notch arrow show hide sidebars columns viewport tablet unfolded phone touch"
>
	<Segmented id="sidebar-handles-mode" label="Show viewport sidebar handles" options={OPTIONS} value={$sidebarHandlesMode} onchange={(/** @type {string} */ v) => sidebarHandlesMode.set(/** @type {any} */ (v))} />
</SettingRow>
<SettingRow
	id="row-sidebar-handles-dim"
	label="Dim the handles at rest"
	description="The handles stay faint until you point at them or focus them."
	badge="This device"
	keywords="sidebar handles dim transparent faint opacity"
>
	<Toggle id="sidebar-handles-dim" label="Dim the handles at rest" bind:checked={$sidebarHandlesDim} />
</SettingRow>
