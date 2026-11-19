<script module>
	/** 95 SM3: what the settings search matches beyond the row names */
	export const keywords = ['moment', 'share a moment', 'record', 'recording', 'last 10 seconds', 'clip', 'gif', 'mp4', 'capture', 'replay', 'privacy'];
</script>

<script>
	// 95 SM3 — Settings ▸ Privacy ▸ Share a moment: "Recording the last 10 s", the visible switch for
	// the moment buffer (default ON, LOCAL to this device). It records the game view only (never the
	// editor, chat, voice or microphone), only in Play, keeps it in this tab and sends nothing.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { momentRecording, momentStatus, MOMENT_KEY } from '$lib/moment/momentStores.js';
	import { momentBlockerText } from '$lib/moment/momentCore.js';

	// a reason the buffer is off that this switch does not explain (VR, memory, a slow device)
	const why = $derived(['vr', 'memory', 'slow', 'browser', 'player'].includes($momentStatus.reason) ? momentBlockerText($momentStatus.reason) : '');
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Share a moment" badge="This device">
		<SettingRow id="row-moment-recording" label="Recording the last 10 s" keywords="moment record replay clip">
			{#snippet desc()}
				While you play, keeps the last 10 seconds of the game view (not the editor, chat, voice or microphone) so
				{MOMENT_KEY} or the Play bar button can make a GIF or MP4 of it. It stays in this tab and is forgotten when Play ends.{#if why}
					<span id="moment-setting-why"> {why}</span>{/if}
			{/snippet}
			<Toggle id="moment-recording" label="Recording the last 10 s" bind:checked={$momentRecording} />
		</SettingRow>
	</Section>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
