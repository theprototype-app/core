<script>
	// uir-people — Settings ▸ Interface ▸ "Show my status". Its own file so the settings page stays a one-line
	// union. OFF by default (owner 2026-11-09: an optional presence field). On, your Person card offers
	// Available / Busy / Away and everyone in the session sees it on your row; off clears it on their screens.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { presenceEnabled, setPresenceEnabled } from '$lib/peoplePresence';
</script>

<SettingRow
	id="row-presence"
	label="Show my status"
	description="Available, Busy or Away beside your name in People. Pick it on your own card; turning this off hides it from everyone."
	badge="This device"
	keywords="presence status available busy away people peers do not disturb"
>
	<Toggle id="setting-presence" label="Show my status" checked={$presenceEnabled} onchange={(/** @type {boolean} */ v) => setPresenceEnabled(v)} />
</SettingRow>
