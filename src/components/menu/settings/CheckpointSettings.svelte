<script module>
	/** 36 B14: what the settings search matches beyond the row names (I4 indexes labels + keywords) */
	export const keywords = ['checkpoint', 'checkpoints', 'version', 'versions', 'timeline', 'history', 'snapshot', 'backup', 'restore', 'storage'];
</script>

<script>
	// 36 B14 — Settings ▸ Scene ▸ Checkpoints: automatic rows in the timeline, how often, and how
	// much of this device they may use. Its own file so the settings index stays a one-line union.
	// Every value is LOCAL (this device), persisted through safeStorage by checkpoints.js.
	// 37-settings (R21): rows only (the Scene page puts them in its "Saving & checkpoints" card), on
	// the redesign kit; the two 4-option choices are segmented controls (Decision D).
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import { checkpointsOpen, settingsOpen } from '../../../stores/appStore.js';
	import { autoCheckpoints, autoCheckpointMinutes, checkpointCapMb, INTERVAL_CHOICES_MIN, CAP_CHOICES_MB } from '$lib/checkpoints';

	const EVERY = INTERVAL_CHOICES_MIN.map((m) => ({ value: String(m), label: m + ' min' }));
	const CAP = CAP_CHOICES_MB.map((m) => ({ value: String(m), label: m >= 1000 ? m / 1000 + ' GB' : m + ' MB' }));
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow id="row-checkpoints-auto" label="Keep automatic checkpoints" description="Autosave also adds a timeline row every few minutes, when the scene changed. Named checkpoints are kept either way.">
		<Toggle id="checkpoints-auto" label="Keep automatic checkpoints" bind:checked={$autoCheckpoints} />
	</SettingRow>
	<SettingRow id="row-checkpoints-every" label="Automatic checkpoint every" description="The shortest gap between two automatic checkpoints." wide>
		<Segmented id="checkpoints-every" label="Automatic checkpoint every" options={EVERY} value={String($autoCheckpointMinutes)} onchange={(v) => autoCheckpointMinutes.set(Number(v))} />
	</SettingRow>
	<SettingRow id="row-checkpoints-cap" label="Checkpoint storage" wide>
		{#snippet desc()}How much of this device checkpoints may use; the oldest unpinned ones go first. <button
				type="button"
				id="checkpoints-open-timeline"
				class="settings-link"
				onclick={() => {
					settingsOpen.set(false);
					checkpointsOpen.set(true);
				}}>Open the timeline</button
			>{/snippet}
		<Segmented id="checkpoints-cap" label="Checkpoint storage" options={CAP} value={String($checkpointCapMb)} onchange={(v) => checkpointCapMb.set(Number(v))} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
