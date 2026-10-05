<script context="module">
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// 36 U3b/I5: the settings search (I4) indexes labels + these keywords. 36-int-122: words for the
	// whole section sit on its root; the headset words belong to their own rows only (a word on the
	// root lists every Tours row — "headset" must find the rows that are about a headset)
	const sectionKeywords = ['tour', 'tours', 'tutorial', 'welcome', 'onboarding', 'help', 'first run', 'guide'];
	const rowKeywords = {
		'VR welcome': ['vr welcome', 'controllers', 'quest'],
		'Offer Enter VR': ['enter vr', 'offer', 'headset browser', 'quest']
	};
	for (const [row, words] of Object.entries(rowKeywords)) registerSettingsKeywords(row, words);
	export const keywords = [...sectionKeywords, ...Object.values(rowKeywords).flat()];
</script>

<script>
	// 36 U3b/I5 — Settings ▸ Tours: start the VR welcome or the editor tour again, reset them,
	// and the auto-start switch "Don't show again" turned off. Its own file and one line in
	// Settings.svelte (the round's merge rule for the settings hot spot). Legacy mode on purpose:
	// SettingRow is a legacy slot component, as in Settings.svelte itself.
	import { Toggle, Button } from 'flowbite-svelte';
	import SettingRow from '../SettingRow.svelte';
	import { tours, tourRecords } from '$lib/tours/index.js';
	import { VR_TOUR, editorTourId, startVRWelcome, startEditorTour, resetAllTours } from '$lib/tours/builtin.js';
	import { settingsOpen } from '../../../stores/appStore.js';
	import { xrOfferEnabled } from '$lib/xrOffer';

	/** @param {string} id @param {number} _tick re-read when a record changes */
	function statusText(id, _tick) {
		const status = tours.status(id);
		if (status === 'done') return 'Seen';
		if (status === 'progress') return 'Started — resumes where you left it';
		return 'Not seen yet';
	}
	/** @param {number} _tick re-read when a record changes */
	const autoStartOn = (_tick) => tours.autoStartEnabled();
	$: autoStart = autoStartOn($tourRecords);
	/** @param {any} e */
	function onAutoStart(e) {
		tours.setAutoStart(!!e?.target?.checked);
	}
	function editor() {
		settingsOpen.set(false);
		startEditorTour();
	}
	function vr() {
		settingsOpen.set(false);
		startVRWelcome();
	}
</script>

<!-- 36-int-122: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={sectionKeywords.join(' ')}>
	<p class="ui-section-label">Tours</p>
	<SettingRow name="Show tours automatically">
		<svelte:fragment slot="control"><Toggle id="setting-tours-auto" checked={autoStart} onchange={onAutoStart} /></svelte:fragment>
		Start the short first-run tours by themselves: the editor tour after the welcome card, and
		"Welcome to ThePrototype VR" the first time you enter VR. "Don't show again" on a tour turns
		this off
	</SettingRow>
	<SettingRow name="VR welcome">
		<svelte:fragment slot="control"><Button id="setting-tour-vr" size="xs" color="alternative" onclick={vr}>Start VR welcome</Button></svelte:fragment>
		Your controllers, moving, pointing, grabbing, the radial menu, playing and leaving VR. In a
		headset it starts now (also: radial menu ▸ Settings ▸ Welcome tour); on a screen it plays the
		next time you enter VR, with a preview offered. <span class="tours-status">{statusText(VR_TOUR, $tourRecords)}</span>
	</SettingRow>
	<SettingRow name="Editor tour">
		<svelte:fragment slot="control"><Button id="setting-tour-editor" size="xs" color="alternative" onclick={editor}>Start editor tour</Button></svelte:fragment>
		Six steps around the editor — adding things, looking around, the tools, Play, building
		together and the logo menu ({editorTourId() === 'editor-touch' ? 'the touch-screen version on this device' : 'mouse and keyboard'}).
		<span class="tours-status">{statusText(editorTourId(), $tourRecords)}</span>
	</SettingRow>
	<SettingRow name="Offer Enter VR">
		<svelte:fragment slot="control"><Toggle id="setting-xr-offer" bind:checked={$xrOfferEnabled} /></svelte:fragment>
		In a headset's browser (Quest), let the browser show its own "Enter VR" button for this page, once
		per visit. Declining it is remembered on this device; switching this off and on asks again
	</SettingRow>
	<SettingRow name="Reset tours">
		<svelte:fragment slot="control"><Button id="setting-tours-reset" size="xs" color="alternative" onclick={resetAllTours}>Reset all</Button></svelte:fragment>
		Forget which tours you have seen or skipped and turn automatic tours back on
	</SettingRow>
</div>

<style>
	.tours-status {
		opacity: 0.7;
		font-style: italic;
	}
</style>
