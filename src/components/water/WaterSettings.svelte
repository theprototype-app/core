<script module>
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['water', 'ocean', 'pool', 'refraction', 'caustics', 'reflection', 'waves', 'quality', 'performance'];
</script>

<script>
	// 36-water — Settings ▸ Scene ▸ Performance: the LOCAL water quality (a fact about this device,
	// never saved into a scene or sent). Its own file so the settings index stays a one-line union.
	// 37-settings (R21): one row on the redesign kit, the 4 choices as a segmented control.
	import SettingRow from '../ui/SettingRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { waterQuality } from '$lib/water/waterPrefs.js';

	const QUALITY = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'high', label: 'High' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'low', label: 'Low' }
	];
</script>

<!-- 36-int-122: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow id="row-water-quality" label="Water quality" description="High draws refraction, caustics and mirrors at full size; Low is the headset look. Auto follows this device." wide>
		<Segmented id="water-quality" label="Water quality" options={QUALITY} value={$waterQuality} onchange={(v) => waterQuality.set(/** @type {any} */ (v))} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
