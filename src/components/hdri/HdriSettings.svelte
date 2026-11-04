<script module>
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['hdri', 'hdr', 'sky', 'skybox', 'environment', 'image based lighting', 'reflections', 'quality', 'performance', 'headset'];
</script>

<script>
	// 37-hdri — Settings ▸ Scene ▸ Performance: the LOCAL HDRI quality (a fact about this device,
	// never saved into a scene or sent). Its own file so the settings index stays a one-line union.
	// 37-int-127: one row on the redesign kit beside Water quality (the 1.26 Settings), a segmented control.
	import SettingRow from '../ui/SettingRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { hdriQuality } from '$lib/hdri/hdriPrefs.js';

	const QUALITY = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'low', label: 'Low (headset)' },
		{ value: 'standard', label: 'Standard (1K)' },
		{ value: 'high', label: 'High (2K)' },
		{ value: 'max', label: 'Max (4K)' }
	];
</script>

<!-- 36-int-122: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow id="row-hdri-quality" label="Sky image quality" description="How sharp a sky image is on this device. Auto picks by device and connection, and a scene may set its own. Low also softens reflections, for a headset or a heavy scene. Peers are unaffected." wide>
		<Segmented id="hdri-quality" label="Sky image quality" options={QUALITY} value={$hdriQuality} onchange={(v) => hdriQuality.set(/** @type {any} */ (v))} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
