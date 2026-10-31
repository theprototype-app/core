<script>
	// 70 W3/W5 — Settings ▸ Interface ▸ Windows & chrome: the pop-out windows' two settings. Desktop
	// only, like the windows themselves (W6). LOCAL (this device).
	//   "Always show tab strip in windows": a window holding one panel shows its strip too (by default
	//   its header shows the panel's name, which IS the tab).
	//   "Tell windows apart by screen": with the browser's permission (Window Management API, Chromium)
	//   a multi-window layout is remembered per arrangement of ALL screens; without it, per the one
	//   screen the page can see.
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { alwaysShowTabStrip } from '$lib/windows/panelPlaces.js';
	import { screenDetailsOptIn, requestScreenDetails } from '$lib/windows/panelHost.js';
	import { popOutSupported } from '$lib/windows/popOutSupport.js';

	const canAsk = typeof window !== 'undefined' && typeof (/** @type {any} */ (window).getScreenDetails) === 'function';

	/** turning it on asks for the permission now (this click is the gesture the prompt needs) @param {boolean} on */
	async function setScreens(on) {
		if (!on) return screenDetailsOptIn.set(false);
		screenDetailsOptIn.set(await requestScreenDetails());
	}
</script>

{#if $popOutSupported}
	<SettingRow
		id="row-windows-strip"
		label="Always show tab strip in windows"
		description="A pop-out window with one panel shows its tab strip too. Off, its header shows the panel's name — drag that name to move the panel."
		badge="This device"
		keywords="pop out popout window windows tabs tab strip monitor"
	>
		<Toggle id="setting-windows-strip" label="Always show tab strip in windows" bind:checked={$alwaysShowTabStrip} />
	</SettingRow>
	{#if canAsk}
		<SettingRow
			id="row-windows-screens"
			label="Remember windows per screen setup"
			description="Asks the browser to see every screen, so pop-out windows come back where they were for each arrangement of monitors. Off, the layout is remembered for the screen this window is on."
			badge="This device"
			keywords="pop out popout window windows monitor screens multi-monitor layout restore"
		>
			<Toggle id="setting-windows-screens" label="Remember windows per screen setup" checked={$screenDetailsOptIn} onchange={(/** @type {boolean} */ next) => setScreens(next)} />
		</SettingRow>
	{/if}
{/if}
