<script context="module">
	/** 36 B14: what the settings search matches beyond the row names (I4 indexes labels + keywords) */
	export const keywords = ['checkpoint', 'checkpoints', 'version', 'versions', 'timeline', 'history', 'snapshot', 'backup', 'restore', 'storage'];
</script>

<script>
	// 36 B14 — Settings ▸ Scene ▸ Checkpoints: automatic rows in the timeline, how often, and how
	// much of this device they may use. Its own file so the settings index stays a one-line union.
	// Every value is LOCAL (this device), persisted through safeStorage by checkpoints.js.
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { Toggle } from 'flowbite-svelte';
	import SettingRow from '../SettingRow.svelte';
	import { checkpointsOpen, settingsOpen } from '../../../stores/appStore.js';
	import {
		autoCheckpoints,
		autoCheckpointMinutes,
		checkpointCapMb,
		INTERVAL_CHOICES_MIN,
		CAP_CHOICES_MB
	} from '$lib/checkpoints';
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<p class="ui-section-label">Checkpoints</p>
	<SettingRow name="Keep automatic checkpoints">
		<svelte:fragment slot="control"><Toggle id="checkpoints-auto" bind:checked={$autoCheckpoints} /></svelte:fragment>
		While you work, autosave also adds a row to the checkpoint timeline every few minutes — only when
		the scene changed. Named checkpoints (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) are kept either way.
	</SettingRow>
	<SettingRow name="Automatic checkpoint every">
		<svelte:fragment slot="control">
			<ThemedSelect
				id="checkpoints-every"
				items={INTERVAL_CHOICES_MIN.map((m) => ({ value: m, name: m + ' min' }))}
				bind:value={$autoCheckpointMinutes}
			/>
		</svelte:fragment>
		The shortest gap between two automatic checkpoints
	</SettingRow>
	<SettingRow name="Checkpoint storage">
		<svelte:fragment slot="control">
			<ThemedSelect
				id="checkpoints-cap"
				items={CAP_CHOICES_MB.map((m) => ({ value: m, name: m >= 1000 ? m / 1000 + ' GB' : m + ' MB' }))}
				bind:value={$checkpointCapMb}
			/>
		</svelte:fragment>
		How much of this device checkpoints may use. When a new one would not fit, the oldest unpinned
		checkpoints are removed — automatic ones before named ones. Pinned checkpoints are never removed.
		<button
			id="checkpoints-open-timeline"
			class="ui-button-quiet ml-1 text-xs"
			on:click={() => {
				settingsOpen.set(false);
				checkpointsOpen.set(true);
			}}>Open the timeline</button
		>
	</SettingRow>
</div>
