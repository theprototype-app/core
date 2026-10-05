<script context="module">
	// I4 settings search: the labels + keywords this section answers to
	export const keywords = ['hdri', 'hdr', 'sky', 'skybox', 'environment', 'image based lighting', 'reflections', 'quality', 'performance', 'headset'];
</script>

<script>
	// 37-hdri — Settings ▸ Performance: the LOCAL HDRI quality (a fact about this device, never
	// saved into a scene or sent). Legacy mode on purpose, like WaterSettings, so it drops into
	// the legacy Settings modal with one line.
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import SettingRow from '../menu/SettingRow.svelte';
	import { hdriQuality } from '$lib/hdri/hdriPrefs.js';
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<SettingRow name="Sky image quality">
		<svelte:fragment slot="control">
			<ThemedSelect
				id="hdri-quality"
				items={[
					{ value: 'auto', name: 'Auto' },
					{ value: 'full', name: 'Full (1k)' },
					{ value: 'low', name: 'Low (headset)' }
				]}
				bind:value={$hdriQuality}
			/>
		</svelte:fragment>
		How sharp an HDRI sky and its reflections are on THIS machine. Full prefilters the image at 1024 px; Low at 512 px,
		the headset tier (a quarter of the memory). Auto picks Low in a headset, in VR, or once the scene is too heavy for
		effects. The scene and your peers are unaffected
	</SettingRow>
</div>
