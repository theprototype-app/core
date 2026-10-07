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
		{ value: 'full', label: 'Full (1k)' },
		{ value: 'low', label: 'Low (headset)' }
	];
</script>

<!-- 36-int-122: the I4 search reads a section's keywords from its root element -->
<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow id="row-hdri-quality" label="Sky image quality" description="How sharp an HDRI sky and its reflections are here: Full at 1024 px, Low at 512 px (the headset tier). Auto picks Low in a headset or a heavy scene. Peers are unaffected." wide>
		<Segmented id="hdri-quality" label="Sky image quality" options={QUALITY} value={$hdriQuality} onchange={(v) => hdriQuality.set(/** @type {any} */ (v))} />
	</SettingRow>
</div>

<style>
	.contents {
		display: contents;
	}
</style>
