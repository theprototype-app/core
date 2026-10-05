<script context="module">
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['water', 'ocean', 'pool', 'refraction', 'caustics', 'reflection', 'waves', 'quality', 'performance'];
</script>

<script>
	// 36-water — Settings ▸ Performance: the LOCAL water quality (a fact about this device,
	// never saved into a scene or sent). Legacy mode on purpose, like SettingRow, so it drops
	// into the legacy Settings modal with one line.
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SettingRow from '../menu/SettingRow.svelte';
	import { waterQuality } from '$lib/water/waterPrefs.js';
</script>

<!-- 36-int-122: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow name="Water quality">
		<svelte:fragment slot="control">
			<ThemedSelect
				id="water-quality"
				items={[
					{ value: 'auto', name: 'Auto' },
					{ value: 'high', name: 'High' },
					{ value: 'medium', name: 'Medium' },
					{ value: 'low', name: 'Low (headset)' }
				]}
				bind:value={$waterQuality}
			/>
		</svelte:fragment>
		High draws refraction, caustics, shoreline foam and planar mirrors at full resolution; Medium at half; Low is the
		headset look (waves, ripples and a light-bending shimmer, no screen-space passes). Auto follows this device's
		quality level (a phone included): Low in a headset or once the scene is too heavy for refraction. Only on THIS machine
	</SettingRow>
</div>
