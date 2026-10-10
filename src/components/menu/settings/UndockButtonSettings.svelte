<script>
	// 40 F8 — Settings ▸ Interface ▸ Windows & chrome ▸ "Undock button". Its own file so the
	// settings page stays a one-line union. What the dock's undock button (left of "minimize
	// the dock") does: undock the ACTIVE tab (default) or every docked tab as ONE floating
	// tabbed window. LOCAL (this device), persisted by bottomDock.undockButtonMode.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import { undockButtonMode } from '$lib/bottomDock';

	const OPTIONS = [
		{ value: 'active', label: 'Active window' },
		{ value: 'group', label: 'All as one tabbed group' }
	];
</script>

<SettingRow
	id="row-undock-button"
	label="Undock button"
	description="What the dock's undock button does: take out the tab you are looking at, or every docked tab as one floating window with tabs."
	badge="This device"
	keywords="undock dock float floating window tabs group tabbed"
>
	<Segmented id="undock-button-mode" label="Undock button" options={OPTIONS} value={$undockButtonMode} onchange={(/** @type {string} */ v) => undockButtonMode.set(v)} />
</SettingRow>
